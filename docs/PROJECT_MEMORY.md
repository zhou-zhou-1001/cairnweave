# ProjectMemory / 项目记忆

`ProjectMemory` is a dependency-free, in-process control-plane primitive for project-scoped claims. It is not a database, persistence layer, authentication service, authorization security boundary, or EvoMap integration. The caller supplies authenticated principal identities and decides who belongs in `authorizedPrincipals` and each private claim's `allowedPrincipals`.

`ProjectMemory` 是零依赖、进程内的项目 claim 控制面原语。它不是数据库、持久化层、认证服务、授权安全边界，也不集成 EvoMap。调用方负责提供已认证的 principal identity，并决定 `authorizedPrincipals` 以及私有 claim 的 `allowedPrincipals`。

```js
const { ProjectMemory } = require('cairnweave');

const memory = new ProjectMemory({
  projectId: 'project-a',
  principalId: 'reader-a',
  authorizedPrincipals: ['observer-a', 'reviewer-a'],
  clock: () => new Date() // optional; inject a deterministic clock in tests/adapters
});

memory.putClaim({
  claimId: 'claim-1',
  subject: 'service-a',
  predicate: 'health',
  content: { state: 'healthy' },
  authorId: 'observer-a',
  status: 'candidate',
  provenance: { check: 'health probe', resultSequence: 4 }
});
memory.approveClaim('claim-1', { actorId: 'reviewer-a', reason: 'probe checked' });
memory.getClaim('claim-1');
memory.query({ predicate: 'health' });
memory.history('claim-1');
memory.audit();

// Validate and defensively clone a complete log before an adapter stores or replays it.
const normalizedEvents = ProjectMemory.validateEvents(memory.audit(), {
  projectId: 'project-a'
});
const canonicalEvents = ProjectMemory.canonicalizeEvents(normalizedEvents, {
  projectId: 'project-a'
});
const eventLogDigest = ProjectMemory.computeEventLogDigest(normalizedEvents, {
  projectId: 'project-a'
});
ProjectMemory.verifyEventLogDigest(normalizedEvents, eventLogDigest, {
  projectId: 'project-a'
}); // true: an explicit digest comparison, not authentication

// Validate an external authority snapshot without importing or applying it.
const authorityContext = ProjectMemory.normalizeAuthorityContext({
  authoritySchema: 'cairnweave/project-memory-authority-context',
  authorityVersion: 1,
  projectId: 'project-a',
  authorizedPrincipals: ['observer-a', 'reviewer-a'],
  privateClaimAudiences: [{
    claimId: 'claim-private',
    authorId: 'observer-a',
    allowedPrincipals: ['reviewer-a']
  }]
}, { projectId: 'project-a' });

// Require an identity and inclusive event-log coverage for a future adapter.
const boundAuthorityContext = ProjectMemory.normalizeBoundAuthorityContext({
  ...authorityContext,
  authorityContextId: 'authority-snapshot-1',
  fromSeq: 1,
  toSeq: normalizedEvents.length,
  eventLogDigest: {
    algorithm: 'sha256',
    digest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  }
}, { projectId: 'project-a' });
```

Candidate and disputed claims are hidden unless `includeCandidates` or `includeDisputed` is true. Expired and superseded claims are always omitted from claim reads but remain in authorized `history()` and `audit()` results. `putClaim()` is candidate-only; approval requires a separate `approveClaim()` call by an actor who can access the claim, and an expired candidate cannot be approved. Phase 1 intentionally has no direct approved import path: without a distinct trusted-import authority, accepting `status: 'approved'` would make the author their own implicit approver. Existing callers that supplied that status receive a clear error and should migrate to candidate creation followed by explicit approval. Disputed and superseded states remain reachable only through their lifecycle methods.

