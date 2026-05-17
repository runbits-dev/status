/**
 * runbits-status — Status page with historical uptime tracking
 *
 * Design inspired by Anthropic/Atlassian Statuspage:
 * - Overall status banner
 * - Per-service status with 90-day uptime bars
 * - Uptime percentage per service
 * - Incident history
 *
 * Architecture:
 * - Cron trigger every 5 min → health check all services → store in KV
 * - KV key format: "checks:{YYYY-MM-DD}" → JSON array of check results
 * - Each day stores up to 288 checks (every 5 min × 24h)
 * - 90 days retained (older auto-expire via KV TTL)
 * - HTTP request → read KV → render HTML with uptime bars
 *
 * Monitoring agent:
 * - After each cron check, detects failures and sends email alerts via Resend
 * - Deduplicates alerts with a 30-min KV TTL key to avoid spam
 * - Detects recovery (service was down, now up) and sends recovery email
 * - Logs incidents to KV with 30-day retention
 */

interface ServiceBindingLike { fetch: (req: Request) => Promise<Response> }

interface Env {
  KV: KVNamespace;
  ENVIRONMENT: string;
  RESEND_API_KEY: string;
  // Shared secret used by the gateway to authenticate proxied admin requests
  // (`/api/monitoring/config`). Set via `wrangler secret put STATUS_INTERNAL_SECRET`
  // on BOTH the gateway and this worker — values must match. The gateway sends
  // it in the `X-Internal-Secret` header; this worker rejects requests missing
  // or with a mismatched value.
  STATUS_INTERNAL_SECRET?: string;
  // Service binding to runtics-control. Used by the self-alert wiring: when a
  // service transitions up→down or down→up we POST to
  // /internal/alert-from-status with HMAC so the alert lands in
  // monitoring_alerts and channels fan out via the runtics dispatcher.
  // Optional — when missing, the legacy email path remains the only channel.
  RUNTICS_CONTROL?: ServiceBindingLike;
  // Same secret as runtics-control's INTERNAL_SERVICE_SECRET. We use it to
  // HMAC-sign the self-alert call from this worker. Bound from Secrets Store.
  INTERNAL_SERVICE_SECRET?: { get: () => Promise<string> };
}

// ─── Monitoring config (KV-backed runtime config) ────────────────────────────
//
// Stored at KV key `monitoring:config`. Single source of truth for cron
// interval, alert thresholds, and notification channels. Read on every
// scheduled tick (cheap — single KV read) and on every config API request.
// Mutated only through PUT /api/monitoring/config (admin-only, gated via the
// gateway service binding).

const MONITORING_CONFIG_KEY = "monitoring:config";

type MonitoringConfig = {
  version: number;
  status_cron: {
    interval_minutes: number; // valid: 5, 10, 15, 30, 60
    enabled: boolean;
  };
  thresholds: {
    error_rate_pct: number;
    error_rate_window_minutes: number;
    cost_daily_usd: number;
    latency_p95_ms: number;
  };
  channels: {
    email: { enabled: boolean; address: string };
    whatsapp: { enabled: boolean; phone: string };
    push: { enabled: boolean };
  };
  updated_at: number;
  updated_by: string;
};

const VALID_INTERVALS = [5, 10, 15, 30, 60] as const;
type ValidInterval = typeof VALID_INTERVALS[number];

const DEFAULT_MONITORING_CONFIG: MonitoringConfig = {
  version: 1,
  status_cron: { interval_minutes: 5, enabled: true },
  thresholds: {
    error_rate_pct: 1.0,
    error_rate_window_minutes: 10,
    cost_daily_usd: 5.0,
    latency_p95_ms: 2000,
  },
  channels: {
    email: { enabled: true, address: "lucas.i.carrizo@gmail.com" },
    whatsapp: { enabled: false, phone: "" },
    push: { enabled: true },
  },
  updated_at: 0,
  updated_by: "",
};

async function getMonitoringConfig(env: Env): Promise<MonitoringConfig> {
  try {
    const raw = await env.KV.get<MonitoringConfig>(MONITORING_CONFIG_KEY, "json");
    if (!raw || typeof raw !== "object") return DEFAULT_MONITORING_CONFIG;
    // Shallow merge defaults so newly-added fields don't break a stored
    // older config blob.
    return {
      version: raw.version ?? DEFAULT_MONITORING_CONFIG.version,
      status_cron: { ...DEFAULT_MONITORING_CONFIG.status_cron, ...(raw.status_cron ?? {}) },
      thresholds: { ...DEFAULT_MONITORING_CONFIG.thresholds, ...(raw.thresholds ?? {}) },
      channels: {
        email: { ...DEFAULT_MONITORING_CONFIG.channels.email, ...(raw.channels?.email ?? {}) },
        whatsapp: { ...DEFAULT_MONITORING_CONFIG.channels.whatsapp, ...(raw.channels?.whatsapp ?? {}) },
        push: { ...DEFAULT_MONITORING_CONFIG.channels.push, ...(raw.channels?.push ?? {}) },
      },
      updated_at: raw.updated_at ?? 0,
      updated_by: raw.updated_by ?? "",
    };
  } catch {
    return DEFAULT_MONITORING_CONFIG;
  }
}

