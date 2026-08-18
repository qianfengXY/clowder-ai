---
description: "把 Cat Café 的项目/方案/多猫 Review 与 ChatGPT Desktop 的实现会话连接为可恢复、可重复的开发闭环。"
related_features: [F167, F211, F253, F275, F286]
topics: [chatgpt-desktop, project-binding, review-hub, managed-work, mcp]
tips_exempt: activation-bound Desktop capability; the user must explicitly enable the scoped profile and credential after independent review
---

# F289: ChatGPT Desktop Development Loop

> Status: implementation<br>
> Owner: CodeX (@cat-idwxwjba, GPT-5)<br>
> Priority: P1<br>
> Architecture cell: `desktop-development-loop` (new), consuming `managed-work`, `review-coordination` and `mcp-surface-governance`; F211 remains an unchanged Cat-runtime compatibility boundary

## Finish line

用户导入外部项目功能后，可以在该功能独立的方案讨论会话中协作，并把最终方案提交到为该功能绑定的方案分支。Cat Café 只以该分支的精确提交作为实现与 Review 权威，然后从功能列表自动创建对应的 ChatGPT Desktop 开发任务；实现提交后，Cat Café 在该功能独立、长期复用的 Review 会话中完成两猫独立 Review、交叉印证与 finding 闭环。任一可见聊天窗口被删除或替换，都不会删除项目、交付轮次、ReviewRound、方案分支绑定或证据。

## 用户旅程

1. 用户在 Cat Café 创建项目，同时绑定 GitHub 仓库、默认分支和本地 checkout。
2. 用户在该项目的普通会话中与猫猫讨论多个方案；冻结后的 Feature Doc、ADR 或实施计划提交到该功能绑定的方案分支。
3. Cat Café 校验方案分支属于项目绑定的同一 Git 仓库，并冻结其本地精确提交；未配置、未提交或仓库不一致时禁止启动。
4. 用户点击功能的“启动开发”；Cat Café 自动创建对应的 ChatGPT Desktop 任务，该任务连接精确 managed work 并取得带方案分支与方案 SHA 的 Resume Packet。
5. ChatGPT Desktop 在永久 worktree 中按冻结的方案 SHA 实现、测试、commit，并按项目策略 push/开 PR；Cat Café 不代替 Desktop 写产品代码。
6. 每个导入功能只有一个方案分支绑定、一个方案讨论会话和一个 Review 会话。每次新实现在该功能 Review 会话中创建新的 ReviewRound，不创建新的可见会话窗口。
7. CodeX 与 Kimi 对同一完整实现 SHA、同一完整方案 SHA 先独立 Review，再交叉印证；只有 barrier 打开后的共识 finding 会交给 Desktop。
8. ChatGPT 原实现会话读取 finding、修复、提交新 SHA；每次任务通知都重申方案分支精确提交，新实现 SHA 必须重新完成完整 ReviewRound，直到零 open finding。
9. 项目前两次成功试点必须由用户在当前 ChatGPT 会话中确认合入。只有“已合入且最终验收通过”才增加成功试点计数。
10. 两次成功试点后，项目自动切换为自动合入；exact-SHA、零 finding、检查与分支策略门禁不变，最终产品验收仍始终由用户完成。
11. 验收不通过时，同一项目和功能 Review 会话开启新的 delivery cycle，保留上一轮证据，不重建整个上下文。
12. Mission Hub 为每个功能展示当前 Attempt 的完整链路：方案提交、Desktop 实现、独立检视、交叉检视、共识、修复交接/合入、最终验收；只有服务端确认状态迁移后节点才显示完成。
13. 当前节点停滞时，用户可以从链路上重新投递该节点的合法动作。重投不得跳过方案 SHA、实现 exact-SHA Review、方案分歧、15 轮续审或最终验收，也不得创建平行 work/attempt/round。
14. 当现有 reviewer 无法形成共识时，不引入第三 reviewer。用户可在 Mission Hub 给出最终裁决，并授权原共识记录猫在同一 round、同一 exact SHA 上提交最终检视意见。

## 角色边界

