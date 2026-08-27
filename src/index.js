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
const ACCOUNTS_CACHE_KEY = "dashboard:accounts_cache"; // guardado en GUARDIAN_KV

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

    // Ruta de debug: fuerza una corrida del cron ahora mismo, sin esperar
    // los 15 minutos. Protegida por el mismo login del dashboard.
    if (url.pathname === "/debug/run-cron") {
      await checkForNewEntriesAndAlert(env);
      return new Response("Cron ejecutado manualmente. Revisá Telegram si había novedades.");
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

/** Lista todas las keys con un prefijo y devuelve {key, ...value} por cada una.
 * ⚠️ kv.list() consume el cupo de "list operations" (solo 1.000/día gratis,
 * MUCHO más bajo que los reads). No llamar esto en cada request del
 * dashboard — usar getCachedAccounts() en su lugar. */
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

/** Accounts vía un cache de UN solo key (get normal, no list). El cron
 * es el único que refresca este cache llamando refreshAccountsCache();
 * el dashboard en cada visita solo hace un get() barato. */
async function getCachedAccounts(env) {
  const raw = await env.GUARDIAN_KV.get(ACCOUNTS_CACHE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      // cache corrupto, seguimos al fallback de abajo
    }
  }
  // Primera vez que corre esto (todavía no hay cache) — hacemos el
  // list() una única vez y dejamos el cache armado para la próxima.
  const accounts = await listByPrefix(env.GUARDIAN_KV, "account:");
  await env.GUARDIAN_KV.put(ACCOUNTS_CACHE_KEY, JSON.stringify(accounts));
  return accounts;
}

async function refreshAccountsCache(env) {
  const accounts = await listByPrefix(env.GUARDIAN_KV, "account:");
  await env.GUARDIAN_KV.put(ACCOUNTS_CACHE_KEY, JSON.stringify(accounts));
  return accounts;
}

/** Trae visitas reales de Cloudflare Web Analytics (RUM) para un hostname,
 * de los últimos `days` días: total, por país, por día, por referrer
 * (de dónde vino la visita) y por hora del día (convertida a ART, UTC-3).
 * Requiere que Web Analytics esté habilitado para ese sitio en Cloudflare
 * (Pages → proyecto → Metrics → Enable Web Analytics), y los secrets
 * CF_API_TOKEN + CF_ACCOUNT_TAG. */
