# Agent Integrity Guard

> **Coding Agent 入口：** 从本仓库接入最小合适层；修改依赖或生产路径前先询问，然后测试并报告改动、验证、回滚和限制。完整内容见[接入配方](docs/AGENT_INTEGRATION.md)。
>
> English: [README.md](README.md)

一个零依赖、进程内的 CommonJS 工具集，为 Agent 结果交接添加明确的生产者标签、顺序、claim 历史和裁决状态。

## 特性

- **零依赖：** 在 Node.js 18+ 上运行，不需要运行时依赖包。
- **进程内且无副作用：** 没有 daemon、网络、持久化、认证或隐藏 I/O。
- **渐进式三件套：** 按需选择 Relay、`ResultStore` 或 `MemoryPassport`。
- **显式 provenance：** 未知的 identity、model、URL 和 source 继续保持未知。
- **防御性历史：** 值会被克隆，记录只追加，复核/争议转换受控。

## 安装

```sh
npm install agent-integrity-guard
```

## 30 秒上手

```js
const { relayExternalResult } = require('agent-integrity-guard');
const relayed = relayExternalResult({
  agentId: response.agentId, result: response.output, url: response.url
});
```

只转发调用方明确提供的字段；本库不会编造 identity 或 provenance。

## 选择最小层

### Relay

忠实转发 `agentId`、`result` 以及可选的 `url`/`model`，适合只需如实保留字段的交接。

```js
relayExternalResult({ agentId: 'planner', result: { ok: true } });
```

### ResultStore

在单个 store 实例内增加追加/读取顺序。序号不跨实例或进程。

```js
new ResultStore().append('planner', { kind: 'plan' });
```

### MemoryPassport

用稳定的 `memoryId` 跟踪 claim 内容、调用方声明的 source、完整历史和复核/争议生命周期。

```js
new MemoryPassport().create({ memoryId: 'claim-1', actorAgentId: 'observer', content: { ok: true } });
```

状态机是 `active -> disputed -> resolved`；`requestReview()` 和 `dispute()` 都会进入 `disputed`。

## Coding Agent 接入

本库既面向 Coding Agent，也可由应用直接使用。Agent 应检查宿主、请求授权、选择最小层、验证接入并提供限定范围的回滚方案。复制使用[唯一接入配方与交接格式](docs/AGENT_INTEGRATION.md)。

## 工具与设计说明

- **API 与 context loader：** 详细示例、事件语义、source 规则和可选 `loadBaseContext` 用法见 [docs/API.md](docs/API.md)。
- **资产验证器：** 本地 CLI 在严格的路径和命令边界内验证受支持的 Gene 声明，见 [docs/ASSET_VERIFY.md](docs/ASSET_VERIFY.md)。
- **Memory Palace：** append-only 持久化与 hash chain 的拟议设计见 [docs/MEMORY_PALACE.md](docs/MEMORY_PALACE.md)。

## 开发

```sh
npm test
npm run example
```

可运行流程见 [`examples/basic.js`](examples/basic.js)。

## License

MIT