| 角色 | 负责 | 禁止 |
|---|---|---|
| Cat Café 猫猫 | 需求/方案、Feature Doc/ADR、只读代码检视、运行既有检查、独立 finding、交叉共识 | 代替 Desktop 实现产品代码；作者自审；独立阶段互看草稿 |
| ChatGPT Desktop developer | worktree、实现/测试、commit/push/PR、修复 finding、满足 gate 后合入 | 作为自身代码 reviewer；改写猫猫私有草稿；绕过 exact-SHA gate |
| 用户 | 绑定项目、配置自动化、裁决无法收敛的 Review 分歧、前两次合入确认、最终验收、必要时重新绑定会话 | 被迫手工搬运每轮 Review 的文本或重复创建窗口 |

Desktop developer 使用独立 external actor（初始保留名 `chatgpt-desktop-dev`），它永远不具备 reviewer 资格。

## 产品模型

### 一个功能，一个方案分支、一个方案讨论会话和一个 Review 会话

- 方案分支绑定由 `projectId + backlogItemId` 确定；只接受项目绑定仓库中的本地已提交分支，并在每轮实现/Review 中记录精确 SHA。
- 两个会话身份由 `projectId + backlogItemId + kind` 确定，长期复用。方案讨论会话只承载讨论背景，不是实现或 Review 权威。
- ReviewRound 是 Hub 内的持久对象；一个 SHA 对应一个 immutable round。
- Review 对应的 Cat Café thread 是可见视图。软删除后可原位恢复；不得因为软删除就为同一功能创建第二个 Review 会话。
- 历史项目级 Review Hub 只为已经在途的旧 round 保留回调兼容；新 round 一律投影到功能 Review 会话。

### 聊天窗口不是状态根

- ChatGPT chat 只是一条可替换的 session binding。
- Desktop binding 不按时间过期；只有显式 rebind 提升 epoch 才会让旧会话失去写权限。
- 新 ChatGPT chat 通过同一项目重新连接，获得更高 binding epoch 和 Resume Packet；旧 chat 随即失去写权限。
- Cat Café thread 软删除只影响可见性；恢复后继续显示同一个 Hub。
- worktree 丢失时仅从最后一个已 commit（及按策略已 push）的 SHA 恢复；未提交内容不声称可恢复。

### 自动合入试点

- `successfulManualPilotCount` 为项目级持久状态，范围 `0..2`。
- 计数只在该 delivery cycle 已合入且用户最终验收为 `accepted` 后增加，幂等且最多一次。
- 当计数 `< 2` 时，`mergeMode` 必须是 `manual_confirm_in_chatgpt`。
- 达到 `2` 的同一原子更新会把 `mergeMode` 自动切换为 `automatic`，不再要求第三次人工开关。
- 自动合入仍要求：最新 exact SHA Review 通过、历史 finding 全闭环、分支/检查/仓库策略允许。
- deploy 和生产数据变更始终不属于本功能。

### 有界、方案约束的 Review 循环

- Review 只有在当前 exact SHA 的全部共识 finding 已解决后才可停止并进入合入门禁；存在 open finding 必须回到原 Desktop 任务修复。
- 每个 finding 必须携带规范的 `git:refs/heads/<方案分支>@<完整方案 SHA>`，并标记为 `plan_conformance` 或 `architecture_decision`。Reviewer 只能依据本轮冻结的方案提交判断实现偏差；安全、性能意见也必须引用该提交，不得借 Review 引入个人偏好、方案外重构或新需求。
- 严重架构问题只能作为 P1 `architecture_decision` finding 提交。Cat Café 暂停 Review 并上报用户；用户与猫猫可以继续在会话中讨论，但只有修改并提交方案分支后，才能选择“方案分支已更新，继续”。保持原方案则要求分支仍指向本轮方案 SHA。决定作为 managed-work evidence 持久化后才可继续实现与 Review。
- 初始允许 attempt 1–15。第 15 次 Review 后仍有 open finding 时，Cat Café 进入 `awaiting_review_continuation`，由用户批准后再开放下一组 15 次；禁止后台无限唤醒 Desktop。
- 历史 round 缺少新字段时只按 `plan_conformance` 兼容读取；若功能已有有效方案分支，则以其当前精确提交补充 `designRef`，否则停在方案分支配置门禁。不得把讨论会话或旧 P1 追溯解释为方案权威，也不从 Review 证据猜测设计。
- 两名 reviewer 在交叉检视后仍无法收敛时，round 保持 `consensus_ready`。用户裁决以 append-only `review_consensus_authorized` 证据绑定 `reviewRoundId + exactSha`；原 recorder 只能据此整理并发布共识，不得新增 reviewer。该授权只解决分歧，不绕过 merge confirmation 或 final acceptance。

