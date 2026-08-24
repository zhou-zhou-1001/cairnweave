# Agent Integrity Guard

## 给自己的 Agent：先复制这段指令

你不需要手写集成。把下面完整的 **AGENT TASK / INTEGRATION RECIPE** 复制给你的 Coding Agent 或通用 Agent，让它在你的项目目录中自行完成评估、接入和验证。建议从最小接入层开始；只有确实需要跨 agent 的追加记录或争议处理时，再升级层级。

```text
AGENT TASK / INTEGRATION RECIPE — Agent Integrity Guard

目标：把 agent-integrity-guard 接入当前用户项目，用它显式保留 agent 输出、顺序和（需要时）争议状态；不要把它当成自动运行的守护进程。

执行前提与边界：
1. 先检查当前项目类型、package.json/锁文件、现有测试命令、模块系统（CommonJS/ESM）和 Node.js 版本；本包要求 Node.js 18+，并优先遵循项目现有约定。
2. 阅读 agent-integrity-guard 的 README 和 API（至少确认 relayExternalResult、ResultStore、MemoryPassport、loadBaseContext 的实际签名），不要猜 API。
3. 只在用户项目目录内修改；不要改本包源码、全局配置或其他目录，不要联网，不要引入未经用户要求的依赖或服务。

选择最短接入路径（从上到下逐级增加能力）：
4. 仅 relay（默认起点）：将外部结果交给 relayExternalResult({ agentId, result, ... })；只转发上游明确提供的 url/model，绝不推断 provenance。
5. relay + ResultStore：若需要本进程内按 agent 追加、按全局 sequence 读取的结果记录，再 append 每个 relayed result；不要宣称它提供持久化或跨进程共享。
6. 完整 MemoryPassport：若需要可复核的 claim 历史和争议流程，再用稳定 memoryId 创建 passport，source 指向 result sequence，并按 dispute/resolve 状态机处理；没有实际需求不要选这一层。

实现与验证：
7. 用项目已有的入口/适配层接入，保持现有模块系统和错误处理；不改变业务语义，不伪造 agent 身份、模型、URL 或来源。
8. 运行项目已有测试和相关 lint/typecheck/example；若没有测试，至少运行一个最小真实调用或等价 smoke test，并检查结果、sequence、history/status（按所选层级）。
9. 汇报：改了哪些用户项目文件、采用哪一接入层、运行了哪些命令及结果、未完成项/风险；明确说明 state 仅进程内（若适用），且本库不提供 persistence、network transport、authentication、authorization、signatures 或 security boundary。

完成标准：接入可运行、验证结果可复现、未知 provenance 保持未知；如果前提不满足或需要用户决定，先报告阻塞点，不擅自扩大改动范围。
```

### Agent 接入后到底做什么

它是一个由宿主 Agent **主动调用**的零依赖 CommonJS 正确性层：relay 忠实转发显式字段，ResultStore 在当前进程追加结果，MemoryPassport 保存 claim 的来源与争议状态。它不会自行常驻、监听消息、联网、同步或替你调度 Agent。

### 三种接入层级

1. **仅 relay**：只做诚实转发，适合先验证边界和 provenance。
2. **relay + ResultStore**：在当前进程追加并按 agent/全局顺序读取结果。
3. **完整 MemoryPassport**：在前两层之上，为需要复核的 claim 管理来源、历史和 dispute/resolve 状态机。

从最小层开始，按实际需求升级；三层都不提供持久化、网络、认证或安全隔离。

Agents can disagree. They should not silently rewrite one another's history or invent provenance.

Agent Integrity Guard is a zero-dependency, in-memory CommonJS toolkit for handing results between agents while retaining who produced what, in which order, and how a disputed claim was resolved. It gives you four small primitives:

- an honest relay that copies only fields the caller supplied;
- an append-only result store partitioned by agent;
- a memory passport with an explicit dispute state machine;
- a context loader that makes every supported prompt mode load the same base files.

It is a correctness layer, not a security boundary or database. It deliberately has no persistence, network transport, authentication, authorization, signatures, or cross-process locking.

## Shortest path

Requires Node.js 18 or newer.

```sh
npm install agent-integrity-guard
```

Give every agent a stable ID. Relay its output, append that output, then create a passport only for claims whose history matters:

```js
const { MemoryPassport, ResultStore, relayExternalResult } = require('agent-integrity-guard');

const relay = relayExternalResult({
  agentId: 'researcher-1',
  result: { claim: 'The deployment completed', confidence: 0.7 },
  model: 'explicit-model-name' // omit when unknown; never guess
});

const results = new ResultStore();
const stored = results.append(relay.agentId, relay);

const passports = new MemoryPassport();
passports.create({
  memoryId: 'deployment-status',
  actorAgentId: relay.agentId,
  content: relay.result,
  source: { resultSequence: stored.sequence }
});
```

That is the complete adoption path. All state is process-local. Returned objects are defensive copies, so callers cannot mutate stored history.

## Copy-paste patterns

### Relay an external result honestly

```js
const { relayExternalResult } = require('agent-integrity-guard');

const relayed = relayExternalResult({
  agentId: response.agentId,
  result: response.output,
  // Include these only if the upstream response explicitly supplied them.
  ...(response.url !== undefined ? { url: response.url } : {}),
  ...(response.model !== undefined ? { model: response.model } : {})
});
```

`agentId` and `result` must be own properties. `url` and `model` are optional own properties. Inherited and unknown fields are ignored; no identity or source is inferred.

### Keep results append-only

