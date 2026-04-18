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
 */

interface Env {
  KV: KVNamespace;
  ENVIRONMENT: string;
}

const SERVICES = [
  { id: "gateway", name: "API Gateway", url: "https://api.runbits.dev/health" },
  { id: "auth", name: "Authentication", url: "https://auth.runbits.dev/health" },
  { id: "restaurants", name: "Restaurant Service", url: "https://restaurants.runbits.dev/health" },
  { id: "orders", name: "Order Service", url: "https://orders.runbits.dev/health" },
  { id: "delivery", name: "Delivery Service", url: "https://delivery.runbits.dev/health" },
  { id: "billing", name: "Billing Service", url: "https://billing.runbits.dev/health" },
  { id: "social", name: "Social Service", url: "https://social.runbits.dev/health" },
  { id: "web", name: "Web Dashboard", url: "https://runbits.io" },
  { id: "landing", name: "Landing Page", url: "https://runbits.io" },
];

type CheckResult = {
  ts: number;
  services: Record<string, { ok: boolean; status: number; latency: number }>;
};

type DayData = {
  date: string;
  checks: CheckResult[];
};

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
  const days: DayData[] = [];
  const now = new Date();
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = `checks:${dateKey(d)}`;
    const checks = await kv.get<CheckResult[]>(key, "json") ?? [];
    days.push({ date: dateKey(d), checks });
  }
  return days;
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
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fff;color:#1a1a2e;min-height:100vh}
  .container{max-width:720px;margin:0 auto;padding:40px 20px}

  /* Header */
  .header{margin-bottom:32px}
  .logo{font-size:20px;font-weight:700;color:#111;margin-bottom:24px;display:flex;align-items:center;gap:8px}
  .logo span{color:#059669}

  /* Overall banner */
  .banner{padding:16px 24px;border-radius:12px;display:flex;align-items:center;gap:12px;margin-bottom:40px;background:${overallBg}}
  .banner-dot{width:12px;height:12px;border-radius:50%;background:${overallColor};box-shadow:0 0 8px ${overallColor}}
  .banner-text{font-size:15px;font-weight:600;color:${overallTextColor}}

  /* Service rows */
  .service{margin-bottom:28px;padding-bottom:28px;border-bottom:1px solid #f3f4f6}
  .service:last-child{border-bottom:none}
  .svc-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .svc-name{font-size:14px;font-weight:600;color:#111}
  .svc-status{font-size:13px;font-weight:600}

  /* 90-day bars */
  .bars{display:flex;gap:1px;height:32px;align-items:stretch}
  .bar{flex:1;min-width:2px;border-radius:2px;cursor:pointer;transition:opacity 0.15s}
  .bar:hover{opacity:0.7}

  .svc-footer{display:flex;justify-content:space-between;margin-top:6px}
  .svc-pct{font-size:12px;font-weight:600;color:#374151}
  .svc-range{font-size:11px;color:#9ca3af}

  /* Footer */
  .footer{text-align:center;margin-top:40px;padding-top:24px;border-top:1px solid #f3f4f6}
  .footer p{font-size:12px;color:#9ca3af;margin-bottom:4px}
  .footer a{color:#6b7280;text-decoration:none}
  .footer a:hover{text-decoration:underline}

  /* Tooltip */
  .bar{position:relative}
  .bar:hover::after{content:attr(title);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;font-size:11px;padding:4px 8px;border-radius:6px;white-space:nowrap;pointer-events:none;z-index:10}

  @media(max-width:640px){
    .bar{min-width:1.5px}
    .bars{height:24px}
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo"><span>Runbits</span> Status</div>
  </div>

  <div class="banner">
    <div class="banner-dot"></div>
    <div class="banner-text">${overallText}</div>
  </div>

  ${serviceRows}

  <div class="footer">
    <p>Last checked: ${now}</p>
    <p>Checks run every 5 minutes &middot; 90-day history</p>
    <p><a href="https://runbits.io">runbits.io</a></p>
  </div>
</div>
</body>
</html>`;
}

// ─── Worker exports ──────────────────────────────────────────────────────────

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
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
    await storeCheck(env.KV, check);
  },
};
