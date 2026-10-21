# Cloudflare Spend Guard

账号级 Cloudflare 用量熔断服务。

这个 Worker 按账单周期读取账号级用量，任一已监控指标接近配置额度时，把熔断状态写入共享 KV。各项目在关键操作之前检查这个状态，停止后续 D1、R2 等资源操作，降低持续超额计费的风险。

**这是应用层熔断，不是 Cloudflare 账号的硬消费上限，不能保证绝对零超额费。** 数据采集和状态传播存在延迟；返回 503 的 Worker 调用仍可能产生请求和 CPU 用量；已有存储、已发出的操作及未接入的调用方也不会因发布状态而自动停止。95% 阈值的预留量不构成超额费用上限。

它独立于业务项目，统计范围是账号级，但执行范围仅限主动接入的调用方。新增 Worker 可以绑定同一个 KV；主机脚本和其他客户端可以查询 HTTP 接口。若要覆盖整个账号，所有可能消耗计费额度的入口都必须接入或停用；本服务不会自动接管账号内其他 Worker 或撤销其权限。

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

以上 7 项指标按账号汇总，不区分项目和 Worker。**当前未监控 Workers CPU、KV 读写及存储、Durable Objects、Queues 等其他可能计费的指标**；应按账号实际启用的产品补齐数据源和额度。接入检查不会自动补齐指标：未监控指标自身接近额度时，不会触发本服务熔断。

表中额度是代码默认值，不代表已经核实的账号套餐权益。部署时应根据实际套餐、账单周期及产品计费规则配置；套餐订阅费、附加服务固定费用也不会因熔断免除。

当前实现中，R2 操作按 `actionType` 分类：`GetObject`、`HeadObject`、`HeadBucket`、`GetBucketLocation`、`GetBucketCors`、`GetBucketEncryption`、`GetBucketLifecycleConfiguration`、`GetBucketPolicy`、`GetBucketVersioning` 算 Class B，**其余（包括未知的新操作）一律算 Class A**——误判只会让熔断更早发生，不会更晚。R2 存储按每个 bucket 取峰值再求和，避免把时间分桶的结果重复累加。

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

消费方读到 `tripped: true`（或状态过期/缺失）后，在执行关键操作前拒绝请求，通常返回 503 `budget_tripped`。具体拦哪些路径由各项目决定；健康检查和静态资源能否保留，取决于其是否继续访问受保护资源。即使直接返回 503，也不能将这次 Worker 调用视为零费用。

| 关键操作 | 检查位置和熔断行为 |
| --- | --- |
| D1 查询、写入、批量操作 | 执行 SQL 前检查，熔断时拒绝 |
| R2 上传、下载、列举、删除 | 调用 R2 前检查，熔断时拒绝 |
| KV 业务读写 | 业务操作前检查；读取熔断状态本身仍消耗 KV 读取 |
| Cron、队列及自动重试 | 每次任务开始前检查，长任务分批检查；熔断后停止处理并避免反复重试；队列须配置延迟、重试上限或暂停消费，避免重投递持续消耗 |
| 主机备份、同步及直接访问资源的客户端 | 操作前查询 guard；状态缺失、过期或查询失败时停止 |
| 外部付费 API | 发出请求前检查；若需按该 API 自身预算触发熔断，还需新增对应计量来源 |

检查应位于鉴权之后、任何受保护资源访问之前。已发送的操作通常无法撤销，长任务仅在开始时检查不足以限制后续消耗。

当前已接入的业务 Worker 是 `ai-routing-control-plane` 和 `xray-routing-panel-d1-gateway`。旧网关 `xray-routing-panel-native-t0074` 已移除；其他 Worker、主机任务和直接访问资源的客户端尚不能视为全部受保护。

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
let state = null;
try {
  state = await env.BUDGET.get("state", "json");
} catch {
  // 查询失败与状态缺失均按停止处理，避免未检查就继续操作。
}
const updatedAt = Date.parse(state?.updated_at || "");
const staleMs = Number(env.BUDGET_STALE_TRIP_SECONDS || 900) * 1000;
const tripped = !state || state.tripped === true ||
  !Number.isFinite(updatedAt) || !Number.isFinite(staleMs) || staleMs <= 0 ||
  Date.now() - updatedAt > staleMs;
if (tripped) return new Response("用量保护已熔断，暂时停止操作", { status: 503 });
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

- **Analytics 延迟与突发流量**：判定使用已经发生的用量。Cron 间隔、Analytics 延迟、KV 最终一致性及消费方缓存共同形成执行窗口；高流量可以在窗口内跨过剩余额度，超额没有由 95% 阈值推导出的固定上限。
- **可选指标读取失败**：代码会沿用上一次已知值；没有历史值的指标才记入 `unreadable`。其他指标刷新成功仍会推进整体 `updated_at`，因此可选指标可能长期停留在旧值，不能保证及时熔断。严格保护还需要逐指标新鲜度检查及读取失败时停止执行。
- **Worker 基础消耗与 guard 自身开销**：拒绝请求仍可能产生 Workers 请求和 CPU 用量；guard 的 Cron、KV 发布及消费方状态读取也会消耗额度。
- **持续存储费用**：停止资源操作不会删除已有 D1、R2、KV 数据，也不保证停止其存储费用；应另行配置容量和保留策略。
- **已发出操作与其他入口**：熔断不会撤销已提交的请求，也不会阻止未接入的脚本、直接 API/S3 客户端继续操作。
- **必需指标读取失败**：整次刷新失败，KV 保持旧状态；900 秒后消费方按过期熔断。
- **检查间隔 vs 消耗速度**：额度很小且流量很大的指标（例如 R2 Class A 100 万/月）理论上可能在一个刷新周期内跨过 95%，所以不要调大 Cron 间隔，也不要调大 `BUDGET_TRIP_PERCENT`。
- **未接入的项目不受管**：guard 只能保护读取它状态的 Worker。账号内任何能消耗额度、却没有绑定这个 KV 的 Worker 都必须停用或接入，否则那部分用量在熔断后仍会继续计费。
- **KV 写入额度**：每分钟一次发布约 43,200–44,640 次/月，仍需与账号其他 KV 使用量合并考虑，并核实实际套餐包含量。

要保证绝对零超额费，必须依赖平台明确提供、覆盖相关产品的硬消费上限，或只使用额度耗尽即拒绝且不会转为按量计费的服务，并处理持续计费资源。账单提醒、支付卡限额及本服务的应用层熔断均不能替代这一保证。

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