type ConfigUpdateError = { ok: false; error: string };
type ConfigUpdateOk = { ok: true; config: MonitoringConfig };

function validateMonitoringConfig(input: unknown): ConfigUpdateError | { ok: true; sanitized: MonitoringConfig } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const i = input as Partial<MonitoringConfig>;

  const sc = i.status_cron ?? DEFAULT_MONITORING_CONFIG.status_cron;
  const interval = Number(sc.interval_minutes);
  if (!VALID_INTERVALS.includes(interval as ValidInterval)) {
    return { ok: false, error: `status_cron.interval_minutes must be one of ${VALID_INTERVALS.join(", ")}` };
  }
  if (typeof sc.enabled !== "boolean") {
    return { ok: false, error: "status_cron.enabled must be a boolean" };
  }

  const th = i.thresholds ?? DEFAULT_MONITORING_CONFIG.thresholds;
  const errRate = Number(th.error_rate_pct);
  const errWin = Number(th.error_rate_window_minutes);
  const costCap = Number(th.cost_daily_usd);
  const lat = Number(th.latency_p95_ms);
  if (!Number.isFinite(errRate) || errRate < 0 || errRate > 100) {
    return { ok: false, error: "thresholds.error_rate_pct must be a number between 0 and 100" };
  }
  if (!Number.isFinite(errWin) || errWin < 1 || errWin > 1440) {
    return { ok: false, error: "thresholds.error_rate_window_minutes must be a number between 1 and 1440" };
  }
  if (!Number.isFinite(costCap) || costCap < 0) {
    return { ok: false, error: "thresholds.cost_daily_usd must be a positive number" };
  }
  if (!Number.isFinite(lat) || lat < 1) {
    return { ok: false, error: "thresholds.latency_p95_ms must be a positive number" };
  }

  const ch = i.channels ?? DEFAULT_MONITORING_CONFIG.channels;
  const email = { ...DEFAULT_MONITORING_CONFIG.channels.email, ...(ch.email ?? {}) };
  const whatsapp = { ...DEFAULT_MONITORING_CONFIG.channels.whatsapp, ...(ch.whatsapp ?? {}) };
  const push = { ...DEFAULT_MONITORING_CONFIG.channels.push, ...(ch.push ?? {}) };

  if (typeof email.enabled !== "boolean") {
    return { ok: false, error: "channels.email.enabled must be a boolean" };
  }
  if (email.enabled && (!email.address || typeof email.address !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.address))) {
    return { ok: false, error: "channels.email.address must be a valid email when enabled" };
  }
  if (typeof whatsapp.enabled !== "boolean") {
    return { ok: false, error: "channels.whatsapp.enabled must be a boolean" };
  }
  if (whatsapp.enabled && (!whatsapp.phone || !/^\+[1-9]\d{6,14}$/.test(whatsapp.phone))) {
    return { ok: false, error: "channels.whatsapp.phone must be E.164 format (+<digits>) when enabled" };
  }
  if (typeof push.enabled !== "boolean") {
    return { ok: false, error: "channels.push.enabled must be a boolean" };
  }

  const sanitized: MonitoringConfig = {
    version: 1,
    status_cron: {
      interval_minutes: interval as ValidInterval,
      enabled: sc.enabled,
    },
    thresholds: {
      error_rate_pct: errRate,
      error_rate_window_minutes: errWin,
      cost_daily_usd: costCap,
      latency_p95_ms: lat,
    },
    channels: {
      email: { enabled: email.enabled, address: email.address ?? "" },
      whatsapp: { enabled: whatsapp.enabled, phone: whatsapp.phone ?? "" },
      push: { enabled: push.enabled },
    },
    updated_at: Date.now(),
    updated_by: "",
  };

  return { ok: true, sanitized };
}

async function saveMonitoringConfig(env: Env, cfg: MonitoringConfig): Promise<ConfigUpdateOk> {
  await env.KV.put(MONITORING_CONFIG_KEY, JSON.stringify(cfg));
  return { ok: true, config: cfg };
}

