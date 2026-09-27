# CairnWeave

> **The provenance fabric for multi-agent systems.**

中文：[README.zh-CN.md](README.zh-CN.md)

CairnWeave is a zero-dependency, in-process CommonJS toolkit for making agent handoffs explicit: who produced a result, what was handed off, in what order, and what review state it is in.

It runs on Node.js >=18 and has no daemon, network calls, persistence layer, authentication system, or hidden I/O. You choose only the primitive your application or coding-agent workflow needs.

Previously published as **Agent Integrity Guard** / `agent-integrity-guard`. Existing APIs, CLI filenames, and serialized schema identifiers remain supported; see [Compatibility and Migration](#compatibility-and-migration).

## Quick Start

Install:

```sh
npm install cairnweave
```

Forward an external agent result without inventing missing provenance:

```js
const { relayExternalResult } = require('cairnweave');

const handoff = relayExternalResult({
  agentId: response.agentId,
  result: response.output,
  url: response.url
});
```

Only caller-supplied fields are preserved. Unknown identity, model, URL, or source remains unknown.

For ordered handoffs:

```js
const { ResultStore } = require('cairnweave');

const store = new ResultStore();
store.append('planner', { kind: 'plan' });
store.append('builder', { kind: 'patch' });
```

For claim history:

```js
const { MemoryPassport } = require('cairnweave');

const passport = new MemoryPassport();
passport.create({
  memoryId: 'claim-1',
  actorAgentId: 'observer',
  content: { status: 'checked' }
});
```

## Why It Exists

Multi-agent and coding-agent systems often pass values between tools, models, reviewers, and scripts. The hard part is not storing another object; it is keeping the handoff honest.

CairnWeave keeps that boundary small and inspectable. It helps you record explicit producer labels, append order, claim revisions, and review/dispute state without introducing a service runtime or claiming more authority than the caller supplied.

## Capability Layers

| Layer | Use when you need | What it adds | What it does not do |
| --- | --- | --- | --- |
| Relay | A minimal handoff wrapper | Preserves `agentId`, `result`, and optional `url`/`model` | Does not infer identity or provenance |
| `ResultStore` | Ordered results in one runtime | Append/read order inside a single store instance | Does not coordinate across processes or instances |
| `MemoryPassport` | Claim lifecycle | Stable `memoryId`, cloned content, caller-declared source, history, review/dispute/resolution state | Does not persist claims or authenticate sources |
| `ProjectMemory` | Project-scoped claim memory | Project membership, private-claim visibility, provenance-required writes, expiry, supersession, revisions, and an in-instance audit log | Does not provide storage, auth, network sync, or hidden import/replay |

Choose the smallest layer that makes the handoff explicit enough for your workflow.

## Typical Scenarios

- Preserve an agent response with its declared producer before passing it to another step.
- Keep ordered intermediate outputs from planner, implementer, reviewer, or verifier agents.
- Track a claim through review, dispute, and resolution without mutating its earlier history.
- Maintain project-scoped claims with visibility rules and an audit trail inside the current process.
- Wrap a coding-agent or command execution flow with `captureAgentTask()` or `captureCommandTask()` and produce a reviewable artifact.

## Boundaries and Non-Goals

CairnWeave is intentionally small.

- It is zero-dependency CommonJS for Node.js >=18.
- It is in-process only.
- It does not start a daemon.
- It does not make network calls.
- It does not persist data for you.
- It does not authenticate identities, sources, or users.
- It does not perform hidden file, shell, network, or database I/O.
- It does not turn a digest into trust. `ProjectMemory` event-log digests are consistency checks over declared event ranges, not authentication.
- It does not treat `ProjectMemory.validateEvents()` or `ProjectMemory.diagnoseEvents()` as replay, import, or authorization decisions. They validate or report diagnostics for event-log shape and consistency.

## API Selection

| If your question is... | Start with |
| --- | --- |
| "Can I forward this result without losing who the caller says produced it?" | `relayExternalResult()` |
| "Can I keep a local sequence of agent outputs?" | `ResultStore` |
| "Can I track the lifecycle of a claim?" | `MemoryPassport` |
| "Can I keep project-scoped claims with visibility, revisions, expiry, and audit events?" | `ProjectMemory` |
| "Can I capture a coding-agent task or command result for review?" | `captureAgentTask()` or `captureCommandTask()` |

## Documentation

- [API Reference and examples](docs/API.md)
- [Coding-agent integration recipe](docs/AGENT_INTEGRATION.md)
- [ProjectMemory guide](docs/PROJECT_MEMORY.md)
- [Integrity verification notes](docs/INTEGRITY_VERIFICATION.md)
- [Compatibility notes](COMPATIBILITY.md)
- [Asset verifier](docs/ASSET_VERIFY.md)
- [Memory Palace design note](docs/MEMORY_PALACE.md)

## Development and Verification

Run the test suite:

```sh
npm test
```

Run the example:

```sh
npm run example
```

See [`examples/basic.js`](examples/basic.js) for a runnable end-to-end flow.

## Compatibility and Migration

CairnWeave is the renamed package for the project previously published as **Agent Integrity Guard** / `agent-integrity-guard`.

The old API surface, CLI filenames, and serialized schema identifiers remain supported for compatibility. New integrations should prefer the current package name and the generic agent/task APIs, while existing `captureCodexTask()` and `bin/guard-codex-task.js` usage can continue during migration.

See [COMPATIBILITY.md](COMPATIBILITY.md) for the detailed migration notes.

## License

MIT