async function getWebAnalytics(env, requestHost, days = 7) {

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  // Usamos alias para pedir 4 agrupaciones distintas en una sola consulta,
  // en vez de combinar todas las dimensiones juntas (eso multiplicaría la
  // cantidad de grupos sin necesidad, ya que solo nos interesa cada
  // dimensión por separado).
  const query = `
    query WebAnalytics($accountTag: string!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          byCountry: rumPageloadEventsAdaptiveGroups(limit: 1000, filter: $filter) {
            sum { visits }
            dimensions { countryName }
          }
          byDay: rumPageloadEventsAdaptiveGroups(limit: 1000, filter: $filter) {
            sum { visits }
            dimensions { date }
          }
          byReferer: rumPageloadEventsAdaptiveGroups(limit: 1000, filter: $filter) {
            sum { visits }
            dimensions { refererHost }
          }
          byHour: rumPageloadEventsAdaptiveGroups(limit: 1000, filter: $filter) {
            sum { visits }
            dimensions { datetimeHour }
          }
          byDetail: rumPageloadEventsAdaptiveGroups(limit: 1000, filter: $filter) {
            sum { visits }
            dimensions { refererHost datetimeHour requestPath }
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: env.CF_ACCOUNT_TAG,
    filter: {
      AND: [
        { datetime_geq: start.toISOString(), datetime_leq: end.toISOString() },
        { requestHost }
      ]
    }
  };

  try {

    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.CF_API_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    });

    const json = await response.json();

    if (!response.ok || json.errors) {
      return { total: 0, byCountry: {}, byDay: {}, byReferer: {}, byHour: {}, error: json.errors ? JSON.stringify(json.errors) : "HTTP " + response.status };
    }

    const account = json?.data?.viewer?.accounts?.[0] || {};

    const byCountry = {};
    let total = 0;
    for (const g of account.byCountry || []) {
      const country = g.dimensions?.countryName || "??";
      byCountry[country] = (byCountry[country] || 0) + (g.sum?.visits || 0);
      total += g.sum?.visits || 0;
    }

    const byDay = {};
    for (const g of account.byDay || []) {
      const day = g.dimensions?.date || "??";
      byDay[day] = (byDay[day] || 0) + (g.sum?.visits || 0);
    }

    const byReferer = {};
    for (const g of account.byReferer || []) {
      // referrer vacío = entró directo (escribió la URL, marcador, app) — sin origen externo
      const referer = g.dimensions?.refererHost || "(directo / sin origen)";
      byReferer[referer] = (byReferer[referer] || 0) + (g.sum?.visits || 0);
    }

    // Cloudflare devuelve la hora en UTC — la convertimos a ART (UTC-3)
    // para que tenga sentido de un vistazo.
    const byHour = {};
    for (const g of account.byHour || []) {
      const utcHour = g.dimensions?.datetimeHour;
      if (utcHour === undefined || utcHour === null) continue;
      const localHour = ((Number(utcHour) - 3) % 24 + 24) % 24;
      byHour[localHour] = (byHour[localHour] || 0) + (g.sum?.visits || 0);
    }

    // Tabla simple: cada fila es una combinación real de origen + hora + URL
    const detail = [];
    for (const g of account.byDetail || []) {
      const utcHour = g.dimensions?.datetimeHour;
      const localHour = (utcHour === undefined || utcHour === null)
        ? null
        : ((Number(utcHour) - 3) % 24 + 24) % 24;
      detail.push({
        referer: g.dimensions?.refererHost || "(directo / sin origen)",
        hour: localHour,
        path: g.dimensions?.requestPath || "/",
        visits: g.sum?.visits || 0
      });
    }
    detail.sort((a, b) => b.visits - a.visits);

    return { total, byCountry, byDay, byReferer, byHour, detail: detail.slice(0, 30) };

  } catch (err) {
    return { total: 0, byCountry: {}, byDay: {}, byReferer: {}, byHour: {}, error: err.message };
  }

}

async function gatherAllData(env) {
  const [leads, watchlist, accounts, radarVisits, guardianVisits] = await Promise.all([
    getArrayKey(env.RADAR_KV, "leads"),
    getArrayKey(env.GUARDIAN_KV, "watchlist"),
    getCachedAccounts(env),
    getWebAnalytics(env, "crypto-radar-1c9.pages.dev", 7),
    getWebAnalytics(env, "wallet-guardian.pages.dev", 7),
  ]);

  // Leads: más recientes primero (sí tienen ts)
  leads.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // Accounts: más recientes primero (createdAt)
  accounts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return {
    radar: { leads, visits: radarVisits },
    guardian: { watchlist, accounts, visits: guardianVisits },
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

  // El cron es el único lugar donde se refresca el cache de accounts
  // (esto SÍ usa list(), pero solo 96 veces/día con el cron cada 15 min,
  // muy por debajo del límite gratis de 1.000 list ops/día).
  await refreshAccountsCache(env).catch(() => {});

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

// Corta cualquier texto sospechosamente largo (spam, bugs, inputs sin
// validar) para que no rompa el layout del dashboard.
function truncate(str, max = 120){
  if (typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) + "…" : str;
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

const COUNTRY_FLAGS = {}; // Cloudflare ya te da el código ISO (AR, US, BR...), suficiente para mostrar

function renderVisitsCard(title, visits){
  if (visits.error) {
    return \`<div class="card">
        <h2>\${title}</h2>
        <div class="empty">No se pudo consultar Cloudflare todavía.</div>
        <div class="note">\${visits.error}</div>
      </div>\`;
  }

  // Últimos 7 días en orden cronológico, con 0 para los días sin datos
  const days = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const dayValues = days.map(d => (visits.byDay || {})[d] || 0);
  const maxDay = Math.max(1, ...dayValues);

  const barChart = \`<div style="display:flex;align-items:flex-end;gap:6px;height:60px;margin:.6rem 0 1rem">
    \${days.map((d,i) => {
      const h = Math.round((dayValues[i] / maxDay) * 50) + 2;
      const label = d.slice(5).replace("-", "/"); // MM/DD
      return \`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div title="\${d}: \${dayValues[i]} visitas" style="width:100%;background:#4f7cff;border-radius:3px 3px 0 0;height:\${h}px"></div>
        <div style="font-size:.6rem;color:#666">\${label}</div>
      </div>\`;
    }).join("")}
  </div>\`;

  const countryEntries = Object.entries(visits.byCountry || {}).sort((a,b) => b[1]-a[1]).slice(0,8);
  const rows = countryEntries.length
    ? countryEntries.map(([country,count]) =>
        \`<div class="item">\${country} <span class="meta">\${count} visita\${count===1?"":"s"}</span></div>\`
      ).join("")
    : '<div class="empty">Sin visitas registradas todavía</div>';

  return \`<div class="card">
      <h2>\${title} <span class="badge">\${visits.total || 0}</span></h2>
      <div class="note" style="margin-bottom:.3rem">Últimos 7 días (datos reales de Cloudflare Web Analytics)</div>
      \${barChart}
      \${rows}
    </div>\`;
}

function renderOriginHourCard(title, visits){
  if (visits.error) return ""; // el error ya se muestra en la card de Visitantes de al lado

  const detail = visits.detail || [];

  const rows = detail.length
    ? detail.map(d =>
        \`<div class="item" style="display:flex;justify-content:space-between;gap:.5rem">
          <span>\${d.referer}</span>
          <span class="meta">\${d.hour !== null ? d.hour + "hs" : "?"}</span>
          <span class="meta" style="flex:1;text-align:right">\${truncate(d.path, 40)}</span>
          <span class="badge" style="flex-shrink:0">\${d.visits}</span>
        </div>\`
      ).join("")
    : '<div class="empty">Sin datos todavía</div>';

  return \`<div class="card">
      <h2>🌐 Origen y horario — \${title}</h2>
      <div class="note" style="margin-bottom:.3rem">Horario ART (UTC-3) · últimos 7 días</div>
      <div class="item" style="display:flex;justify-content:space-between;gap:.5rem;font-size:.7rem;color:#666;border-top:none">
        <span>Origen</span><span>Hora</span><span style="flex:1;text-align:right">URL</span><span style="flex-shrink:0">Visitas</span>
      </div>
      \${rows}
    </div>\`;
}

async function load(){
  document.getElementById("updated").textContent = "Actualizando...";
  const res = await fetch("/api/data");
  const data = await res.json();
  const grid = document.getElementById("grid");

  grid.innerHTML =
    renderCard("🎯 Leads PRO — Crypto Radar", data.radar.leads,
      l => \`\${truncate(l.email) || "(sin email)"} — \${truncate(l.interest) || "?"}<div class="meta">\${fmtDate(l.ts)}</div>\`) +

    renderCard("🔑 Pedidos API Key — Crypto Radar", [],
      () => "", "No se guarda en KV todavía — llega solo por email de PayPal.") +

    renderCard("🛡️ Wallets registradas — Wallet Guardian", data.guardian.watchlist,
      w => \`\${truncate(w.address)}<div class="meta">\${truncate(w.email) || "(sin email)"}</div>\`) +

    renderCard("💳 Cuentas/Planes — Wallet Guardian", data.guardian.accounts,
      a => \`Plan: \${truncate(a.plan) || "?"}<div class="meta">\${fmtDate(a.createdAt)}</div>\`) +

    renderVisitsCard("📈 Visitantes — Crypto Radar", data.radar.visits) +
    renderVisitsCard("📈 Visitantes — Wallet Guardian", data.guardian.visits) +

    renderOriginHourCard("Crypto Radar", data.radar.visits) +
    renderOriginHourCard("Wallet Guardian", data.guardian.visits);

  document.getElementById("updated").textContent =
    "Última actualización: " + new Date(data.generated_at).toLocaleString("es-AR");
}

load();
setInterval(load, 300000); // 5 minutos — no hace falta más seguido, y cuida el cupo gratis de Cloudflare
</script>
</body></html>`;
}
