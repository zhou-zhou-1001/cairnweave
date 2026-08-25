# Memory Palace Integration Design / Memory Palace 对接设计

## Memory Palace integration design (not implemented)

- Persist each Passport event as one append-only `memory_events` row: `event_id`, `memory_id`, per-memory `seq`, `event_type`, `actor_agent_id`, `timestamp`, and canonicalized `payload`. Map both `review` and `dispute` to the pending-adjudication state when projecting current memory state.
- Store provenance from `payload.source` separately from authenticated identity: it is caller-declared evidence, not proof. Preserve the complete JSON while optionally indexing `resultSequence`, artifact identifiers, and check type.
- Add `prev_hash` and `event_hash`, computed from a versioned canonical serialization of immutable row fields. Enforce unique `(memory_id, seq)` and `event_id`; append and expected previous hash must be checked in one transaction to prevent concurrent forks.
- Rebuild current state from the event log and treat snapshots as disposable projections. Ingestion should be idempotent by `event_id`; imports must reject sequence gaps, hash mismatches, illegal transitions, and `resolve` without an open `review`/`dispute`.
- Keep trust boundaries explicit: Memory Palace persistence and hash chaining provide tamper evidence, not actor authentication. Signing, key management, authorization, cross-store ordering, and migration of existing in-memory histories need separate protocols before production integration.

## 对接 Memory Palace 的设计（本次未实现）

- 每个 Passport 事件对应 `memory_events` 的一行 append-only 记录：`event_id`、`memory_id`、memory 内 `seq`、`event_type`、`actor_agent_id`、`timestamp` 和规范化后的 `payload`。投影当前状态时，`review` 与 `dispute` 都映射到等待裁决状态。
- 将 `payload.source` provenance 与已认证身份分开：它是调用方声明的证据，不是身份证明。保留完整 JSON，同时可索引 `resultSequence`、artifact ID 与检查类型。
- 增加 `prev_hash` 和 `event_hash`，基于带版本号的规范序列化和不可变行字段计算。对 `(memory_id, seq)` 与 `event_id` 设唯一约束；追加与预期前序 hash 检查必须处于同一事务，防止并发分叉。
- 当前状态由事件日志重放得到，snapshot 仅作可丢弃投影。按 `event_id` 幂等导入；遇到序号缺口、hash 不匹配、非法转换，或没有开放 review/dispute 就 resolve 时拒绝写入。
- 明确信任边界：Memory Palace 持久化与 hash chain 只能提供篡改可见性，不能认证 actor。签名、密钥管理、授权、跨库排序和现有内存历史迁移，都需要在生产接入前另定协议。