Every author or lifecycle actor must be an authorized project principal. Private claims further require the reader or actor to be their author or on their explicit allowlist; this private allowlist never grants project membership by itself. `ProjectMemory` enforces those configured identities but does not authenticate them: the embedding application is the Phase 1 authority boundary and must supply authenticated IDs and trustworthy membership/allowlist configuration. Missing, unauthorized, and inaccessible mutation targets return the same non-disclosing error; once access is established, callers receive specific lifecycle errors. Candidate writes require explicit, non-null provenance. A supersession replacement must be accessible to the actor, approved, unexpired, have the same subject and predicate, and be readable by every authorized principal who can read the old claim. That audience invariant makes the replacement ID and status safe to retain in the old claim's authorized history. Mutations append globally ordered events within the instance, and lifecycle events record their status transition; all inputs and outputs cross defensive-copy boundaries.

The optional `clock` constructor field must be a function returning a valid `Date`; it defaults to the system clock. Each public operation that needs time takes exactly one clock snapshot. The same snapshot drives all expiry comparisons in that operation and, for mutations, its event timestamp. Expiry is exclusive: a claim is expired when `expiresAt <= clock()`. A clock failure aborts before the claim or lifecycle mutation is committed. This boundary makes tests and future storage adapters deterministic without moving time authority into `ProjectMemory`.

Every audit event includes `eventSchema: 'cairnweave/project-memory-event'`, numeric `eventVersion: 1`, a global `seq`, and a per-claim `revision`, followed by the timestamp, actor, project, claim, action, and action-specific fields. Both counters start at 1: `seq` increases for every event in the instance, while `revision` increases independently for each claim. Sequence numbers remain instance-local and timestamps are clock-supplied metadata; neither is a cross-process ordering guarantee or cryptographic proof.

`ProjectMemory.validateEvents(events, { projectId? })` is the replay-ready boundary for adapters. It accepts only a complete, unfiltered, single-project log beginning at `seq: 1`; rejects unsupported schemas or versions, malformed envelopes and candidate snapshots, discontinuous global sequences or claim revisions, and impossible lifecycle transitions; preserves unknown fields; and returns a defensive clone. Validation errors identify only the event index and invalid field/transition, not claim IDs or claim content. The optional `projectId` pins the expected project. A filtered `audit()`/`history()` result can contain legitimate sequence or revision gaps and therefore is not a valid input unless it happens to be the complete log.

This method validates structure and deterministic state transitions only. It does not mutate or hydrate a `ProjectMemory`, persist data, authenticate actors, prove that historical authorization was configured correctly, re-evaluate expiry against a new clock, or expose otherwise inaccessible events. In particular, audience coverage for supersession depends on the original authorized-principal configuration and cannot be reconstructed safely from events alone. A future replay/import API must receive and validate that external authority context explicitly; version 1 intentionally stops at normalization.

`ProjectMemory.diagnoseEvents(events, { projectId? })` is the non-throwing, error-collecting companion to `validateEvents()`. It returns `{ valid, errors }`, where each error is `{ code, message, path, index?, seq? }` with stable codes, paths, indexes, and seqs; it mirrors `validateEvents()`'s checks and message text exactly but collects every independent defect it can evaluate instead of stopping at the first. Messages and paths reference only field names — never claim identifiers or claim content. The internal state machine advances only past fully valid events, so later events are evaluated against the last fully valid state. Like `validateEvents()`, it is a pure structural/semantic check: it does not replay, import, activate, persist, authenticate, or authorize, and its result is not an authorization decision.

`ProjectMemory.normalizeAuthorityContext(context, { projectId? })` is the pure boundary for that external snapshot. Version 1 requires the stable envelope `authoritySchema: 'cairnweave/project-memory-authority-context'`, `authorityVersion: 1`, one `projectId`, a unique `authorizedPrincipals` list, and one unique private-audience rule per claim. Each rule contains only `claimId`, an authorized `authorId`, and a duplicate-free `allowedPrincipals` list—never claim content. Unknown extension fields are preserved in the defensive copy. The optional `projectId` pins the expected project.

