# ManyChat — Engenharia reversa (análise de 24/10/2026)

> Legenda de confiança: **[OBS]** observado diretamente nesta análise · **[DOC]** documentação pública oficial ou fala da própria empresa · **[INF]** inferência minha · **[?]** desconhecido / não verificado.

---

## 1. O que o produto é, em uma frase

Um **motor de automação de conversas** que fica entre as APIs oficiais de mensagens da Meta/TikTok/Twilio-like (Instagram, Messenger, WhatsApp, TikTok, SMS, e-mail) e o negócio do cliente. Ele recebe eventos (DM, comentário, menção em story, clique em link), identifica/cria um **contato**, e executa um **fluxo** (grafo de nós) que envia mensagens, grava dados no contato e chama sistemas externos.

O valor real não está na tecnologia de chat — está em:
1. Ser **parceiro oficial da Meta** (acesso às APIs de Instagram/Messenger/WhatsApp com permissões aprovadas) [DOC — FAQ do site].
2. Um **editor visual de fluxos** que esconde as regras chatas de cada canal (janela de 24h, tags de mensagem, templates do WhatsApp, limite de 1 resposta privada por comentário).
3. **Templates prontos** ("Quick Automations": comentário → DM, boas-vindas, FAQ, sorteio) [OBS — site /pt].

---

## 2. O que foi observado na infraestrutura

| Item | Evidência | Conclusão |
|---|---|---|
| `manychat.com` (marketing) | Chrome headless recebeu `307 → 403` + script `challenges.cloudflare.com/turnstile` [OBS] | Site atrás do **Cloudflare** com bot-management (Turnstile). |
| `app.manychat.com` (painel) | `202` + `challenge.js` de `*.eu-central-1.token.awswaf.com`, depois `302 /login → /signin` e página de captcha AWS [OBS] | Painel atrás do **AWS WAF** com Bot Control; token emitido em **eu-central-1 (Frankfurt)** → backend provavelmente na AWS Europa [INF]. |
| `api.manychat.com/swagger` | Swagger UI público, OpenAPI 3, auth `Bearer` [OBS] | API pública REST, chave por conta. |
| Stack backend | PHP 8.x (Yii2), PostgreSQL + PgBouncer, Redis, Elasticsearch, NGINX + **Lua** para receber webhooks de forma assíncrona, workers PHP-CLI, AWS [DOC — PHP Foundation, Habr, vagas] | Monólito PHP maduro + filas. Ingestão de webhooks chega a **~25.000 req/s** (palestra do lead de backend) [DOC]. |
| Stack frontend | React + Redux + TypeScript, testes Jest/Playwright [DOC — vagas] | SPA clássica. |
| `operationId` no OpenAPI são hashes de 32 hex (ex. `b6ae94031676b69a57eb2ad5ea1413f9`) [OBS] | Típico de spec gerada por anotações **swagger-php** [INF] — consistente com o backend PHP. |
| Prefixo `/fb/` em todos os endpoints, entidade raiz chamada `Page` [OBS] | Herança da origem só-Messenger; hoje "Page" = **conta/workspace**, mesmo para Instagram/WhatsApp [INF]. |

**Não fiz:** login no painel, criação de conta, nem contornei Cloudflare/AWS WAF. Tudo sobre o editor interno (formato JSON do fluxo, endpoints privados do painel) é **[?]** — dá para observar se você abrir o painel logado no navegador e me deixar inspecionar o tráfego da sua própria conta.

---

## 3. API pública (lida da spec OpenAPI oficial) [OBS]

Base `https://api.manychat.com`, header `Authorization: Bearer <API_KEY>` (gerada em *Settings → API*, plano Pro+).

### Conta ("page")
| Método | Caminho | Limite |
|---|---|---|
| GET | `/fb/page/getInfo` | 100/s |
| GET | `/fb/page/getTags` · `getCustomFields` · `getBotFields` · `getGrowthTools` · `getOtnTopics` | 100/s |
| GET | `/fb/page/getFlows` | 10/s |
| POST | `/fb/page/createTag` · `removeTag` · `removeTagByName` | 10/s |
| POST | `/fb/page/createCustomField` (`caption,type,description`) | 10/s |
| POST | `/fb/page/createBotField` · `setBotField` · `setBotFieldByName` · `setBotFields` | 10/s |

