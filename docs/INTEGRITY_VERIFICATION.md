# Integrity Verification / 完整性验证

## 结论

CairnWeave 当前提供的是三层中的前两层：

1. **逻辑完整性（当前主要能力）**：验证任务、执行结果、Git revision、scope、review 状态、passport history、current state 和 timeline 之间的结构与引用关系是否自洽。
2. **篡改可见性（有限能力）**：artifact envelope 可用 SHA-256 检查保存后的 payload 是否被改写；这不是认证，也不是签名。
3. **密码学真实性与安全边界（当前不提供）**：不能证明某个 agent、reviewer、命令、测试输出或 Git 状态确实来自声称的实体，也不能提供权限隔离、密钥保护、可信执行环境或抗回滚保证。

因此，“integrity”在当前版本中应理解为 **correctness / consistency guard**，而不是 security boundary。

## 已验证的逻辑完整性

`npm test` 当前包含 129 个测试，覆盖以下攻击面：

- 状态机：`awaiting_review`、`changes_requested`、`inconclusive`、`accepted`、`rejected` 的 review 生命周期；
- resultStore 三事件链：handoff → runner verification → review request；
- 全局 sequence 连续性以及 runner/reviewer/task agent 关系；
- passport history 的 event ID 唯一性、seq 连续性、create/review/resolve 交替关系；
- review/resolve 事件之间的 `reviewEventId` 引用链；
- `task.status`、`review.required`、兼容字段 `reviewRequired`、review decision/status 的一致性；
- 从 history 重建 `passport.current` 和 `passport.timeline`，拒绝派生视图被单独篡改；
- task ID、cwd、schema、runner identity、handoff kind 等跨字段关系；
- revision 的 SHA-256 value、components 格式以及 components → value 的重算关系；
- 事件日志 canonicalization：版本化 envelope、确定性 key 排序、稳定 digest vector、项目绑定、digest mismatch 与非法 digest 输入；这里是项目自定义 canonicalization，不声称符合 RFC 8785/JCS；
- 事件日志范围 digest（`computeEventLogRangeDigest`）：闭合区间摘要与全日志 digest 字节一致、跨运行时固定测试向量、反向/越界区间拒绝；
- authority 快照与事件日志的一致性校验（`verifyAuthorityContextEventLog`）：范围覆盖存在性、digest 元数据与精确闭区间重算比对、缺失 digest 时的纯范围校验、不要求 `toSeq === eventCount`（不发明 winner/激活/latest 语义）；
- 事件日志结构校验：必填字段必须是自有且可枚举的数据属性，拒绝原型链继承、不可枚举属性和 accessor 伪造的必填字段；
- `diagnoseEvents` 结构化诊断：与 `validateEvents` 边界一致的非抛错伴生检查，输出稳定 code/path/index/seq，收集多重独立缺陷，抵御 Proxy/accessor/稀疏数组/循环/非数组等恶意输入，且绝不回显 claim 标识或 claim 内容；
- 当前 revision 与 resolve 时工作区 fingerprint 的比对；
- artifact 本身排除在工作区 scope 检测之外，但其他越界路径仍阻止 review；
- 旧 Codex schema、事件类型、runner identity、memory ID 和多轮 review 生命周期兼容性；
- 命令 adapter 的 `shell: false`、stdin prompt 和参数边界。

这些检查保证的是：**如果输入 artifact 被提交给 CairnWeave，CairnWeave 能发现大量内部矛盾、断链和不匹配。**

## Artifact envelope 的实际语义

`saveArtifact()` / `loadArtifact()` 提供版本化 envelope 和 SHA-256 digest：

- 普通误写、截断、字段修改会被检测为 `artifact integrity mismatch`；
- 保存使用临时文件后 rename，避免常见的半写入文件；
- digest 保护的是 envelope 内的 payload 一致性；
- digest 没有密钥，因此知道格式的写入者可以修改 payload 后重新计算 digest；
- `resolveCapturedTask()` 的逻辑验证与 envelope 的持久化校验是两个层次，调用方必须明确使用 `saveArtifact()` / `loadArtifact()` 才能获得 envelope 检查。

不要把 SHA-256 digest 描述为“防篡改签名”“可信来源证明”或“认证”。更准确的说法是：**tamper evidence / 篡改可见性**。

## 尚未提供的安全保证

以下项目当前明确不保证：

- agentId、reviewerId、adjudicatorId 的密码学身份认证；不同字符串可能由同一实体伪造；
- capture 进程自报的 exit code、stdout、stderr、测试结果确实来自真实子进程；
- Git、`.git`、hooks、replace refs 或运行环境本身没有被控制者伪造；
- capture 到 resolve 之间不存在 TOCTOU；
- 时间戳具备可信时钟、单调性或不可回滚性；
- artifact 的新鲜度、来源 URL、分支、机器或执行环境绑定；
- 进程/文件权限隔离、沙箱、网络策略、密钥管理、授权或审计存储；
- 跨进程、跨机器或跨存储的全局事件顺序；
- artifact 被复制到另一台机器后的上下文真实性。

## 可复现验证命令

```sh
cd agent-integrity-guard
npm test
git diff --check
```

预期：129 个测试全部通过，且 diff 检查无输出。

## 后续安全化路线（不属于当前版本）

如果未来要把 CairnWeave 提升为安全边界，需要单独设计协议，而不是继续增加字符串字段：

1. 用受保护私钥对 execution receipt、revision、scope、输出摘要和事件链签名；
2. 为 agent、reviewer、runner 建立可验证的身份与密钥绑定；
3. 使用可信持久化或 append-only log 保存 nonce、sequence、时间和撤销状态；
4. 将执行放入明确的权限/沙箱边界，并从外部采集而非自报执行证据；
5. 增加 freshness、expiry、branch/repository/environment binding；
6. 明确定义 key rotation、replay、rollback、失钥和迁移协议。

在这些协议落地前，产品文案只能承诺逻辑一致性和有限的篡改可见性。