Private visibility is the intersection of project authority and the rule audience: a historical reader is eligible only when they occur in `authorizedPrincipals` **and** are the rule's `authorId` or occur in `allowedPrincipals`. An allowlisted identity that is absent from `authorizedPrincipals` remains unauthorized; normalization preserves that historical fact and does not promote it. Duplicate claim rules, duplicate principals, an unauthorized author, or listing the author again in the allowlist are rejected as ambiguous or conflicting. This method does not read current memory state, append an event, persist, import, hydrate, replay, authenticate, or itself decide access.

`ProjectMemory.normalizeBoundAuthorityContext(context, { projectId? })` is the additive, stricter boundary for a snapshot associated with an event-log interval. It requires a stable non-empty `authorityContextId` and positive safe-integer `fromSeq`/`toSeq`, where both endpoints are inclusive and `fromSeq <= toSeq`. It reuses all authority-context validation, project pinning, defensive copying, and extension preservation. Claim-bearing `claim`, `claims`, `content`, `claimContent`, or `claimContents` fields are rejected: this envelope carries authority metadata, not hidden claim payloads.

The optional `coverageMode`, when present, must be the literal `'closed'`; omitting it retains the same closed-range semantics for backward compatibility. Version 1 has no open-ended, `latest`, half-open, or correction range. Such meanings must not be encoded with `null`, sentinels, or extension values because that would silently reinterpret the required finite endpoints. `ProjectMemory.normalizeAuthorityContextRanges(contexts, { projectId? })` defensively normalizes and sorts a range set, then rejects duplicate context IDs, mixed projects, overlaps, and sequence gaps. An empty array remains an empty range set. Overlapping corrections require a future explicit append-only supersession contract and are not inferred here.

The optional `coverageIntent` must be exactly `'complete'` or `'partial'`. It is a range-set assertion, repeated on each member so it survives ordinary JSON serialization: if any member declares it, every member must declare the same value. `partial` explicitly marks a finite contiguous excerpt and may begin after sequence 1. `complete` requires the first range to begin at sequence 1; the last range's required finite `toSeq` is the asserted upper boundary. It does not mean “through latest,” and this normalizer does not compare that boundary with an event log. Omitting the field preserves prior behavior and makes no completeness assertion. A complete empty set cannot be expressed in version 1 because there is no member on which to state a finite upper boundary.

`ProjectMemory.canonicalizeEvents(events, { projectId? })` first applies `validateEvents()` and then returns the version-1 canonical UTF-8 JSON text. The canonical top-level envelope is `{ canonicalizationSchema: 'cairnweave/project-memory-event-log', canonicalizationVersion: 1, events }`, which domain-separates and versions the bytes. Each event is included in full exactly as defensively cloned by validation, including its event envelope, claim snapshot, action fields, and unknown extension fields; authority-context `eventLogDigest` metadata is not part of the events and is therefore excluded. Arrays retain their order, object keys are recursively sorted by UTF-16 code units, and no whitespace is emitted. Values must be plain JSON data: `null`, booleans, strings, finite numbers, dense arrays, and plain objects with enumerable string-keyed data properties. Undefined, functions, symbols (including symbol keys), bigint, non-finite numbers, sparse arrays, circular references, accessors, and non-plain objects are rejected rather than omitted. This is a narrow JCS-inspired contract, not a claim of full RFC 8785 compliance.

