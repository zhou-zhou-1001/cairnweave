# Agent Integrity Guard

> **Coding Agent 入口：** 阅读 https://github.com/zhou-zhou-1001/agent-integrity-guard，并把最小合适层接入当前项目；修改依赖或生产路径前先询问；运行测试，并报告改动、验证、回滚和限制。
>
> English: [README.md](README.md)

上面这句话是入口，不是绕过授权。Agent 仍必须读取实际宿主 `package.json`、模块系统、将使用版本的根导出和 API 签名，并在改动前取得用户确认。本仓库不是 skill 包，不要用 `npx skills add` 安装它。

## Canonical Agent Recipe（唯一接入配方）

把下面的配方复制给 Coding Agent。后文示例只是 API 文档，不是第二份相互独立的 Recipe。

```text
AGENT TASK / INTEGRATION RECIPE — Agent Integrity Guard

版本与边界：适用于 agent-integrity-guard >=0.1.0 <0.2.0 与 Node.js >=18。安装前必须读取实际将使用版本的 package.json、README、根导出和 API 签名；版本范围不能替代 API 检查。本库是零依赖、进程内、由宿主主动调用的 CommonJS 库，不是 daemon；不提供持久化、网络传输、认证、授权、签名或安全边界。

1. DISCOVERY（先只读）：定位项目根目录和 package.json；识别包管理器与锁文件、CJS/ESM、实际 Node 版本、已有 test/lint/typecheck/build 命令，以及宿主已有的 canonical agent identity schema。检查未提交改动并确认依赖符合现有约束。若 Node <18、包管理器不明确、依赖不可用或项目状态无法判断：停止并报告，不猜测、不安装、不修改。
2. AUTHORIZATION（确认门）：修改前向用户列出拟用层级、文件和命令，等待明确授权。安装依赖、修改 package.json/锁文件、修改生产路径、增加 identity 映射，都必须在授权范围内。保留用户已有未提交改动，只改必要文件。
3. IDENTITY：复用宿主已有 canonical agent identity。若没有，先提出稳定 ID、映射位置和迁移影响并等待批准。agentId 是调用方提供的标签，本库不认证它，不能据此证明真实身份。
4. LEVEL（按需求选最小层，不强制逐层接入）：
   A. 仅 RELAY：用 relayExternalResult 忠实转发 agentId/result 和上游明确提供的 url/model。
   B. RELAY + RESULTSTORE：只有需要在本 ResultStore 实例内追加/读取顺序时才使用。sequence 只在该实例内全局有效，不跨实例或进程。
   C. MEMORYPASSPORT：只有需要 claim 历史和 dispute/resolve 流程时才使用稳定 memoryId。source.resultSequence 是调用方显式声明的 provenance；本库不验证被引用结果是否存在。
   loadBaseContext 是独立可选能力，只有宿主需要统一基础上下文加载时才接入，不能因选了 A/B/C 就默认接入。
5. IMPORT（按实际模块系统采用准确形式，不猜）：
   CommonJS：const { relayExternalResult } = require('agent-integrity-guard');
   ESM：import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { relayExternalResult } = require('agent-integrity-guard');
   示例：relayExternalResult({ agentId, result, ...(url !== undefined ? { url } : {}), ...(model !== undefined ? { model } : {}) }); 不得编造 identity、model、URL 或 source。
6. CHANGE：在宿主现有入口/适配层做最小改动，保留其模块系统、错误处理和业务语义。开始前记录基线（例如限定范围 git diff 或目标文件副本），并记录本次实际修改的每个文件。
7. VERIFICATION / STOP：运行宿主已有的 test、lint、typecheck、build（存在才运行），再运行与所选层匹配的最小 smoke test。验证 relay 字段；选 store 则验证实例内 sequence/read；选 passport 则验证 history/status。任一步失败，记录命令、输出和影响，停止并报告；不要擅自扩大依赖、生产设计或文件范围。
8. ROLLBACK：生成可审查的 git diff。只回滚本次接入，不碰用户此前改动。给出逐文件回滚命令或反向补丁供审查，但不要自动执行；禁止 git reset --hard、宽泛 checkout 或破坏性 reset。
9. REPORT（固定标题）：discovery、authorization、changes、verification、rollback、limitations。limitations 必须写明所选层、未验证项、进程内状态，以及没有 persistence、network、authentication、authorization、signatures、security boundary。

完成标准：授权范围内的最小接入可运行，验证可复现，未知 provenance 仍保持未知，回滚范围清楚。前提或授权不足时，以报告结束，不要猜测。
```

## 这是什么

Agent Integrity Guard 是一个零依赖、内存内 CommonJS 工具集，供宿主 Agent 传递结果，同时保留调用方明确提供的生产者标签、进程内顺序、claim 历史和争议状态。它由宿主进程主动调用；不会自行监听、同步、调度、持久化、认证、授权、签名或传输数据。`agentId` 由调用方提供且未经认证。这是正确性层，不是数据库或安全边界。

设计参考了 EvoMap 风格的 quickstart、agent skill 和 Evolver 文档中的一些表达方式，但本库独立存在，不宣称关联、兼容或隶属。

## 安装与最短路径

需要 Node.js 18 或更高版本。完成上方 discovery 与 authorization 后，使用宿主项目选定的包管理器：

```sh
npm install agent-integrity-guard
```

本包是 CommonJS（`package.json` 为 `"type": "commonjs"`），没有运行时依赖。ESM 宿主必须使用上方准确的 `createRequire` 桥接方式，不要猜测存在命名 ESM 导出。

从最小层开始选择：