### Envio
| Método | Caminho | Corpo | Limite |
|---|---|---|---|
| POST | `/fb/sending/sendContent` | `subscriber_id, data, message_tag, otn_topic_name` | 25/s |
| POST | `/fb/sending/sendContentByUserRef` | `user_ref, data` | 25/s |
| POST | `/fb/sending/sendFlow` | `subscriber_id, flow_ns` | 20/s e **100/h por contato** |

Erros documentados do `sendContent`: `3011` fora da janela de 24h sem tag; `3021` sem token de One-Time Notification; `3031` sem "Notification Reason" após 24h; `304X` canal não permite.

### Contatos ("subscriber")
`getInfo`, `findByName`, `getInfoByUserRef`, `findByCustomField` (só Text/Number), `findBySystemField` (email **ou** phone, 50/s), `addTag[ByName]`, `removeTag[ByName]`, `setCustomField[s|ByName]`, `verifyBySignedRequest`, `createSubscriber`, `updateSubscriber` — maioria 10/s.

**O que a API NÃO expõe:** criar/editar fluxos, gatilhos ou palavras-chave. A lógica de automação fica só no painel.

### Modelo de dados exposto [OBS]
```text
Page        { id, name, category, avatar_link, username, about, description, is_pro, timezone }
Subscriber  { id, page_id, user_refs[], first_name, last_name, name, gender, profile_pic,
              locale, language, timezone, live_chat_url, last_input_text,
              phone, optin_phone, email, optin_email,
              ig_id, ig_username,
              whatsapp_phone, whatsapp_bsuid, whatsapp_username, optin_whatsapp,
              subscribed, last_interaction, last_seen, is_followup_enabled,
              custom_fields[], tags[] }
CustomField { id, name, type, description }          // valor por contato
BotField    { id, name, type, description, value }   // variável global da conta
Tag         { id, name }
Flow        { ns, name, folder_id }                  // "ns" = namespace/ID string do fluxo
Folder      { id, name, parent_id }                  // pastas aninhadas
GrowthTool  { id, name, type }                       // pontos de entrada (links ref, widgets, QR)
OtnTopic    { id, name, description }                // One-Time Notification (Messenger)
```

Ponto-chave: **um contato unificado** guarda IDs de vários canais (`ig_id`, `whatsapp_phone`, `phone`, `email`, `user_refs`) — é um mini-CRM.

---

## 4. Formato de mensagem — "Dynamic Block" v2 [DOC]

É a linguagem interna de conteúdo que vaza para fora via API/External Request:

```json
{
  "version": "v2",
  "content": {
    "messages": [
      { "type": "text", "text": "Oi {{first_name}}!",
        "buttons": [{ "type": "url", "caption": "Ver loja", "url": "https://..." }] }
    ],
    "actions": [
      { "action": "add_tag", "tag_name": "lead" },
      { "action": "set_field_value", "field_name": "origem", "value": "comentario" }
    ],
    "quick_replies": [
      { "type": "dynamic_block_callback", "caption": "Quero", "url": "https://meu.servidor/cb", "method": "post" }
    ],
    "external_message_callback": { "url": "https://...", "method": "post", "timeout": 3600 }
  }
}
```

- Mensagens: `text`, `image`, `video`, `audio`, `file`, `cards` (até 10 mensagens, 5 actions, 11 quick replies).
- Botões: `url`, `flow`, `node`, `call`, `buy` (Stripe/PayPal), `dynamic_block_callback`.
- `external_message_callback` = "a próxima mensagem do usuário vai para o seu servidor" → é assim que integrações de IA externas funcionam.

---

## 5. Como o motor funciona por dentro (reconstrução)

```text
Meta / TikTok / WhatsApp Cloud API
          │  webhooks (DM, comentário, menção, postback, status de entrega)
          ▼
┌──────────────────────────┐
│ Edge de ingestão         │  NGINX+Lua: valida assinatura (X-Hub-Signature-256),
│ (só ACK 200 + enfileira) │  responde 200 em ms e joga o payload numa fila
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐
│ Normalizador de evento   │  payload do canal → Evento interno
│                          │  {account, channel, external_user_id, type, text, ref, post_id...}
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐
│ Resolução de contato     │  upsert Subscriber por (account, canal, external_id);
│                          │  atualiza last_interaction (abre janela de 24h)
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐
│ Roteador de gatilhos     │  1) o contato está "esperando input"? → retoma o fluxo
│                          │  2) keyword / comentário em post X / story mention / ref link
│                          │  3) senão → Default Reply
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐
│ Executor de fluxo        │  percorre o grafo nó a nó; persiste o estado do contato
│ (workers)                │  (fluxo atual, nó atual, timers) entre passos
└──────────┬───────────────┘
           ▼
┌──────────────────────────┐
│ Camada de envio por canal│  aplica política (24h, tags, templates WA, 1 private reply
│ + rate limit             │  por comentário), traduz Dynamic Block → API do canal,
└──────────────────────────┘  respeita limites da Meta por conta, faz retry
```

