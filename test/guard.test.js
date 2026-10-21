import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  budgetLimits,
  evaluateBudget,
  isClassA,
  isTripped,
  refreshBudget,
} from "../src/index.js";

function fakeKV(initial = null) {
  let value = initial;
  return {
    async get(_key, type) {
      if (value === null || value === undefined) return null;
      return type === "json" && typeof value === "string" ? JSON.parse(value) : value;
    },
    async put(_key, next) {
      value = next;
    },
  };
}

const state = (overrides = {}) => ({
  tripped: false,
  reason: "",
  source: "analytics",
  updated_at: new Date().toISOString(),
  checked_at: new Date().toISOString(),
  cycle_start: new Date().toISOString(),
  metrics: {},
  unreadable: [],
  ...overrides,
});

test("trips at the configured share of an included allowance", () => {
  const limits = budgetLimits({});
  const now = new Date("2026-10-21T12:00:00Z");
  const start = new Date("2026-10-01T00:00:00Z");
  assert.equal(evaluateBudget({}, { d1_rows_read: limits.d1_rows_read * 0.94 }, start, now).tripped, false);
  const at = evaluateBudget({}, { d1_rows_read: limits.d1_rows_read * 0.95 }, start, now);
  assert.equal(at.tripped, true);
  assert.equal(at.reason, "d1_rows_read");
  assert.equal(evaluateBudget({ BUDGET_TRIP_PERCENT: "50" }, { d1_rows_read: limits.d1_rows_read * 0.6 }, start, now).tripped, true);
});

test("carries the last known value forward and records the gap", () => {
  const previous = state({ metrics: { d1_rows_read: { used: 10, limit: 100 } } });
  const next = evaluateBudget({}, { d1_rows_read: null }, new Date(), new Date(), previous);
  assert.equal(next.metrics.d1_rows_read.used, 10);
  assert.ok(next.unreadable.includes("d1_rows_written"));
});

test("missing, tripped and stale states are treated correctly", () => {
  assert.equal(isTripped(null, {}), false);
  assert.equal(isTripped(null, { BUDGET_REQUIRE_STATE: "1" }), true);
  assert.equal(isTripped(state(), {}), false);
  assert.equal(isTripped(state({ tripped: true }), {}), true);
  const old = state({ updated_at: new Date(Date.now() - 16 * 60 * 1000).toISOString() });
  assert.equal(isTripped(old, {}), true);
  assert.equal(isTripped(old, { BUDGET_STALE_TRIP_SECONDS: "3600" }), false);
});

test("unknown R2 actions count as Class A", () => {
  assert.equal(isClassA("GetObject"), false);
  assert.equal(isClassA("PutObject"), true);
  assert.equal(isClassA("SomeNewAction"), true);
});

test("refresh reads account usage and publishes the state", async () => {
  const limits = budgetLimits({});
  const queries = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    queries.push(String(body.query));
    const optional = String(body.query).includes("BudgetOptional");
    const account = optional
      ? {
          d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 1024 }, dimensions: { databaseId: "db" } }],
          r2OperationsAdaptiveGroups: [
            { sum: { requests: 3 }, dimensions: { actionType: "PutObject" } },
            { sum: { requests: 5 }, dimensions: { actionType: "GetObject" } },
          ],
          r2StorageAdaptiveGroups: [{ max: { payloadSize: 2048 }, dimensions: { bucketName: "b" } }],
        }
      : {
          d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: limits.d1_rows_read, rowsWritten: 10 } }],
          workersInvocationsAdaptive: [{ sum: { requests: 7 } }],
        };
    return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }), { status: 200 });
  };
  try {
    const env = { CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "token", STATE: fakeKV() };
    const published = await refreshBudget(env, new Date("2026-10-21T12:00:00Z"));
    assert.equal(published.tripped, true);
    assert.equal(published.metrics.r2_class_a.used, 3);
    assert.equal(published.metrics.r2_class_b.used, 5);
    assert.equal(published.metrics.r2_storage_bytes.used, 2048);
    assert.ok(queries.some((query) => query.includes("BudgetOptional")));

    const stored = await env.STATE.get("state", "json");
    assert.equal(stored.tripped, true);
    assert.equal(stored.cycle_start, "2026-10-01T00:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed refresh leaves the previous state in place", async () => {
  const originalFetch = globalThis.fetch;
  const previous = state({ updated_at: "2026-10-21T11:00:00.000Z" });
  globalThis.fetch = async () => new Response("upstream", { status: 500 });
  try {
    const env = { CF_ACCOUNT_ID: "account", CF_ANALYTICS_TOKEN: "token", STATE: fakeKV(JSON.stringify(previous)) };
    await assert.rejects(() => refreshBudget(env, new Date("2026-10-21T12:00:00Z")), /analytics HTTP 500/);
    assert.deepEqual(await env.STATE.get("state", "json"), previous);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health reports the trip and the state endpoint requires the guard token", async () => {
  const env = { GUARD_TOKEN: "guard-token", STATE: fakeKV(JSON.stringify(state({ tripped: true, reason: "r2_class_a" }))) };

  const health = await worker.fetch(new Request("https://guard.test/healthz"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "cloudflare-spend-guard",
    tripped: true,
    reason: "r2_class_a",
    updated_at: (await env.STATE.get("state", "json")).updated_at,
  });

  const anonymous = await worker.fetch(new Request("https://guard.test/v1/state"), env);
  assert.equal(anonymous.status, 401);

  const authorized = await worker.fetch(new Request("https://guard.test/v1/state", {
    headers: { authorization: "Bearer guard-token" },
  }), env);
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).tripped, true);
});

test("manual refresh without analytics credentials is rejected, not published", async () => {
  const env = { GUARD_TOKEN: "guard-token", STATE: fakeKV() };
  const response = await worker.fetch(new Request("https://guard.test/v1/refresh", {
    method: "POST",
    headers: { authorization: "Bearer guard-token" },
  }), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).ok, false);
  assert.equal(await env.STATE.get("state", "json"), null);
});