## Stateful Object Census

| 对象 | 真相所有者 | 身份与持久状态 | 关键不变量 |
|---|---|---|---|
| `DesktopDevelopmentProjectBinding` | F289 | `projectId`、repo、default branch、本地 checkout 引用、reviewer roster、merge policy、pilot count、protocol version、version | TTL=0；路径仅本地返回；不得从目录/聊天猜绑定 |
| `FeatureDesignBranchBinding` | F289 | `projectId/backlogItemId`、方案分支名；精确 SHA 在读取、任务和 ReviewRound 中冻结 | 分支必须属于绑定仓库且已有提交；会话不能替代它；Review 分歧只能通过用户决策及方案提交推进 |
| `FeatureWorkspaceThreads` | F289 + existing ThreadStore view | deterministic `projectId/backlogItemId/kind`、方案讨论/Review thread views | 每功能至多一个方案讨论与一个 Review 会话；软删除原位恢复；旧 project Hub 仅兼容在途回调 |
| `DesktopSessionBinding` | F289 | project/work、external actor runtime session、chat ref、binding epoch、status | 绑定永久有效；同一 work 仅最高 epoch 可写；窗口消失不终止 work；不伪装成 F211 Cat session |
| `WorkspaceBinding` | F289 | repo identity、永久 worktree、branch、base/current SHA、validation time | 不对公共消息暴露路径；丢失只恢复 committed truth |
| `WorkAdmission` / `WorkAttempt` / terminal evidence | F275 | canonical work root、ordered attempts、typed evidence、whole-work terminal | F289 不创建平行 job/attempt/terminal ledger |
| `ReviewRound` | F253 review coordination | work/attempt、full SHA、private drafts、barrier、consensus、finding status、version | full SHA immutable；两名非作者；barrier 前草稿隔离 |
| `ResumePacket` | derived projection | project/work/attempt/session/workspace/review 的只读合成 | 不持久化第二份 phase；不含 secret/private draft |

所有用户可见、可追溯、可恢复对象 TTL=0。Desktop 会话 binding 同样不按时间过期。

## 生命周期

```text
awaiting_design_branch
  -> design_ready
  -> ready_for_desktop
  -> implementing
  -> implementation_ready
  -> independent_review
  -> cross_review
  -> fix_required -> implementing (new attempt / new SHA / new round)
  -> awaiting_architecture_decision -> design branch commit -> fix_required
  -> awaiting_review_continuation (attempt 15/30/45...) -> fix_required
  -> approved_for_merge
  -> awaiting_manual_merge_confirmation | auto_merge_ready
  -> acceptance_pending
  -> accepted | rejected -> design_ready (new delivery cycle)
```

Mission Hub 把这个生命周期投影为当前 Attempt 的有序节点，而不是创建第二份状态机。节点使用
`pending / active / blocked / completed` 表示可见进度，并携带当前负责人、开始/完成时间、Review 完成人数和
唯一合法的人工恢复动作。`completed` 只能从 F275 evidence、F253 ReviewRound 或 terminal truth 推导；聊天文字、
Resume Capsule 的 baton holder 和按钮点击本身都不能证明已经交给下一轮。

人工“再次触发”只重投当前节点：实现/修复/合入节点唤醒原绑定 Desktop 任务；Review 节点向尚未完成的
reviewer 或 recorder 重发带 `Review 系统消息` 标识的当前 stage。用户决策门禁继续使用专用动作，通用重试接口
必须拒绝代替用户做决定。

Review 系统消息只携带路由、项目/功能、阶段、实现 SHA、共用方案分支/SHA、功能设计文档、round 与进度，并要求加载
`chatgpt-review-rounds` skill。统一表格、回调顺序和强制约束只在 skill 中维护，不在每轮消息里重复展开。

whole-work attempt/terminal 语义仍由 F275 拥有。若 named-consumer port 不可用，F289 必须返回 `managed_work_capability_unavailable`，不能通过 thread、branch、task 或本地 Redis key 猜测/复制 work identity。

## 核心不变量

