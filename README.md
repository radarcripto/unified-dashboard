# Unified Dashboard — Crypto Radar + Wallet Guardian

Panel único (web + alertas Telegram) para ver leads, wallets registradas
y cuentas/planes de ambos proyectos, sin entrar a la consola de
Cloudflare a buscar en cada KV.

## Estructura real de datos (ya confirmada)
 
- `radar-kv` → key `leads`: un único array `[{email, interest, ts}, ...]`
- `wallet-guardian-kv` → key `watchlist`: un único array `[{address, email}, ...]`
- `wallet-guardian-kv` → prefijo `account:<uuid>`: uno por cuenta, `{plan, createdAt}`

**Pendiente / no incluido:** los pedidos de API key de Crypto Radar
(pagos vía PayPal) no se guardan en ningún KV hoy — solo llega el email
de PayPal. El dashboard muestra esa sección vacía con una nota. Si más
adelante querés verlos acá también, hay que agregar un webhook de
PayPal (IPN) que escriba un registro en `radar-kv` cada vez que se
acredita un pago — es un cambio aparte, avisame si lo querés armar.

Como `watchlist` no tiene timestamp confiable por item, la detección de
"nuevo" para wallets se hace comparando la lista actual contra la
última corrida del cron (diff de direcciones), no por fecha.

## 1. Configurar wrangler.toml

Ya viene completado con los IDs reales de tus namespaces
(`radar-kv` y `wallet-guardian-kv`). Son bindings de **solo lectura
adicionales** — no tocan nada de los Workers originales.

## 3. Configurar secrets

```bash
wrangler secret put DASH_PASSWORD          # la password para entrar al dashboard
wrangler secret put DASH_PASSWORD_HASH     # un string random largo (openssl rand -hex 32)
wrangler secret put TELEGRAM_BOT_TOKEN     # token del bot (podés reusar el de Wallet Guardian)
wrangler secret put TELEGRAM_CHAT_ID       # tu chat id
```

## 4. Deploy

```bash
npm install -g wrangler   # si no lo tenés
wrangler deploy
```

## 5. Uso

- Entrá a la URL del Worker (`unified-dashboard.<tu-subdominio>.workers.dev`),
  poné la password, y vas a ver las 5 secciones con todo ordenado por fecha.
- El dashboard se auto-refresca cada 60s mientras lo tenés abierto.
- Cada 15 minutos (configurable en `wrangler.toml`) el cron revisa si hay
  entradas nuevas desde la última corrida y te manda un resumen a Telegram.

## Notas de seguridad

- El Worker solo lee los KV (no escribe ni modifica nada de los otros
  dos proyectos).
- La sesión es una cookie simple pensada para uso personal — no es un
  sistema de auth robusto. Si en algún momento le das acceso a otra
  persona, conviene reforzarlo (JWT con expiración real, rate limiting
  en /login, etc.).
- No subas `wrangler.toml` con IDs reales ni secrets a un repo público;
  usá `wrangler secret put` para todo lo sensible.
