// Account-wide Cloudflare spend guard.
//
// Cloudflare has no hard spending cap for usage-based billing. This Worker is
// the single publisher of a per-account "stop spending" state: it reads usage
// for every billable product from the account-level Analytics API, and once a
// metric reaches the configured share of its included allowance it publishes
// `{tripped: true}` to KV. Every Worker that can consume allowances binds the
// same namespace and refuses billable work while the state is tripped or stale,
// so the guard does not need to know about individual projects.

export const STATE_KEY = "state";
export const TRIPPED_MESSAGE = "Cloudflare 用量已达到套餐上限，服务已熔断以停止产生额外费用；升级套餐或等待下个计费周期后自动恢复。";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const DEFAULT_TRIP_PERCENT = 95;
const DEFAULT_STALE_SECONDS = 900;
const QUERY_TIMEOUT_MS = 10_000;

// Workers Paid allowances. Override any of them with BUDGET_<METRIC> so a plan
// or add-on change does not require a code change.
const DEFAULT_LIMITS = {
  d1_rows_read: 25_000_000_000,
  d1_rows_written: 50_000_000,
  worker_requests: 10_000_000,
  r2_class_a: 1_000_000,
  r2_class_b: 10_000_000,
  r2_storage_bytes: 10_000_000_000,
  d1_storage_bytes: 5_000_000_000,
};

// Cloudflare bills Class A and Class B operations separately. Unknown actions
// count as Class A so an unrecognised operation can only trip earlier.
const CLASS_B = new Set([
  "GetObject", "HeadObject", "HeadBucket", "GetBucketLocation", "GetBucketCors",
  "GetBucketEncryption", "GetBucketLifecycleConfiguration", "GetBucketPolicy",
  "GetBucketVersioning",
]);

export function numberVar(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function budgetLimits(env = {}) {
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
    limits[key] = numberVar(env[`BUDGET_${key.toUpperCase()}`], fallback);
  }
  return limits;
}

export function tripPercent(env = {}) {
  return Math.min(100, Math.max(1, numberVar(env.BUDGET_TRIP_PERCENT, DEFAULT_TRIP_PERCENT)));
}

export function staleSeconds(env = {}) {
  return numberVar(env.BUDGET_STALE_TRIP_SECONDS, DEFAULT_STALE_SECONDS);
}

function addUtcMonths(date, months) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
}