1. 项目绑定是唯一 repo/默认分支/本地 checkout/自动化策略真相源；项目级共用方案分支的精确提交与该功能选中的设计文档共同构成实现和 Review 的方案真相源。
2. 一个项目只有一个方案分支绑定；一个导入功能有一组设计文档、一个方案讨论会话和一个 Review 会话。一个实现 exact SHA + 方案 exact SHA + 文档清单组合只有一个 active immutable ReviewRound。
3. 每个 Review 阶段面向用户的回复统一采用同一份双表格协议：阶段摘要表 + 检视意见明细表。GPT、Kimi 与后续 reviewer 不得自行改列或退回纯文字；无 finding 也必须保留一行“通过”。明细表只显示从 `1` 开始的短序号，完整 finding ID 仅用于 callback。独立检视表只包含当前 reviewer 自己的内容，barrier 规则不因展示格式而放宽。
4. Review 至少两名非作者，独立阶段草稿不可互见；barrier 原子打开。
5. 任意代码、测试或配置 delta 都使旧 round stale；修复后必须用新 full SHA 开新 round。
6. `openFindingCount > 0` 必须回到修复；merge 只允许最新 SHA 通过且历史共识 finding 全关闭。
6. session/transition/evidence 写入同时验证 actor、项目 scope、expected version、binding epoch 与 idempotency key。
7. Resume Packet 是 server-derived projection，不能包含凭据、私有 reviewer draft 或可从远端滥用的本地绝对路径。
8. MCP 不暴露 shell、任意文件写、Git push/merge 或 deploy；Desktop 通过自身本地工具完成 repo mutation。
9. 协议版本或 capability 不兼容时写操作 fail closed；只读状态与恢复指引仍可返回。
10. Cat Café 或 ChatGPT 可见窗口删除不等于 work/ReviewRound/证据删除。
11. Review finding 必须引用冻结的方案提交，且只能引用本功能选中的设计文档；中英文成对时只读取中文权威文档，英文翻译件不进入 Review。未由用户决定且未提交到共用方案分支的严重架构冲突，以及每 15 次循环边界，均阻断下一次 Desktop 投递。
12. Reviewer 无法形成共识时只接受当前用户的显式裁决授权；不得自动多数表决、追加 reviewer 或从聊天文字猜测授权。授权一经记录不可静默改写。

## MCP 合同

新增 strict runtime profile `desktop:development-loop`（启动模式 `development-loop`），只包含 7 个 Desktop lifecycle 工具：

- `cat_cafe_development_project_read`：按 project ID 或精确 GitHub repo 读取项目绑定、历史 Hub 兼容标识，以及由项目 Backlog + Workflow SOP 导出的权威 managed-work candidates；多候选时 Desktop 必须请用户选择。
- `cat_cafe_development_work_read`：读取 Resume Packet、当前 attempt、检查证据与 legal actions。
- `cat_cafe_development_work_connect`：claim/rebind 当前 Desktop chat，提升 binding epoch。
- 当 Resume Packet 为 `fix_required` 时，同一 connect 工具幂等创建下一 F275 attempt 并把当前 chat 绑定到
  新 attempt；返回递增的 `attemptNumber`，不新增第八个 lifecycle 工具或 F289 私有 attempt ledger。
- `cat_cafe_development_work_heartbeat`：刷新 committed workspace metadata；不承担续租。
- `cat_cafe_development_implementation_report`：报告 committed exact SHA 并在当前 backlog 功能的 Review 会话触发新 round。
- `cat_cafe_development_merge_confirmation_record`：记录前两次试点中当前 chat 的用户确认；不执行 Git。
- `cat_cafe_development_merge_report`：记录 Desktop 原生 Git 已产生的 merge receipt；不执行 Git。

Review 猫仍运行在 full profile，通过 7 个 `cat_cafe_review_*` callback-scoped 工具完成 private draft、barrier、cross-review 与 consensus。F211 的 `antigravity-desktop` Cat session registry 不承载 `chatgpt-desktop-dev` external actor，避免伪造 `CatId`、agent-key principal 或 Antigravity provenance。

每个写动作带 side-effect annotation，返回更新后的 resource/version 与 server-derived `nextLegalActions`。

## 依赖边界（用功能说明，不要求用户记 F 号）

- **managed-work（F275）**：拥有 work/attempt/evidence/accepted-rejected 真相；F289 只消费命名接口。
- **successor lease（F167）**：只用于 Cat Café 内部把 Review 棒交给猫猫；Desktop binding 不使用时间租约。
- **review coordination（F253）**：拥有 independent-first、exact-SHA、barrier、cross-review、repeat-until-zero 语义。
- **Cat runtime session（F211 compatibility boundary）**：继续只登记具备 CatId/agent-key/Antigravity provenance 的 Cat session；F289 不改写也不复用这套身份模型。
- **MCP governance（F286）**：约束 strict profile、authority、annotation 和 fail-closed capability negotiation。

