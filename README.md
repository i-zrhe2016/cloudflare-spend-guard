# Cloudflare Spend Guard

账号级 Cloudflare 用量熔断服务。

Cloudflare 的按量计费**没有硬性消费上限**：超出套餐包含额度后照常服务、照常出账。这个 Worker 是账号内唯一的“停止花钱”状态发布者——它按账单周期读取账号级用量，任一计费指标接近额度就把熔断状态写入 KV。账号内所有会产生费用的 Worker 绑定同一个命名空间并遵守这个状态，于是无需在每个项目里各做一套统计。

它不属于任何一个业务项目，也不知道有哪些项目存在；新增项目只要接入同一个 KV，或调用它的 HTTP 接口。

## 工作方式

```
Cron（每分钟）
  └─ Analytics API（账号级，账单周期起始 → 现在）
       ├─ 必需：D1 rowsRead/rowsWritten、Workers requests
       └─ 可选：D1 storage、R2 operations、R2 storage
  └─ 逐指标判定 used*100 >= limit*percent
  └─ 写入 KV state（tripped / reason / metrics / updated_at）
        └─ 各项目 Worker 每 30 秒读取，拒绝计费请求
```

### 1. 采集

每个账单周期从周期起始时间统计到现在（不是滚动 30 天，避免一次尖峰被计费整月）。数据源是 GraphQL Analytics API：

| 指标 key | 数据源 | 默认额度（Workers Paid / R2 包含量） |
| --- | --- | --- |
| `d1_rows_read` | `d1AnalyticsAdaptiveGroups.sum.rowsRead` | 25,000,000,000 / 月 |
| `d1_rows_written` | `d1AnalyticsAdaptiveGroups.sum.rowsWritten` | 50,000,000 / 月 |
| `worker_requests` | `workersInvocationsAdaptive.sum.requests` | 10,000,000 / 月 |
| `d1_storage_bytes` | `d1StorageAdaptiveGroups.max.databaseSizeBytes` | 5,000,000,000 |
| `r2_class_a` | `r2OperationsAdaptiveGroups.sum.requests` | 1,000,000 / 月 |
| `r2_class_b` | `r2OperationsAdaptiveGroups.sum.requests` | 10,000,000 / 月 |
| `r2_storage_bytes` | `r2StorageAdaptiveGroups.max.payloadSize` | 10,000,000,000 |

计量覆盖整个账号，不区分项目和 Worker。R2 操作按 `actionType` 分类：`GetObject`、`HeadObject`、`HeadBucket`、`GetBucketLocation`、`GetBucketCors`、`GetBucketEncryption`、`GetBucketLifecycleConfiguration`、`GetBucketPolicy`、`GetBucketVersioning` 算 Class B，**其余（包括未知的新操作）一律算 Class A**——误判只会让熔断更早发生，不会更晚。R2 存储按每个 bucket 取峰值再求和，避免把时间分桶的结果重复累加。

### 2. 判定

任一指标满足下面条件即熔断：

```
used × 100 ≥ limit × BUDGET_TRIP_PERCENT      // 默认 95%
```

`reason` 记录第一个命中的指标。95% 留出的 5% 是给“发现到执行”之间的窗口：Cron 每分钟刷新、消费方最多 30 秒后生效。

此外两条兜底条件同样按熔断处理：

- **状态过期**：`updated_at` 超过 `BUDGET_STALE_TRIP_SECONDS`（默认 900 秒）。guard 挂掉、Analytics 持续报错、Cron 被禁用都会走到这里。
- **状态缺失**：消费方显式配置了 `BUDGET_REQUIRE_STATE=1` 时，KV 里没有 `state` 视为熔断。生产环境应当开启，否则删掉一个键就能静默恢复计费流量。

### 3. 发布

状态写入 KV 命名空间的 `state` 键，结构：

```json
{
  "tripped": true,
  "reason": "d1_rows_read",
  "source": "analytics",
  "updated_at": "2026-10-21T12:00:00.000Z",
  "checked_at": "2026-10-21T12:00:00.000Z",
  "cycle_start": "2026-10-01T00:00:00.000Z",
  "metrics": {
    "d1_rows_read": { "used": 23750000000, "limit": 25000000000 }
  },
  "unreadable": []
}
```

即使没有熔断也会每分钟写入一次，`updated_at` 就是“guard 最后一次成功检查”的时间。

### 4. 执行

消费方读到 `tripped: true`（或状态过期/缺失）后拒绝所有计费路径。具体拦哪些路径由各项目决定；本项目接入方的做法是保留不产生费用的健康检查和静态资源，其余 `/api/*`、`/executor/*`、订阅路径、D1 网关请求全部返回 503 `budget_tripped`。

### 5. 恢复

用量回落到阈值以下（新账单周期或提升套餐）后，guard 下一次刷新发布 `tripped: false`，消费方最多 30 秒内自动恢复。没有需要人工解锁的开关。

## 消费方接入

### Worker（推荐）

绑定同一个 KV 命名空间：

```jsonc
// wrangler.jsonc
"kv_namespaces": [{ "binding": "BUDGET", "id": "197abed79e214647be4b16f104ca66db" }],
"vars": { "BUDGET_STALE_TRIP_SECONDS": "900", "BUDGET_REQUIRE_STATE": "1" }
```

