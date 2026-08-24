# Agent Integrity Guard

> **Coding Agent entry:** Read https://github.com/zhou-zhou-1001/agent-integrity-guard and integrate the smallest suitable layer into this project. Ask before changing dependencies or production paths. Run tests and report changes, verification, rollback, and limitations.
>
> 中文版：[README.zh-CN.md](README.zh-CN.md)

The sentence above is an entry point, not an authorization bypass. An agent must still inspect the actual host `package.json`, module system, package API, and user approval before making changes. This repository is a transferable integration asset, not a skill package; do not use `npx skills add` to install it.

## Canonical agent recipe

Copy this recipe to a Coding Agent. It is the one canonical integration recipe; the examples later are API documentation, not a second recipe.

```text
AGENT TASK / INTEGRATION RECIPE — Agent Integrity Guard

VERSION AND BOUNDARY: For agent-integrity-guard >=0.1.0 <0.2.0 and Node.js >=18. Before installation, read the package.json, README, root exports, and actual API signatures for the version that will really be used. A version range never replaces API inspection. This is a dependency-free, in-process CommonJS library actively called by the host; it is not a daemon and provides no persistence, network transport, authentication, authorization, signatures, or security boundary.

1. DISCOVERY (read-only first): Find the project root and package.json. Identify the package manager and lockfile, CJS/ESM mode, actual Node version, existing test/lint/typecheck/build commands, and the host's canonical agent-identity schema. Inspect uncommitted work and confirm that the dependency is compatible with existing constraints. If Node is below 18, the package manager is unclear, the dependency is unavailable, or the project state cannot be determined: stop and report; do not guess, install, or edit.
2. AUTHORIZATION GATE: Before editing, tell the user the proposed layer, files, and commands, then wait for explicit approval. Installing a dependency, changing package.json/lockfiles, changing production paths, and adding an identity mapping each require approval within scope. Preserve existing uncommitted work and edit only what is necessary.
3. IDENTITY: Reuse the host's canonical agent identity. If none exists, propose a stable ID, mapping location, and migration impact and wait for approval. agentId is a caller-supplied label; it is not authenticated by this library and cannot prove real identity.
4. CHOOSE THE SMALLEST LAYER (do not force all three):
   A. RELAY ONLY: call relayExternalResult to faithfully forward agentId/result and upstream-supplied url/model.
   B. RELAY + RESULTSTORE: add ResultStore only when this ResultStore instance needs append/read ordering. sequence is global only inside that instance, never across instances or processes.
   C. MEMORYPASSPORT: add MemoryPassport only when claim history and dispute/resolve workflow are needed. Use a stable memoryId. source.resultSequence is an explicit caller provenance declaration; this library does not verify that the referenced result exists.
   loadBaseContext is independent and optional; use it only when the host needs one base-context loader, never automatically because A/B/C was selected.
5. IMPORT (use the host's real module system; do not guess):
   CommonJS: const { relayExternalResult } = require('agent-integrity-guard');
   ESM: import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { relayExternalResult } = require('agent-integrity-guard');
   Example: relayExternalResult({ agentId, result, ...(url !== undefined ? { url } : {}), ...(model !== undefined ? { model } : {}) }); Never invent identity, model, URL, or source.
6. CHANGE: Make the smallest edit in the host's existing entry/adapter layer. Preserve its module system, errors, and business semantics. Record the baseline (for example, a scoped git diff or copies of target files) and track every file changed by this integration.
7. VERIFICATION / STOP: Run the host's existing test, lint, typecheck, and build commands when present, then a smallest smoke test for the selected layer. Verify relay fields; for ResultStore verify instance-local sequence/read; for MemoryPassport verify history/status. On any failure, record command, output, and impact, stop, and report. Do not widen dependencies, production design, or file scope.
8. ROLLBACK: Produce a reviewable git diff. Revert only this integration's changes, never the user's earlier work. Give per-file rollback commands or a reverse patch for review, but do not execute it automatically and never use git reset --hard, broad checkout, or destructive reset.
9. REPORT (fixed headings): discovery, authorization, changes, verification, rollback, limitations. Limitations must name the selected layer, unverified items, process-local state, and the absence of persistence, network, authentication, authorization, signatures, and security boundary.

DONE means: the approved minimal integration runs, verification is reproducible, unknown provenance remains unknown, and rollback scope is clear. If a prerequisite or approval is missing, end with a report rather than guessing.
```

## What this library is

Agent Integrity Guard is a zero-dependency, in-memory CommonJS toolkit for a host agent to hand off results while retaining explicit producer labels, instance-local order, claim history, and dispute status. It is actively called by the host process: it does not listen, sync, schedule, persist, authenticate, authorize, sign, or transmit anything. `agentId` is caller-supplied and unauthenticated. This is a correctness layer, not a database or security boundary.

The design is informed by patterns seen in EvoMap-style quickstarts, agent skills, and Evolver documentation, but this library is independent and makes no affiliation or compatibility claim.

## Installation and shortest path

Requires Node.js 18+. After the recipe's discovery and authorization gates, use the host project's package manager:

```sh
npm install agent-integrity-guard
```

The package is CommonJS (`package.json` has `"type": "commonjs"`). It has no runtime dependencies. For an ESM host, use the accurate bridge shown in the recipe rather than assuming a named ESM export.

Start at the smallest layer:

1. **Relay only** — honest forwarding of explicitly supplied fields.
2. **Relay + `ResultStore`** — append/read events in one store instance.
3. **`MemoryPassport`** — claim history plus dispute/resolve state machine.

`loadBaseContext` is a separate optional capability, not a fourth required layer.

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
passport.dispute('claim-42', {
  actorAgentId: 'reviewer', reason: 'Probe conflicts with incident log',
  source: { resultSequence: 4 }
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

The state machine is `active -> disputed -> resolved`; a resolved memory must be disputed again before content changes. Updates do not close a dispute, and history retains every event. `source.resultSequence` is caller-declared and unverified. If new content has no source, an old source is not carried forward.

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

## Agent handoff and limitations

Report observation, provenance, and review status separately. Never fill an unknown URL, model, identity, or source with a plausible value. A useful fixed handoff is:

```text
discovery: ...
authorization: ...
changes: ...
verification: ...
rollback: ...
limitations: selected layer; unverified provenance; process-local state; no persistence, network, authentication, authorization, signatures, or security boundary
```

## API reference and development

Root exports are `BASE_CONTEXT_FILES`, `loadBaseContext`, `MemoryPassport`, `relayExternalResult`, and `ResultStore`. See [`examples/basic.js`](examples/basic.js) for a runnable flow.

```sh
npm test
npm run example
```

## License

MIT