## Acceptance Criteria

### Project / Hub

- [x] AC-P1: 创建或更新 Cat Café 项目可绑定规范化 GitHub repo、默认分支、本地 checkout 与默认 reviewers；Desktop actor 不能进入 reviewer roster。（`desktop-development-loop.test.js`、`external-project-routes.test.js`、`desktop-development-form.test.ts`）
- [x] AC-P2: 每个项目只会 resolve 到一个 Review Hub；10 个并发 ensure 请求仍只创建/恢复一个 Hub thread。（`project-review-hub-service.test.js`）
- [x] AC-P3: Hub thread 软删除后原位恢复且 round/history 不变；底层视图不可恢复地丢失时按同一 deterministic Hub ID 重建，不复制 lifecycle truth。（`project-review-hub-service.test.js`）
- [x] AC-P4: 项目绑定和 pilot count 在服务重启后仍存在；本地路径不出现在公开 DTO/消息/日志。（`external-project-store.test.js`、`desktop-development-loop.test.js`）
- [x] AC-P5: 项目可持久绑定一个本地已提交共用方案分支，每个功能可选择其中一至多份设计文档；启动、恢复、Desktop 任务和 ReviewRound 都冻结并展示精确方案 SHA 与文档，错误仓库/缺失分支/缺失文档 fail closed。（`design-branch-resolver.test.js`、`external-project-store.redis.test.js`、`desktop-development-launch.test.js`、`desktop-development-loop-routes.test.js`）

### Desktop session / recovery

- [x] AC-S1: F289 以独立 external actor 持久化 Desktop session provenance；F211 继续只接受 `antigravity-desktop` Cat session，既有行为零修改。（`desktop-session-store.test.js` + source inventory）
- [x] AC-S2: 新 chat rebind 提升 epoch；旧 epoch 的 heartbeat/report 被拒绝。（`desktop-session-store.test.js`、`desktop-development-loop-service.test.js`）
- [x] AC-S3: chat/app 消失或 Cat Café 重启后，永久 binding 与同一 work 可通过 Resume Packet 恢复且不重复 attempt/commit/round。（`desktop-session-store.test.js`、`desktop-development-loop-service.test.js`）
- [x] AC-S4: worktree 丢失返回 committed recovery point 和明确人工/自动重建动作，不声称恢复未提交数据。（`desktop-session-store.test.js`、`desktop-development-loop-service.test.js`、`desktop-executor-skill.test.ts`）

### Review / feedback loop

- [x] AC-R1: 至少两名非作者在同一 full SHA 上独立完成后 barrier 才打开，并发 finish 不会提前泄露草稿。（`review-round-store.test.js`）
- [x] AC-R2: 共识 finding 有稳定 finding ID/evidence/status；Desktop 只能读取 barrier-safe projection。（`review-round-store.test.js`）
- [x] AC-R3: 新 SHA 使旧 round stale；有 open finding 时不能 merge；零 finding 只批准最新 SHA。（work-current + atomic consensus regression）
- [x] AC-R4: 同一功能 Review 会话可连续承载多个 delivery cycle、attempt 与 round；不同功能互不混流。（`project-review-hub-service.test.js`、`desktop-development-loop-service.test.js`）
- [x] AC-R5: finding 必须携带方案引用与范围；严重架构冲突在 Cat Café 等待用户决策，不能被 Review 建议暗中改写方案。（`review-round-callback-routes.test.js`、`review-round-tools.test.ts`、`review-loop-policy.test.js`）
- [x] AC-R6: 第 15 次及之后每组 15 次 Review 未清零时等待用户续审批准；Desktop IPC 只有在任务实际出现该轮消息后才清除 durable outbox。（`review-loop-policy.test.js`、`codex-desktop-task-launcher.test.js`）
- [x] AC-R7: Mission Hub 展示服务端推导的完整 Attempt 链路、负责人、Review 进度与迁移时间；当前 Desktop/Review 节点可由用户幂等重投，过期 version 被拒绝，人工门禁不可被通用重试绕过。（`desktop-development-loop-service.test.js`、`desktop-development-loop-routes.test.js`、`DesktopDevelopmentPanel.tsx`）
- [x] AC-R8: 共识无法收敛时，用户可为当前 round + exact SHA 写入不可变裁决授权；服务端重投原 recorder 并暴露授权状态，不新增 reviewer，也不放宽合入与验收门禁。（`desktop-development-loop-service.test.js`、`desktop-development-loop-routes.test.js`、`review-round-stage-dispatcher.test.js`、`desktop-development-form.test.ts`）
- [x] AC-R9: Review 系统消息保持短小，只投递准确身份/阶段/双 SHA 并加载统一 skill；模板与稳定强制约束不重复嵌入每条消息。（`review-round-stage-dispatcher.test.js`、`chatgpt-review-rounds/SKILL.md`）
- [x] AC-R10: 可见 Review 明细表只显示短序号，完整 finding ID 保留在 callback carrier 中且不得作为表格宽列泄露。（`check-external-review-closure.test.mjs`、`chatgpt-review-round-template.md`）

