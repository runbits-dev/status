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

interface Env {
  KV: KVNamespace;
  ENVIRONMENT: string;
  RESEND_API_KEY: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const check = await checkAll();
    await Promise.all([
      storeCheck(env.KV, check),
      runMonitoringAgent(env, check),
    ]);
    await runQASmoke(env);
  },
};
