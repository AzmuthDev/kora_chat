// Painel do Kora — JS puro, sem build. Todo texto vindo da API entra via textContent (nunca innerHTML).
// Autenticação por cookie de sessão HttpOnly: o JS nunca vê nem guarda o token.

const ACCOUNT_KEY = "painel.accountId";

const ROUTES = [
  { id: "conexoes", label: "Conexões", render: renderConnections },
  { id: "automacoes", label: "Automações", render: renderAutomations },
  { id: "simulador", label: "Simulador", render: renderSimulator },
  { id: "contatos", label: "Contatos", render: renderContacts },
  { id: "mensagens", label: "Mensagens", render: renderMessages },
  { id: "equipe", label: "Equipe", render: renderTeam, ownerOnly: true },
];

const state = {
  user: null,
  accounts: [],
  accountId: safeGet(localStorage, ACCOUNT_KEY),
  stopPolling: null,
};

const sim = { connectionId: null, username: "maria.teste", mediaId: "post-de-teste", messages: [], signature: "" };

// ---------------------------------------------------------------- utilidades

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* armazenamento indisponível: segue sem lembrar */
  }
}

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = value;
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const safeHref = (url) => (/^https?:\/\//i.test(url ?? "") ? url : null);

function initials(name) {
  return (name ?? "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
function ago(value) {
  if (!value) return "—";
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "agora";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

function dateTime(value) {
  return value ? new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
}

let toastTimer;
function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `show ${kind === "error" ? "error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 3200);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body, allow401 = false } = {}) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !allow401) {
    stopPolling();
    state.user = null;
    renderLogin("Sua sessão terminou. Entre de novo.");
    throw new ApiError("não autenticado", 401);
  }
  if (!res.ok) {
    const issues = Array.isArray(data.issues)
      ? data.issues.map((i) => `${i.path?.join(".") || "campo"}: ${i.message}`).join("; ")
      : null;
    throw new ApiError(data.error && data.error !== "validation" ? data.error : (issues ?? data.error ?? `Erro ${res.status}`), res.status);
  }
  return data;
}

const acc = (path = "") => `/api/accounts/${state.accountId}${path}`;

async function withBusy(button, fn) {
  button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    if (err.status !== 401) toast(err.message, "error");
    return undefined;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- login e contas

const isOwner = () => state.user?.role === "owner";

async function logout() {
  stopPolling();
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => {});
  state.user = null;
  renderLogin("Você saiu do painel.", "info");
}

function gateForm({ title, lede, fields, submitLabel, onSubmit, footer }) {
  const error = h("p", { class: "error", role: "alert" });
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.className = "error";
        error.textContent = "";
        const button = e.submitter;
        button.disabled = true;
        try {
          await onSubmit(new FormData(form), (msg) => (error.textContent = msg));
        } finally {
          button.disabled = false;
        }
      },
    },
    h("img", { class: "gate-logo", src: "/panel/kora-wordmark.svg", alt: "Kora" }),
    h("h1", null, title),
    lede ? h("p", { class: "muted" }, lede) : null,
    fields,
    error,
    h("button", { type: "submit" }, submitLabel),
    footer ?? null,
  );
  mount(h("div", { class: "gate" }, form));
  form.querySelector("input")?.focus();
  return { form, error };
}

function renderLogin(message, tone = "error") {
  const { error } = gateForm({
    title: "Entrar no painel",
    lede: "Use o e-mail e a senha que o administrador cadastrou para você.",
    fields: [
      h("label", null, "E-mail", h("input", { name: "email", type: "email", autocomplete: "username", required: true })),
      h("label", null, "Senha", h("input", { name: "password", type: "password", autocomplete: "current-password", required: true })),
    ],
    submitLabel: "Entrar",
    footer: h("p", { class: "muted small" }, "Esqueceu a senha? Peça a um administrador para redefinir na seção Equipe."),
    onSubmit: async (data, showError) => {
      try {
        const res = await api("/auth/login", {
          method: "POST",
          body: { email: String(data.get("email")), password: String(data.get("password")) },
          allow401: true,
        });
        state.user = res.user;
        await boot();
      } catch (err) {
        showError(err.message);
      }
    },
  });
  if (message) {
    error.textContent = message;
    if (tone === "info") error.className = "notice";
  }
}

function renderSetup() {
  gateForm({
    title: "Crie o administrador",
    lede: "Primeiro acesso: cadastre quem vai administrar o painel. Depois, essa pessoa adiciona o resto da equipe.",
    fields: [
      h(
        "label",
        null,
        "Token de instalação",
        h("span", { class: "hint" }, "Valor de ADMIN_TOKEN no .env do servidor. Só é pedido agora."),
        h("input", { name: "admin_token", type: "password", autocomplete: "off", required: true }),
      ),
      h("label", null, "Seu nome", h("input", { name: "name", autocomplete: "name", required: true })),
      h("label", null, "E-mail", h("input", { name: "email", type: "email", autocomplete: "username", required: true })),
      h(
        "label",
        null,
        "Senha",
        h("span", { class: "hint" }, "Pelo menos 8 caracteres."),
        h("input", { name: "password", type: "password", autocomplete: "new-password", minlength: 8, required: true }),
      ),
      h("label", null, "Repita a senha", h("input", { name: "confirm", type: "password", autocomplete: "new-password", required: true })),
    ],
    submitLabel: "Criar administrador",
    onSubmit: async (data, showError) => {
      if (data.get("password") !== data.get("confirm")) return showError("As senhas não são iguais.");
      try {
        const res = await api("/auth/setup", {
          method: "POST",
          body: {
            admin_token: String(data.get("admin_token")).trim(),
            name: String(data.get("name")),
            email: String(data.get("email")),
            password: String(data.get("password")),
          },
          allow401: true,
        });
        state.user = res.user;
        await boot();
      } catch (err) {
        showError(err.message);
      }
    },
  });
}

function changePasswordDialog() {
  const errors = h("p", { class: "form-errors", role: "alert" });
  const form = h(
    "form",
    {
      method: "dialog",
      onsubmit: async (e) => {
        if (e.submitter?.value === "cancel") return;
        e.preventDefault();
        errors.textContent = "";
        const d = new FormData(form);
        if (d.get("new_password") !== d.get("confirm")) {
          errors.textContent = "As senhas novas não são iguais.";
          return;
        }
        await withBusy(e.submitter, async () => {
          try {
            await api("/auth/password", {
              method: "POST",
              body: { current_password: String(d.get("current_password")), new_password: String(d.get("new_password")) },
            });
          } catch (err) {
            errors.textContent = err.message;
            return;
          }
          form.reset();
          dialog.close();
          toast("Senha alterada. Os outros aparelhos foram desconectados.");
        });
      },
    },
    h("h2", null, "Alterar senha"),
    h("label", null, "Senha atual", h("input", { name: "current_password", type: "password", autocomplete: "current-password", required: true })),
    h(
      "label",
      null,
      "Nova senha",
      h("span", { class: "hint" }, "Pelo menos 8 caracteres."),
      h("input", { name: "new_password", type: "password", autocomplete: "new-password", minlength: 8, required: true }),
    ),
    h("label", null, "Repita a nova senha", h("input", { name: "confirm", type: "password", autocomplete: "new-password", required: true })),
    errors,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "submit", value: "save" }, "Salvar senha"),
      h("button", { type: "submit", value: "cancel", class: "secondary", formnovalidate: true }, "Cancelar"),
    ),
  );
  const dialog = h("dialog", { "aria-label": "Alterar senha" }, form);
  return dialog;
}

function renderNoAccess() {
  mount(
    h(
      "div",
      { class: "gate" },
      h(
        "div",
        { class: "gate-card" },
        h("img", { class: "gate-logo", src: "/panel/kora-wordmark.svg", alt: "Kora" }),
        h("h1", null, "Nenhuma conta liberada"),
        h("p", { class: "muted" }, `Olá, ${state.user.name}. Peça a um administrador para te dar acesso a uma conta na seção Equipe.`),
        h("button", { type: "button", class: "secondary", onclick: () => logout() }, "Sair"),
      ),
    ),
  );
}

function renderFirstAccount() {
  const input = h("input", { id: "account-name", required: true, placeholder: "Ex.: Loja da Ana" });
  const form = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(e.submitter, async () => {
          const created = await api("/api/accounts", { method: "POST", body: { name: input.value.trim() } });
          selectAccount(created.id);
          location.hash = "#/conexoes";
          await boot();
        });
      },
    },
    h("img", { class: "gate-logo", src: "/panel/kora-wordmark.svg", alt: "Kora" }),
    h("h1", null, "Crie sua primeira conta"),
    h("p", { class: "muted" }, "Uma conta reúne as conexões do Instagram, as automações e os contatos de um cliente ou marca."),
    h("label", { for: "account-name" }, "Nome da conta", input),
    h("button", { type: "submit" }, "Criar conta"),
  );
  mount(h("div", { class: "gate" }, form));
  input.focus();
}

function selectAccount(id) {
  state.accountId = id;
  safeSet(localStorage, ACCOUNT_KEY, id);
}

function mount(node) {
  const app = document.getElementById("app");
  app.className = "";
  app.replaceChildren(node);
}

async function boot() {
  try {
    if (!state.user) {
      const me = await api("/auth/me", { allow401: true }).catch((err) => (err.status === 401 ? null : Promise.reject(err)));
      if (!me) {
        const status = await api("/auth/status");
        return status.needs_setup ? renderSetup() : renderLogin();
      }
      state.user = me.user;
    }
    state.accounts = await api("/api/accounts");
  } catch (err) {
    if (err.status !== 401) mount(h("div", { class: "gate" }, h("p", { class: "error" }, `Não foi possível falar com o servidor: ${err.message}`)));
    return;
  }
  if (state.accounts.length === 0) return isOwner() ? renderFirstAccount() : renderNoAccess();
  if (!state.accounts.some((a) => a.id === state.accountId)) selectAccount(state.accounts[0].id);
  renderShell();
  route();
}

// ---------------------------------------------------------------- estrutura

function renderShell() {
  const select = h(
    "select",
    {
      id: "account-select",
      onchange: (e) => {
        selectAccount(e.target.value);
        sim.connectionId = null;
        route();
      },
    },
    state.accounts.map((a) => h("option", { value: a.id, selected: a.id === state.accountId }, a.name)),
  );

  const dialog = newAccountDialog();
  const passwordDialog = changePasswordDialog();
  const rail = h(
    "aside",
    { class: "rail" },
    h("div", { class: "wordmark" }, h("img", { src: "/panel/kora-wordmark-white.svg", alt: "Kora" })),
    h(
      "div",
      { class: "account" },
      h("label", { for: "account-select" }, "Conta"),
      select,
      isOwner() ? h("button", { class: "quiet", type: "button", onclick: () => dialog.showModal() }, "+ Nova conta") : null,
    ),
    h(
      "nav",
      { class: "nav", "aria-label": "Seções" },
      ROUTES.filter((r) => !r.ownerOnly || isOwner()).map((r) => h("a", { href: `#/${r.id}`, "data-route": r.id }, r.label)),
    ),
    h(
      "div",
      { class: "me" },
      h("span", { class: "avatar user", "aria-hidden": "true" }, initials(state.user.name)),
      h("div", { class: "me-name" }, h("strong", null, state.user.name), h("small", null, state.user.email)),
      h(
        "div",
        { class: "me-actions" },
        h("button", { class: "quiet", type: "button", onclick: () => passwordDialog.showModal() }, "Alterar senha"),
        h("button", { class: "quiet", type: "button", onclick: () => logout() }, "Sair"),
      ),
    ),
  );

  mount(h("div", { class: "shell" }, rail, h("main", { id: "main", tabindex: "-1" }), dialog, passwordDialog));
}

function newAccountDialog() {
  const input = h("input", { id: "new-account", required: true });
  const dialog = h(
    "dialog",
    { "aria-labelledby": "new-account-title" },
    h(
      "form",
      {
        method: "dialog",
        onsubmit: async (e) => {
          if (e.submitter?.value === "cancel") return;
          e.preventDefault();
          await withBusy(e.submitter, async () => {
            const created = await api("/api/accounts", { method: "POST", body: { name: input.value.trim() } });
            dialog.close();
            selectAccount(created.id);
            toast(`Conta "${created.name}" criada`);
            location.hash = "#/conexoes";
            await boot();
          });
        },
      },
      h("h2", { id: "new-account-title" }, "Nova conta"),
      h("label", { for: "new-account" }, "Nome", input),
      h(
        "div",
        { class: "actions" },
        h("button", { type: "submit", value: "create" }, "Criar conta"),
        h("button", { type: "submit", value: "cancel", class: "secondary", formnovalidate: true }, "Cancelar"),
      ),
    ),
  );
  return dialog;
}

function stopPolling() {
  state.stopPolling?.();
  state.stopPolling = null;
}

async function route() {
  stopPolling();
  const id = location.hash.replace(/^#\//, "") || "automacoes";
  const current = ROUTES.find((r) => r.id === id && (!r.ownerOnly || isOwner())) ?? ROUTES[1];
  for (const a of document.querySelectorAll(".nav a")) {
    if (a.dataset.route === current.id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const main = document.getElementById("main");
  if (!main) return;
  main.replaceChildren(h("p", { class: "muted" }, "Carregando…"));
  try {
    await current.render(main);
  } catch (err) {
    if (err.status !== 401) main.replaceChildren(h("p", { class: "error-text" }, `Erro ao carregar: ${err.message}`));
  }
}

function pageHead(title, lede, ...actions) {
  return h(
    "header",
    { class: "page-head" },
    h("div", null, h("h1", null, title), lede && h("p", { class: "lede" }, lede)),
    actions.length ? h("div", { class: "actions" }, actions) : null,
  );
}

// ---------------------------------------------------------------- conexões

const CONNECTION_STATUS = {
  active: ["Ativa", "ok"],
  expired: ["Expirada — reconecte", "bad"],
  disconnected: ["Desconectada", "bad"],
};

async function renderConnections(main) {
  const connections = await api(acc("/connections"));

  const connectBtn = h(
    "button",
    {
      type: "button",
      onclick: (e) =>
        withBusy(e.currentTarget, async () => {
          try {
            const { authorize_url } = await api(acc("/connections/instagram/oauth"), { method: "POST" });
            location.href = authorize_url;
          } catch (err) {
            if (err.status === 503) {
              toast("Login do Instagram não configurado: preencha IG_APP_ID, IG_APP_SECRET e PUBLIC_BASE_URL no .env.", "error");
              return;
            }
            throw err;
          }
        }),
    },
    "Conectar com Instagram",
  );
  const sandboxBtn = h(
    "button",
    {
      type: "button",
      class: "secondary",
      onclick: (e) =>
        withBusy(e.currentTarget, async () => {
          const c = await api(acc("/connections/sandbox"), { method: "POST", body: {} });
          toast(`Conta de teste @${c.username} criada`);
          sim.connectionId = c.id;
          route();
        }),
    },
    "Criar conta de teste",
  );

  const list = connections.length
    ? h(
        "ul",
        { class: "rows block" },
        connections.map((c) => {
          const [label, tone] = CONNECTION_STATUS[c.status] ?? [c.status, ""];
          return h(
            "li",
            null,
            h(
              "div",
              { class: "title" },
              `@${c.username ?? c.ig_user_id}`,
              c.sandbox ? h("span", { class: "pill test" }, "Teste") : null,
            ),
            h(
              "div",
              { class: "detail" },
              c.sandbox
                ? h("span", null, "Recebe só comentários do simulador. Nada é enviado ao Instagram.")
                : h(
                    "span",
                    null,
                    "Token ",
                    h("strong", null, c.token_expires_at ? `vence ${ago(c.token_expires_at)}` : "sem validade conhecida"),
                  ),
              c.token_refreshed_at ? h("span", null, `Renovado ${ago(c.token_refreshed_at)}`) : null,
              h("span", null, `ID ${c.ig_user_id}`),
              c.last_refresh_error && c.status !== "active"
                ? h("span", { class: "error-text" }, c.last_refresh_error)
                : null,
            ),
            h("span", { class: `pill ${tone}` }, label),
          );
        }),
      )
    : h(
        "div",
        { class: "block empty" },
        h("h2", null, "Nenhuma conta do Instagram conectada"),
        h(
          "p",
          { class: "muted" },
          "Conecte uma conta profissional para as automações responderem comentários de verdade, ou crie uma conta de teste para experimentar no simulador.",
        ),
      );

  main.replaceChildren(
    pageHead("Conexões", "Contas do Instagram que esta conta usa para responder comentários e mandar DMs.", connectBtn, sandboxBtn),
    list,
    manualTokenForm(),
  );
}

function manualTokenForm() {
  const errors = h("p", { class: "form-errors", role: "alert" });
  const form = h(
    "form",
    {
      class: "form-body",
      onsubmit: async (e) => {
        e.preventDefault();
        errors.textContent = "";
        const data = new FormData(form);
        await withBusy(e.submitter, async () => {
          try {
            await api(acc("/connections/instagram"), {
              method: "POST",
              body: {
                ig_user_id: String(data.get("ig_user_id")).trim(),
                username: String(data.get("username")).trim() || undefined,
                access_token: String(data.get("access_token")).trim(),
              },
            });
          } catch (err) {
            errors.textContent = err.message;
            return;
          }
          toast("Conta conectada");
          route();
        });
      },
    },
    h(
      "fieldset",
      null,
      h(
        "p",
        { class: "muted small" },
        "Use quando o login do Instagram ainda não estiver configurado: gere um token no painel do app da Meta e cole aqui.",
      ),
      h(
        "div",
        { class: "grid-2" },
        h("label", null, "ID da conta profissional", h("input", { name: "ig_user_id", required: true, inputmode: "numeric", pattern: "\\d+" })),
        h("label", null, "Usuário (opcional)", h("input", { name: "username" })),
      ),
      h("label", null, "Access token", h("input", { name: "access_token", required: true, type: "password", autocomplete: "off" })),
      errors,
      h("div", null, h("button", { type: "submit" }, "Conectar com token")),
    ),
  );
  return h("details", { class: "form" }, h("summary", null, "Conectar com token manualmente"), form);
}

// ---------------------------------------------------------------- automações

function summarizeGraph(graph) {
  const nodes = graph?.nodes ?? {};
  const text = (node) => node?.content?.content?.messages?.[0]?.text;
  return {
    publicReplies: nodes.public_reply?.texts ?? [],
    opening: text(nodes.opening),
    openingButton: nodes.opening?.content?.content?.quick_replies?.[0]?.caption,
    dm: text(nodes.dm),
    buttons: nodes.dm?.content?.content?.messages?.[0]?.buttons ?? [],
    tag: nodes.tag?.actions?.find((a) => a.action === "add_tag")?.tag_name,
    custom: !nodes.dm,
  };
}

async function renderAutomations(main) {
  const automations = await api(acc("/automations"));

  const list = automations.length
    ? h(
        "ul",
        { class: "rows block" },
        automations.map((a) => {
          const s = summarizeGraph(a.graph);
          const cfg = a.config ?? {};
          const keywords = cfg.keywords ?? [];
          const toggle = h("input", {
            type: "checkbox",
            role: "switch",
            checked: a.active,
            "aria-label": `Automação ${a.name} ativa`,
            onchange: async (e) => {
              const input = e.currentTarget;
              const result = await withBusy(input, () =>
                api(acc(`/automations/${a.id}`), { method: "PATCH", body: { active: input.checked } }),
              );
              if (!result) input.checked = !input.checked;
              else {
                stateText.textContent = input.checked ? "Ativa" : "Pausada";
                toast(input.checked ? "Automação ativada" : "Automação pausada");
              }
            },
          });
          const stateText = h("span", null, a.active ? "Ativa" : "Pausada");
          return h(
            "li",
            null,
            h(
              "div",
              { class: "detail" },
              h("div", { class: "title" }, a.name),
              h(
                "div",
                null,
                keywords.length
                  ? [cfg.match === "exact" ? "Comentário igual a " : "Comentário com ", keywords.map((k) => h("span", { class: "chip" }, k))]
                  : "Qualquer comentário",
              ),
              h("span", null, cfg.media_ids?.length ? `Só nos posts ${cfg.media_ids.join(", ")}` : "Em todos os posts"),
            ),
            s.custom
              ? h("div", { class: "detail" }, "Fluxo personalizado")
              : h(
                  "div",
                  { class: "detail" },
                  s.publicReplies.length ? h("span", null, "Responde no post: ", h("strong", null, s.publicReplies.join(" / "))) : null,
                  s.opening
                    ? h("span", null, "Pergunta no direct: ", h("strong", null, s.opening), ` [${s.openingButton}]`)
                    : null,
                  h("span", null, s.opening ? "Depois do toque, manda: " : "Manda no direct: ", h("strong", null, s.dm)),
                  s.buttons.length ? h("span", null, "Botões: ", s.buttons.map((b) => h("span", { class: "chip" }, b.caption))) : null,
                  s.tag ? h("span", null, "Marca o contato com ", h("span", { class: "chip" }, s.tag)) : null,
                ),
            h("label", { class: "switch" }, toggle, stateText),
          );
        }),
      )
    : h(
        "div",
        { class: "block empty" },
        h("h2", null, "Nenhuma automação ainda"),
        h("p", { class: "muted" }, "Crie a primeira: escolha as palavras-chave e a mensagem que a pessoa recebe no direct quando comentar."),
      );

  main.replaceChildren(
    pageHead("Automações", "Quando alguém comenta num post, a automação responde no comentário e manda uma mensagem no direct."),
    list,
    automationForm(automations.length === 0),
  );
}

function automationForm(open) {
  const errors = h("p", { class: "form-errors", role: "alert" });
  const openingFields = h(
    "div",
    { class: "grid-2", hidden: true },
    h("label", null, "Pergunta", h("textarea", { name: "opening_text", rows: 2, value: "Oi! Quer que eu te mande o link?" })),
    h("label", null, "Texto do botão", h("input", { name: "opening_button", maxlength: 20, value: "Quero!" })),
  );
  const askFirst = h("input", {
    type: "checkbox",
    name: "ask_first",
    onchange: (e) => (openingFields.hidden = !e.currentTarget.checked),
  });

  const form = h(
    "form",
    {
      class: "form-body",
      onsubmit: async (e) => {
        e.preventDefault();
        errors.textContent = "";
        const d = new FormData(form);
        const str = (k) => String(d.get(k) ?? "").trim();
        const list = (k, sep) => str(k).split(sep).map((x) => x.trim()).filter(Boolean);
        const body = {
          name: str("name") || "Comentário → DM",
          keywords: list("keywords", ","),
          match: str("match"),
          media_ids: list("media_ids", ","),
          public_replies: list("public_replies", "\n"),
          dm: { text: str("dm_text") },
        };
        if (!body.public_replies.length) delete body.public_replies;
        if (str("button_caption") || str("button_url")) {
          body.dm.buttons = [{ caption: str("button_caption"), url: str("button_url") }];
        }
        if (askFirst.checked) body.opening = { text: str("opening_text"), button_caption: str("opening_button") };
        if (str("tag")) body.tag = str("tag");

        await withBusy(e.submitter, async () => {
          try {
            await api(acc("/automations/comment-to-dm"), { method: "POST", body });
          } catch (err) {
            errors.textContent = `Revise o formulário: ${err.message}`;
            return;
          }
          toast("Automação criada");
          route();
        });
      },
    },
    h(
      "fieldset",
      null,
      h("legend", null, "Quando disparar"),
      h("label", null, "Nome", h("input", { name: "name", placeholder: "Ex.: Link da promoção" })),
      h(
        "div",
        { class: "grid-2" },
        h(
          "label",
          null,
          "Palavras-chave",
          h("span", { class: "hint" }, "Separe por vírgula. Vazio = qualquer comentário."),
          h("input", { name: "keywords", placeholder: "quero, link, preço" }),
        ),
        h(
          "label",
          null,
          "Como comparar",
          h("span", { class: "hint" }, "Maiúsculas e acentos não importam."),
          h(
            "select",
            { name: "match" },
            h("option", { value: "contains" }, "O comentário contém a palavra"),
            h("option", { value: "exact" }, "O comentário é exatamente a palavra"),
          ),
        ),
      ),
      h(
        "label",
        null,
        "Posts",
        h("span", { class: "hint" }, "IDs separados por vírgula. Vazio = todos os posts."),
        h("input", { name: "media_ids", placeholder: "17890000000000000" }),
      ),
    ),
    h(
      "fieldset",
      null,
      h("legend", null, "Resposta no post"),
      h(
        "label",
        null,
        "Respostas públicas (opcional)",
        h("span", { class: "hint" }, "Uma por linha; cada comentário recebe uma delas, sorteada. Use {{username}} para o @ da pessoa."),
        h("textarea", { name: "public_replies", rows: 2, placeholder: "Te mandei no direct, @{{username}}! 📩" }),
      ),
    ),
    h(
      "fieldset",
      null,
      h("legend", null, "Mensagem no direct"),
      h("label", { class: "check" }, askFirst, "Perguntar antes de mandar o link"),
      h(
        "p",
        { class: "muted small" },
        "O Instagram só deixa mandar uma mensagem para quem comentou. Com a pergunta, o link vai depois que a pessoa toca no botão, e a conversa fica aberta por 24h.",
      ),
      openingFields,
      h("label", null, "Mensagem", h("textarea", { name: "dm_text", required: true, rows: 3, placeholder: "Oi {{first_name}}! Aqui está o link da promoção:" })),
      h(
        "div",
        { class: "grid-2" },
        h("label", null, "Texto do botão (opcional)", h("input", { name: "button_caption", maxlength: 20, placeholder: "Ver oferta" })),
        h("label", null, "Link do botão", h("input", { name: "button_url", type: "url", placeholder: "https://minhaloja.com/oferta" })),
      ),
      h("label", null, "Marcar contato com a tag (opcional)", h("input", { name: "tag", placeholder: "lead-promo" })),
    ),
    errors,
    h("div", null, h("button", { type: "submit" }, "Criar automação")),
  );
  return h("details", { class: "form", open }, h("summary", null, "Nova automação"), form);
}

// ---------------------------------------------------------------- simulador

const SIM_USERNAME_KEY = "painel.simUsername";

async function renderSimulator(main) {
  const connections = (await api(acc("/connections"))).filter((c) => c.sandbox && c.status === "active");
  if (!connections.length) {
    const btn = h(
      "button",
      {
        type: "button",
        onclick: (e) =>
          withBusy(e.currentTarget, async () => {
            const c = await api(acc("/connections/sandbox"), { method: "POST", body: {} });
            sim.connectionId = c.id;
            route();
          }),
      },
      "Criar conta de teste",
    );
    main.replaceChildren(
      pageHead("Simulador", "Teste suas automações comentando como um seguidor, sem tocar no Instagram de verdade."),
      h(
        "div",
        { class: "block empty" },
        h("h2", null, "Crie uma conta de teste para começar"),
        h("p", { class: "muted" }, "Ela funciona como um perfil do Instagram, mas só recebe comentários daqui e não envia nada para ninguém."),
        btn,
      ),
    );
    return;
  }

  if (!connections.some((c) => c.id === sim.connectionId)) sim.connectionId = connections[0].id;
  sim.username = safeGet(localStorage, SIM_USERNAME_KEY) ?? sim.username;
  sim.signature = "";
  const store = () => connections.find((c) => c.id === sim.connectionId);

  const commentsList = h("ul", { class: "comments", "aria-label": "Comentários do post", "aria-live": "polite" });
  const thread = h("div", { class: "thread", "aria-live": "polite" });
  const phoneHeadName = h("span");
  const phoneCaption = h("p", { class: "phone-caption" });
  const postHeadName = h("span");

  // barra superior
  const connSelect = h(
    "select",
    {
      id: "sim-conn",
      onchange: (e) => {
        sim.connectionId = e.target.value;
        refresh(true);
      },
    },
    connections.map((c) => h("option", { value: c.id, selected: c.id === sim.connectionId }, `@${c.username}`)),
  );
  const mediaInput = h("input", {
    id: "sim-media",
    value: sim.mediaId,
    onchange: (e) => {
      sim.mediaId = e.target.value.trim() || "post-de-teste";
      mediaTitle.textContent = sim.mediaId;
      refresh(true);
    },
  });
  const mediaTitle = h("span", null, sim.mediaId);

  // comentário
  const userInput = h("input", {
    id: "sim-user",
    value: sim.username,
    "aria-label": "Comentar como (usuário)",
    pattern: "[A-Za-z0-9._]{1,30}",
    required: true,
    onchange: (e) => {
      sim.username = e.target.value.trim();
      safeSet(localStorage, SIM_USERNAME_KEY, sim.username);
      refresh(true);
    },
  });
  const commentInput = h("input", { id: "sim-comment", "aria-label": "Comentário", placeholder: "Escreva um comentário…", required: true });
  const commentForm = h(
    "form",
    {
      class: "composer",
      onsubmit: async (e) => {
        e.preventDefault();
        sim.username = userInput.value.trim();
        safeSet(localStorage, SIM_USERNAME_KEY, sim.username);
        await withBusy(e.submitter, async () => {
          await api(acc("/simulate/comment"), {
            method: "POST",
            body: { connection_id: sim.connectionId, username: sim.username, text: commentInput.value, media_id: sim.mediaId },
          });
          commentInput.value = "";
          refresh(true);
        });
      },
    },
    h("div", { class: "at-field" }, userInput),
    commentInput,
    h("button", { type: "submit" }, "Comentar"),
  );

  // direct
  const dmInput = h("input", { "aria-label": "Mensagem no direct", placeholder: "Mensagem…", required: true });
  const dmForm = h(
    "form",
    {
      class: "phone-composer",
      onsubmit: async (e) => {
        e.preventDefault();
        await sendAsUser(e.submitter, { text: dmInput.value });
        dmInput.value = "";
      },
    },
    dmInput,
    h("button", { type: "submit" }, "Enviar"),
  );

  async function sendAsUser(button, { text, quick_reply_payload }) {
    await withBusy(button, async () => {
      await api(acc("/simulate/message"), {
        method: "POST",
        body: { connection_id: sim.connectionId, username: sim.username, text, quick_reply_payload },
      });
      refresh(true);
    });
  }

  function paint() {
    const owner = store()?.username ?? "loja";
    const igsid = `sim-${sim.username.toLowerCase()}`;
    postHeadName.textContent = `@${owner}`;
    phoneHeadName.textContent = `@${owner}`;
    phoneCaption.textContent = `Direct visto por @${sim.username}`;

    // Comentários do post atual, com as respostas públicas logo abaixo de cada um.
    const asc = [...sim.messages].reverse();
    const replies = new Map();
    for (const m of asc) {
      if (m.kind === "comment_reply") {
        const list = replies.get(m.payload?.comment_id) ?? [];
        list.push(m);
        replies.set(m.payload?.comment_id, list);
      }
    }
    commentsList.replaceChildren(
      ...asc
        .filter((m) => m.kind === "comment" && (m.payload?.media_id ?? "post-de-teste") === sim.mediaId)
        .flatMap((c) => [
          commentItem(c.username, c.payload?.text ?? "", c.created_at, false),
          ...(replies.get(c.external_message_id) ?? []).map((r) =>
            commentItem(owner, r.payload?.text ?? "", r.created_at, true, r.status),
          ),
        ]),
    );
    commentsList.scrollTop = commentsList.scrollHeight;

    // Conversa no direct do usuário simulado.
    const dms = asc.filter((m) => m.igsid === igsid && (m.kind === "dm" || m.kind === "private_reply"));
    const lastOutbound = dms.findLast((m) => m.direction === "outbound" && m.status === "sent");
    const answeredAfter = lastOutbound && dms.some((m) => m.direction === "inbound" && m.created_at > lastOutbound.created_at);
    thread.replaceChildren(
      ...(dms.length
        ? dms.map((m) => dmItem(m, m === lastOutbound && !answeredAfter))
        : [h("p", { class: "thread-empty" }, `Quando @${sim.username} comentar uma palavra-chave, a resposta aparece aqui.`)]),
    );
    thread.scrollTop = thread.scrollHeight;
  }

  function commentItem(username, text, when, isReply, status) {
    return h(
      "li",
      { class: `comment ${isReply ? "reply" : ""}` },
      h("span", { class: `avatar ${isReply ? "" : "user"}`, "aria-hidden": "true" }, initials(username)),
      h(
        "p",
        { class: "body" },
        h("span", { class: "who" }, `@${username ?? "?"}`),
        text,
        h("span", { class: "when" }, status === "failed" ? "Falhou ao responder" : ago(when)),
      ),
    );
  }

  function dmItem(m, quickRepliesActive) {
    if (m.status === "blocked" || m.status === "failed") {
      return h(
        "p",
        { class: `note ${m.status}` },
        m.status === "blocked" ? `Não enviada: ${m.error ?? "fora da janela de 24h"}` : `Falhou: ${m.error ?? "erro do Instagram"}`,
      );
    }
    const p = m.payload ?? {};
    if (m.direction === "inbound") {
      return h("div", { class: "msg me" }, h("div", { class: "bubble" }, p.text || "(botão tocado)"));
    }
    const msg = p.message ?? p;
    const tpl = msg.attachment?.type === "template" ? msg.attachment.payload : null;
    const image = msg.attachment?.type === "image" ? msg.attachment.payload?.url : null;
    const text = msg.text ?? tpl?.text ?? (image ? "[imagem]" : "");
    const quick = msg.quick_replies ?? [];
    return h(
      "div",
      { class: "msg them" },
      m.kind === "private_reply" ? h("span", { class: "context" }, "Respondeu ao seu comentário") : null,
      h("div", { class: "bubble" }, text),
      tpl?.buttons?.length
        ? h(
            "div",
            { class: "bubble-buttons" },
            tpl.buttons.map((b) =>
              safeHref(b.url)
                ? h("a", { href: safeHref(b.url), target: "_blank", rel: "noopener noreferrer" }, b.title)
                : h("span", null, b.title),
            ),
          )
        : null,
      quick.length && quickRepliesActive
        ? h(
            "div",
            { class: "quick-replies" },
            quick.map((q) =>
              h(
                "button",
                { type: "button", onclick: (e) => sendAsUser(e.currentTarget, { text: q.title, quick_reply_payload: q.payload }) },
                q.title,
              ),
            ),
          )
        : null,
    );
  }

  async function refresh(force) {
    const messages = await api(acc(`/messages?connection_id=${encodeURIComponent(sim.connectionId)}&limit=300`));
    const signature = messages.map((m) => `${m.id}:${m.status}`).join("|");
    if (!force && signature === sim.signature) return;
    sim.signature = signature;
    sim.messages = messages;
    paint();
  }

  main.replaceChildren(
    pageHead("Simulador", "Comente como um seguidor e veja a automação responder no post e no direct."),
    h(
      "div",
      { class: "sim-bar" },
      h("label", { for: "sim-conn" }, "Conta de teste", connSelect),
      h("label", { for: "sim-media" }, "ID do post", mediaInput),
      h("span", { class: "sim-note" }, "Modo de teste: nada é enviado ao Instagram"),
    ),
    h(
      "div",
      { class: "stage" },
      h(
        "section",
        { class: "post", "aria-label": "Post" },
        h("div", { class: "post-head" }, h("span", { class: "avatar", "aria-hidden": "true" }, "IG"), postHeadName),
        h("div", { class: "post-media" }, h("div", null, mediaTitle, h("small", null, "Post de teste"))),
        commentsList,
        commentForm,
      ),
      h(
        "div",
        { class: "phone-wrap" },
        h(
          "section",
          { class: "phone", "aria-label": "Direct" },
          h(
            "div",
            { class: "phone-head" },
            h("span", { class: "avatar", "aria-hidden": "true" }, "IG"),
            h("div", null, phoneHeadName, h("small", null, "Direct")),
          ),
          thread,
          dmForm,
        ),
        phoneCaption,
      ),
    ),
  );

  await refresh(true);
  // O worker processa em segundo plano: atualiza a conversa a cada 1,2 s enquanto o simulador estiver aberto.
  const timer = setInterval(() => refresh(false).catch(() => {}), 1200);
  state.stopPolling = () => clearInterval(timer);
}

// ---------------------------------------------------------------- contatos

async function renderContacts(main) {
  const contacts = await api(acc("/contacts"));
  main.replaceChildren(
    pageHead("Contatos", "Pessoas que comentaram ou mandaram mensagem, com as tags e os campos que as automações gravaram."),
    contacts.length
      ? h(
          "div",
          { class: "block table-wrap" },
          h(
            "table",
            null,
            h("thead", null, h("tr", null, ["Contato", "Tags", "Campos", "Última mensagem", "Conversa aberta até", "Desde"].map((t) => h("th", { scope: "col" }, t)))),
            h(
              "tbody",
              null,
              contacts.map((c) => {
                const fields = Object.entries(c.fields ?? {});
                const windowEnd = c.last_inbound_at ? new Date(new Date(c.last_inbound_at).getTime() + 86400000) : null;
                return h(
                  "tr",
                  null,
                  h("td", null, h("strong", null, `@${c.username ?? c.igsid ?? "?"}`)),
                  h("td", null, (c.tags ?? []).length ? c.tags.map((t) => h("span", { class: "chip" }, t)) : h("span", { class: "muted" }, "—")),
                  h("td", null, fields.length ? fields.map(([k, v]) => h("div", null, `${k}: ${v}`)) : h("span", { class: "muted" }, "—")),
                  h("td", { class: "content" }, c.last_input_text ?? h("span", { class: "muted" }, "—")),
                  h("td", null, windowEnd && windowEnd > new Date() ? dateTime(windowEnd) : h("span", { class: "muted" }, "Fechada")),
                  h("td", null, dateTime(c.created_at)),
                );
              }),
            ),
          ),
        )
      : h(
          "div",
          { class: "block empty" },
          h("h2", null, "Nenhum contato ainda"),
          h("p", { class: "muted" }, "Os contatos aparecem aqui quando alguém comenta num post ou manda uma DM. Use o simulador para gerar os primeiros."),
          h("a", { class: "button", href: "#/simulador" }, "Abrir simulador"),
        ),
  );
}

// ---------------------------------------------------------------- mensagens

const KIND = { comment: "Comentário", comment_reply: "Resposta pública", private_reply: "Resposta privada", dm: "Direct" };
const STATUS = {
  received: ["Recebida", ""],
  sent: ["Enviada", "ok"],
  failed: ["Falhou", "bad"],
  blocked: ["Bloqueada", "test"],
  pending: ["Enviando", ""],
};

function kindLabel(m) {
  if (m.kind === "dm") return m.direction === "inbound" ? "Direct recebido" : "Direct enviado";
  return KIND[m.kind] ?? m.kind;
}

function messageText(m) {
  const p = m.payload ?? {};
  if (m.kind === "comment" || m.kind === "comment_reply" || m.direction === "inbound") return p.text ?? "";
  const msg = p.message ?? p;
  const tpl = msg.attachment?.type === "template" ? msg.attachment.payload : null;
  const parts = [msg.text ?? tpl?.text ?? (msg.attachment?.type === "image" ? "[imagem]" : "")];
  if (tpl?.buttons?.length) parts.push(`[${tpl.buttons.map((b) => b.title).join("] [")}]`);
  if (msg.quick_replies?.length) parts.push(`(${msg.quick_replies.map((q) => q.title).join(", ")})`);
  return parts.filter(Boolean).join(" ");
}

async function renderMessages(main) {
  const messages = await api(acc("/messages?limit=200"));
  main.replaceChildren(
    pageHead("Mensagens", "Tudo o que entrou e saiu: comentários, respostas e DMs, com o motivo quando algo não foi enviado.",
      h("button", { type: "button", class: "secondary", onclick: () => route() }, "Atualizar")),
    messages.length
      ? h(
          "div",
          { class: "block table-wrap" },
          h(
            "table",
            null,
            h("thead", null, h("tr", null, ["Quando", "Contato", "Tipo", "Situação", "Conteúdo"].map((t) => h("th", { scope: "col" }, t)))),
            h(
              "tbody",
              null,
              messages.map((m) => {
                const [label, tone] = STATUS[m.status] ?? [m.status, ""];
                return h(
                  "tr",
                  null,
                  h("td", { title: dateTime(m.created_at) }, ago(m.created_at)),
                  h("td", null, m.username ? `@${m.username}` : (m.igsid ?? "—")),
                  h("td", null, kindLabel(m)),
                  h("td", null, h("span", { class: `pill ${tone}` }, label)),
                  h(
                    "td",
                    { class: "content" },
                    messageText(m),
                    m.error ? h("div", { class: "error-text small" }, m.error) : null,
                  ),
                );
              }),
            ),
          ),
        )
      : h(
          "div",
          { class: "block empty" },
          h("h2", null, "Nenhuma mensagem ainda"),
          h("p", { class: "muted" }, "As mensagens aparecem aqui assim que a primeira automação responder alguém."),
        ),
  );
}

// ---------------------------------------------------------------- equipe (só administradores)

const ROLE_LABEL = { owner: "Administrador", member: "Membro" };

function accountChecklist(selected) {
  return h(
    "fieldset",
    { class: "checklist" },
    h("legend", null, "Contas que pode acessar"),
    h("p", { class: "muted small" }, "Administradores veem todas as contas, marcadas ou não."),
    state.accounts.map((a) =>
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "account_ids", value: a.id, checked: selected.includes(a.id) }), a.name),
    ),
  );
}

async function renderTeam(main) {
  const users = await api("/api/users");
  const accountName = new Map(state.accounts.map((a) => [a.id, a.name]));
  const editDialog = h("dialog", { "aria-label": "Editar pessoa" });

  function openEdit(u) {
    const errors = h("p", { class: "form-errors", role: "alert" });
    const isSelf = u.id === state.user.id;
    const form = h(
      "form",
      {
        method: "dialog",
        onsubmit: async (e) => {
          if (e.submitter?.value === "cancel") return;
          e.preventDefault();
          errors.textContent = "";
          const d = new FormData(form);
          const body = {
            name: String(d.get("name")).trim(),
            role: isSelf ? undefined : String(d.get("role")),
            account_ids: d.getAll("account_ids").map(String),
          };
          const newPassword = String(d.get("password") ?? "");
          if (newPassword) body.password = newPassword;
          await withBusy(e.submitter, async () => {
            try {
              await api(`/api/users/${u.id}`, { method: "PATCH", body });
            } catch (err) {
              errors.textContent = err.message;
              return;
            }
            editDialog.close();
            toast(newPassword ? `Dados de ${body.name} salvos e senha redefinida` : `Dados de ${body.name} salvos`);
            route();
          });
        },
      },
      h("h2", null, `Editar ${u.name}`),
      h("label", null, "Nome", h("input", { name: "name", value: u.name, required: true })),
      isSelf
        ? h("p", { class: "muted small" }, "Você não pode mudar o próprio papel.")
        : h(
            "label",
            null,
            "Papel",
            h(
              "select",
              { name: "role" },
              Object.entries(ROLE_LABEL).map(([v, l]) => h("option", { value: v, selected: u.role === v }, l)),
            ),
          ),
      accountChecklist(u.account_ids ?? []),
      h(
        "label",
        null,
        "Nova senha (opcional)",
        h("span", { class: "hint" }, "Preencha só para redefinir. A pessoa será desconectada dos aparelhos."),
        h("input", { name: "password", type: "password", autocomplete: "new-password", minlength: 8 }),
      ),
      errors,
      h(
        "div",
        { class: "actions" },
        h("button", { type: "submit", value: "save" }, "Salvar"),
        h("button", { type: "submit", value: "cancel", class: "secondary", formnovalidate: true }, "Cancelar"),
      ),
    );
    editDialog.replaceChildren(form);
    editDialog.showModal();
  }

  async function toggleDisabled(button, u) {
    const disabled = !u.disabled;
    await withBusy(button, async () => {
      await api(`/api/users/${u.id}`, { method: "PATCH", body: { disabled } });
      toast(disabled ? `Acesso de ${u.name} desativado` : `Acesso de ${u.name} reativado`);
      route();
    });
  }

  const list = h(
    "div",
    { class: "block table-wrap" },
    h(
      "table",
      null,
      h("thead", null, h("tr", null, ["Pessoa", "Papel", "Contas", "Último acesso", "Situação", ""].map((t) => h("th", { scope: "col" }, t)))),
      h(
        "tbody",
        null,
        users.map((u) =>
          h(
            "tr",
            null,
            h("td", null, h("strong", null, u.name), h("div", { class: "muted" }, u.email)),
            h("td", null, ROLE_LABEL[u.role] ?? u.role),
            h(
              "td",
              null,
              u.role === "owner"
                ? h("span", { class: "muted" }, "Todas")
                : (u.account_ids ?? []).length
                  ? u.account_ids.map((id) => h("span", { class: "chip" }, accountName.get(id) ?? "?"))
                  : h("span", { class: "muted" }, "Nenhuma"),
            ),
            h("td", null, u.last_login_at ? ago(u.last_login_at) : h("span", { class: "muted" }, "Nunca entrou")),
            h("td", null, h("span", { class: `pill ${u.disabled ? "bad" : "ok"}` }, u.disabled ? "Desativado" : "Ativo")),
            h(
              "td",
              { class: "row-actions" },
              h("button", { type: "button", class: "secondary", onclick: () => openEdit(u) }, "Editar"),
              u.id === state.user.id
                ? null
                : h(
                    "button",
                    { type: "button", class: "quiet", onclick: (e) => toggleDisabled(e.currentTarget, u) },
                    u.disabled ? "Reativar" : "Desativar",
                  ),
            ),
          ),
        ),
      ),
    ),
  );

  const errors = h("p", { class: "form-errors", role: "alert" });
  const form = h(
    "form",
    {
      class: "form-body",
      onsubmit: async (e) => {
        e.preventDefault();
        errors.textContent = "";
        const d = new FormData(form);
        const body = {
          name: String(d.get("name")).trim(),
          email: String(d.get("email")).trim(),
          password: String(d.get("password")),
          role: String(d.get("role")),
          account_ids: d.getAll("account_ids").map(String),
        };
        await withBusy(e.submitter, async () => {
          try {
            await api("/api/users", { method: "POST", body });
          } catch (err) {
            errors.textContent = err.message;
            return;
          }
          toast(`${body.name} foi adicionado. Passe o e-mail e a senha para a pessoa entrar.`);
          route();
        });
      },
    },
    h(
      "fieldset",
      null,
      h(
        "div",
        { class: "grid-2" },
        h("label", null, "Nome", h("input", { name: "name", required: true, autocomplete: "off" })),
        h("label", null, "E-mail", h("input", { name: "email", type: "email", required: true, autocomplete: "off" })),
        h(
          "label",
          null,
          "Senha inicial",
          h("span", { class: "hint" }, "Pelo menos 8 caracteres. A pessoa pode trocar depois."),
          h("input", { name: "password", type: "password", minlength: 8, required: true, autocomplete: "new-password" }),
        ),
        h(
          "label",
          null,
          "Papel",
          h("span", { class: "hint" }, "Membros só veem as contas marcadas abaixo."),
          h("select", { name: "role" }, h("option", { value: "member" }, "Membro"), h("option", { value: "owner" }, "Administrador")),
        ),
      ),
      accountChecklist([]),
    ),
    errors,
    h("div", null, h("button", { type: "submit" }, "Adicionar pessoa")),
  );

  main.replaceChildren(
    pageHead("Equipe", "Quem pode entrar no painel e quais contas cada pessoa pode ver e operar."),
    list,
    h("details", { class: "form", open: users.length <= 1 }, h("summary", null, "Adicionar pessoa"), form),
    editDialog,
  );
}

// ---------------------------------------------------------------- início

window.addEventListener("hashchange", () => {
  if (document.getElementById("main")) route();
});
boot();