### Merge / acceptance

- [x] AC-M1: 前两次成功试点必须在当前 ChatGPT binding 中取得用户确认；没有确认 token/evidence 时 merge 不可执行。（`desktop-development-loop-service.test.js`、`desktop-development-loop-routes.test.js`）
- [x] AC-M2: pilot count 只在 merge + final acceptance 后幂等增加；rejected/aborted cycle 不计数。（`desktop-development-loop-service.test.js`、`managed-work-consumer-port.test.js`）
- [x] AC-M3: 第二次成功验收会自动切换 auto-merge；自动合入仍受 exact-SHA/review/check/branch policy gate。（`external-project-store.test.js`、`desktop-development-loop-service.test.js`、`review-round-store.test.js`）
- [x] AC-M4: merge 后进入 `acceptance_pending`；只有用户验收可进入 `accepted`，拒绝开启新的 delivery cycle。（`desktop-development-loop-service.test.js`、`managed-work-consumer-port.test.js`、`desktop-development-form.test.ts`）

### Security / compatibility

- [x] AC-C1: `desktop:development-loop` profile 不包含 shell、任意文件写、Git mutation、merge 或 deploy primitive。（`desktop-mode.test.ts`、`desktop-development-loop-tools.test.ts`）
- [x] AC-C2: 所有写操作验证 actor/scope/version/epoch/idempotency；跨项目、过期 actor、作者自审全部 fail closed。（`desktop-development-loop-service.test.js`、`desktop-development-loop-routes.test.js`、`review-round-callback-routes.test.js`）
- [x] AC-C3: client protocol/capability 不兼容时禁止写，返回兼容性原因和安全升级指引。（`desktop-development-loop-routes.test.js`、`desktop-development-loop-service.test.js`）
- [x] AC-C4: 不把任一试点项目的 Issue、语言、ledger 或 PR comment 规则提升为 F289 核心契约。（`desktop-executor-skill.test.ts`、MCP inventory tests）

## 分阶段交付

1. **Contract + Project/Hub foundation**：类型、项目绑定、唯一 Review Hub、软删除恢复、UI 配置面。
2. **Session + Resume**：F289 external Desktop session source、永久 binding epoch、Resume Packet；F211 Cat session contract 不变。
3. **Managed work port**：接通 F275 ordered attempt/evidence/terminal 接口；不可用时 fail closed。
4. **Review coordinator**：F253 durable round、private barrier、consensus/finding closure。
5. **Strict MCP + Desktop skill**：治理 profile、executor skill、Scheduled Task 幂等 polling/recovery。
6. **Pilot rollout**：两个按项目计数的人工合入/验收试点，第二次成功后自动切换 auto-merge。

## Non-goals

- 不从 Cat Café 远程操纵 ChatGPT Desktop UI，也不强制创建 ChatGPT chat。
- 不保证恢复未 commit 的 worktree 内容。
- 不自动部署、不修改生产数据、不自动取得新的 GitHub/ChatGPT 权限。
- 不要求把 finding 发布成 GitHub Issue、双语文本、ledger 或 PR comment。
- 不把 ChatGPT 或 Cat Café 的窗口 ID 当作 work identity。

## Verification baseline

- shared contract/type tests；API store/route/restart/concurrency tests；MCP registry/profile snapshots。
- isolated Redis `redis://localhost:6398`，绝不使用 runtime/production store。
- UI 配置与恢复状态使用 browser preview 验证。
- exact HEAD 上执行 targeted gate、full repository gate、非作者安全/架构 Review。
