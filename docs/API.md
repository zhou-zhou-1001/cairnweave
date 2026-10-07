# API Reference / API 参考

CairnWeave is a dependency-free, in-process CommonJS correctness layer. It does not persist, transmit, authenticate, authorize, or sign data. Root exports also include the generic task APIs `captureAgentTask`, `captureCommandTask`, and `resolveCapturedTask`; `captureCodexTask` is retained for compatibility.

The protocol API is exposed at `require('cairnweave/protocol')` and as the non-enumerable `require('cairnweave').protocol` namespace. It includes the bounded injected-stream NDJSON adapter. See [Protocol Core](PROTOCOL.md).

CairnWeave 是零依赖、进程内的 CommonJS 正确性层。它不持久化、传输、认证、授权或签名数据。根导出还包括通用任务 API `captureAgentTask`、`captureCommandTask`、`resolveCapturedTask`；`captureCodexTask` 继续作为兼容 API。

协议 API 位于 `require('cairnweave/protocol')`，也可通过不可枚举的 `require('cairnweave').protocol` 使用，其中包含有界的注入 stream NDJSON adapter。参见[中文协议文档](PROTOCOL.zh-CN.md)。

### Guarded task capture

`captureAgentTask()` injects an agent-neutral `run` function. Generic artifacts use schema `agent-integrity-guard/agent-task`, runner identity `agent-task-runner`, memory IDs prefixed with `agent-task-`, and `process.agent`. `captureCommandTask()` runs a command with `shell: false`, passes the prompt on stdin, and returns the same artifact shape. `resolveCapturedTask()` accepts both generic artifacts and legacy Codex artifacts so existing review lifecycles remain valid.

```js
const { captureCommandTask } = require('cairnweave');
const artifact = await captureCommandTask({
  cwd: process.cwd(), taskId: 'task-1', prompt: 'input',
  command: 'my-agent', args: ['--json'], agentId: 'my-agent'
});
```

### 通用受控任务捕获

`captureAgentTask()` 注入 Agent 中立的 `run` 函数。通用 artifact 使用 schema `agent-integrity-guard/agent-task`、runner identity `agent-task-runner`、`agent-task-` 前缀 memory ID 与 `process.agent`。`captureCommandTask()` 以 `shell: false` 执行命令，并通过 stdin 传入 prompt。`resolveCapturedTask()` 同时接受通用 artifact 和旧 Codex artifact，确保既有 review 生命周期可继续使用。

## API examples

### Relay

```js
const { relayExternalResult } = require('cairnweave');

const relayed = relayExternalResult({
  agentId: response.agentId,
  result: response.output,
  ...(response.url !== undefined ? { url: response.url } : {}),
  ...(response.model !== undefined ? { model: response.model } : {})
});
```

`agentId` and `result` must be own properties. `url` and `model` are optional own properties. Unknown and inherited fields are ignored; no identity or source is inferred.

### ResultStore

```js
const { ResultStore } = require('cairnweave');
const store = new ResultStore();
store.append('planner', { kind: 'plan', text: 'Inspect first' });
store.append('reviewer', { kind: 'review', text: 'Evidence missing' });
store.readAgent('planner');
store.readAll();
```

`append()` is append-only and returns defensive copies. Its sequence is global only within this store instance, not across instances or processes. Values must be supported by Node `structuredClone`; a failed clone does not consume a sequence number.

### MemoryPassport

```js
const { MemoryPassport } = require('cairnweave');
const passport = new MemoryPassport();
passport.create({
  memoryId: 'claim-42', actorAgentId: 'observer',
  content: { claim: 'Service is healthy' },
  source: { resultSequence: 1, check: 'health probe' }
});
passport.update('claim-42', {
  actorAgentId: 'observer',
  content: { claim: 'Service is degraded' },
  source: { resultSequence: 3, check: 'health probe' }
});
passport.requestReview('claim-42', {
  actorAgentId: 'reviewer', reason: 'Routine independent verification',
  source: { resultSequence: 4, check: 'compared health probe with raw metrics' }
});
passport.resolve('claim-42', {
  adjudicatorAgentId: 'lead-reviewer', reason: 'Checked raw metrics',
  decision: 'replace', content: { claim: 'Service had a partial outage' },
  source: { resultSequence: 5 }
});
passport.current('claim-42');
passport.history('claim-42');
passport.timeline('claim-42');
passport.formatTimeline('claim-42');
```

