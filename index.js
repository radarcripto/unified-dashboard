/**
 * UNIFIED DASHBOARD — Crypto Radar + Wallet Guardian
 * ---------------------------------------------------
 * Estructura real de los KV (confirmada por inspección):
 *
 *   radar-kv:
 *     - "leads"      -> UN array de leads: [{email, interest, ts}, ...]
 *     - (sin registro de pedidos de API key todavía — solo llega por
 *        email de PayPal, no hay nada que leer acá por ahora)
 *
 *   wallet-guardian-kv:
 *     - "watchlist"        -> UN array de wallets: [{address, email}, ...]
 *     - "account:<uuid>"   -> prefijo, uno por cuenta: {plan, createdAt}
 *
 * Como "watchlist" no trae timestamp confiable por item, la detección de
 * "nuevo" para wallets se hace por DIFF de direcciones contra la última
 * corrida (no por fecha). Para "leads" sí usamos el campo ts.
 */

const STATE_KEY = "dashboard:cron_state"; // guardado en RADAR_KV

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/login") {
      return handleLogin(request, env);
    }
    if (!isAuthenticated(request, env)) {
      return new Response(loginPageHtml(), {
        status: 401,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/data") {
      const data = await gatherAllData(env);
      return Response.json(data);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(dashboardHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkForNewEntriesAndAlert(env));
  },
};

// ─────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────

function isAuthenticated(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  return cookie.includes(`dash_session=${env.DASH_PASSWORD_HASH}`);
}

async function handleLogin(request, env) {
  if (request.method === "POST") {
    const form = await request.formData();
    const pass = form.get("password");
    if (pass === env.DASH_PASSWORD) {
      const headers = new Headers();
      headers.set("Location", "/");
      headers.set(
        "Set-Cookie",
        `dash_session=${env.DASH_PASSWORD_HASH}; Path=/; HttpOnly; Max-Age=604800`
      );
      return new Response(null, { status: 302, headers });
    }
    return new Response(loginPageHtml("Password incorrecta"), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(loginPageHtml(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ─────────────────────────────────────────────────────────────────────
// DATA GATHERING
// ─────────────────────────────────────────────────────────────────────

/** Lee una key única que contiene un array JSON. Devuelve [] si no existe. */
async function getArrayKey(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Lista todas las keys con un prefijo y devuelve {key, ...value} por cada una. */
async function listByPrefix(kv, prefix) {
  const results = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        value = { raw };
      }
      results.push({ key: key.name, id: key.name.slice(prefix.length), ...value });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return results;
}

async function gatherAllData(env) {
  const [leads, watchlist, accounts] = await Promise.all([
    getArrayKey(env.RADAR_KV, "leads"),
    getArrayKey(env.GUARDIAN_KV, "watchlist"),
    listByPrefix(env.GUARDIAN_KV, "account:"),
  ]);

  // Leads: más recientes primero (sí tienen ts)
  leads.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // Accounts: más recientes primero (createdAt)
  accounts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return {
    radar: { leads },
    guardian: { watchlist, accounts },
    generated_at: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// CRON: detectar nuevas entradas y avisar por Telegram
// ─────────────────────────────────────────────────────────────────────

async function loadState(env) {
  const raw = await env.RADAR_KV.get(STATE_KEY);
  if (!raw) return { lastLeadsTs: 0, knownWallets: [], knownAccountIds: [] };
  try {
    return JSON.parse(raw);
  } catch {
    return { lastLeadsTs: 0, knownWallets: [], knownAccountIds: [] };
  }
}

async function saveState(env, state) {
  await env.RADAR_KV.put(STATE_KEY, JSON.stringify(state));
}

async function checkForNewEntriesAndAlert(env) {
  const state = await loadState(env);
  const data = await gatherAllData(env);

  const messages = [];

  // ── Leads nuevos (por ts) ──
  const newLeads = data.radar.leads.filter((l) => (l.ts || 0) > state.lastLeadsTs);
  for (const l of newLeads) {
    messages.push(`🎯 *Lead nuevo (Crypto Radar)*\n${l.email || "(sin email)"} — interés: ${l.interest || "?"}`);
  }
  const maxLeadTs = data.radar.leads.reduce((m, l) => Math.max(m, l.ts || 0), state.lastLeadsTs);

  // ── Wallets nuevas (por diff de direcciones) ──
  const knownSet = new Set(state.knownWallets);
  const newWallets = data.guardian.watchlist.filter((w) => w.address && !knownSet.has(w.address));
  for (const w of newWallets) {
    messages.push(`🛡️ *Wallet nueva registrada (Wallet Guardian)*\n${w.address}\n${w.email || "(sin email)"}`);
  }

  // ── Cuentas/suscripciones nuevas (por diff de id) ──
  const knownAccSet = new Set(state.knownAccountIds);
  const newAccounts = data.guardian.accounts.filter((a) => !knownAccSet.has(a.id));
  for (const a of newAccounts) {
    messages.push(`💳 *Cuenta nueva (Wallet Guardian)*\nPlan: ${a.plan || "?"}`);
  }

  if (messages.length > 0) {
    await sendTelegramMessage(env, `📬 *${messages.length} novedad(es)*\n\n${messages.join("\n\n")}`);
  }

  await saveState(env, {
    lastLeadsTs: maxLeadTs,
    knownWallets: data.guardian.watchlist.map((w) => w.address).filter(Boolean),
    knownAccountIds: data.guardian.accounts.map((a) => a.id),
  });
}

async function sendTelegramMessage(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
  });
}

// ─────────────────────────────────────────────────────────────────────
// HTML
// ─────────────────────────────────────────────────────────────────────

function loginPageHtml(error = "") {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Dashboard - Login</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;
       align-items:center;justify-content:center;height:100vh;margin:0}
  form{background:#1a1d24;padding:2rem;border-radius:12px;width:280px}
  input{width:100%;padding:.6rem;margin-top:.5rem;border-radius:6px;border:1px solid #333;
        background:#0f1115;color:#fff;box-sizing:border-box}
  button{width:100%;margin-top:1rem;padding:.6rem;border:none;border-radius:6px;
         background:#4f7cff;color:#fff;font-weight:600;cursor:pointer}
  .error{color:#ff6b6b;font-size:.9rem;margin-top:.5rem}
</style></head>
<body>
  <form method="POST" action="/login">
    <h2>🔐 Dashboard</h2>
    <input type="password" name="password" placeholder="Password" autofocus required>
    <button type="submit">Entrar</button>
    ${error ? `<div class="error">${error}</div>` : ""}
  </form>
</body></html>`;
}

function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Dashboard Unificado</title>
<style>
  :root{color-scheme:dark}
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:2rem}
  h1{font-size:1.4rem;margin-bottom:.2rem}
  .sub{color:#888;margin-bottom:2rem;font-size:.85rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1.2rem}
  .card{background:#1a1d24;border-radius:12px;padding:1.2rem}
  .card h2{font-size:1rem;margin:0 0 .8rem;display:flex;justify-content:space-between}
  .badge{background:#4f7cff;border-radius:20px;padding:.1rem .6rem;font-size:.75rem}
  .item{border-top:1px solid #2a2d35;padding:.6rem 0;font-size:.85rem;word-break:break-all}
  .item:first-child{border-top:none}
  .item .meta{color:#888;font-size:.75rem}
  .empty{color:#666;font-size:.85rem;padding:.5rem 0}
  .refresh{position:fixed;top:1.5rem;right:2rem;background:#2a2d35;border:none;color:#fff;
           padding:.5rem 1rem;border-radius:8px;cursor:pointer}
  .note{color:#666;font-size:.75rem;margin-top:.5rem;font-style:italic}
</style></head>
<body>
  <button class="refresh" onclick="load()">↻ Actualizar</button>
  <h1>📊 Dashboard Unificado</h1>
  <div class="sub" id="updated">Cargando...</div>
  <div class="grid" id="grid"></div>

<script>
function fmtDate(ts){
  if(!ts) return "sin fecha";
  return new Date(ts).toLocaleString("es-AR");
}

function renderCard(title, items, renderItem, note){
  const rows = items.length
    ? items.map(it => \`<div class="item">\${renderItem(it)}</div>\`).join("")
    : '<div class="empty">Sin registros todavía</div>';
  return \`<div class="card">
      <h2>\${title} <span class="badge">\${items.length}</span></h2>
      \${rows}
      \${note ? \`<div class="note">\${note}</div>\` : ""}
    </div>\`;
}

async function load(){
  document.getElementById("updated").textContent = "Actualizando...";
  const res = await fetch("/api/data");
  const data = await res.json();
  const grid = document.getElementById("grid");

  grid.innerHTML =
    renderCard("🎯 Leads PRO — Crypto Radar", data.radar.leads,
      l => \`\${l.email || "(sin email)"} — \${l.interest || "?"}<div class="meta">\${fmtDate(l.ts)}</div>\`) +

    renderCard("🔑 Pedidos API Key — Crypto Radar", [],
      () => "", "No se guarda en KV todavía — llega solo por email de PayPal.") +

    renderCard("🛡️ Wallets registradas — Wallet Guardian", data.guardian.watchlist,
      w => \`\${w.address}<div class="meta">\${w.email || "(sin email)"}</div>\`) +

    renderCard("💳 Cuentas/Planes — Wallet Guardian", data.guardian.accounts,
      a => \`Plan: \${a.plan || "?"}<div class="meta">\${fmtDate(a.createdAt)}</div>\`);

  document.getElementById("updated").textContent =
    "Última actualización: " + new Date(data.generated_at).toLocaleString("es-AR");
}

load();
setInterval(load, 60000);
</script>
</body></html>`;
}
