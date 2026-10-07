# Protocol Core and NDJSON Transport

CairnWeave defines zero-dependency, JSON-wire-safe contracts for agent communication and one concrete adapter over caller-injected Node.js streams. It does not open sockets, start a daemon, select peers, authenticate identities, retry delivery, or implement MCP.

```js
const {
  createMessage, createEnvelope, createCapability,
  negotiateCapabilities, createTransport, createNdjsonTransport
} = require('cairnweave/protocol');
```

The same frozen namespace is available as `require('cairnweave').protocol`. It remains non-enumerable so the established root export list is unchanged.

## Wire-safe values

`cloneWireValue(value)` validates and copies the narrow JSON common denominator: `null`, strings, booleans, finite numbers, dense arrays, and plain objects with enumerable string-keyed data properties. It rejects values JSON would omit, reinterpret, or execute while reading. `isWireValue(value)` provides a boolean check.

## Messages, correlation, and envelopes

The version-1 message kinds are `request`, `response`, `event`, and `error`. Responses and errors require `correlationId`.

```js
const request = createMessage({
  kind: 'request', capability: 'files/read', payload: { path: 'README.md' }
});
const response = createMessage({
  kind: 'response', capability: 'files/read',
  correlationId: request.id, payload: { text: '# CairnWeave' }
});
assertReplyCorrelation(request, response);
```

`assertReplyCorrelation()` defensively normalizes both values and requires a request followed by a response/error whose `correlationId` equals the request ID and whose capability is identical. Failures use stable `ProtocolError.code` values. It does not track outstanding requests, enforce uniqueness across peers, or provide timeouts.

Envelopes keep routing metadata separate from message semantics. `recipient` is optional. Factories create IDs and timestamps by default. Normalizers reject unknown schemas/versions, return defensive copies, and preserve unknown wire-safe extensions.

## Capabilities

Capabilities use a name and positive integer revision. `normalizeCapabilities()` rejects duplicate `(name, revision)` pairs. `negotiateCapabilities(local, remote)` returns exact matches in local preference order; it does not infer compatibility, authorization, or downgrade policy.

## Generic transport contract

`createTransport({ name, send, subscribe, subscribeErrors?, close? })` normalizes envelopes at outbound and inbound boundaries. `send()` and `close()` return promises. Subscriptions return unsubscribe functions. Optional `subscribeErrors(handler)` is the non-fatal adapter diagnostic channel; adapters without one expose a no-op subscription for compatibility. `assertTransport()` accepts the original minimal contract and validates `subscribeErrors` when present.

The generic contract does not claim common retry, ordering, framing, or delivery semantics. Concrete adapters must state them.

## Injected-stream NDJSON adapter

```js
const transport = createNdjsonTransport({
  readable: process.stdin,
  writable: process.stdout,
  maxFrameBytes: 1024 * 1024
});

transport.subscribe((envelope) => handle(envelope));
transport.subscribeErrors((error) => log(error.code, error.message));
await transport.send(envelope);
```

`readable` and `writable` are injected Node streams; they may be stdin/stdout, child-process pipes, `PassThrough` streams, or another caller-owned stream pair. The adapter performs no process spawning or network I/O.

Framing and parsing rules:

- One compact JSON envelope per frame, terminated by LF (`0x0a`). CRLF is accepted and the CR is removed. A final frame without LF is truncated, even if its JSON is otherwise complete.
- Frames are decoded as strict UTF-8 and parsed with `JSON.parse`, then passed through `normalizeEnvelope()`. Empty frames are errors; blank lines are not ignored.
- `maxFrameBytes` defaults to 1 MiB and counts encoded frame bytes excluding LF. It applies inbound and outbound. Oversized inbound data is reported once, discarded through its next LF, and parsing resumes at the following frame.
- Chunk boundaries have no semantic meaning: partial and multiple frames are buffered correctly. Malformed, empty, oversized, invalid-UTF-8, and invalid-envelope frames are reported through `subscribeErrors()` and do not stop later frames.
- Clean EOF emits nothing. EOF or readable close with a buffered partial frame reports `ERR_NDJSON_TRUNCATED_FRAME`. EOF does not implicitly close the writable side.
- Sends are serialized in call order. A send promise resolves only after the writable's write callback, so stream backpressure/processing propagates asynchronously. Write failures reject the active send and are retained for later sends.
- `close()` rejects new sends, detaches listeners, waits for already queued sends, and is idempotent. Injected streams remain caller-owned by default. Set `endWritableOnClose: true` to end the writable after queued sends complete.

Stable adapter errors are `TransportError` instances. Current codes are `ERR_NDJSON_EMPTY_FRAME`, `ERR_NDJSON_INVALID_JSON`, `ERR_NDJSON_INVALID_ENVELOPE`, `ERR_NDJSON_FRAME_TOO_LARGE`, `ERR_NDJSON_TRUNCATED_FRAME`, `ERR_TRANSPORT_READ`, `ERR_TRANSPORT_WRITE`, `ERR_TRANSPORT_CLOSED`, and `ERR_TRANSPORT_HANDLER`. Error details never include frame content.

## Security and delivery boundary

NDJSON framing is not authentication, confidentiality, authorization, canonicalization, signing, delivery acknowledgement, or replay protection. A resolved send means the local writable accepted and processed the write callback—not that a peer parsed or acted on it. Put protocol traffic on a dedicated stream; application logs on the same writable would corrupt framing.

Version 1 uses `cairnweave/protocol-message`, `cairnweave/protocol-envelope`, and `cairnweave/protocol-capability`, each with numeric version `1`. Incompatible semantic changes require a new version.