`ProjectMemory.computeEventLogDigest(events, { projectId? })` returns lowercase hexadecimal SHA-256 over those canonical UTF-8 bytes. `ProjectMemory.verifyEventLogDigest(events, expectedDigest, { projectId? })` requires exactly 64 lowercase hexadecimal characters and returns the explicit comparison result as a boolean. Both reuse the same validation, canonicalization, and optional project pinning and do not mutate inputs. `ProjectMemory.computeEventLogRangeDigest(events, fromSeq, toSeq, { projectId? })` returns the digest over the inclusive closed range `fromSeq..toSeq` of a complete validated log; a full-range call is byte-identical to `computeEventLogDigest()`, while a reversed, non-integral, or out-of-bounds range is rejected. An optional authority-context `eventLogDigest` carries a caller-supplied `algorithm: 'sha256'` value; version 1 defines it as the digest of exactly the snapshot's declared closed range, produced by `computeEventLogRangeDigest()`. A matching digest only detects a difference from the expected bytes; it is not authentication, a digital signature, proof of authorship or approval, authorization for replay, or protection from an attacker who can replace both data and digest.

`ProjectMemory.verifyAuthorityContextEventLog(context, events, { projectId? })` is the consistency boundary that ties a bound authority snapshot to a concrete log. It normalizes the context and the complete event log with the existing pure boundaries (structural and project-pinning failures throw), then reports coverage and digest mismatches as a consumable result: `{ valid, range: { fromSeq, toSeq, eventCount, withinLog }, digest?: { algorithm, verified } }`, with `errors` listed when invalid. When the context declares `eventLogDigest`, the digest is recomputed over exactly the declared closed range and compared; `verified: false` means the metadata does not match these events. The check never requires `toSeq === eventCount` — not even under `coverageIntent: 'complete'`, which asserts an upper boundary, not "the log ends here" — and it does not select a winner, activate or invalidate a snapshot, or assert anything about events beyond the declared range. An excerpt that is not a complete seq-1 log is rejected by the shared validation boundary rather than reinterpreted; digesting excerpts independently remains unsupported in version 1. A `verified: false` result is a comparison conclusion between well-formed data, not a rejected import.

An optional `supersedes` object records explicit append-only revision lineage. It must identify a different prior `authorityContextId` and repeat that target's `projectId`, `fromSeq`, and `toSeq`; the project and exact closed range must match the new snapshot. Normalization preserves and defensively copies the relation but does not look up the target, prove that it exists, infer transitive lineage, select a winner, activate the revision, invalidate the prior snapshot, or allow overlapping members in `normalizeAuthorityContextRanges()`. Applications must retain both snapshots and make any later selection policy explicit outside this contract.

`ProjectMemory.normalizeAuthorityContextLineage(contexts, { projectId? })` optionally validates a self-contained lineage set containing one or more independent linear chains. It normalizes every member, requires unique snapshot IDs and one project, requires every explicitly named target to be present with matching project and exact range, and rejects multiple successors for one target and cycles. `ProjectMemory.normalizeAuthorityContextChain(contexts, { projectId? })` adds the requirement that every non-empty set has exactly one root, so the supplied members form one connected chain. Both preserve input order and return defensive copies. This is structural validation of the supplied set only: neither method discovers targets outside the set, infers missing or transitive links, sorts revisions, selects a head or winner, or activates or invalidates any snapshot. Use `normalizeBoundAuthorityContext()` instead when a dangling external reference is intentionally only descriptive.

默认读取隐藏 candidate 与 disputed claim，只有设置 `includeCandidates` 或 `includeDisputed` 才会返回。过期和 superseded claim 始终不出现在 claim 读取结果中，但会保留在已授权的 `history()` 与 `audit()` 结果中。`putClaim()` 只能创建 candidate；approval 必须由可访问该 claim 的 actor 另行调用 `approveClaim()`，且过期 candidate 不能获批。Phase 1 刻意不提供直接导入 approved claim 的路径：在没有独立可信导入权限的情况下，允许 `status: 'approved'` 会让作者隐式自批。现有调用方若传入该状态会收到清晰错误，应迁移为先创建 candidate、再显式批准。disputed 与 superseded 状态仍只能通过对应生命周期方法进入。