### Tipos de nó do fluxo (do produto/editor) [DOC/INF]
| Nó | Função |
|---|---|
| **Trigger** | Palavra-chave, comentário em post/reel, resposta/menção em story, link `ig.me/m/...?ref=`, novo contato, evento de API, gatilho por data em campo |
| **Send Message** | Um ou mais blocos de conteúdo (texto, mídia, cards, botões, quick replies) |
| **Collect input** ("User Input") | Espera texto/e-mail/telefone, valida, grava em Custom Field, timeout |
| **Condition** | Ramifica por tag, campo, canal, horário, opt-in |
| **Actions** | Add/remove tag, set field, inscrever em sequência, notificar admin, passar para humano (Live Chat) |
| **Smart Delay** | Pausa N minutos/horas/dias (timer persistido) |
| **Randomizer** | Teste A/B com pesos |
| **External Request** | HTTP para fora; mapeia JSON da resposta para campos (JSONPath) |
| **AI Step / Agente** | LLM com instruções e acesso a campos; responde e extrai dados |
| **Start another flow** | Composição de fluxos |

### Regras de canal que o motor esconde [DOC — políticas da Meta]
- **Janela de 24h:** fora dela só com *message tag* (ex. `HUMAN_AGENT` 7 dias no Messenger/Instagram) — o erro `3011` da API é exatamente isso.
- **Comentário → DM:** Instagram permite **uma resposta privada por comentário**, dentro de ~7 dias, endereçada por `comment_id` (não precisa de DM anterior). É a funcionalidade nº 1 do produto.
- **WhatsApp:** fora de 24h só **template aprovado** pela Meta; cobrança por mensagem de template.
- **Limites da plataforma:** a Meta limita chamadas por conta; por isso o rate limit próprio (25/s no envio) e o `100/h por contato` no `sendFlow`.
- "Dar oi a novos seguidores" (anunciado no site) [?]: não confirmei qual evento da API da Meta alimenta isso.

---

## 6. Modelo de dados para um clone (PostgreSQL)

```sql
accounts            (id, name, timezone, plan, created_at)
channel_connections (id, account_id, channel, external_account_id, access_token_enc,
                     token_expires_at, status)                -- ig, messenger, whatsapp, tiktok, sms, email
contacts            (id, account_id, first_name, last_name, email, phone, locale, timezone,
                     last_interaction_at, last_input_text, status, created_at)
contact_identities  (contact_id, channel, external_user_id, opted_in, UNIQUE(account_id, channel, external_user_id))
tags                (id, account_id, name)
contact_tags        (contact_id, tag_id)
custom_fields       (id, account_id, name, type)              -- text, number, date, datetime, boolean, array
contact_field_values(contact_id, field_id, value_jsonb)
bot_fields          (id, account_id, name, type, value_jsonb) -- variáveis globais
folders             (id, account_id, parent_id, name)
flows               (id, account_id, ns, folder_id, name, status, published_version_id)
flow_versions       (id, flow_id, graph_jsonb, created_at)    -- grafo imutável por versão publicada
triggers            (id, account_id, flow_id, channel, type, config_jsonb, priority, active)
                    -- type: keyword | comment | story_reply | story_mention | ref_url | default_reply | api
contact_sessions    (contact_id, flow_version_id, node_id, waiting_for, context_jsonb, expires_at)
scheduled_jobs      (id, contact_id, run_at, kind, payload_jsonb, status)  -- smart delays, sequências
messages            (id, contact_id, channel, direction, payload_jsonb, external_message_id, status, created_at)
events_raw          (id, channel, received_at, payload_jsonb)            -- auditoria/replay de webhooks
broadcasts          (id, account_id, segment_jsonb, content_jsonb, scheduled_at, status)
api_keys            (id, account_id, hash, created_at)
```