const SERVICES = [
  // Public surfaces (cliente-facing)
  { id: "gateway", name: "API Gateway", url: "https://api.runbits.dev/health" },
  { id: "web", name: "Dashboard (runbits.io)", url: "https://runbits.io" },
  { id: "app", name: "Marketplace (runbits.app)", url: "https://runbits.app" },

  // Internal microservices via gateway aggregated /health/svc/{id} endpoint
  // (gateway forwards to each worker via service binding, no auth required).
  { id: "auth", name: "Auth Service", url: "https://api.runbits.dev/health/svc/auth" },
  { id: "billing", name: "Billing Service", url: "https://api.runbits.dev/health/svc/billing" },
  { id: "payments", name: "Payments Service", url: "https://api.runbits.dev/health/svc/payments" },
  { id: "domain", name: "Domain Service", url: "https://api.runbits.dev/health/svc/domain" },
  { id: "core", name: "Core (Restaurants/Catalog)", url: "https://api.runbits.dev/health/svc/core" },
  { id: "orders", name: "Orders Service", url: "https://api.runbits.dev/health/svc/orders" },
  { id: "social", name: "Social Service", url: "https://api.runbits.dev/health/svc/social" },
  { id: "delivery", name: "Delivery Service", url: "https://api.runbits.dev/health/svc/delivery" },
  { id: "verification", name: "Verification (KYC)", url: "https://api.runbits.dev/health/svc/verification" },
  { id: "notifications", name: "Notifications Service", url: "https://api.runbits.dev/health/svc/notifications" },
  { id: "whatsapp", name: "WhatsApp Bot", url: "https://api.runbits.dev/health/svc/whatsapp" },
  // Added 2026-05: channels (omnichannel inbox), runtics (AI agent), and
  // catalog/sales aliases that the gateway resolves to RESTAURANT_SERVICE
  // and SALES_AGENT bindings respectively. Email-marketing wired via
  // MARKETING_SERVICE binding on the gateway.
  { id: "channels", name: "Channels (omnichannel)", url: "https://api.runbits.dev/health/svc/channels" },
  { id: "runtics", name: "Runtics (AI Agent)", url: "https://api.runbits.dev/health/svc/runtics" },
  { id: "sales", name: "Sales Agent (AI)", url: "https://api.runbits.dev/health/svc/sales" },
  { id: "catalog", name: "Catalog Service", url: "https://api.runbits.dev/health/svc/catalog" },
  { id: "marketing", name: "Email Marketing", url: "https://api.runbits.dev/health/svc/marketing" },
];

type CheckResult = {
  ts: number;
  services: Record<string, { ok: boolean; status: number; latency: number }>;
};

type DayData = {
  date: string;
  checks: CheckResult[];
};

type FailedService = { id: string; name: string; status: number; error?: string };

// ─── Health check logic ──────────────────────────────────────────────────────

async function checkAll(): Promise<CheckResult> {
  const results: CheckResult["services"] = {};
  await Promise.all(
    SERVICES.map(async (svc) => {
      const start = Date.now();
      try {
        const res = await fetch(svc.url, { method: "GET", redirect: "follow" });
        results[svc.id] = { ok: res.status === 200, status: res.status, latency: Date.now() - start };
      } catch {
        results[svc.id] = { ok: false, status: 0, latency: Date.now() - start };
      }
    })
  );
  return { ts: Date.now(), services: results };
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function storeCheck(kv: KVNamespace, check: CheckResult): Promise<void> {
  const key = `checks:${dateKey(new Date(check.ts))}`;
  const existing = await kv.get<CheckResult[]>(key, "json") ?? [];
  existing.push(check);
  await kv.put(key, JSON.stringify(existing), { expirationTtl: 90 * 86400 });
}

async function getLast90Days(kv: KVNamespace): Promise<DayData[]> {
  const now = new Date();
  // Build all 90 dates first
  const dates: string[] = [];
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(dateKey(d));
  }
  // Fetch all 90 KV reads in parallel (was sequential = 22s, now ~500ms)
  const results = await Promise.all(
    dates.map((date) => kv.get<CheckResult[]>(`checks:${date}`, "json").then((checks) => ({ date, checks: checks ?? [] })))
  );
  return results;
}

// ─── Uptime calculation ──────────────────────────────────────────────────────

type DayStatus = "operational" | "degraded" | "outage" | "nodata";

function dayStatusForService(checks: CheckResult[], serviceId: string): DayStatus {
  if (checks.length === 0) return "nodata";
  const svcChecks = checks.map((c) => c.services[serviceId]).filter(Boolean);
  if (svcChecks.length === 0) return "nodata";
  const upCount = svcChecks.filter((c) => c.ok).length;
  const ratio = upCount / svcChecks.length;
  if (ratio >= 0.99) return "operational";
  if (ratio >= 0.5) return "degraded";
  return "outage";
}

function uptimePercent(days: DayData[], serviceId: string): number {
  let total = 0;
  let up = 0;
  for (const day of days) {
    for (const check of day.checks) {
      const svc = check.services[serviceId];
      if (svc) {
        total++;
        if (svc.ok) up++;
      }
    }
  }
  if (total === 0) return 100;
  return Math.round((up / total) * 10000) / 100;
}

// ─── Alerting helpers ────────────────────────────────────────────────────────