每位作者或生命周期变更 actor 都必须是已授权的项目 principal。私有 claim 还要求读者或 actor 是作者或位于显式 allowlist 中；该 allowlist 本身不会授予项目成员资格。`ProjectMemory` 执行这些已配置 identity 的规则，但不负责认证；嵌入它的应用程序才是 Phase 1 的权限边界，必须提供经过认证的 ID 以及可信的成员和 allowlist 配置。不存在、未授权及不可访问的 mutation target 返回相同的不披露错误；确认访问权后，调用方仍会收到具体的生命周期错误。candidate 写入必须带显式且非 null 的 provenance。替代 claim 必须对 actor 可访问、已 approved、未过期、subject 与 predicate 相同，并且对所有可读取旧 claim 的已授权 principal 均可读；因此旧 claim 的授权历史可以安全保留 replacement ID 和 status。每次变更都会在本实例内追加全局有序事件，生命周期事件会记录状态迁移；输入输出均使用防御性副本。

可选构造字段 `clock` 必须是返回有效 `Date` 的函数，默认使用系统时钟。每个需要时间的公开操作只取一次时钟快照；同一快照既用于该操作的全部过期判断，也用于 mutation 的事件时间戳。过期边界为闭合判断：当 `expiresAt <= clock()` 时 claim 已过期。时钟失败会在提交 claim 或生命周期变更前中止。该边界让测试和未来 storage adapter 具备确定性，同时不把时间权威移入 `ProjectMemory`。

每条审计事件都包含 `eventSchema: 'cairnweave/project-memory-event'`、数值型 `eventVersion: 1`、全局 `seq` 和按 claim 独立计数的 `revision`，其后是 timestamp、actor、project、claim、action 及 action 专属字段。两个计数器都从 1 开始：`seq` 随实例内每条事件递增，`revision` 则对每个 claim 分别递增。sequence 仍只在实例内有效，timestamp 只是由 clock 提供的元数据；两者都不保证跨进程顺序，也不是密码学证明。

`ProjectMemory.validateEvents(events, { projectId? })` 是 adapter 的 replay-ready 边界。它只接受从 `seq: 1` 开始、完整、未过滤、属于单一项目的日志；拒绝不支持的 schema/version、格式错误的 envelope 与 candidate snapshot、不连续的全局 sequence 或 claim revision，以及不可能的生命周期转换；保留未知字段并返回防御性副本。校验错误只指出事件索引与无效字段/转换，不回显 claim ID 或 claim 内容。可选 `projectId` 用于锁定期望项目。经过过滤的 `audit()`/`history()` 结果可能合理地存在 sequence 或 revision 间隔，因此除非它恰好就是完整日志，否则不能作为输入。

该方法只校验结构和确定性的状态转换，不会改变或恢复 `ProjectMemory`、持久化数据、认证 actor、证明历史 authorization 配置正确、按新时钟重新判断过期，也不会暴露原本不可访问的事件。尤其是 supersession 的 audience coverage 依赖当时的 authorized-principal 配置，无法仅凭事件安全重建。未来的 replay/import API 必须显式接收并校验此外部权限上下文；version 1 有意止步于 normalization。

`ProjectMemory.diagnoseEvents(events, { projectId? })` 是 `validateEvents()` 不抛错、收集错误的伴生方法。它返回 `{ valid, errors }`，每条错误为 `{ code, message, path, index?, seq? }`，code/path/index/seq 均稳定；它逐字镜像 `validateEvents()` 的检查与消息文本，但会收集它能评估的每一个独立缺陷，而不是在第一个错误处停止。消息与 path 只引用字段名，绝不回显 claim 标识或 claim 内容。内部状态机只在完全有效的事件上前进，因此后续事件会对照最后一个完全有效的状态进行评估。与 `validateEvents()` 相同，它是纯结构/语义检查：不执行 replay/import、激活、持久化、认证或授权，其结果也不是授权决策。

