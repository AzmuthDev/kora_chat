# Kora: automação de Instagram (comentário → DM)

Alguém comenta uma palavra-chave num post/reel → o sistema responde em público no comentário e manda uma DM (resposta privada) para a pessoa, cria o contato e aplica uma tag. Baseado na engenharia reversa em [ENGENHARIA_REVERSA_MANYCHAT.md](ENGENHARIA_REVERSA_MANYCHAT.md).

Identidade visual (logo, símbolo, ícone de app, cores, regras de uso e PNGs para redes sociais) em [brand/](brand/index.html). Para regenerar os PNGs: `node scripts/export-brand-png.mjs`.

## Rodar

```bash
npm install
```

```bash
cp .env.example .env
```

Preencha `META_APP_SECRET`, `META_VERIFY_TOKEN`, `ADMIN_TOKEN`, `TOKEN_ENCRYPTION_KEY` e o banco (`DATABASE_URL`, abaixo) no `.env`.

```bash
npm run dev
```

```bash
npm test
```

As migrações rodam sozinhas ao subir o servidor (ou `npm run migrate`). No PowerShell, se aparecer "a execução de scripts foi desabilitada", troque `npm` por `npm.cmd`.

## Banco de dados: MySQL 8

O app usa **MySQL 8.0.19 ou mais novo** (desenvolvido e testado no 8.4). As versões antigas em PostgreSQL ficaram em `legacy/` só como referência.

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Banco que o app usa. Em produção é o da nuvem: `mysql://usuario:senha@host:porta/banco?ssl-mode=REQUIRED` |
| `DATABASE_SSL_CA` | Certificado da autoridade do provedor (na Aiven: "CA certificate" na página do serviço), salvo como `ca.pem` |
| `LOCAL_DATABASE_URL` | Banco `manychat` do MySQL local, para desenvolver sem a nuvem (copie para `DATABASE_URL`) |
| `TEST_DATABASE_URL` | Usuário dos testes no MySQL local; cada arquivo de teste cria e apaga um banco `manychat_test_*` |
| `LOCAL_MYSQL_ROOT_URL` | Senha do root do MySQL local (gerada pelo `setup-mysql.mjs`) |

### Nuvem (Aiven, plano Free)

Na página do serviço MySQL da Aiven:
1. Copie a **URI do serviço** (com a senha revelada) para `DATABASE_URL`.
2. Salve o **CA certificate** como `ca.pem` na pasta do projeto, com `DATABASE_SSL_CA=./ca.pem`.

O plano Free desliga o serviço depois de um tempo sem uso. Se o app ficar parado, religue o serviço no painel da Aiven.

### MySQL local (Windows), para desenvolver e rodar os testes

```bash
winget install --id Oracle.MySQL --exact --version 8.4.9
```

Num PowerShell **de administrador** (cria o serviço `MySQL84`, só acessível neste computador):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-mysql-windows.ps1
```

Depois, num terminal normal (define a senha do root e cria os usuários do app e dos testes no `.env`):

```bash
node scripts/setup-mysql.mjs
```

### Diferenças em relação ao PostgreSQL que o código já trata

- Parâmetros `$1, $2…` viram `?` no adaptador (`src/db/index.ts`), que também converte datas ISO, listas vazias em `IN (...)` e `0/1` em verdadeiro/falso.
- IDs são gerados pelo app (`randomUUID`), porque o MySQL não tem `RETURNING`.
- `INSERT IGNORE` e `ON DUPLICATE KEY UPDATE` substituem o `ON CONFLICT`.
- Leituras logo depois de uma corrida entre workers usam `FOR SHARE`, porque o MySQL (REPEATABLE READ) enxerga a "foto" do início da transação.
- Collation binária (`utf8mb4_bin`): comparações diferenciam maiúsculas, como no PostgreSQL. E-mails são gravados em minúsculas.
- Comandos de estrutura não entram em transação: se uma migração falhar no meio, corrija e rode de novo num banco limpo.

## Empresas, login e equipe (multiempresa)

O Kora atende várias **empresas-clientes**. Cada empresa tem as próprias conexões do Instagram, automações, contatos e equipe, e uma empresa nunca vê os dados de outra. O login é por **e-mail e senha**, com sessão em cookie `HttpOnly` que dura 14 dias e se renova com o uso.

| Papel | Onde vale | Pode |
|---|---|---|
| Super-admin | Plataforma inteira | Ver e entrar em todas as empresas, suspender e reativar empresas, gerenciar as pessoas da plataforma (seção **Plataforma**). |
| Administrador | Uma empresa | Tudo do membro, mais convidar e remover pessoas, mudar papéis e conectar o Instagram. |
| Membro | Uma empresa | Criar e pausar automações, usar o simulador, ver contatos e mensagens. |

1. **Primeiro acesso (você, dono da plataforma):** em `/` aparece "Crie o administrador". Informe o `ADMIN_TOKEN` do `.env` (a prova de que você tem acesso ao servidor), seu nome, e-mail e senha. Essa pessoa é o **super-admin**. Isso só funciona uma vez.
2. **Cadastro de cliente:** na tela de login, "Criar conta" cria o login e a empresa, com a pessoa como administradora. Para fechar o cadastro e aceitar gente só por convite, defina `SIGNUP_ENABLED=false`.
3. **Convites:** em **Equipe**, o administrador informa o e-mail e o papel e recebe um link (`/#/convite/<token>`). O Kora ainda não envia e-mail: copie o link e mande para a pessoa. O link vale por 7 dias, é de uso único e só funciona com o e-mail convidado. Quem já tem conta entra com ela para aceitar; quem não tem cria a senha na hora.
4. **Várias empresas:** qualquer pessoa logada pode abrir outra empresa em "+ Nova empresa" (útil para agências) e troca de empresa pelo seletor.

