# CairnWeave

> **面向多 Agent 系统的 provenance fabric。**

English: [README.md](README.md)

CairnWeave 是一个零依赖、进程内的 CommonJS 工具集，用来让 Agent 交接变得明确：谁产出了结果、交接了什么、顺序如何、处于什么复核状态。

它运行在 Node.js >=18 上，没有 daemon、网络调用、持久化层、认证系统或隐藏 I/O。你只接入应用或 Coding Agent 工作流真正需要的原语。

本项目原名 **Agent Integrity Guard**，包名为 `agent-integrity-guard`。既有 API、CLI 文件名和序列化 schema 标识继续兼容；见[兼容与迁移](#兼容与迁移)。

## Quick Start

安装：

```sh
npm install cairnweave
```

转发外部 Agent 结果，同时不编造缺失的 provenance：

```js
const { relayExternalResult } = require('cairnweave');

const handoff = relayExternalResult({
  agentId: response.agentId,
  result: response.output,
  url: response.url
});
```

只保留调用方提供的字段。未知的 identity、model、URL 或 source 会继续保持未知。

需要有序交接时：

```js
const { ResultStore } = require('cairnweave');

const store = new ResultStore();
store.append('planner', { kind: 'plan' });
store.append('builder', { kind: 'patch' });
```

需要 claim 历史时：

```js
const { MemoryPassport } = require('cairnweave');

const passport = new MemoryPassport();
passport.create({
  memoryId: 'claim-1',
  actorAgentId: 'observer',
  content: { status: 'checked' }
});
```

## 为什么存在

多 Agent 和 Coding Agent 系统经常在工具、模型、reviewer 和脚本之间传递值。难点不只是再存一个对象，而是让交接保持诚实。

CairnWeave 把这个边界做小、做清楚。它帮助你记录明确的生产者标签、追加顺序、claim revision 和复核/争议状态，同时不引入服务运行时，也不声称拥有调用方没有提供的权威。

## 能力分层

| 层 | 适合在你需要... | 增加什么 | 不做什么 |
| --- | --- | --- | --- |
| Relay | 最小交接包装 | 保留 `agentId`、`result` 和可选 `url`/`model` | 不推断 identity 或 provenance |
| `ResultStore` | 单个运行时内的有序结果 | 单个 store 实例内的 append/read 顺序 | 不跨进程或实例协调 |
| `MemoryPassport` | Claim 生命周期 | 稳定 `memoryId`、克隆内容、调用方声明的 source、历史、复核/争议/解决状态 | 不持久化 claim，也不认证 source |
| `ProjectMemory` | 项目范围内的 claim memory | 项目成员、私有 claim 可见性、强制 provenance 的写入、过期、替代、revision 和实例内审计日志 | 不提供存储、认证、网络同步或隐藏 import/replay |

选择能让交接足够明确的最小层。

## 典型场景

- 在传给下一步之前，保留 Agent 响应及其声明的生产者。
- 保存 planner、implementer、reviewer 或 verifier Agent 的有序中间输出。
- 跟踪 claim 的复核、争议和解决过程，同时不改写早期历史。
- 在当前进程内维护带可见性规则和审计轨迹的项目范围 claim。
- 用 `captureAgentTask()` 或 `captureCommandTask()` 包装 Coding Agent 或命令执行流程，生成可复核 artifact。

## 边界与非目标

CairnWeave 刻意保持小而明确。

- 它是面向 Node.js >=18 的零依赖 CommonJS。
- 它只在进程内运行。
- 它不会启动 daemon。
- 它不会发起网络调用。
- 它不会替你持久化数据。
- 它不会认证 identity、source 或 user。
- 它不会执行隐藏的文件、shell、网络或数据库 I/O。
- 它不会把 digest 变成信任。`ProjectMemory` event-log digest 是对声明事件范围的一致性检查，不是认证。
- 它不会把 `ProjectMemory.validateEvents()` 或 `ProjectMemory.diagnoseEvents()` 当作 replay、import 或授权决策。它们只校验事件日志形状与一致性，或返回诊断。

## API 选择

| 如果你的问题是... | 从这里开始 |
| --- | --- |
| “能否转发这个结果，同时不丢失调用方声明的生产者？” | `relayExternalResult()` |
| “能否保存一组本地有序的 Agent 输出？” | `ResultStore` |
| “能否跟踪一个 claim 的生命周期？” | `MemoryPassport` |
| “能否维护带可见性、revision、过期和审计事件的项目范围 claim？” | `ProjectMemory` |
| “能否捕获 Coding Agent 任务或命令结果以便复核？” | `captureAgentTask()` 或 `captureCommandTask()` |

## 文档导航

- [API 参考与示例](docs/API.md)
- [Coding Agent 接入配方](docs/AGENT_INTEGRATION.md)
- [ProjectMemory 指南](docs/PROJECT_MEMORY.md)
- [完整性验证说明](docs/INTEGRITY_VERIFICATION.md)
- [兼容说明](COMPATIBILITY.md)
- [资产验证器](docs/ASSET_VERIFY.md)
- [Memory Palace 设计说明](docs/MEMORY_PALACE.md)

## 开发验证

运行测试：

```sh
npm test
```

运行示例：

```sh
npm run example
```

可运行的端到端流程见 [`examples/basic.js`](examples/basic.js)。

## 兼容与迁移

CairnWeave 是原 **Agent Integrity Guard** / `agent-integrity-guard` 项目的新名称。

旧 API surface、CLI 文件名和序列化 schema 标识会继续兼容。新接入建议使用当前包名和通用 agent/task API；既有 `captureCodexTask()` 与 `bin/guard-codex-task.js` 用法可以在迁移期继续保留。

详细迁移说明见 [COMPATIBILITY.md](COMPATIBILITY.md)。

## License

MIT
