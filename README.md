# Agent Integrity Guard

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