```js
const state = await env.BUDGET.get("state", "json");
const tripped = !state
  ? env.BUDGET_REQUIRE_STATE === "1"
  : state.tripped === true ||
    Date.now() - Date.parse(state.updated_at) > 900_000;
if (tripped) return new Response("Cloudflare 用量已达到套餐上限，服务已熔断", { status: 503 });
```

建议在 isolate 内缓存 30 秒，避免每个请求都读 KV（KV 读取计入账号额度，但缓存后量很小）。检查要放在鉴权之后、任何 D1/R2 访问之前——包括会读 D1 的健康检查。

### 非 Worker 脚本

- `GET /v1/state`（`Authorization: Bearer $GUARD_TOKEN`）返回完整状态。
- `GET /healthz` 无需鉴权，只返回 `{ok, tripped, reason, updated_at}`，适合监控和“执行前先问一句”的脚本。
- `POST /v1/refresh`（`Authorization: Bearer $GUARD_TOKEN`）立即刷新一次，用于部署后确认，或人工核对用量。

## 部署

```bash
npx wrangler secret put CF_ANALYTICS_TOKEN   # API Token，权限 Account Analytics: Read
npx wrangler secret put GUARD_TOKEN          # /v1/state、/v1/refresh 的机器 token
npx wrangler deploy
```

部署后验证：

```bash
curl https://cloudflare-spend-guard.<account>.workers.dev/healthz
curl -H "Authorization: Bearer $GUARD_TOKEN" https://cloudflare-spend-guard.<account>.workers.dev/v1/state
```

确认 `updated_at` 是最近一分钟内的时间，且 `tripped` 符合预期。

**接入顺序**：先部署并验证 guard，再部署消费方。开启了 `BUDGET_REQUIRE_STATE` 的服务在 guard 发布第一个状态之前会一直熔断，这是有意为之。

## 手动验证熔断

不需要等真实用量。直接往 KV 写一条熔断状态，guard 下一分钟会用真实值覆盖它：

```bash
npx wrangler kv key put state --binding=STATE --remote \
  '{"tripped":true,"reason":"manual_test","source":"manual","updated_at":"2026-10-21T12:00:00Z","checked_at":"2026-10-21T12:00:00Z","cycle_start":"2026-10-01T00:00:00Z","metrics":{},"unreadable":[]}'
```

30 秒内消费方开始返回 503，`/healthz` 显示 `tripped: true`。恢复：

```bash
npx wrangler kv key delete state --binding=STATE --remote
```

或者把 `BUDGET_TRIP_PERCENT` 临时改小、重新部署，等一分钟让 guard 自己判定——恢复时改回并再部署一次。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CF_ACCOUNT_ID` | — | 要保护的账号（wrangler.jsonc 中已配置） |
| `BUDGET_TRIP_PERCENT` | `95` | 达到额度的百分比即熔断，有效范围 1–100 |
| `BUDGET_STALE_TRIP_SECONDS` | `900` | 状态超过该时长未刷新按熔断处理 |
| `BUDGET_CYCLE_START` | 每月 1 日 | 账单周期锚点（ISO 8601），与订阅日不一致时必须设置 |
| `BUDGET_D1_ROWS_READ` | 25,000,000,000 | |
| `BUDGET_D1_ROWS_WRITTEN` | 50,000,000 | |
| `BUDGET_WORKER_REQUESTS` | 10,000,000 | |
| `BUDGET_D1_STORAGE_BYTES` | 5,000,000,000 | |
| `BUDGET_R2_CLASS_A` | 1,000,000 | |
| `BUDGET_R2_CLASS_B` | 10,000,000 | |
| `BUDGET_R2_STORAGE_BYTES` | 10,000,000,000 | |

`BUDGET_<指标>` 覆盖的是**包含额度**，不是价格。升级套餐或购买附加包后改这里，不需要改代码。新增计费产品也是在这里加一个数据源和默认额度，消费方不用动。

## 失败模式与边界

- **Analytics 有分钟级延迟**：判定使用的是已经发生的用量，窗口内的超额（最多约 5% 加一分钟）无法避免，但不会被放大到持续出账。
- **可选指标读取失败**：沿用上一次已知值（只会更早熔断），并把指标记入 `unreadable`。
- **必需指标读取失败**：整次刷新失败，KV 保持旧状态；900 秒后消费方按过期熔断。
- **检查间隔 vs 消耗速度**：额度很小且流量很大的指标（例如 R2 Class A 100 万/月）理论上可能在一个刷新周期内跨过 95%，所以不要调大 Cron 间隔，也不要调大 `BUDGET_TRIP_PERCENT`。
- **未接入的项目不受管**：guard 只能保护读取它状态的 Worker。账号内任何能消耗额度、却没有绑定这个 KV 的 Worker 都必须停用或接入，否则那部分用量在熔断后仍会继续计费。
- **KV 写入额度**：每分钟一次写入约 43,200 次/月，在 Workers Paid 的 100 万次/月包含量内。

## 测试

```bash
npm test
```

覆盖：阈值判定（94% 不熔断 / 95% 熔断 / 自定义百分比）、缺失指标沿用旧值、缺失/过期/熔断状态判定、Class A/B 分类、刷新与 KV 发布、刷新失败保留旧状态、HTTP 鉴权与手动刷新。

## 目录

```
src/index.js        采集、判定、KV 发布；HTTP 接口
test/guard.test.js  单元与接口测试
wrangler.jsonc      Cron、KV 绑定、账号和阈值
```
