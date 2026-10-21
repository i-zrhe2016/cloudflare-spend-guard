# Cloudflare Spend Guard

账号级 Cloudflare 用量熔断服务。Cloudflare 的按量计费没有硬性上限，这个 Worker 是唯一的“停止花钱”状态发布者：它按账单周期读取账号级 Analytics API，任何指标达到套餐额度的设定比例后，把 `tripped` 状态写入 KV。账号内所有会产生费用的 Worker 绑定同一个 KV 命名空间，在熔断或状态过期时拒绝计费请求。

它不属于任何一个业务项目，也不需要知道有哪些项目；新增项目只要接入同一个 KV 或调用它的 HTTP 接口即可。

## 部署

```bash
npx wrangler secret put CF_ANALYTICS_TOKEN   # API Token，权限 Account Analytics: Read
npx wrangler secret put GUARD_TOKEN          # 读取 /v1/state、触发 /v1/refresh 的机器 token
npx wrangler deploy
```

KV 命名空间 `cloudflare-spend-guard`（`197abed79e214647be4b16f104ca66db`）已创建并绑定为 `STATE`。Cron `* * * * *` 每分钟刷新一次状态；刷新失败时保留上一次状态，不更新时间戳，消费方会在超过 `BUDGET_STALE_TRIP_SECONDS`（默认 900 秒）后按熔断处理。

验证：

```bash
curl https://cloudflare-spend-guard.<account>.workers.dev/healthz
curl -H "Authorization: Bearer $GUARD_TOKEN" https://cloudflare-spend-guard.<account>.workers.dev/v1/state
```

`POST /v1/refresh` 可手动触发一次刷新（同样需要 `GUARD_TOKEN`）。

## 消费方接入

**Worker（推荐）**：在 `wrangler.jsonc` 绑定同一个命名空间，读取 `state` 键：

```jsonc
"kv_namespaces": [{ "binding": "BUDGET", "id": "197abed79e214647be4b16f104ca66db" }]
```

```js
const state = await env.BUDGET.get("state", "json");
const stale = !state || Date.now() - Date.parse(state.updated_at) > 900_000;
if (!state ? REQUIRE_GUARD : state.tripped || stale) return new Response(TRIPPED_MESSAGE, { status: 503 });
```

建议给消费方加 30 秒进程内缓存，避免每个请求都读 KV；KV 读取会计入账号额度，但 30 秒缓存下量很小。

**非 Worker 脚本**：调用 `GET /v1/state`（Bearer `GUARD_TOKEN`），或在启动前读 `/healthz` 的 `tripped` 字段。`/healthz` 不含秘密。

## 状态与配置

`state` 结构：

```json
{
  "tripped": true,
  "reason": "d1_rows_read",
  "source": "analytics",
  "updated_at": "2026-10-21T12:00:00.000Z",
  "checked_at": "2026-10-21T12:00:00.000Z",
  "cycle_start": "2026-10-01T00:00:00.000Z",
  "metrics": { "d1_rows_read": { "used": 23750000000, "limit": 25000000000 } },
  "unreadable": []
}
```

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BUDGET_TRIP_PERCENT` | `95` | 达到额度的百分比即熔断 |
| `BUDGET_STALE_TRIP_SECONDS` | `900` | 状态超过该时长未刷新按熔断处理 |
| `BUDGET_CYCLE_START` | 每月 1 日 | 账单周期锚点（ISO 时间） |
| `BUDGET_D1_ROWS_READ` | 25,000,000,000 | D1 每月读取行数 |
| `BUDGET_D1_ROWS_WRITTEN` | 50,000,000 | D1 每月写入行数 |
| `BUDGET_WORKER_REQUESTS` | 10,000,000 | Workers 每月请求数 |
| `BUDGET_R2_CLASS_A` | 1,000,000 | R2 每月 Class A 操作 |
| `BUDGET_R2_CLASS_B` | 10,000,000 | R2 每月 Class B 操作 |
| `BUDGET_R2_STORAGE_BYTES` | 10,000,000,000 | R2 存储 |
| `BUDGET_D1_STORAGE_BYTES` | 5,000,000,000 | D1 存储 |

计量覆盖整账号，不区分项目：D1 读写行数与存储、Workers 请求数、R2 Class A/B 操作与存储。未知 R2 操作按 Class A 计（只会更早熔断）。单个可选指标读取失败时沿用上一次已知值并记入 `unreadable`；必需指标读取失败则整次刷新失败，状态保持旧值直至过期。

新增计费产品时在这里补数据源和默认额度即可，消费方不需要改动。

## 测试

```bash
npm test
```