`ProjectMemory.normalizeAuthorityContext(context, { projectId? })` 是此外部快照的纯边界。版本 1 要求稳定 envelope：`authoritySchema: 'cairnweave/project-memory-authority-context'`、`authorityVersion: 1`、单一 `projectId`、无重复的 `authorizedPrincipals`，以及每个 claim 至多一条私有 audience 规则。每条规则只包含 `claimId`、已授权的 `authorId` 和无重复的 `allowedPrincipals`，绝不包含 claim content。防御性副本会保留未知 extension 字段；可选 `projectId` 用于锁定期望项目。

私有可见性取项目权限与规则 audience 的交集：历史 reader 必须既存在于 `authorizedPrincipals`，又是规则中的 `authorId` 或位于 `allowedPrincipals`，才具备访问资格。仅出现在 allowlist、但不在 `authorizedPrincipals` 中的 identity 仍未获授权；normalization 会保留这一历史事实，而不会提升其权限。重复的 claim 规则、重复 principal、未授权 author，或在 allowlist 中再次列出 author，都会因歧义或冲突而被拒绝。该方法不读取当前 memory 状态，不追加事件，也不执行持久化、导入、恢复、回放、认证或实际访问决策。

`ProjectMemory.normalizeBoundAuthorityContext(context, { projectId? })` 是新增且更严格的边界，用于把权限快照描述为覆盖某段事件日志。它要求稳定、非空的 `authorityContextId`，以及正安全整数 `fromSeq`/`toSeq`；两个端点均为包含关系，且必须满足 `fromSeq <= toSeq`。它复用全部 authority-context 校验、project 锁定、防御性复制和 extension 保留规则。出现承载 claim 的 `claim`、`claims`、`content`、`claimContent` 或 `claimContents` 字段会被拒绝：该 envelope 只承载权限元数据，不夹带 claim 内容。

可选的 `coverageMode` 一旦出现，就必须严格等于 `'closed'`；为保持向后兼容，省略它仍表示相同的闭区间语义。版本 1 不表示 open-ended、`latest`、半开区间或 correction range；不得用 `null`、哨兵值或 extension 值编码这些含义，否则会悄然改写必填有限端点的语义。`ProjectMemory.normalizeAuthorityContextRanges(contexts, { projectId? })` 会防御性规范化并排序一组范围，然后拒绝重复 context ID、混合项目、重叠和 sequence 缺口；空数组仍表示空范围集。重叠 correction 需要未来显式的 append-only supersession 合约，本轮不会推断。

可选的 `coverageIntent` 必须严格为 `'complete'` 或 `'partial'`。它是范围集断言，为了能经由普通 JSON 序列化保留，需在每个成员上重复：任一成员声明后，全部成员都必须声明相同值。`partial` 明确表示有限且连续的摘录，可从 sequence 1 之后开始。`complete` 要求首个范围从 sequence 1 开始；最后一个范围必填且有限的 `toSeq` 是所声明的上边界。它不表示“直到 latest”，规范化器也不会把该边界与事件日志比对。省略字段将保持旧行为，且不作完整性声明。版本 1 无法表达 complete 空集，因为没有可用于声明有限上边界的成员。

`ProjectMemory.canonicalizeEvents(events, { projectId? })` 会先调用 `validateEvents()`，再返回 version 1 的 canonical UTF-8 JSON 文本。顶层 envelope 固定为 `{ canonicalizationSchema: 'cairnweave/project-memory-event-log', canonicalizationVersion: 1, events }`，用于版本标识和 domain separation。每个事件均按校验后的防御性副本完整纳入，包括 event envelope、claim snapshot、action 字段和未知 extension 字段；authority-context 的 `eventLogDigest` 元数据不在 events 内，因此不参与计算。数组保持顺序，对象 key 按 UTF-16 code unit 递归排序，不输出空白。值只能是普通 JSON 数据：`null`、布尔值、字符串、有限数字、稠密数组，以及仅含可枚举字符串 data property 的普通对象。undefined、函数、symbol（含 symbol key）、bigint、非有限数字、稀疏数组、循环引用、accessor 和非普通对象都会被拒绝，而不会被静默省略。这是受 JCS 启发的窄合约，不声称完整符合 RFC 8785。

