# Agent Integrity Guard

## 给自己的 Agent：可迁移的接入资产

下面是唯一的 canonical **AGENT TASK / INTEGRATION RECIPE**。复制给 Coding Agent 或通用 Agent，让它先发现、再获授权、最后实施和验证；不要把本页后面的示例当成另一份 Recipe。

```text
AGENT TASK / INTEGRATION RECIPE — Agent Integrity Guard

资产版本与边界：适用于 agent-integrity-guard >=0.1.0 <0.2.0、Node.js >=18。安装前必须读取将实际安装版本的 package.json、README、根导出和 API 签名；版本范围不是代替检查 API 的承诺。本库是由宿主主动调用的进程内 CommonJS 库，不是常驻 daemon；不提供 persistence、network transport、authentication、authorization、signatures 或 security boundary。

目标：按宿主需求选择最小接入层，显式保留 agent 输出及可选的顺序、claim 历史和争议状态。

1. DISCOVERY（只读，先完成）：定位项目根目录和 package.json；识别 npm/pnpm/yarn/bun、对应锁文件、CJS/ESM、实际 Node 版本、现有 test/lint/typecheck/build 命令，以及宿主已有的 canonical agent identity schema。检查工作树是否有未提交修改，并确认依赖在既有约束下可用。若 Node <18、没有合适包管理器、依赖不可用或项目状态无法判断，停止并报告，不猜测、不安装、不修改。
2. AUTHORIZATION（明确确认门）：先向用户列出拟采用的接入层、将修改的文件和命令，并等待明确授权。安装依赖、修改 package.json/锁文件、修改任何生产路径或引入 identity 映射，每一类都必须在授权范围内。宿主若有未提交修改，先记录/保护它们，只改必要文件；不得覆盖或回滚用户原有修改。
3. IDENTITY：复用宿主已有 canonical agent identity。若不存在，提出稳定 ID 方案、映射位置和迁移影响，等待确认后再实现。agentId 只是调用方提供的标签，未经本库认证，不能据此断言真实身份。
4. LEVEL（按需求选择，不要求逐层全接）：
   A. 仅 relay：用 relayExternalResult 忠实转发 agentId/result，以及上游明确提供的 url/model。
   B. relay + ResultStore：需要本 ResultStore 实例内追加和读取时才使用。sequence 是该实例内的全局追加序号，不跨进程、也不跨实例。
   C. 完整 MemoryPassport：只有需要 claim 历史和 dispute/resolve 流程时使用稳定 memoryId。source.resultSequence 只是调用方的显式 provenance 声明；本库不验证被引用结果是否真实存在。
   loadBaseContext 是独立可选能力，仅在宿主确需统一加载基础上下文时接入，不能因选择 A/B/C 而默认强接。
5. IMPORT（按宿主模块系统采用准确的最小形式）：
   CommonJS: const { relayExternalResult } = require('agent-integrity-guard');
   ESM: import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { relayExternalResult } = require('agent-integrity-guard');
   调用示例：relayExternalResult({ agentId, result, ...(url !== undefined ? { url } : {}), ...(model !== undefined ? { model } : {}) }); 不推断或伪造 identity、model、URL 或 source。
6. CHANGE：在宿主现有入口/适配层做最小改动，保留其模块系统、错误处理和业务语义。开始前记录目标文件原内容或基线 git diff；持续记录本次实际改动文件。
7. VERIFICATION / STOP：运行宿主已有 test、lint、typecheck 和 build（存在者），再运行与所选层级匹配的最小 smoke test。验证 relay 字段；若使用 store，验证实例内 sequence/read；若使用 passport，验证 history/status。任一步失败，记录命令、输出和影响，停止并报告；不要擅自扩依赖、改生产设计或扩大文件范围。
8. ROLLBACK：生成可审查的 git diff。只撤回本次接入所改内容，不触碰用户先前修改；向用户给出逐文件、可审查的回滚命令或反向补丁，但不自动执行，不使用 git reset --hard、宽泛 checkout 或其他破坏性 reset。
9. REPORT（固定格式）：discovery、authorization、changes、verification、rollback、limitations。limitations 必须说明所选层级、未验证项、进程内状态，以及本库不提供 persistence/network/auth/signatures/security boundary。

完成标准：授权范围内的最小接入可运行、验证可复现、未知 provenance 保持未知、回滚范围清楚。任何前提或授权不足时，以报告结束而不是猜测。
```

### Agent 接入后到底做什么

它是一个由宿主 Agent **主动调用**的零依赖 CommonJS 正确性层：relay 忠实转发显式字段，ResultStore 在当前进程追加结果，MemoryPassport 保存 claim 的来源与争议状态。它不会自行常驻、监听消息、联网、同步或替你调度 Agent。

### 三种接入层级

1. **仅 relay**：只做诚实转发，适合先验证边界和 provenance。
2. **relay + ResultStore**：在当前实例追加，并按 agent 或该实例的全局追加序号读取结果。
3. **完整 MemoryPassport**：在前两层之上，为需要复核的 claim 管理来源、历史和 dispute/resolve 状态机。

从最小层开始，按实际需求升级；三层都不提供持久化、网络、认证或安全隔离。

Agents can disagree. They should not silently rewrite one another's history or invent provenance.

Agent Integrity Guard is a zero-dependency, in-memory CommonJS toolkit for handing results between agents while retaining who produced what, in which order, and how a disputed claim was resolved. It gives you four small primitives:

- an honest relay that copies only fields the caller supplied;
- an append-only result store partitioned by agent;
- a memory passport with an explicit dispute state machine;
- a context loader that makes every supported prompt mode load the same base files.

It is a correctness layer, not a security boundary or database. It deliberately has no persistence, network transport, authentication, authorization, signatures, or cross-process locking. An `agentId` is caller-supplied and unauthenticated.

## Shortest path

Requires Node.js 18 or newer. Run this only after the canonical Recipe's discovery and authorization gates, using the host project's selected package manager:

```sh
npm install agent-integrity-guard
```

Reuse the host's canonical agent ID. If none exists, obtain approval for a stable ID scheme first. Relay output, append it only if ordering is needed, and create a passport only for claims whose history matters:

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

This example shows the full tier; relay-only and relay-plus-store are valid smaller choices. All state is process-local. Returned objects are defensive copies, so callers cannot mutate stored history.

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
store.readAll();            // all events, in this store instance's sequence order
```

`append()` never replaces an event. Its sequence is global only within that `ResultStore` instance, not across instances or processes. A failed clone does not consume a sequence number. Values must be supported by Node's `structuredClone`.

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

Provenance is explicit per content change. `source.resultSequence` is a caller-supplied provenance declaration; the library does not verify that the referenced result exists. If an update or replacement content has no `source`, the current view has no source; the library never carries an old source forward as if it supported new content.

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

## Optional context completeness

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

## Canonical agent recipe

Use the **AGENT TASK / INTEGRATION RECIPE** at the beginning of this README. It is the sole transferable recipe; the examples below document APIs but do not weaken its discovery, authorization, verification, rollback, identity, or reporting requirements.

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