```js
const { ResultStore } = require('agent-integrity-guard');

const store = new ResultStore();
store.append('planner', { kind: 'plan', text: 'Inspect first' });
store.append('reviewer', { kind: 'review', text: 'Evidence missing' });

store.readAgent('planner'); // this agent's events, in append order
store.readAll();            // all events, in global sequence order
```

`append()` never replaces an event. A failed clone does not consume a sequence number. Values must be supported by Node's `structuredClone`.

### Track a claim and its provenance

```js
const { MemoryPassport } = require('agent-integrity-guard');

const passport = new MemoryPassport();
passport.create({
  memoryId: 'claim-42',
  actorAgentId: 'observer',
  content: { claim: 'Service is healthy' },
  source: { resultSequence: 1, check: 'health probe' }
});

passport.update('claim-42', {
  actorAgentId: 'observer',
  content: { claim: 'Service is degraded' },
  source: { resultSequence: 3, check: 'health probe' }
});

passport.current('claim-42');        // derived current state
passport.history('claim-42');        // lossless event history
passport.timeline('claim-42');       // safe structured summary
passport.formatTimeline('claim-42'); // one-line-per-event report
```

Provenance is explicit per content change. If an update or replacement content has no `source`, the current view has no source; the library never carries an old source forward as if it supported new content.

### Dispute and adjudicate

```js
passport.dispute('claim-42', {
  actorAgentId: 'reviewer',
  reason: 'The probe conflicts with the incident log',
  source: { resultSequence: 4 }
});

passport.resolve('claim-42', {
  adjudicatorAgentId: 'lead-reviewer',
  reason: 'The incident log and raw metrics were checked',
  decision: 'replace',
  content: { claim: 'Service had a partial outage' },
  source: { resultSequence: 5 }
});
```

The state machine is intentionally small:

```text
active --dispute--> disputed --resolve--> resolved
                         ^                    |
                         +------dispute-------+
```

- Updates are allowed while active or disputed; they never close a dispute.
- A second dispute cannot overwrite an open dispute.
- Only a disputed memory can be resolved.
- Resolution requires an adjudicator, reason, and decision.
- A resolved memory must be disputed again before its content can change.
- Reopening removes the old resolution only from `current()`; the event remains in `history()`.

## How an agent should report

When handing work back, report the observation separately from its provenance and review status. Never fill an unknown URL, model, or source with a plausible value.

```text
Claim: Service had a partial outage.
Produced by: researcher-1
Provenance: result sequence 5; raw metrics explicitly inspected
Passport: claim-42, sequence 4, status resolved
Dispute: resolved by lead-reviewer — incident log and raw metrics checked
Limitations: no authenticated identity; state exists only in this process
```

If a dispute is still open, say so prominently and report both the current claim and the dispute reason. Do not describe disputed content as settled. Use `formatTimeline()` for a compact audit handoff; it collapses untrusted whitespace and omits arbitrary content/source values. Use `history()` only where the receiver is meant to inspect full payloads.

## Context completeness

If an agent runner has several prompt modes, inject its own file reader and load the same base context in each:

```js
const fs = require('node:fs/promises');
const { loadBaseContext } = require('agent-integrity-guard');

const context = await loadBaseContext({
  promptMode: 'worker', // default, compact, or worker
  readFile: (filename) => fs.readFile(filename, 'utf8')
});
```

Every supported mode requests `AGENTS.md`, `SOUL.md`, and `USER.md` in that order. Reading is injected because filesystem location and missing-file policy belong to the host application.

## Self-contained agent recipe

Inspired by EvoMap-style transferable instructions, the block below can be pasted into another agent's task. It requires only Node.js 18+ and this package.

```text
INTEGRITY RECIPE
1. Use CommonJS: require('agent-integrity-guard').
2. Assign each producer a stable, non-empty agentId.
3. Pass external output through relayExternalResult({ agentId, result, ...explicitProvenance }).
   Include url/model only when the upstream value is explicit. Never infer them.
4. Append every relayed result to one ResultStore. Keep the returned global sequence.
5. For a claim that may be reused, create one MemoryPassport record whose source points
   to that result sequence. Use a stable memoryId.
6. Never mutate old records. Call update for new content, dispute for conflicting evidence,
   and resolve only after review with an explicit adjudicator, reason, and decision.
7. Treat current().status === 'disputed' as unresolved. A resolved claim must be reopened
   with dispute before it can change.
8. In the final report include: claim, producer agentId, explicit source (or "not supplied"),
   memoryId/sequence/status, open dispute or resolution, and limitations.
9. Do not claim persistence, authentication, authorization, signatures, or network safety.
10. Hand off formatTimeline(memoryId) plus any authorized full result separately.
```

## API reference

- `relayExternalResult(input)` returns defensive copies of the explicitly allowed fields.
- `new ResultStore()` provides `append(agentId, event)`, `readAgent(agentId)`, and `readAll()`.
- `new MemoryPassport()` provides `create`, `update`, `dispute`, `resolve`, `current`, `history`, `timeline`, and `formatTimeline`.
- `BASE_CONTEXT_FILES` is the frozen base manifest.
- `loadBaseContext({ promptMode, readFile })` loads that manifest for `default`, `compact`, or `worker`.

All APIs are exported from the package root. See [`examples/basic.js`](examples/basic.js) for a runnable flow.

## Development

```sh
npm test
npm run example
```

Changes should preserve CommonJS, zero dependencies, append-only history, explicit provenance, the state machine, and defensive copies. Add a regression test for every changed invariant.

## License

MIT