Regras que o sistema garante:
- Toda empresa mantém pelo menos um administrador ativo, e a plataforma mantém pelo menos um super-admin.
- Uma conta do Instagram só pode estar conectada em **uma** empresa. Conectar a mesma conta em outra é recusado, em vez de tirá-la de quem já usava.
- **Empresa suspensa** (por exemplo, pagamento em aberto): o painel continua abrindo, mas nada pode ser alterado e o worker ignora os comentários e DMs dela até reativar.
- Cada pessoa troca a própria senha em "Alterar senha", e os outros aparelhos dela são desconectados. Esqueceu a senha? O super-admin redefine em **Plataforma**, ou no servidor com `npm run reset-password -- email@exemplo.com`.

**Segurança:**
- Senhas guardadas com scrypt.
- Login bloqueado por 15 minutos após 10 tentativas erradas; cadastros em sequência do mesmo IP também são limitados.
- Proteção contra CSRF (cookie `SameSite=Lax` e verificação de origem).
- Os tokens de convite ficam só como hash no banco.
- O `ADMIN_TOKEN` vale como `Authorization: Bearer` de **super-admin** para scripts e integrações. Guarde-o como uma senha de root.

### Deixar acessível para a equipe

- **Na mesma rede (escritório):** no `.env`, troque `HOST=127.0.0.1` por `HOST=0.0.0.0` e libere a porta 3000 no firewall do Windows. As pessoas acessam `http://IP-DO-COMPUTADOR:3000`. Em HTTP sem cadeado, use isso só em rede confiável.
- **Pela internet:** coloque o app num servidor (VPS) atrás de um proxy com HTTPS (Caddy, nginx ou Cloudflare Tunnel) e defina `TRUST_PROXY=true` no `.env`. Assim o cookie de sessão passa a ser `Secure`. O webhook do Instagram também exige HTTPS público.

## Painel web

Abra `http://localhost:3000/` e entre com seu e-mail e senha. O painel é HTML, CSS e JS puros em `public/`, sem etapa de build, servido pelo mesmo servidor da API.

| Seção | O que faz |
|---|---|
| Conexões | Conecta o Instagram pelo login (OAuth) ou colando um token, cria contas de teste e mostra o status e a validade de cada token. |
| Automações | Cria automações comentário → DM (palavras-chave, posts, resposta pública, pergunta com botão, mensagem com link, tag) e pausa ou reativa cada uma. |
| Simulador | Um post e um celular lado a lado: comente como um seguidor, veja a resposta pública e a DM chegarem e toque nos botões. |
| Contatos | Quem interagiu, com tags, campos e até quando a conversa de 24h está aberta. |
| Mensagens | Tudo o que entrou e saiu, com o motivo quando algo foi bloqueado ou falhou. |

**Contas de teste:** são conexões marcadas como `sandbox`. O simulador gera para elas exatamente o mesmo evento que o webhook da Meta geraria (`/api/accounts/:id/simulate/comment` e `/simulate/message`). O worker usa um "Instagram" falso: tudo é registrado em `messages` e nada é enviado a ninguém. Elas também ficam fora da renovação de token, e o simulador recusa conexões reais.

## Como funciona

