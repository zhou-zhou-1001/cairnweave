# Agent Integrity Guard

> **Coding Agent entry:** Integrate the smallest suitable layer from this repository. Ask before changing dependencies or production paths, then test and report changes, verification, rollback, and limitations. See the [complete integration recipe](docs/AGENT_INTEGRATION.md).
>
> 中文版：[README.zh-CN.md](README.zh-CN.md)

A zero-dependency, in-process CommonJS toolkit that adds explicit producer labels, ordering, claim history, and adjudication status to agent result handoffs.

## Features

- **Zero dependencies:** Node.js 18+ with no runtime packages.
- **In-process and side-effect free:** no daemon, network, persistence, authentication, or hidden I/O.
- **Progressive primitives:** adopt Relay, `ResultStore`, or `MemoryPassport` only as needed.
- **Explicit provenance:** unknown identity, model, URL, and source remain unknown.
- **Defensive history:** cloned values, append-only records, and controlled review/dispute transitions.
- **Agent-neutral task capture:** a generic core and command adapter, with the existing Codex entry retained as a compatibility adapter.

## Installation

```sh
npm install agent-integrity-guard
```

## 30-second start

```js
const { relayExternalResult } = require('agent-integrity-guard');
const relayed = relayExternalResult({
  agentId: response.agentId, result: response.output, url: response.url
});
```

Only explicitly supplied fields are forwarded; the library never invents identity or provenance.

## Choose the smallest layer

### Relay

Faithfully forwards `agentId`, `result`, and optional `url`/`model` when a handoff only needs honest field preservation.

```js
relayExternalResult({ agentId: 'planner', result: { ok: true } });
```

### ResultStore

Adds append/read ordering within one store instance. Sequence numbers do not span instances or processes.

```js
new ResultStore().append('planner', { kind: 'plan' });
```

### MemoryPassport

Tracks claim content, caller-declared source, complete history, and review/dispute lifecycle under a stable `memoryId`.

```js
new MemoryPassport().create({ memoryId: 'claim-1', actorAgentId: 'observer', content: { ok: true } });
```

The state machine is `active -> disputed -> resolved`; both `requestReview()` and `dispute()` enter `disputed`.

## Coding agent integration

This library is designed for coding agents as well as direct application use. Agents should inspect the host, request authorization, choose the smallest layer, verify the integration, and provide a scoped rollback. Copy the [canonical recipe and handoff format](docs/AGENT_INTEGRATION.md).

The generic API is `captureAgentTask({ agentId, run, ... })`; `captureCommandTask({ command, args, ... })` supplies a dependency-free command adapter. The CLI equivalent is `bin/guard-agent-task.js`. Existing `captureCodexTask()` and `bin/guard-codex-task.js` behavior remain available for compatibility.

## Tools and design notes

- **API and context loader:** detailed examples, event semantics, source rules, and optional `loadBaseContext` usage are in [docs/API.md](docs/API.md).
- **Asset verifier:** the local CLI validates supported Gene declarations with strict path and command boundaries; see [docs/ASSET_VERIFY.md](docs/ASSET_VERIFY.md).
- **Memory Palace:** the proposed append-only persistence and hash-chain design is in [docs/MEMORY_PALACE.md](docs/MEMORY_PALACE.md).

## Development

```sh
npm test
npm run example
```

See [`examples/basic.js`](examples/basic.js) for a runnable flow.

## License

MIT
