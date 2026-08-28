# API Reference / API 参考

Agent Integrity Guard is a dependency-free, in-process CommonJS correctness layer. It does not persist, transmit, authenticate, authorize, or sign data. Root exports also include the generic task APIs `captureAgentTask`, `captureCommandTask`, and `resolveCapturedTask`; `captureCodexTask` is retained for compatibility.

Agent Integrity Guard 是零依赖、进程内的 CommonJS 正确性层。它不持久化、传输、认证、授权或签名数据。根导出还包括通用任务 API `captureAgentTask`、`captureCommandTask`、`resolveCapturedTask`；`captureCodexTask` 继续作为兼容 API。

### Guarded task capture

`captureAgentTask()` injects an agent-neutral `run` function. Generic artifacts use schema `agent-integrity-guard/agent-task`, runner identity `agent-task-runner`, memory IDs prefixed with `agent-task-`, and `process.agent`. `captureCommandTask()` runs a command with `shell: false`, passes the prompt on stdin, and returns the same artifact shape. `resolveCapturedTask()` accepts both generic artifacts and legacy Codex artifacts so existing review lifecycles remain valid.

```js
const { captureCommandTask } = require('agent-integrity-guard');
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
const { relayExternalResult } = require('agent-integrity-guard');

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
const { ResultStore } = require('agent-integrity-guard');
const store = new ResultStore();
store.append('planner', { kind: 'plan', text: 'Inspect first' });
store.append('reviewer', { kind: 'review', text: 'Evidence missing' });
store.readAgent('planner');
store.readAll();
```

`append()` is append-only and returns defensive copies. Its sequence is global only within this store instance, not across instances or processes. Values must be supported by Node `structuredClone`; a failed clone does not consume a sequence number.

### MemoryPassport

```js
const { MemoryPassport } = require('agent-integrity-guard');
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

## API 示例

### Relay：诚实转发

```js
const { relayExternalResult } = require('agent-integrity-guard');

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
const { ResultStore } = require('agent-integrity-guard');
const store = new ResultStore();
store.append('planner', { kind: 'plan', text: 'Inspect first' });
store.append('reviewer', { kind: 'review', text: 'Evidence missing' });
store.readAgent('planner');
store.readAll();
```

`append()` 不替换事件并返回防御性副本。sequence 只在本 `ResultStore` 实例内全局有效，不跨实例或进程；值必须受 Node `structuredClone` 支持，克隆失败不会消耗序号。

### MemoryPassport：记录 claim 与争议

```js
const { MemoryPassport } = require('agent-integrity-guard');
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

### Optional context loader

```js
const fs = require('node:fs/promises');
const { loadBaseContext } = require('agent-integrity-guard');
const context = await loadBaseContext({
  promptMode: 'worker',
  readFile: (filename) => fs.readFile(filename, 'utf8')
});
```

Supported modes are `default`, `compact`, and `worker`; each requests `AGENTS.md`, `SOUL.md`, and `USER.md` in that order. The host supplies file reading and missing-file policy.

### 可选 context loader

```js
const fs = require('node:fs/promises');
const { loadBaseContext } = require('agent-integrity-guard');
const context = await loadBaseContext({
  promptMode: 'worker',
  readFile: (filename) => fs.readFile(filename, 'utf8')
});
```

支持 `default`、`compact`、`worker` 三种模式；每种都会按顺序请求 `AGENTS.md`、`SOUL.md`、`USER.md`。文件读取和缺失文件策略由宿主提供。