```text
Meta ──POST /webhooks/instagram──▶ valida X-Hub-Signature-256
                                   grava events_raw (dedupe) + scheduled_jobs ──▶ 200 "EVENT_RECEIVED"
                                                           │
worker (mesmo processo, ou vários) ◀── SELECT … FOR UPDATE SKIP LOCKED
   ├─ acha a conta conectada (entry.id)
   ├─ ignora comentários da própria conta (senão a resposta pública gera laço)
   ├─ upsert do contato pelo IGSID
   ├─ casa gatilhos de comentário (post, palavras-chave, prioridade)
   └─ executa o grafo do fluxo publicado:
        reply_comment → POST /{comment-id}/replies
        send_message  → POST /{ig-user-id}/messages
                         • DM normal se o contato mandou DM nas últimas 24h
                         • senão UMA resposta privada para { comment_id }
                         • senão bloqueado (registrado em messages)
        action        → tags / campos personalizados
```

| Pasta | O que tem |
|---|---|
| `migrations/001_init.sql` | Modelo de dados completo do relatório (contas, conexões, contatos, identidades, tags, campos, fluxos/versões, gatilhos, fila, mensagens…) |
| `src/http/` | Fastify: webhook e API administrativa |
| `src/instagram/` | Assinatura, normalização do webhook, cliente da Graph API, tradução Dynamic Block → Send API |
| `src/engine/` | Tipos do grafo (zod), gatilhos, política de janela de 24h, executor |
| `src/worker/` | Fila no MySQL (com `SKIP LOCKED`), processamento de eventos, loop do worker |
| `src/store/` | Acesso a contatos, mensagens e criação de automações |

**Garantias:** webhook repetido não reenvia nada (`events_raw.dedupe_key`); job reprocessado após falha temporária pula as mensagens já enviadas (`messages.idempotency_key`); recusas por limite de taxa (429 e os códigos de throttling) têm retry com backoff; erros definitivos ficam registrados em `messages.error`. Os access tokens ficam cifrados com AES-256-GCM.

**Entrega incerta não se repete.** Uma resposta 5xx, uma falha de rede ou os erros 1 e 2 da Graph API não provam que a DM deixou de chegar: a Meta às vezes entrega e responde erro mesmo assim. Nesses casos a mensagem fica com status `unconfirmed` e o Kora **não** tenta de novo, para não mandar duas vezes. O mesmo vale para um envio que ficou `pending` porque o processo caiu no meio. O painel mostra "Entrega incerta: confira no Direct antes de mandar de novo".

## Varredura de comentários

Sem *Advanced Access*, a Meta não entrega o webhook de comentários em tempo real, e mesmo com ele alguns comentários nunca chegam ("ver mais", contas filtradas). Por isso, a cada `COMMENT_SWEEP_MINUTES` minutos (padrão 5, `0` desliga) o worker lê os comentários recentes dos posts que têm automação ativa e põe na fila os que casam com uma palavra-chave.

- Usa a mesma chave do webhook (`comment:<id>`): o que já chegou pelo webhook, ou numa varredura anterior, não é processado de novo.
- Pula comentários da própria conta, os que a conta já respondeu, os de antes da automação existir e os com mais de 72h.
- Automação sem post definido olha os 10 posts mais recentes. Cada rodada põe no máximo 30 comentários por conta na fila, dos mais antigos para os mais novos.
- Usa a permissão `instagram_business_manage_comments`, que o login já pede.

## Links rastreados

Com `PUBLIC_BASE_URL` definido, os botões de link da DM passam por `PUBLIC_BASE_URL/r/<slug>?r=<pessoa>`: o Kora conta o toque e redireciona para o destino. O `r` é um HMAC do contato, então dá para contar pessoas distintas sem expor quem é, e o IP é gravado só como HMAC. O painel mostra, em cada automação, quantas das pessoas que receberam o link tocaram nele.

## Pedir para seguir antes do link

Com `require_follow`, só quem segue a conta recebe o link. Quem não segue recebe um pedido para seguir com o botão "Já sigo". A Meta só informa se alguém segue a conta depois que a pessoa toca num botão, por isso essa opção sempre usa a mensagem de abertura (sem `opening`, entra uma abertura padrão). Como a Meta leva até cerca de um minuto para reconhecer um follow novo, um toque em "Já sigo" que ainda volte como "não segue" é conferido de novo depois de 20s e de 40s antes de repetir o pedido. Se a Meta não informar (`null`), o link é entregue, para nunca travar quem segue de verdade.