`ProjectMemory.computeEventLogDigest(events, { projectId? })` 对上述 canonical UTF-8 字节计算 SHA-256，并返回小写十六进制文本。`ProjectMemory.verifyEventLogDigest(events, expectedDigest, { projectId? })` 要求 expected digest 恰好为 64 个小写十六进制字符，并返回显式比较的布尔结果。两者复用相同的校验、canonicalization 与可选 project 锁定，且不改变输入。`ProjectMemory.computeEventLogRangeDigest(events, fromSeq, toSeq, { projectId? })` 返回完整已验证日志中闭合区间 `fromSeq..toSeq`（两端包含）的 digest；全区间调用与 `computeEventLogDigest()` 字节一致，而反向、非整数或超出日志长度的区间会被拒绝。权限上下文中可选的 `eventLogDigest` 携带调用方提供的 `algorithm: 'sha256'` 值；版本 1 将其定义为：恰为快照所声明闭区间的 digest，由 `computeEventLogRangeDigest()` 产生。digest 匹配只表示实际字节与期望值一致；它不是身份认证、数字签名、作者或批准证明、replay 授权，也无法防止能同时替换数据和 digest 的攻击者。

`ProjectMemory.verifyAuthorityContextEventLog(context, events, { projectId? })` 是把受约束权限快照与具体日志关联起来的一致性边界。它先用既有纯边界规范化 context 与完整事件日志（结构与 project 锁定问题会抛错），再把覆盖范围与 digest 的不匹配作为可消费结果返回：`{ valid, range: { fromSeq, toSeq, eventCount, withinLog }, digest?: { algorithm, verified } }`，无效时附带 `errors`。当 context 声明 `eventLogDigest` 时，digest 会按声明的精确闭区间重新计算并比对；`verified: false` 表示该元数据与这些事件不一致。校验从不要求 `toSeq === eventCount`——即使 `coverageIntent: 'complete'` 也只断言上边界，而非“日志到此结束”——它不选择胜者、不激活或失效快照，也不对声明区间之外的事件作任何断言。不是完整 seq-1 日志的摘录会被共享校验边界拒绝，而不会被重新解释；版本 1 仍然不支持独立摘要摘录。`verified: false` 是对结构自洽数据之间的显式比对结论，不是被拒绝的导入。

可选的 `supersedes` 对象用于显式记录 append-only revision lineage。它必须指向另一个既有 `authorityContextId`，并重复该目标的 `projectId`、`fromSeq` 与 `toSeq`；其项目与精确闭区间必须和新快照一致。规范化只会保留并防御性复制该关系，不会查找或证明目标存在、推断传递关系、选择胜者、激活新 revision、使旧快照失效，也不会允许 `normalizeAuthorityContextRanges()` 中出现重叠成员。应用必须保留两个快照，并在本合约之外显式定义后续选择策略。

`ProjectMemory.normalizeAuthorityContextLineage(contexts, { projectId? })` 可选地校验一个包含一条或多条独立线性 chain 的自包含 lineage 集合。它会规范化每个成员，要求 snapshot ID 唯一且项目一致，要求每个显式目标都出现在集合中且项目与精确范围匹配，并拒绝同一目标存在多个 successor 以及任何 cycle。`ProjectMemory.normalizeAuthorityContextChain(contexts, { projectId? })` 进一步要求每个非空集合恰有一个 root，从而保证所有给定成员组成一条连通 chain。两者都保留输入顺序并返回防御性副本。这只校验给定集合的结构：两者都不会在集合外发现目标、推断缺失或传递链接、排序 revision、选择 head/winner，也不会激活或使任何 snapshot 失效。若 dangling external reference 仅用于描述，应继续使用 `normalizeBoundAuthorityContext()`。