async function sendAlertEmail(
  apiKey: string,
  failed: FailedService[]
): Promise<void> {
  if (!apiKey) return;

  const serviceList = failed.map((s) => `• ${s.name}: ${s.error ?? `HTTP ${s.status || "unreachable"}`}`).join("\n");
  const message = `Runbits: ${failed.length} service(s) DOWN\n${serviceList}`;

  const html = `<div style="font-family:system-ui,sans-serif;padding:20px;">
    <h2 style="color:#dc2626;">Alerta: Servicios caidos</h2>
    <p>${message.replace(/\n/g, "<br>")}</p>
    <p style="color:#6b7280;font-size:12px;">Runbits Monitoring Agent — ${new Date().toISOString()}</p>
    <a href="https://status.runbits.dev" style="color:#4f46e5;">Ver status page</a>
  </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: "Runbits Monitoring <alerts@runbits.io>",
      to: "lucas@runbits.io",
      subject: `Runbits Alert: ${failed.map((f) => f.name).join(", ")} DOWN`,
      html,
    }),
  }).catch((err) => console.error("[monitoring] Email alert failed:", err));
}

async function sendRecoveryEmail(
  apiKey: string,
  serviceName: string
): Promise<void> {
  if (!apiKey) return;

  const html = `<div style="font-family:system-ui,sans-serif;padding:20px;">
    <h2 style="color:#16a34a;">Recuperado: ${serviceName}</h2>
    <p><strong>${serviceName}</strong> ha vuelto a estar operativo.</p>
    <p style="color:#6b7280;font-size:12px;">Runbits Monitoring Agent — ${new Date().toISOString()}</p>
    <a href="https://status.runbits.dev" style="color:#4f46e5;">Ver status page</a>
  </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: "Runbits Monitoring <alerts@runbits.io>",
      to: "lucas@runbits.io",
      subject: `Runbits Recovered: ${serviceName} is back up`,
      html,
    }),
  }).catch((err) => console.error("[monitoring] Recovery email failed:", err));
}

// ─── Self-alert to runtics-control (HMAC-signed S2S) ────────────────────────
//
// Push transitions (up→down, down→up) into the runtics monitoring pipeline so
// the alert lands in monitoring_alerts, fans out to channels per the runtime
// config, and triggers the monitoring agent's context_analysis mode.
//
// HMAC signature mirrors runtics-control/src/service-auth.ts:
//   signature = HMAC-SHA256(secret, `${ts}.${caller}.${path}.${bodyHash}`)
//
// Failure is non-fatal — the legacy email path keeps working even if the
// runtics-control call fails.

const ENC = new TextEncoder();

function bufToHexStr(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function sha256HexStr(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", ENC.encode(s));
  return bufToHexStr(buf);
}

async function sendSelfAlertToRuntics(
  env: Env,
  payload: { service: string; type: "service_down" | "service_recovered"; message: string; http_status?: number; latency_ms?: number },
): Promise<void> {
  if (!env.RUNTICS_CONTROL || !env.INTERNAL_SERVICE_SECRET) return;
  try {
    const secret = await env.INTERNAL_SERVICE_SECRET.get();
    if (!secret) return;
    const url = "https://internal/internal/alert-from-status";
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const path = "/internal/alert-from-status";
    const bodyHash = await sha256HexStr(body);
    const message = `${ts}.runbits-status.${path}.${bodyHash}`;
    const key = await crypto.subtle.importKey(
      "raw",
      ENC.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, ENC.encode(message));
    const headers = new Headers({
      "Content-Type": "application/json",
      "X-Service-Caller": "runbits-status",
      "X-Service-Ts": ts,
      "X-Service-Signature": bufToHexStr(sigBuf),
    });
    const res = await env.RUNTICS_CONTROL.fetch(
      new Request(url, { method: "POST", headers, body }),
    );
    if (!res.ok) {
      console.error(`[monitoring] self-alert to runtics returned ${res.status}`);
    }
  } catch (err) {
    console.error("[monitoring] self-alert to runtics failed:", err);
  }
}

// ─── Monitoring agent ────────────────────────────────────────────────────────

async function runMonitoringAgent(env: Env, check: CheckResult): Promise<void> {
  const failed: FailedService[] = SERVICES.filter(
    (svc) => !check.services[svc.id]?.ok
  ).map((svc) => ({
    id: svc.id,
    name: svc.name,
    status: check.services[svc.id]?.status ?? 0,
  }));

  const up = SERVICES.filter((svc) => check.services[svc.id]?.ok);

  // ── 1. Recovery detection (must run before alert dedup cleanup) ───────────
  for (const svc of up) {
    const alertKey = `alert:${svc.id}`;
    const wasAlerting = await env.KV.get(alertKey);
    if (wasAlerting) {
      console.log(`[monitoring] Recovery detected: ${svc.name}`);
      await Promise.all([
        sendRecoveryEmail(env.RESEND_API_KEY, svc.name),
        env.KV.delete(alertKey),
        sendSelfAlertToRuntics(env, {
          service: svc.id,
          type: "service_recovered",
          message: `${svc.name} is back online.`,
          latency_ms: check.services[svc.id]?.latency,
        }),
      ]);
    }
  }

  // ── 2. Failure detection and alerting ────────────────────────────────────
  if (failed.length > 0) {
    // Log incident regardless of alert dedup
    const incidentId = `incident:${Date.now()}`;
    await env.KV.put(
      incidentId,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        services: failed.map((s) => s.name),
        resolved: false,
      }),
      { expirationTtl: 86400 * 30 } // keep 30 days
    );

    // Per-service alert dedup: alert for each newly-failing service
    const newlyFailed: FailedService[] = [];
    await Promise.all(
      failed.map(async (svc) => {
        const alertKey = `alert:${svc.id}`;
        const alreadyAlerted = await env.KV.get(alertKey);
        if (!alreadyAlerted) {
          newlyFailed.push(svc);
          // TTL 30 min — will re-alert if still down after 30 min
          await env.KV.put(alertKey, new Date().toISOString(), {
            expirationTtl: 1800,
          });
        }
      })
    );

    if (newlyFailed.length > 0) {
      console.log(
        `[monitoring] Alerting for ${newlyFailed.length} newly-failed service(s): ${newlyFailed.map((s) => s.name).join(", ")}`
      );
      await sendAlertEmail(env.RESEND_API_KEY, newlyFailed);
      // Also push each transition into runtics so they land in monitoring_alerts.
      await Promise.all(
        newlyFailed.map((svc) =>
          sendSelfAlertToRuntics(env, {
            service: svc.id,
            type: "service_down",
            message: `${svc.name} is down (HTTP ${svc.status || "unreachable"}).`,
            http_status: svc.status,
          }),
        ),
      );
    } else {
      console.log(
        `[monitoring] ${failed.length} service(s) still down, alert already sent (within 30 min window)`
      );
    }
  }
}

