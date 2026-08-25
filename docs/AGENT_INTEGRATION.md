# Coding Agent Integration / Coding Agent 接入

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

## Guarded Codex task runner / 受控 Codex 任务运行器

`bin/guard-codex-task.js` has two separate phases. `run` executes Codex, captures repository status and verification evidence, and writes an artifact that remains `reviewRequired: true`. A reviewer must then independently run `resolve` with a decision and reason; the runner does not auto-accept Codex's work. Child processes use `shell: false`, so commands and arguments are passed directly rather than interpreted by a shell.

`bin/guard-codex-task.js` 分为两个独立阶段。`run` 执行 Codex、记录仓库状态与验证证据，并写出仍标记为 `reviewRequired: true` 的 artifact。随后必须由 reviewer 独立执行 `resolve`，明确给出 decision 和 reason；该工具不会自动接受 Codex 的工作。子进程使用 `shell: false`，命令及参数会被直接传递，不经过 shell 解释。

```sh
node bin/guard-codex-task.js run . task-1 "Update the docs" task-1.guard.json
node bin/guard-codex-task.js resolve task-1.guard.json accepted "Reviewed the diff and tests"
```

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