O `graph_jsonb` de uma versão de fluxo pode seguir este formato (proposta minha — o formato real do ManyChat é [?]):

```json
{
  "start": "n1",
  "nodes": {
    "n1": { "type": "send_message", "content": { "version": "v2", "content": { "messages": [ { "type": "text", "text": "Qual seu e-mail?" } ] } }, "next": "n2" },
    "n2": { "type": "collect_input", "kind": "email", "save_to": "email", "timeout_s": 86400, "next": "n3", "on_timeout": "n9" },
    "n3": { "type": "condition", "rules": [ { "if": { "has_tag": "cliente" }, "go": "n4" } ], "else": "n5" },
    "n4": { "type": "action", "actions": [ { "action": "add_tag", "tag_name": "vip" } ], "next": null },
    "n5": { "type": "external_request", "method": "POST", "url": "https://crm/leads", "body": { "email": "{{email}}" }, "map": { "$.id": "crm_id" }, "next": null }
  }
}
```

---

## 7. Plano para construir um clone (do mínimo ao completo)

**MVP (o que gera 80% do valor): Instagram "comentário → DM"**
1. App na Meta (Instagram API com login do Instagram ou via Página do Facebook), permissões `instagram_business_manage_messages`, `instagram_business_manage_comments` — exige **App Review** da Meta antes de atender terceiros.
2. Endpoint de webhook (verificação `hub.challenge` + assinatura HMAC), que só enfileira.
3. Worker: evento `comments` → casa palavra-chave do post → envia **private reply** pelo `comment_id` → contato vira identidade IG.
4. Evento `messages` → retoma sessão / responde keyword / default reply.
5. Editor simples (lista de regras) antes do editor de grafo.

**Fase 2:** editor visual (React Flow), Smart Delay com fila de jobs, Custom Fields/Tags, Live Chat (inbox humano com WebSocket), API pública no formato acima.

**Fase 3:** WhatsApp Cloud API (templates, números, cobrança), broadcasts com segmentação, External Request, passo de IA (LLM), multi-conta/agência, cobrança por contatos ativos.

**Stack sugerida (não precisa ser PHP):** Node/TypeScript ou Go para ingestão + workers; PostgreSQL; Redis (filas BullMQ/streams, locks por contato para não processar 2 eventos do mesmo usuário em paralelo); S3 para mídia; React + React Flow no painel.

**Armadilhas que o ManyChat já resolveu e você vai encontrar:**
- Webhooks duplicados/fora de ordem → idempotência por `external_message_id` + lock por contato.
- Tokens que expiram/revogados → monitor de conexão e reconexão.
- Bloqueio por spam → rate limit por conta e por contato.
- Mudanças de API da Meta (versões a cada ~3 meses).
- Aprovação da Meta (App Review, Business Verification) é o gargalo real, não o código.

---

## 8. O que ficou em aberto

| Pergunta | Status | Como responder |
|---|---|---|
| Formato JSON interno do fluxo no editor | [?] | Inspecionar o tráfego do `app.manychat.com` logado na **sua** conta |
| Endpoints privados do painel (salvar fluxo, publicar, live chat) | [?] | Idem |
| Transporte do Live Chat em tempo real (WebSocket? SSE?) | [?] | Idem, captura de WebSocket |
| Evento usado para "novo seguidor" no Instagram | [?] | Docs atuais da Instagram Platform |
| Formato exato de `flow_ns` | [?] | Chamar `GET /fb/page/getFlows` com sua chave |

---

## Fontes
- Spec OpenAPI oficial: https://api.manychat.com/swagger (lida no navegador)
- Dynamic Block docs: https://manychat.github.io/dynamic_block_docs/
- PHP Foundation — stack do Manychat: https://thephp.foundation/blog/2025/05/09/manychat-powered-by-php/
- Palestra "Scaling Facebook webhooks… 25,000 rps with PHP": https://www.meetup.com/nl-NL/amsterdamphp/events/gpcdrtyhcjbzb/
- Post da equipe no Habr: https://habr.com/ru/post/486844
- Vagas/stack: https://relocate.me/company/manychat · https://dev.to/manychat
- Guia de API e limites (terceiro): https://www.blotato.com/blog/manychat-api
- Site: https://manychat.com/pt
