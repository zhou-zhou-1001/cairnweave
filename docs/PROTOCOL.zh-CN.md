# Protocol Core 与 NDJSON 传输

CairnWeave 提供零依赖、JSON wire-safe 的 Agent 通信合约，以及一个基于调用方注入 Node.js stream 的具体 adapter。它不会打开 socket、启动 daemon、选择 peer、认证 identity、自动重试，也不实现 MCP。

```js
const {
  createMessage, createEnvelope, assertReplyCorrelation,
  createNdjsonTransport
} = require('cairnweave/protocol');
```

同一个冻结 namespace 也位于 `require('cairnweave').protocol`；它保持不可枚举，既有根导出列表不变。

## Wire-safe 值与消息

`cloneWireValue()` 只接受不会被 JSON 静默省略或改写的值：`null`、字符串、布尔值、有限数字、稠密数组，以及仅含可枚举字符串 data property 的普通对象。message kind 为 `request`、`response`、`event` 或 `error`；`response` 与 `error` 必须包含 `correlationId`。

`assertReplyCorrelation(request, reply)` 会防御性规范化两端，并要求：源消息是 request；reply 是 response/error；`reply.correlationId` 等于 request ID；两者 capability 完全相同。失败通过带稳定 `code` 的 `ProtocolError` 表示。它不维护 pending request 表、不提供 timeout，也不跨 peer 保证 ID 唯一。

Envelope 将 sender、可选 recipient、发送时间等路由信息与 message 语义分离。Normalizer 拒绝未知 schema/version，返回防御性副本，并保留未知但 wire-safe 的扩展字段。

Capability 以名称和正整数 revision 标识。协商只接受精确 revision 匹配，不推断兼容性、授权或降级策略。

## 通用 transport 合约

`createTransport({ name, send, subscribe, subscribeErrors?, close? })` 在发送与接收边界规范化 envelope。`send()`、`close()` 返回 Promise；订阅返回 unsubscribe 函数。可选的 `subscribeErrors()` 用于非致命 adapter 诊断；未实现错误通道的旧 adapter 会得到 no-op 订阅，保持兼容。

通用合约不承诺 retry、ordering、framing 或 delivery guarantee；这些必须由具体 adapter 说明。

## 注入 stream 的 NDJSON adapter

```js
const transport = createNdjsonTransport({
  readable: process.stdin,
  writable: process.stdout,
  maxFrameBytes: 1024 * 1024
});

transport.subscribe(handle);
transport.subscribeErrors((error) => log(error.code));
await transport.send(envelope);
```

`readable` 与 `writable` 由调用方注入，可以是 stdin/stdout、child-process pipe、`PassThrough`，或其他 stream pair。Adapter 自身不创建进程，也不执行网络 I/O。

明确规则如下：

- 每帧是一个紧凑 JSON envelope，以 LF（`0x0a`）结束；接受 CRLF 并移除 CR。EOF 前没有 LF 的最终内容一律视为截断，即使 JSON 完整。
- 使用严格 UTF-8 解码、`JSON.parse`，随后调用 `normalizeEnvelope()`。空帧是错误，不会忽略空行。
- `maxFrameBytes` 默认 1 MiB，按不含 LF 的编码后字节数计算，同时约束收发。超大入站帧只报告一次，丢弃到下一个 LF，然后从后续帧恢复。
- Chunk 边界没有语义：adapter 能正确拼接半帧并拆分多帧。格式错误、空帧、超大帧、非法 UTF-8 或非法 envelope 会通过 `subscribeErrors()` 报告，不阻止后续合法帧。
- 干净 EOF 不产生事件；仍有半帧时，EOF 或 readable close 报告 `ERR_NDJSON_TRUNCATED_FRAME`。读端 EOF 不会隐式关闭写端。
- Send 按调用顺序串行。Promise 只在 writable 的 write callback 执行后 resolve，因此能异步传递 stream backpressure/处理状态。写失败会 reject 当前 send，并使后续 send 稳定失败。
- `close()` 拒绝新 send、移除 listener、等待已排队 send，并且可重复调用。默认不结束调用方注入的 stream；设置 `endWritableOnClose: true` 才会在排队发送完成后结束 writable。

Adapter 错误都是 `TransportError`。稳定 code 包括：`ERR_NDJSON_EMPTY_FRAME`、`ERR_NDJSON_INVALID_JSON`、`ERR_NDJSON_INVALID_ENVELOPE`、`ERR_NDJSON_FRAME_TOO_LARGE`、`ERR_NDJSON_TRUNCATED_FRAME`、`ERR_TRANSPORT_READ`、`ERR_TRANSPORT_WRITE`、`ERR_TRANSPORT_CLOSED` 与 `ERR_TRANSPORT_HANDLER`。错误 detail 不包含原始帧内容。

## 安全与交付边界

NDJSON framing 不等于认证、保密、授权、canonicalization、签名、交付确认或 replay protection。Send resolve 只表示本地 writable 完成 write callback，并不表示 peer 已解析或执行。协议应使用专用 stream；若把日志写入同一个 writable，会破坏 framing。