// Allowances reset with the billing cycle, not on a rolling window. Set
// BUDGET_CYCLE_START to the subscription anchor when it is not the 1st.
export function cycleStart(env, now) {
  const anchor = env.BUDGET_CYCLE_START ? Date.parse(env.BUDGET_CYCLE_START) : NaN;
  if (Number.isFinite(anchor)) {
    let start = new Date(anchor);
    for (let i = 0; i < 120 && addUtcMonths(start, 1) <= now; i++) start = addUtcMonths(start, 1);
    return start;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function isClassA(actionType) {
  return !CLASS_B.has(actionType);
}

function sumField(rows, key) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const value = Number(row?.sum?.[key]);
    if (!Number.isFinite(value) || value < 0) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

function maxField(rows, key) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let best = null;
  for (const row of rows) {
    const value = Number(row?.max?.[key]);
    if (!Number.isFinite(value) || value < 0) continue;
    best = best === null ? value : Math.max(best, value);
  }
  return best;
}

export function usageFrom(body) {
  const account = body?.data?.viewer?.accounts?.[0] || {};
  return {
    d1_rows_read: sumField(account.d1AnalyticsAdaptiveGroups, "rowsRead"),
    d1_rows_written: sumField(account.d1AnalyticsAdaptiveGroups, "rowsWritten"),
    worker_requests: sumField(account.workersInvocationsAdaptive, "requests"),
    d1_storage_bytes: maxField(account.d1StorageAdaptiveGroups, "databaseSizeBytes"),
  };
}

export function r2UsageFrom(body) {
  const account = body?.data?.viewer?.accounts?.[0] || {};
  const operations = Array.isArray(account.r2OperationsAdaptiveGroups) ? account.r2OperationsAdaptiveGroups : [];
  let classA = 0;
  let classB = 0;
  let seen = false;
  for (const row of operations) {
    const requests = Number(row?.sum?.requests);
    if (!Number.isFinite(requests) || requests < 0) continue;
    seen = true;
    if (isClassA(String(row?.dimensions?.actionType || ""))) classA += requests;
    else classB += requests;
  }
  // Storage is a high-water mark per bucket, not a sum across time buckets.
  const perBucket = new Map();
  const storage = Array.isArray(account.r2StorageAdaptiveGroups) ? account.r2StorageAdaptiveGroups : [];
  for (const row of storage) {
    const size = Number(row?.max?.payloadSize);
    if (!Number.isFinite(size) || size < 0) continue;
    const bucket = String(row?.dimensions?.bucketName || "");
    perBucket.set(bucket, Math.max(perBucket.get(bucket) ?? 0, size));
  }
  return {
    r2_class_a: seen ? classA : null,
    r2_class_b: seen ? classB : null,
    r2_storage_bytes: perBucket.size ? [...perBucket.values()].reduce((a, b) => a + b, 0) : null,
  };
}

// D1 storage is reported per database. Keep each database's high-water mark
// and sum them, so the account total is not reduced to the largest database.
export function d1StorageFrom(body) {
  const account = body?.data?.viewer?.accounts?.[0] || {};
  const perDatabase = new Map();
  const rows = Array.isArray(account.d1StorageAdaptiveGroups) ? account.d1StorageAdaptiveGroups : [];
  for (const row of rows) {
    const size = Number(row?.max?.databaseSizeBytes);
    if (!Number.isFinite(size) || size < 0) continue;
    const id = String(row?.dimensions?.databaseId || "");
    perDatabase.set(id, Math.max(perDatabase.get(id) ?? 0, size));
  }
  return {
    d1_storage_bytes: perDatabase.size ? [...perDatabase.values()].reduce((a, b) => a + b, 0) : null,
  };
}

export function evaluateBudget(env, usage, start, now, previous) {
  const limits = budgetLimits(env);
  const metrics = {};
  const unreadable = [];
  for (const [key, limit] of Object.entries(limits)) {
    const raw = usage[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      metrics[key] = { used: Math.floor(raw), limit };
      continue;
    }
    // Keep the last known value for a metric that is temporarily unavailable.
    // A stale high value can only trip earlier, which is the safe direction.
    const prior = previous?.metrics?.[key];
    if (prior && Number.isFinite(prior.used)) metrics[key] = { used: prior.used, limit };
    else unreadable.push(key);
  }
  const percent = tripPercent(env);
  const reason = Object.keys(metrics).find((key) => metrics[key].used * 100 >= metrics[key].limit * percent) || "";
  return {
    tripped: Boolean(reason),
    reason,
    source: "analytics",
    updated_at: now.toISOString(),
    checked_at: now.toISOString(),
    cycle_start: start.toISOString(),
    metrics,
    unreadable,
  };
}

// Consumers use the same rule: a missing state is only tolerated when the
// deployment explicitly says it does not require the guard.
export function isTripped(state, env = {}, now = Date.now()) {
  if (!state) return env.BUDGET_REQUIRE_STATE === "1" || env.BUDGET_REQUIRE_STATE === "true";
  if (state.tripped === true) return true;
  const at = Date.parse(state.updated_at || "");
  return !Number.isFinite(at) || now - at > staleSeconds(env) * 1000;
}

export async function readState(env) {
  try {
    return (await env.STATE.get(STATE_KEY, "json")) || null;
  } catch (error) {
    console.warn("budget_state_unavailable", { message: String(error?.message || error) });
    return null;
  }
}

const REQUIRED_QUERY = `query BudgetRequired($account:String!,$start:DateTime!,$end:DateTime!){
  viewer{accounts(filter:{accountTag:$account}){
    d1AnalyticsAdaptiveGroups(limit:10000,filter:{datetime_geq:$start,datetime_leq:$end}){sum{rowsRead rowsWritten}}
    workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$start,datetime_leq:$end}){sum{requests}}
  }}
}`;

const OPTIONAL_QUERY = `query BudgetOptional($account:String!,$start:DateTime!,$end:DateTime!){
  viewer{accounts(filter:{accountTag:$account}){
    d1StorageAdaptiveGroups(limit:10000,filter:{datetime_geq:$start,datetime_leq:$end}){max{databaseSizeBytes} dimensions{databaseId}}
    r2OperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$start,datetime_leq:$end}){sum{requests} dimensions{actionType}}
    r2StorageAdaptiveGroups(limit:10000,filter:{datetime_geq:$start,datetime_leq:$end}){max{payloadSize} dimensions{bucketName}}
  }}
}`;

async function graphql(env, query, variables) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) throw new Error("analytics credentials are not configured");
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`analytics HTTP ${response.status}`);
  const body = await response.json();
  if (Array.isArray(body.errors) && body.errors.length) {
    throw new Error(`analytics error ${String(body.errors[0]?.message || "unknown").slice(0, 200)}`);
  }
  if (!body.data?.viewer?.accounts?.length) throw new Error("analytics account missing");
  return body;
}

// A failed refresh deliberately leaves the previous state (and its timestamp)
// in place. Consumers then treat the state as stale and fail closed, which
// bounds the blast radius of a transient Analytics API error.
export async function refreshBudget(env, now = new Date()) {
  const previous = await env.STATE.get(STATE_KEY, "json");
  const start = cycleStart(env, now);
  const variables = { account: env.CF_ACCOUNT_ID, start: start.toISOString(), end: now.toISOString() };
  const usage = { ...usageFrom(await graphql(env, REQUIRED_QUERY, variables)) };
  try {
    const optional = await graphql(env, OPTIONAL_QUERY, variables);
    Object.assign(usage, r2UsageFrom(optional), d1StorageFrom(optional));
  } catch (error) {
    console.warn("budget_optional_metrics_unavailable", { message: String(error?.message || error) });
  }
  const state = evaluateBudget(env, usage, start, now, previous);
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
  return state;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function authorized(request, env) {
  const expected = String(env.GUARD_TOKEN || "");
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Health is free of secrets and is what the guard's own monitoring reads.
    if (request.method === "GET" && url.pathname === "/healthz") {
      const state = await readState(env);
      return json({
        ok: true,
        service: "cloudflare-spend-guard",
        tripped: isTripped(state, env),
        reason: state?.reason || "",
        updated_at: state?.updated_at || "",
      });
    }
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    if (request.method === "GET" && url.pathname === "/v1/state") {
      const state = await readState(env);
      return json({ ok: true, tripped: isTripped(state, env), state });
    }
    if (request.method === "POST" && url.pathname === "/v1/refresh") {
      try {
        const state = await refreshBudget(env);
        return json({ ok: true, tripped: isTripped(state, env), state });
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 502);
      }
    }
    return json({ error: "not found" }, 404);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshBudget(env).catch((error) => {
      console.error(JSON.stringify({ event: "budget_refresh_failed", message: String(error?.message || error) }));
    }));
  },
};
