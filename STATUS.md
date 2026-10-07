# Status

## Completed

- Preserved the Phase 1 zero-dependency protocol core, CommonJS packaging, Node.js >=18 floor, legacy enumerable root API, and additive `cairnweave/protocol` entry point.
- Added `createNdjsonTransport()` over caller-injected Node readable/writable streams. It implements strict LF framing with CRLF acceptance, fatal UTF-8 decoding, chunk-safe buffering, multiple frames per chunk, a configurable 1 MiB default byte limit on inbound and outbound frames, oversize-frame resynchronization, and explicit partial-frame EOF behavior.
- Added ordered asynchronous send semantics: send promises follow writable callbacks, queued sends preserve call order, failures reject with stable errors, and close waits for queued sends. Injected streams remain caller-owned unless `endWritableOnClose` is explicitly enabled.
- Added `ProtocolError`, `TransportError`, stable adapter error codes, and the optional `subscribeErrors()` transport diagnostic channel without making it mandatory for existing transport implementations.
- Added `assertReplyCorrelation()` to validate request/reply kind, request ID correlation, and exact capability continuity without adding speculative request tracking or timeout machinery.
- Added English and Chinese protocol documentation with exact framing, parsing, size, recovery, EOF, ownership, backpressure, security, and delivery boundaries.

## Evidence

Verified on Node.js v24.19.0 on 2026-10-07:

- `npm test`: 150/150 passing, including direct chunk-boundary tests, bidirectional injected stream-pair integration, malformed/empty/invalid-UTF-8/invalid-envelope recovery, oversize resynchronization, truncated EOF, write ordering, delayed write callbacks, close-time queue draining, write failure retention, size limits, and stream ownership.
- `npm run example`: passing.
- `npm pack --dry-run`: passing; 33 files, including both protocol guides and all adapter implementation files.
- `git diff --check`: passing.

## Current state

The package now has a production-oriented local framing adapter but still does not open a socket, spawn a process, run a daemon, or perform network I/O. Applications can inject stdio, child-process pipes, in-memory streams, or another Node stream pair. Malformed inbound frames are isolated and reported without preventing later delimited frames from being processed.

No MCP bridge was added. The current protocol has a sound bridge boundary—wire-safe envelopes, explicit capabilities, correlation validation, injected transport, and typed diagnostics—but there is not yet a concrete MCP mapping requirement. Adding one now would invent lifecycle, capability-name, and error-mapping policy.

## Risks and explicit non-guarantees

- Declared identities are not authenticated; NDJSON provides neither confidentiality nor integrity.
- A resolved send means the local writable completed its write callback. It is not peer acknowledgement, delivery confirmation, execution confirmation, retry, deduplication, or replay protection.
- A dedicated protocol writable is required. Logs or other bytes on the same stream corrupt framing.
- Malformed frames are recoverable only at the next LF delimiter. A malicious peer can force discard work up to a delimiter, though retained memory is bounded by `maxFrameBytes`.
- Error observers are advisory; an observer that throws is isolated. Subscriber failures are reported as `ERR_TRANSPORT_HANDLER`, but the adapter does not retry delivery to that subscriber.
- Correlation validation is stateless. Callers still own pending-request registries, timeout/cancellation policy, ID uniqueness across trust domains, and duplicate-reply handling.
- Capability negotiation remains exact-revision matching and does not imply authorization or semantic compatibility beyond equality.

## Recommended next step

Define reusable transport conformance tests for any second adapter only when another adapter is actually planned. If MCP integration becomes concrete, first specify the exact mapping between MCP request/result/error objects and CairnWeave capabilities, messages, and correlation; then implement a thin bridge against the existing transport boundary. Do not add a daemon or generic request manager until a real consumer supplies lifecycle requirements.