// ─── HTML rendering ──────────────────────────────────────────────────────────

const STATUS_COLORS: Record<DayStatus, string> = {
  operational: "#22c55e",
  degraded: "#eab308",
  outage: "#ef4444",
  nodata: "#e5e7eb",
};

function renderPage(days: DayData[], liveCheck: CheckResult): string {
  const allUp = SERVICES.every((s) => liveCheck.services[s.id]?.ok);
  const overallColor = allUp ? "#22c55e" : "#ef4444";
  const overallText = allUp ? "All Systems Operational" : "Some Systems Experiencing Issues";
  const overallBg = allUp ? "#f0fdf4" : "#fef2f2";
  const overallTextColor = allUp ? "#166534" : "#991b1b";

  const serviceRows = SERVICES.map((svc) => {
    const live = liveCheck.services[svc.id];
    const pct = uptimePercent(days, svc.id);
    const bars = days.map((day) => {
      const status = dayStatusForService(day.checks, svc.id);
      const color = STATUS_COLORS[status];
      const tooltip = `${day.date}: ${status}`;
      return `<div class="bar" style="background:${color}" title="${tooltip}"></div>`;
    }).join("");

    const statusText = live?.ok ? "Operational" : "Outage";
    const statusColor = live?.ok ? "#22c55e" : "#ef4444";

    return `
      <div class="service">
        <div class="svc-header">
          <span class="svc-name">${svc.name}</span>
          <span class="svc-status" style="color:${statusColor}">${statusText}</span>
        </div>
        <div class="bars">${bars}</div>
        <div class="svc-footer">
          <span class="svc-pct">${pct}% uptime</span>
          <span class="svc-range">90 days</span>
        </div>
      </div>
    `;
  }).join("");

  const now = new Date().toISOString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Runbits Status</title>
<meta name="description" content="Real-time status and uptime monitoring for Runbits services">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Montserrat:ital,wght@1,800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
  a{color:#818cf8;text-decoration:none}
  a:hover{text-decoration:underline}
  .container{max-width:720px;margin:0 auto;padding:40px 20px}

  /* Header */
  .header{display:flex;align-items:center;justify-content:space-between;margin-bottom:40px;padding-bottom:20px;border-bottom:1px solid #1e293b}
  .logo{font-family:'Montserrat',sans-serif;font-weight:800;font-style:italic;text-transform:uppercase;letter-spacing:-0.5px;font-size:22px;color:#fff}
  .logo-badge{font-family:'Inter',sans-serif;font-style:normal;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#818cf8;margin-left:8px}
  .nav{display:flex;gap:16px;font-size:13px}
  .nav a{color:#94a3b8}
  .nav a:hover{color:#e2e8f0}

  /* Overall banner */
  .banner{padding:16px 24px;border-radius:12px;display:flex;align-items:center;gap:12px;margin-bottom:40px;background:${allUp ? '#0f291e' : '#2d1215'};border:1px solid ${allUp ? '#166534' : '#7f1d1d'}}
  .banner-dot{width:12px;height:12px;border-radius:50%;background:${overallColor};box-shadow:0 0 8px ${overallColor}}
  .banner-text{font-size:15px;font-weight:600;color:${allUp ? '#4ade80' : '#fca5a5'}}

  /* Service rows */
  .service{margin-bottom:24px;padding:20px;border-radius:12px;background:#1e293b;border:1px solid #334155}
  .svc-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
  .svc-name{font-size:14px;font-weight:600;color:#f1f5f9}
  .svc-status{font-size:13px;font-weight:600}

  /* 90-day bars */
  .bars{display:flex;gap:1px;height:32px;align-items:stretch}
  .bar{flex:1;min-width:2px;border-radius:2px;cursor:pointer;transition:opacity 0.15s}
  .bar:hover{opacity:0.7}

  .svc-footer{display:flex;justify-content:space-between;margin-top:8px}
  .svc-pct{font-size:12px;font-weight:600;color:#94a3b8}
  .svc-range{font-size:11px;color:#64748b}

  /* Footer */
  .footer{text-align:center;margin-top:40px;padding-top:24px;border-top:1px solid #1e293b}
  .footer p{font-size:12px;color:#64748b;margin-bottom:6px}

  /* Tooltip */
  .bar{position:relative}
  .bar:hover::after{content:attr(title);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:#f1f5f9;color:#0f172a;font-size:11px;padding:4px 8px;border-radius:6px;white-space:nowrap;pointer-events:none;z-index:10;font-weight:500}

  @media(max-width:640px){
    .bar{min-width:1.5px}
    .bars{height:24px}
    .header{flex-direction:column;align-items:flex-start;gap:12px}
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div><span class="logo">RUNBITS</span><span class="logo-badge">Status</span></div>
    <div class="nav">
      <a href="https://runbits.io">Commerce</a>
      <a href="https://runbits.app">Marketplace</a>
      <a href="https://runbits.dev">Developers</a>
    </div>
  </div>

  <div class="banner">
    <div class="banner-dot"></div>
    <div class="banner-text">${overallText}</div>
  </div>

  ${serviceRows}

  <div class="footer">
    <p>Last checked: ${now}</p>
    <p>Checks run every 5 minutes &middot; 90-day history</p>
    <p>&copy; ${new Date().getFullYear()} Runbits.io LLC</p>
  </div>
</div>
</body>
</html>`;
}

// ─── QA Smoke Tests ─────────────────────────────────────────────────────────

async function runQASmoke(env: Env): Promise<void> {
  // Only run on Mondays at ~6:00-6:05 UTC
  const now = new Date();
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 6) return;

  // Already ran this week?
  const lastRun = await env.KV.get("qa:last-run");
  if (lastRun) {
    const diff = Date.now() - parseInt(lastRun);
    if (diff < 6 * 24 * 60 * 60 * 1000) return; // Less than 6 days ago
  }

  console.log("[qa-agent] Starting weekly smoke tests");

  const API = "https://api.runbits.dev";
  const results: Array<{ name: string; ok: boolean; status?: number; ms: number; error?: string }> = [];

  const tests: Array<{ name: string; url: string; method: string; body?: string; expectStatus?: number }> = [
    { name: "Gateway health", url: `${API}/health`, method: "GET" },
    { name: "Auth health", url: `${API}/api/auth/me`, method: "GET", expectStatus: 401 },
    { name: "Login validation", url: `${API}/api/auth/login`, method: "POST", body: "{}", expectStatus: 400 },
    { name: "Register validation", url: `${API}/api/auth/login`, method: "POST", body: '{"email":"","password":""}', expectStatus: 400 },
    { name: "Stores public", url: `${API}/api/stores`, method: "GET" },
    { name: "Zones public", url: `${API}/api/zones`, method: "GET" },
    { name: "Feature flags", url: `${API}/api/config/flags`, method: "GET" },
    { name: "Store chat", url: `${API}/api/store/chat`, method: "POST", body: '{"message":"test","storeId":"test","storeName":"test"}', expectStatus: 200 },
    { name: "Orders auth", url: `${API}/api/orders`, method: "GET", expectStatus: 401 },
    { name: "Profiles auth", url: `${API}/api/profiles`, method: "GET", expectStatus: 401 },
    { name: "OTP request", url: `${API}/api/auth/otp/request`, method: "POST", body: '{"email":"qa-test@runbits.io"}' },
    { name: "Magic link request", url: `${API}/api/auth/magic-link/request`, method: "POST", body: '{"email":"qa-test@runbits.io"}' },
  ];

  for (const test of tests) {
    const start = Date.now();
    try {
      const res = await fetch(test.url, {
        method: test.method,
        headers: test.body ? { "Content-Type": "application/json" } : {},
        body: test.body,
      });
      const ms = Date.now() - start;
      const expectedStatus = test.expectStatus ?? 200;
      const ok = res.status === expectedStatus;
      results.push({ name: test.name, ok, status: res.status, ms });
    } catch (err) {
      results.push({ name: test.name, ok: false, ms: Date.now() - start, error: String(err) });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const totalMs = results.reduce((s, r) => s + r.ms, 0);

  // Store result
  await env.KV.put("qa:last-run", String(Date.now()), { expirationTtl: 604800 });
  await env.KV.put(
    `qa:report:${now.toISOString().slice(0, 10)}`,
    JSON.stringify({ results, passed, failed, totalMs }),
    { expirationTtl: 2592000 }
  );

  // Send email report
  if (env.RESEND_API_KEY) {
    const statusEmoji = failed === 0 ? "✅" : "❌";
    const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:${failed === 0 ? "#059669" : "#dc2626"};">${statusEmoji} QA Smoke Tests — ${passed}/${results.length} passed</h2>
      <p style="color:#6b7280;font-size:13px;">Weekly report — ${now.toISOString().slice(0, 10)} — Total: ${totalMs}ms</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:13px;">
        <tr style="background:#f9fafb;"><th style="text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;">Test</th><th style="padding:8px;border-bottom:1px solid #e5e7eb;">Status</th><th style="padding:8px;border-bottom:1px solid #e5e7eb;">Time</th></tr>
        ${results
          .map(
            (r) =>
              `<tr><td style="padding:8px;border-bottom:1px solid #f3f4f6;">${r.name}</td><td style="padding:8px;text-align:center;border-bottom:1px solid #f3f4f6;">${r.ok ? "✅" : `❌ ${r.status ?? r.error}`}</td><td style="padding:8px;text-align:center;border-bottom:1px solid #f3f4f6;color:#6b7280;">${r.ms}ms</td></tr>`
          )
          .join("")}
      </table>
      <p style="color:#9ca3af;font-size:11px;margin-top:16px;">Runbits QA Agent</p>
    </div>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: "Runbits QA <alerts@runbits.io>",
        to: "lucas@runbits.io",
        subject: `${statusEmoji} QA Report: ${passed}/${results.length} passed — ${now.toISOString().slice(0, 10)}`,
        html,
      }),
    }).catch((err) => console.error("[qa-agent] Email failed:", err));
  }

  console.log(`[qa-agent] Done: ${passed}/${results.length} passed, ${failed} failed, ${totalMs}ms total`);
}

// Forced variant used by the manual /qa/run endpoint — skips the day/hour guard.
async function runQASmokeForced(env: Env): Promise<void> {
  const now = new Date();

  console.log("[qa-agent] Starting forced smoke tests");

  const API = "https://api.runbits.dev";
  const results: Array<{ name: string; ok: boolean; status?: number; ms: number; error?: string }> = [];

  const tests: Array<{ name: string; url: string; method: string; body?: string; expectStatus?: number }> = [
    { name: "Gateway health", url: `${API}/health`, method: "GET" },
    { name: "Auth health", url: `${API}/api/auth/me`, method: "GET", expectStatus: 401 },
    { name: "Login validation", url: `${API}/api/auth/login`, method: "POST", body: "{}", expectStatus: 400 },
    { name: "Register validation", url: `${API}/api/auth/login`, method: "POST", body: '{"email":"","password":""}', expectStatus: 400 },
    { name: "Stores public", url: `${API}/api/stores`, method: "GET" },
    { name: "Zones public", url: `${API}/api/zones`, method: "GET" },
    { name: "Feature flags", url: `${API}/api/config/flags`, method: "GET" },
    { name: "Store chat", url: `${API}/api/store/chat`, method: "POST", body: '{"message":"test","storeId":"test","storeName":"test"}', expectStatus: 200 },
    { name: "Orders auth", url: `${API}/api/orders`, method: "GET", expectStatus: 401 },
    { name: "Profiles auth", url: `${API}/api/profiles`, method: "GET", expectStatus: 401 },
    { name: "OTP request", url: `${API}/api/auth/otp/request`, method: "POST", body: '{"email":"qa-test@runbits.io"}' },
    { name: "Magic link request", url: `${API}/api/auth/magic-link/request`, method: "POST", body: '{"email":"qa-test@runbits.io"}' },
  ];

  for (const test of tests) {
    const start = Date.now();
    try {
      const res = await fetch(test.url, {
        method: test.method,
        headers: test.body ? { "Content-Type": "application/json" } : {},
        body: test.body,
      });
      const ms = Date.now() - start;
      const expectedStatus = test.expectStatus ?? 200;
      const ok = res.status === expectedStatus;
      results.push({ name: test.name, ok, status: res.status, ms });
    } catch (err) {
      results.push({ name: test.name, ok: false, ms: Date.now() - start, error: String(err) });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const totalMs = results.reduce((s, r) => s + r.ms, 0);

  await env.KV.put("qa:last-run", String(Date.now()), { expirationTtl: 604800 });
  await env.KV.put(
    `qa:report:${now.toISOString().slice(0, 10)}`,
    JSON.stringify({ results, passed, failed, totalMs }),
    { expirationTtl: 2592000 }
  );

  if (env.RESEND_API_KEY) {
    const statusEmoji = failed === 0 ? "✅" : "❌";
    const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:${failed === 0 ? "#059669" : "#dc2626"};">${statusEmoji} QA Smoke Tests — ${passed}/${results.length} passed</h2>
      <p style="color:#6b7280;font-size:13px;">Manual run — ${now.toISOString().slice(0, 10)} — Total: ${totalMs}ms</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:13px;">
        <tr style="background:#f9fafb;"><th style="text-align:left;padding:8px;border-bottom:1px solid #e5e7eb;">Test</th><th style="padding:8px;border-bottom:1px solid #e5e7eb;">Status</th><th style="padding:8px;border-bottom:1px solid #e5e7eb;">Time</th></tr>
        ${results
          .map(
            (r) =>
              `<tr><td style="padding:8px;border-bottom:1px solid #f3f4f6;">${r.name}</td><td style="padding:8px;text-align:center;border-bottom:1px solid #f3f4f6;">${r.ok ? "✅" : `❌ ${r.status ?? r.error}`}</td><td style="padding:8px;text-align:center;border-bottom:1px solid #f3f4f6;color:#6b7280;">${r.ms}ms</td></tr>`
          )
          .join("")}
      </table>
      <p style="color:#9ca3af;font-size:11px;margin-top:16px;">Runbits QA Agent</p>
    </div>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: "Runbits QA <alerts@runbits.io>",
        to: "lucas@runbits.io",
        subject: `${statusEmoji} QA Report (manual): ${passed}/${results.length} passed — ${now.toISOString().slice(0, 10)}`,
        html,
      }),
    }).catch((err) => console.error("[qa-agent] Email failed:", err));
  }

  console.log(`[qa-agent] Done: ${passed}/${results.length} passed, ${failed} failed, ${totalMs}ms total`);
}

// ─── Worker exports ──────────────────────────────────────────────────────────

// ─── Internal auth helper for /api/monitoring/* ──────────────────────────────
//
// The status worker is intentionally public at status.runbits.dev (renders the
// public status page). The monitoring/config endpoints below MUST NOT be
// reachable publicly — they're proxied here by runbits-gateway via service
// binding after the gateway has already validated JWT + admin role.
//
// We defend in depth: even though the binding is internal, callers must
// present a matching INTERNAL_GATEWAY_SECRET so a misconfigured public route
// or a stolen URL can't mutate config. Returns null if auth passes, or a
// Response if it should be rejected.

function rejectIfNotInternal(req: Request, env: Env): Response | null {
  const provided = req.headers.get("X-Internal-Secret");
  const expected = env.STATUS_INTERNAL_SECRET;
  if (!expected) {
    return new Response(
      JSON.stringify({ error: "Service not configured (missing STATUS_INTERNAL_SECRET)" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!provided || provided !== expected) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Internal monitoring config endpoints (proxied by gateway) ───────────
    if (url.pathname === "/api/monitoring/config") {
      const reject = rejectIfNotInternal(request, env);
      if (reject) return reject;

      if (request.method === "GET") {
        const cfg = await getMonitoringConfig(env);
        return new Response(JSON.stringify({ config: cfg }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (request.method === "PUT") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const validation = validateMonitoringConfig(body);
        if (!validation.ok) {
          return new Response(JSON.stringify({ error: validation.error }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Stamp updated_by from header forwarded by the gateway (which read it
        // from the JWT's email/sub claim — see gateway proxy logic).
        const updatedBy = request.headers.get("X-User-Email") || request.headers.get("X-User-Id") || "";
        const cfg: MonitoringConfig = { ...validation.sanitized, updated_by: updatedBy };
        const saved = await saveMonitoringConfig(env, cfg);
        return new Response(JSON.stringify(saved), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", "Allow": "GET, PUT" },
      });
    }

    // Public health snapshot — returns current live check (one-shot, no KV
    // write). Safe to expose: same data the public status page renders.
    if (request.method === "GET" && url.pathname === "/api/monitoring/health-snapshot") {
      const check = await checkAll();
      const services = SERVICES.map((svc) => {
        const r = check.services[svc.id];
        return {
          id: svc.id,
          name: svc.name,
          ok: !!r?.ok,
          status: r?.status ?? 0,
          latency_ms: r?.latency ?? 0,
        };
      });
      return new Response(
        JSON.stringify({ ts: check.ts, services }),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }

    // Manual QA trigger endpoint
    if (request.method === "POST" && url.pathname === "/qa/run") {
      // Clear the last-run to force execution regardless of schedule guard
      await env.KV.delete("qa:last-run");
      // Override the day/hour guard by temporarily spoofing: run inline
      // We patch the guard by directly invoking the core logic below
      await runQASmokeForced(env);
      return new Response(JSON.stringify({ message: "QA smoke tests executed. Check email for results." }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const [liveCheck, days] = await Promise.all([
      checkAll(),
      getLast90Days(env.KV),
    ]);
    return new Response(renderPage(days, liveCheck), {
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // Read runtime config — controls whether checks run and at what cadence.
    // The cron itself fires every 5 min (declared in wrangler.toml), but the
    // handler decides whether THIS tick should actually execute the checks.
    const config = await getMonitoringConfig(env);

    // QA smoke is independent of the status_cron toggle — it has its own
    // weekly schedule guard inside runQASmoke().
    await runQASmoke(env);

    if (!config.status_cron.enabled) return;

    // Skip ticks that don't align with the selected interval. eg interval=15
    // means only run when minute is 0, 15, 30, 45. We use UTC minutes from
    // the scheduled time (deterministic across worker invocations).
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    if (minute % config.status_cron.interval_minutes !== 0) return;

    const check = await checkAll();
    await Promise.all([
      storeCheck(env.KV, check),
      runMonitoringAgent(env, check),
    ]);
  },
};
