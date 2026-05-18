# runbits-status

> Public status page + 90-day uptime history + alert dispatch on flip events.

## Stack

- **Type**: Cloudflare Worker (no Hono — plain `fetch` handler)
- **Runtime**: TypeScript + KV
- **Custom domain**: `status.runbits.dev`
- **Worker name in CF**: `runbits-status`

## Bindings

| Binding | Type | Resource | Purpose |
|---|---|---|---|
| `KV` | KV | `6b1ab19c…` | `checks:{YYYY-MM-DD}` (288/day × 90d retention) + `monitoring:config` blob |
| `RUNTICS_CONTROL` | Service Binding | `runtics-control` | Self-alert → monitoring agent pipeline |
| 17 service bindings | Service Bindings | every worker | Direct health probes (avoid cascade-522 via gateway) |
| Secrets Store | — | `3b9c560a…` | INTERNAL_SERVICE_SECRET |
| Worker secrets (plain) | — | wrangler secret put | RESEND_API_KEY, STATUS_INTERNAL_SECRET |

Service bindings cover: GATEWAY, AUTH_SERVICE, BILLING_SERVICE, PAYMENTS_SERVICE, DOMAIN_SERVICE, CORE_SERVICE, ORDER_SERVICE, SOCIAL_SERVICE, DELIVERY_SERVICE, VERIFICATION_SERVICE, NOTIFICATIONS_SERVICE, WHATSAPP_SERVICE, CHANNELS_SERVICE, SALES_AGENT, MARKETING_SERVICE.

## Cron triggers

| Cron | What it does |
|---|---|
| `*/5 * * * *` | Health-check all services, store result in KV. Handler honors `monitoring:config.interval_minutes` (5/10/15/30) and skips ticks that don't align — change cadence at runtime via admin UI without redeploy |

## Endpoints

The worker renders an HTML status page directly. Admin `/api/monitoring/*` endpoints are reached via the gateway, which proxies in with `X-Internal-Secret = STATUS_INTERNAL_SECRET`.

## Self-alert flow

On any service flipping up→down or down→up:
1. HMAC-sign POST to `runtics-control` `/internal/alert-from-status` (uses `INTERNAL_SERVICE_SECRET`)
2. Runtics monitoring pipeline fans out via configured channels + context analysis
3. Legacy fallback: direct email via Resend (RESEND_API_KEY)

## Deduplication

30-min KV TTL key per (service, state) → prevents alert spam.

## How to deploy

```bash
export CLOUDFLARE_API_TOKEN=<token>
export CLOUDFLARE_ACCOUNT_ID=e26bfe18bfa6df2cb533f24129d433ba
npx wrangler@4 deploy

# Required secrets (one-time)
npx wrangler@4 secret put RESEND_API_KEY
npx wrangler@4 secret put STATUS_INTERNAL_SECRET   # MUST match gateway value
npx wrangler@4 secret put INTERNAL_SERVICE_SECRET  # same as runtics-control
```

## How to test

```bash
curl https://status.runbits.dev/
```

## Files of interest

- `src/index.ts` — `fetch` + `scheduled` handlers, KV state, HTML render
- `app.json` — status-page app metadata

## Gotchas

- **`STATUS_INTERNAL_SECRET` must match the gateway's value EXACTLY.** Drift = monitoring config edits return 503.
- Direct service bindings (instead of `fetch(api.runbits.dev/health)`) were added after a cascade-522 incident: gateway → status → gateway → status → 17× → timeout. Don't replace these with public-URL fetches.
- Pages (runbits.io, runbits.app) are NOT bound here — they're not Workers. Health checks use plain `fetch(url)` for those.
- CF cron quirk: use `7` for Sunday (CF rejects `0` in some positions).
- `monitoring:config` blob is the source of truth for channels + thresholds. Read by `runtics-control` alert dispatcher.

## Logs

```bash
npx wrangler@4 tail runbits-status --format=pretty
```