```bash
curl -X POST localhost:3000/api/accounts/$ACC/automations/comment-to-dm -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"keywords":["link"],"opening":{"text":"Quer o link?","button_caption":"Quero!"},"require_follow":{"text":"Siga a gente e toque em Já sigo 💙","button_caption":"Já sigo"},"dm":{"text":"Aqui está 👇","buttons":[{"caption":"Abrir","url":"https://minhaloja.com/oferta"}]}}'
```

A varredura, os links rastreados, o pedido para seguir e a regra de entrega incerta foram adaptados do [OpenReply](https://github.com/diwenne/openreply) (licença MIT). O código foi reescrito para este projeto.

## Fluxo em duas etapas (o padrão que o ManyChat usa)

A resposta privada só permite **uma** mensagem até a pessoa responder. Por isso a automação pode mandar primeiro uma abertura com botão ("Quero!"). Quando a pessoa toca no botão, chega uma DM, a janela de 24h se abre e o fluxo continua com o link por DM normal. Use o campo `opening`, como no exemplo abaixo.

## API administrativa

Todas as rotas `/api/*` exigem `Authorization: Bearer $ADMIN_TOKEN`.

```bash
curl -X POST localhost:3000/api/accounts -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"name":"Minha loja"}'
```

```bash
curl -X POST localhost:3000/api/accounts/$ACC/connections/instagram -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"ig_user_id":"1784…","username":"minhaloja","access_token":"IGAA…"}'
```

```bash
curl -X POST localhost:3000/api/accounts/$ACC/automations/comment-to-dm -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"keywords":["quero","link"],"media_ids":[],"public_replies":["Te chamei no direct, @{{username}}! 📩"],"opening":{"text":"Oi! Quer receber o link?","button_caption":"Quero!"},"dm":{"text":"Aqui está 👇","buttons":[{"caption":"Abrir oferta","url":"https://minhaloja.com/oferta"}]},"tag":"lead-reels"}'
```

Outras rotas: `POST /api/accounts/:id/flows` (grafo livre + gatilho), `GET /api/accounts/:id/connections` (status e validade dos tokens), `GET /api/accounts/:id/contacts`, `GET /api/accounts/:id/messages`, `GET /health`.

## Conectar contas pelo login do Instagram (OAuth)

```bash
curl -X POST localhost:3000/api/accounts/$ACC/connections/instagram/oauth -H "Authorization: Bearer $ADMIN_TOKEN"
```

A resposta traz `authorize_url`. Abra esse link no navegador e entre com a conta profissional do Instagram. O Instagram redireciona para `/oauth/instagram/callback`, que:

1. confere o `state`: aleatório, de uso único, vale 15 minutos e está ligado à conta que pediu o link;
2. troca o `code` por um token curto e confere se as três permissões foram aceitas;
3. troca o token curto por um **token longo de 60 dias**;
4. lê o perfil (`user_id`, que é o mesmo ID que chega nos webhooks, e `username`);
5. assina os webhooks `comments` e `messages` para essa conta (`POST /me/subscribed_apps`);
6. grava a conexão com o token cifrado e mostra "Instagram conectado".

Reconectar uma conta que já existe atualiza o token e reativa a conexão se ela estiver `expired`.

### Renovação automática do token

O worker verifica a cada 10 minutos e renova (`GET /refresh_access_token`) os tokens que:
- vencem em menos de `IG_TOKEN_REFRESH_DAYS_BEFORE` dias (padrão 15) ou têm validade desconhecida (token colado à mão);
- foram emitidos há mais de 24h (exigência da Meta).

O que acontece em cada caso:
- **Sucesso:** o token e a validade são atualizados.
- **Erro 190** (token revogado ou inválido) ou **token já vencido:** a conexão vira `expired`, os webhooks dela passam a ser ignorados e é preciso reconectar pelo OAuth.
- **Falha temporária:** o erro fica em `last_refresh_error` e uma nova tentativa acontece em 1h.

Vários workers podem rodar juntos sem renovar o mesmo token duas vezes.

Se um **envio** (DM ou resposta pública) falhar com erro 190, a conexão também vira `expired` na hora e o fluxo para ali. Outros erros definitivos, como a janela de 24h, não derrubam a conexão.

## Termos de Uso e Política de Privacidade

As páginas públicas `/termos` e `/privacidade` (arquivos em `public/legal/`) são **rascunhos para revisão jurídica**. Os trechos com fundo amarelo (`<mark class="ph">`) precisam ser preenchidos com os dados da empresa: razão social, CNPJ, endereço, encarregado (DPO), prazos e provedores. Depois que o advogado aprovar, apague o aviso `legal-draft` do topo de cada página. A Meta pede a URL da política de privacidade nas configurações do app e no App Review.

## Desautorização e exclusão de dados (exigidos no App Review)

No painel do app, em "Configurar login comercial do Instagram", preencha:

| Campo no painel | URL |
|---|---|
| URL de retorno de chamada para cancelar autorização | `PUBLIC_BASE_URL/meta/instagram/deauthorize` |
| URL de solicitação de exclusão de dados | `PUBLIC_BASE_URL/meta/instagram/data-deletion` |
| URL da Política de Privacidade (Configurações básicas do app) | `PUBLIC_BASE_URL/privacidade` |
| URL dos Termos de Serviço (Configurações básicas do app) | `PUBLIC_BASE_URL/termos` |

Os dois recebem `signed_request` (HMAC-SHA256), validado com `IG_APP_SECRET` ou `META_APP_SECRET`. O `user_id` é comparado tanto com o ID da conta profissional quanto com o ID escopado do app (guardado no OAuth).

- **Desautorização:** a conexão vira `disconnected`, o token é apagado do banco e os webhooks da conta passam a ser ignorados. Os dados ficam até a pessoa reconectar ou pedir exclusão.
- **Exclusão de dados:** a conexão é desconectada na hora e a resposta é `{ "url", "confirmation_code" }`. A `url` aponta para `/meta/data-deletion/status?code=…`, uma página pública que mostra "em andamento" ou "concluída".
  - Um job no worker apaga tudo o que veio daquela conexão: mensagens, identidades, contatos que ficarem sem nenhuma identidade, webhooks brutos, jobs pendentes e a própria conexão.
  - Fluxos, gatilhos e tags do cliente não são dados do usuário da Meta e ficam.
  - O resumo do que foi apagado fica em `data_deletion_requests.summary`.

Para isso, contatos e mensagens agora guardam de qual conexão vieram (`connection_id`). A migração 003 preenche o histórico quando a conta tem uma única conexão Instagram. Dados antigos de contas com várias conexões ficam sem vínculo e não entram numa exclusão automática.

## Ligar num Instagram de verdade

1. Em [developers.facebook.com](https://developers.facebook.com), crie um app com o caso de uso de mensagens e conteúdo do Instagram ("Instagram API with Instagram Login").
2. Exponha o servidor local com HTTPS público, por exemplo com `cloudflared tunnel --url http://localhost:3000` ou ngrok. Coloque essa URL em `PUBLIC_BASE_URL`.
3. Em "Configurar API com login do Instagram":
   - copie o **ID** e a **chave secreta do app do Instagram** para `IG_APP_ID` e `IG_APP_SECRET`;
   - em "Configurar login comercial do Instagram", cadastre `PUBLIC_BASE_URL/oauth/instagram/callback` como URI de redirecionamento.
4. Configure o webhook do Instagram no app:
   - URL: `https://<seu-túnel>/webhooks/instagram`
   - Token de verificação: o valor de `META_VERIFY_TOKEN`
   - Campos: `comments` e `messages`

   As assinaturas são aceitas tanto com `META_APP_SECRET` quanto com `IG_APP_SECRET`.
5. Conecte a conta pelo OAuth (seção acima). Como alternativa sem OAuth, gere um token no painel e use `POST /api/accounts/:id/connections/instagram`. Nesse caso, o `ig_user_id` é o ID que chega em `entry[].id` nos webhooks; se tiver dúvida, comente num post e o log mostra `conta Instagram <ID> não conectada`.
6. Enquanto o app estiver em modo de desenvolvimento, só contas com papel no app recebem mensagens. Para atender clientes, é preciso passar pelo **App Review** e pela **verificação da empresa** na Meta.

## Ainda não feito (próximos passos)

- Avisar o cliente (e-mail ou painel) quando uma conexão vira `expired` ou `disconnected`.
- Gatilhos de DM por palavra-chave, menção e resposta em story, resposta padrão.
- Smart Delay, coleta de input (`contact_sessions` já está no schema), condições, External Request, passo de IA.
- Editor visual de fluxos livres (por exemplo React Flow); hoje o painel cria só o modelo comentário → DM.
- Envio de e-mail (convites, recuperação de senha, aviso de conexão expirada): hoje o admin copia o link do convite, e o super-admin redefine senhas em Plataforma ou com `npm run reset-password`.
- Cobrança e limites por plano (`accounts.plan` já existe; a suspensão de empresa já está pronta para ser usada pela cobrança).
- Registro de auditoria: quem criou ou alterou cada automação.
- Lock por contato e rate limit por conta para volumes altos.
- Busca do perfil (nome) do usuário: hoje `{{first_name}}` cai para o `username`.