The state machine is `active -> disputed -> resolved`; both `requestReview()` and `dispute()` open the pending-adjudication (`disputed`) state. Use `requestReview()` for routine independent verification: it records a `review` event and requires an explicit, non-null `source` as evidence. `dispute()` remains backward compatible for conflict reports, including older calls without `source`, though evidence-bearing disputes are strongly recommended. A resolved memory must be reviewed or disputed again before content changes. Updates do not close an open review/dispute, and history retains every event. `source.resultSequence` is caller-declared and unverified. If new content has no source, an old source is not carried forward.

For a conflicting claim, call `dispute()` instead of `requestReview()`; only one review or dispute may be open at a time.

### ProjectMemory

`new ProjectMemory({ projectId, principalId, authorizedPrincipals, clock })` accepts an optional zero-argument `clock` that returns a valid `Date`. Time-sensitive operations take one snapshot, used consistently for expiry and mutation event timestamps. Audit events are tagged with `eventSchema: 'cairnweave/project-memory-event'`, `eventVersion: 1`, global `seq`, and per-claim `revision`. `ProjectMemory.validateEvents(events, { projectId? })` validates and defensively clones a complete event log for a future replay adapter; it does not import or expose events. `ProjectMemory.diagnoseEvents(events, { projectId? })` is its non-throwing, error-collecting companion: it returns `{ valid, errors }` with stable `{ code, message, path, index?, seq? }` entries, follows the same validation boundary as `validateEvents()`, and never echoes claim identifiers or claim content. Diagnostics are structural/semantic findings, not authorization decisions. `ProjectMemory.canonicalizeEvents(events, { projectId? })` returns a versioned, domain-separated canonical JSON string after validation; it recursively sorts object keys by UTF-16 code units, preserves arrays, emits no whitespace, includes every validated event field, and rejects values that JSON would omit or cannot safely represent. This narrow contract is JCS-inspired but does not claim full RFC 8785 compliance. `ProjectMemory.computeEventLogDigest(events, { projectId? })` returns lowercase SHA-256 hex over the canonical UTF-8 bytes. `ProjectMemory.verifyEventLogDigest(events, expectedDigest, { projectId? })` requires a 64-character lowercase hex digest and returns only the explicit boolean comparison result. `ProjectMemory.computeEventLogRangeDigest(events, fromSeq, toSeq, { projectId? })` returns the digest over the inclusive closed range `fromSeq..toSeq` of a complete validated log; a full-range call (`1..length`) is byte-identical to `computeEventLogDigest`, and a range that is reversed, non-integral, or beyond the log is rejected. `ProjectMemory.verifyAuthorityContextEventLog(context, events, { projectId? })` checks a bound authority snapshot against a concrete complete log and returns a consumable result: `{ valid, range: { fromSeq, toSeq, eventCount, withinLog }, digest?: { algorithm, verified } }`, with `errors` listed when invalid. The context must first pass `normalizeBoundAuthorityContext`; when it declares `eventLogDigest`, the verifier recomputes it over exactly the declared range and reports `verified: false` on mismatch. It never requires `toSeq === eventCount` (even for `coverageIntent: 'complete'`), does not select or activate snapshots, and adds no winner/latest semantics. `ProjectMemory.normalizeBoundAuthorityContext(context, { projectId? })` validates an authority snapshot ID, a closed inclusive `fromSeq`/`toSeq` coverage description, optional `coverageMode: 'closed'`, optional `coverageIntent: 'complete' | 'partial'`, optional caller-supplied `eventLogDigest: { algorithm: 'sha256', digest }` metadata, and optional explicit `supersedes: { authorityContextId, projectId, fromSeq, toSeq }` lineage. A superseded target must have a different ID and the same project and exact range; normalization does not resolve, activate, invalidate, or choose between snapshots. `ProjectMemory.normalizeAuthorityContextLineage(contexts, { projectId? })` validates a supplied self-contained set of one or more linear chains, rejecting absent or mismatched targets, duplicate IDs, multiple successors, and cycles. `ProjectMemory.normalizeAuthorityContextChain(contexts, { projectId? })` additionally requires exactly one root for a non-empty set, ensuring one connected chain without inferring links or selecting a head. `ProjectMemory.normalizeAuthorityContextRanges(contexts, { projectId? })` returns a defensively copied, range-sorted set and rejects duplicate IDs, mixed projects, overlaps, and gaps. If one range declares `coverageIntent`, all must declare the same value; `complete` must start at `seq: 1`, and its final finite `toSeq` is the asserted upper boundary. Omission preserves legacy behavior without asserting completeness. Neither method represents open-ended/latest ranges. Digest metadata is not part of an event log and is excluded from canonicalization. Digest equality is not authentication, a signature, or proof of authorship. See the [ProjectMemory guide](PROJECT_MEMORY.md) for lifecycle, visibility, validation, and replay boundaries.