1. **仅 relay**：诚实转发调用方明确提供的字段。
2. **relay + `ResultStore`**：在一个 store 实例中追加和读取事件。
3. **`MemoryPassport`**：管理 claim 历史及 dispute/resolve 状态机。

`loadBaseContext` 是独立的可选能力，不是必须的第四层。

## API 示例

### Relay：诚实转发

```js
const { relayExternalResult } = require('agent-integrity-guard');

const relayed = relayExternalResult({
  agentId: response.agentId,
  result: response.output,
  ...(response.url !== undefined ? { url: response.url } : {}),
  ...(response.model !== undefined ? { model: response.model } : {})
});
```

`agentId` 与 `result` 必须是对象自身属性；`url`、`model` 是可选自身属性。未知属性和继承属性会被忽略；库不会推断 identity 或 source。

### ResultStore：保持追加顺序

```js
const { ResultStore } = require('agent-integrity-guard');
const store = new ResultStore();
store.append('planner', { kind: 'plan', text: 'Inspect first' });
store.append('reviewer', { kind: 'review', text: 'Evidence missing' });
store.readAgent('planner');
store.readAll();
```

`append()` 不替换事件并返回防御性副本。sequence 只在本 `ResultStore` 实例内全局有效，不跨实例或进程；值必须受 Node `structuredClone` 支持，克隆失败不会消耗序号。

### MemoryPassport：记录 claim 与争议

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
passport.requestReview('claim-42', {
  actorAgentId: 'reviewer', reason: '例行独立复核',
  source: { resultSequence: 4, check: '将健康探针与原始指标对照' }
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

状态机为 `active -> disputed -> resolved`；`requestReview()` 与 `dispute()` 都会进入等待裁决的 `disputed` 状态。例行独立复核使用 `requestReview()`：它记录 `review` 事件，并强制提供显式且非 null 的 `source` 证据。`dispute()` 继续兼容冲突争议及旧版未带 `source` 的调用，但强烈建议争议也附证据。resolved memory 必须先再次 review 或 dispute 才能改变内容。更新不会关闭已打开的复核/争议，history 保留每个事件。`source.resultSequence` 是调用方声明且未验证的 provenance；新内容没有 source 时，旧 source 不会被冒充为新来源。

遇到冲突 claim 时，应使用 `dispute()` 代替 `requestReview()`；同一时间只能打开一个复核或争议。

## 本地 EvoMap 资产验证

直接用 Node 运行零依赖验证器。JSON 资产包必须包含 `payload.assets`；工具只读取 `Gene` 上的 validation，绝不会退回读取 `Capsule`。为避免执行任意 shell 内容，目前仅接受 `bash -n <相对文件>` 形式，并直接调用 Bash、不经过 shell 中间层。目标文件相对资产包定位，且不能逃逸该目录。

```sh
node bin/guard-asset-verify.js /path/to/bundle.json
```

输出是结构化 JSON，包含两个 ResultStore 事件、逐项检查、Passport 的 `create -> review -> resolve` 生命周期与时间线。所有声明检查通过时退出码为 `0`；校验失败、输入格式错误或不支持的声明均以非零退出码结束。

## 对接 Memory Palace 的设计（本次未实现）

- 每个 Passport 事件对应 `memory_events` 的一行 append-only 记录：`event_id`、`memory_id`、memory 内 `seq`、`event_type`、`actor_agent_id`、`timestamp` 和规范化后的 `payload`。投影当前状态时，`review` 与 `dispute` 都映射到等待裁决状态。
- 将 `payload.source` provenance 与已认证身份分开：它是调用方声明的证据，不是身份证明。保留完整 JSON，同时可索引 `resultSequence`、artifact ID 与检查类型。
- 增加 `prev_hash` 和 `event_hash`，基于带版本号的规范序列化和不可变行字段计算。对 `(memory_id, seq)` 与 `event_id` 设唯一约束；追加与预期前序 hash 检查必须处于同一事务，防止并发分叉。
- 当前状态由事件日志重放得到，snapshot 仅作可丢弃投影。按 `event_id` 幂等导入；遇到序号缺口、hash 不匹配、非法转换，或没有开放 review/dispute 就 resolve 时拒绝写入。
- 明确信任边界：Memory Palace 持久化与 hash chain 只能提供篡改可见性，不能认证 actor。签名、密钥管理、授权、跨库排序和现有内存历史迁移，都需要在生产接入前另定协议。

### 可选 context loader

```js
const fs = require('node:fs/promises');
const { loadBaseContext } = require('agent-integrity-guard');
const context = await loadBaseContext({
  promptMode: 'worker',
  readFile: (filename) => fs.readFile(filename, 'utf8')
});
```

支持 `default`、`compact`、`worker` 三种模式；每种都会按顺序请求 `AGENTS.md`、`SOUL.md`、`USER.md`。文件读取和缺失文件策略由宿主提供。

## Agent 接入后的报告与限制

交接时把观察、provenance 和复核状态分开报告。不要给未知的 URL、model、identity 或 source 填入看似合理的值。固定报告格式如下：

```text
discovery: ...
authorization: ...
changes: ...
verification: ...
rollback: ...
limitations: 所选层；未验证的 provenance；仅进程内状态；没有 persistence、network、authentication、authorization、signatures 或 security boundary
```

如果争议仍未解决，要显著说明，并同时报告当前 claim 与争议原因；不能把 disputed 内容描述成已确认。

## API 总览与开发

根导出为 `BASE_CONTEXT_FILES`、`loadBaseContext`、`MemoryPassport`、`relayExternalResult`、`ResultStore`。可运行流程见 [`examples/basic.js`](examples/basic.js)。

```sh
npm test
npm run example
```

## License

MIT