## API 示例

### Relay：诚实转发

```js
const { relayExternalResult } = require('cairnweave');

const relayed = relayExternalResult({
  agentId: response.agentId,
  result: response.output,
  ...(response.url !== undefined ? { url: response.url } : {}),
  ...(response.model !== undefined ? { model: response.model } : {})
});
```

`agentId` 与 `result` 必须是对象自身属性；`url`、`model` 是可选自身属性。未知属性和继承属性会被忽略；库不会推断 identity 或 source。

### ResultStore：保持追加顺序

```js
const { ResultStore } = require('cairnweave');
const store = new ResultStore();
store.append('planner', { kind: 'plan', text: 'Inspect first' });
store.append('reviewer', { kind: 'review', text: 'Evidence missing' });
store.readAgent('planner');
store.readAll();
```

`append()` 不替换事件并返回防御性副本。sequence 只在本 `ResultStore` 实例内全局有效，不跨实例或进程；值必须受 Node `structuredClone` 支持，克隆失败不会消耗序号。

### MemoryPassport：记录 claim 与争议

```js
const { MemoryPassport } = require('cairnweave');
const passport = new MemoryPassport();
passport.create({
  memoryId: 'claim-42', actorAgentId: 'observer',
  content: { claim: 'Service is healthy' },
  source: { resultSequence: 1, check: 'health probe' }
});
passport.update('claim-42', {
  actorAgentId: 'observer',
  content: { claim: 'Service is degraded' },
  source: { resultSequence: 3, check: 'health probe' }
});
passport.requestReview('claim-42', {
  actorAgentId: 'reviewer', reason: '例行独立复核',
  source: { resultSequence: 4, check: '将健康探针与原始指标对照' }
});
passport.resolve('claim-42', {
  adjudicatorAgentId: 'lead-reviewer', reason: 'Checked raw metrics',
  decision: 'replace', content: { claim: 'Service had a partial outage' },
  source: { resultSequence: 5 }
});
passport.current('claim-42');
passport.history('claim-42');
passport.timeline('claim-42');
passport.formatTimeline('claim-42');
```

状态机为 `active -> disputed -> resolved`；`requestReview()` 与 `dispute()` 都会进入等待裁决的 `disputed` 状态。例行独立复核使用 `requestReview()`：它记录 `review` 事件，并强制提供显式且非 null 的 `source` 证据。`dispute()` 继续兼容冲突争议及旧版未带 `source` 的调用，但强烈建议争议也附证据。resolved memory 必须先再次 review 或 dispute 才能改变内容。更新不会关闭已打开的复核/争议，history 保留每个事件。`source.resultSequence` 是调用方声明且未验证的 provenance；新内容没有 source 时，旧 source 不会被冒充为新来源。

遇到冲突 claim 时，应使用 `dispute()` 代替 `requestReview()`；同一时间只能打开一个复核或争议。

### ProjectMemory

`new ProjectMemory({ projectId, principalId, authorizedPrincipals, clock })` 接受可选的零参数 `clock`，该函数须返回有效 `Date`。时间敏感操作只获取一次快照，并一致用于过期判断及 mutation 事件时间戳。审计事件带有 `eventSchema: 'cairnweave/project-memory-event'`、`eventVersion: 1`、全局 `seq` 与按 claim 递增的 `revision`。`ProjectMemory.validateEvents(events, { projectId? })` 可为未来 replay adapter 校验完整事件日志并返回防御性副本；它不会导入或暴露事件。`ProjectMemory.diagnoseEvents(events, { projectId? })` 是其不抛错、收集错误的伴生方法：返回 `{ valid, errors }`，条目为稳定的 `{ code, message, path, index?, seq? }`，遵循与 `validateEvents()` 相同的校验边界，且绝不回显 claim 标识或 claim 内容。诊断只是结构/语义结果，不是授权决策。`ProjectMemory.canonicalizeEvents(events, { projectId? })` 在校验后返回带版本与 domain separation 的 canonical JSON 字符串；对象 key 按 UTF-16 code unit 递归排序，数组顺序不变，不输出空白，纳入每个已校验事件字段，并拒绝会被 JSON 省略或无法安全表示的值。该窄合约受 JCS 启发，但不声称完整符合 RFC 8785。`ProjectMemory.computeEventLogDigest(events, { projectId? })` 对 canonical UTF-8 字节返回小写 SHA-256 十六进制值。`ProjectMemory.verifyEventLogDigest(events, expectedDigest, { projectId? })` 要求 64 字符小写十六进制 digest，并只返回显式比较的布尔结果。`ProjectMemory.computeEventLogRangeDigest(events, fromSeq, toSeq, { projectId? })` 返回完整已验证日志中闭合区间 `fromSeq..toSeq`（两端包含）的 digest；全区间调用（`1..length`）与 `computeEventLogDigest` 字节一致，而反向、非整数或超出日志长度的区间会被拒绝。`ProjectMemory.verifyAuthorityContextEventLog(context, events, { projectId? })` 把受约束的权限快照与具体完整日志做一致性校验，返回可消费结果：`{ valid, range: { fromSeq, toSeq, eventCount, withinLog }, digest?: { algorithm, verified } }`，无效时附带 `errors`。context 必须先通过 `normalizeBoundAuthorityContext`；当它声明 `eventLogDigest` 时，校验器会按声明的精确区间重新计算并比对，不匹配时返回 `verified: false`。它从不要求 `toSeq === eventCount`（即使 `coverageIntent: 'complete'` 也不要求），不选择或激活任何快照，也不添加 winner/latest 语义。`ProjectMemory.normalizeBoundAuthorityContext(context, { projectId? })` 校验权限快照 ID、闭合且包含端点的 `fromSeq`/`toSeq` 覆盖描述、可选的 `coverageMode: 'closed'`、可选的 `coverageIntent: 'complete' | 'partial'`、可选的调用方提供的 `eventLogDigest: { algorithm: 'sha256', digest }` 元数据，以及可选的显式 `supersedes: { authorityContextId, projectId, fromSeq, toSeq }` lineage。被替代目标必须使用不同 ID，并具有相同项目和精确范围；规范化不会解析、激活、失效或选择快照。`ProjectMemory.normalizeAuthorityContextLineage(contexts, { projectId? })` 校验给定的自包含集合，其中可包含一条或多条独立线性 chain，并拒绝缺失或不匹配的目标、重复 ID、多个 successor 与 cycle。`ProjectMemory.normalizeAuthorityContextChain(contexts, { projectId? })` 还要求非空集合恰有一个 root，以保证单一连通 chain，同时不推断链接或选择 head。`ProjectMemory.normalizeAuthorityContextRanges(contexts, { projectId? })` 返回防御性复制且按范围排序的集合，并拒绝重复 ID、混合项目、重叠和缺口。任一范围声明 `coverageIntent` 时，所有范围必须声明相同值；`complete` 必须从 `seq: 1` 开始，最后一个有限 `toSeq` 是其声明的上边界。省略字段保持旧行为，不作完整性声明。两者都不表示 open-ended/latest 范围。digest 元数据不属于事件日志，因此不参与 canonicalization。digest 相等不是身份认证、签名或作者证明。生命周期、可见性、校验及 replay 边界详见 [ProjectMemory 指南](PROJECT_MEMORY.md)。

### Optional context loader

```js
const fs = require('node:fs/promises');
const { loadBaseContext } = require('cairnweave');
const context = await loadBaseContext({
  promptMode: 'worker',
  readFile: (filename) => fs.readFile(filename, 'utf8')
});
```

Supported modes are `default`, `compact`, and `worker`; each requests `AGENTS.md`, `SOUL.md`, and `USER.md` in that order. The host supplies file reading and missing-file policy.

### 可选 context loader

```js
const fs = require('node:fs/promises');
const { loadBaseContext } = require('cairnweave');
const context = await loadBaseContext({
  promptMode: 'worker',
  readFile: (filename) => fs.readFile(filename, 'utf8')
});
```

支持 `default`、`compact`、`worker` 三种模式；每种都会按顺序请求 `AGENTS.md`、`SOUL.md`、`USER.md`。文件读取和缺失文件策略由宿主提供。
