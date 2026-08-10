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

用户在 Cat Café 项目中完成方案讨论后，可以把同一项目交给 ChatGPT Desktop 实现；实现提交后，Cat Café 在该项目唯一、长期复用的 Review Hub 中完成两猫独立 Review、交叉印证与 finding 闭环；ChatGPT 原实现会话读取结果继续修复，直到允许合入。任一可见聊天窗口被删除或替换，都不会删除项目、交付轮次、ReviewRound 或证据。

## 用户旅程

1. 用户在 Cat Café 创建项目，同时绑定 GitHub 仓库、默认分支和本地 checkout。
2. 用户在该项目的普通会话中与猫猫讨论多个方案；冻结后的 Feature Doc、ADR 或实施计划提交到绑定仓库。
3. 用户在 ChatGPT Desktop 选择同一个本地项目；当前 ChatGPT 会话连接 Cat Café 项目并取得 Resume Packet。
4. ChatGPT Desktop 在永久 worktree 中实现、测试、commit，并按项目策略 push/开 PR；Cat Café 不代替 Desktop 写产品代码。
5. 每个 Cat Café 项目只有一个 Review Hub。每次新实现只在这个 Hub 中创建新的 ReviewRound，不创建新的可见会话窗口。
6. CodeX 与 Kimi 对同一完整 commit SHA 先独立 Review，再交叉印证；只有 barrier 打开后的共识 finding 会交给 Desktop。
7. ChatGPT 原实现会话读取 finding、修复、提交新 SHA；新 SHA 必须重新完成完整 ReviewRound，直到零 open finding。
8. 项目前两次成功试点必须由用户在当前 ChatGPT 会话中确认合入。只有“已合入且最终验收通过”才增加成功试点计数。
9. 两次成功试点后，用户可以按项目显式开启自动合入；最终产品验收仍始终由用户完成。
10. 验收不通过时，同一项目和 Review Hub 开启新的 delivery cycle，保留上一轮证据，不重建整个上下文。

## 角色边界

| 角色 | 负责 | 禁止 |
|---|---|---|
| Cat Café 猫猫 | 需求/方案、Feature Doc/ADR、只读代码检视、运行既有检查、独立 finding、交叉共识 | 代替 Desktop 实现产品代码；作者自审；独立阶段互看草稿 |
| ChatGPT Desktop developer | worktree、实现/测试、commit/push/PR、修复 finding、满足 gate 后合入 | 作为自身代码 reviewer；改写猫猫私有草稿；绕过 exact-SHA gate |
| 用户 | 绑定项目、配置自动化、前两次合入确认、最终验收、必要时重新绑定会话 | 被迫手工搬运每轮 Review 的文本或重复创建窗口 |

Desktop developer 使用独立 external actor（初始保留名 `chatgpt-desktop-dev`），它永远不具备 reviewer 资格。

## 产品模型

### 一个项目，一个 Review Hub

- Review Hub 身份由 `projectId` 确定，长期复用。
- ReviewRound 是 Hub 内的持久对象；一个 SHA 对应一个 immutable round。
- Hub 对应的 Cat Café thread 是可见视图。软删除后可原位恢复；不得因为软删除就创建第二个 Hub。
- 底层 thread 即使被不可恢复地移除，也只按同一个 deterministic Hub ID 重建可见视图；ReviewRound 真相不复制、不迁移。

### 聊天窗口不是状态根

- ChatGPT chat 只是一条可替换的 session binding。
- heartbeat/lease 过期只会使该 binding `detached`，不会把 work 判失败或删除永久 worktree。
- 新 ChatGPT chat 通过同一项目重新连接，获得更高 binding epoch 和 Resume Packet；旧 chat 随即失去写权限。
- Cat Café thread 软删除只影响可见性；恢复后继续显示同一个 Hub。
- worktree 丢失时仅从最后一个已 commit（及按策略已 push）的 SHA 恢复；未提交内容不声称可恢复。

### 自动合入试点

- `successfulManualPilotCount` 为项目级持久状态，范围 `0..2`。
- 计数只在该 delivery cycle 已合入且用户最终验收为 `accepted` 后增加，幂等且最多一次。
- 当计数 `< 2` 时，`mergeMode` 必须是 `manual_confirm_in_chatgpt`。
- 达到 `2` 后，系统只展示“可启用自动合入”；必须由用户显式改为 `automatic`。
- 自动合入仍要求：最新 exact SHA Review 通过、历史 finding 全闭环、分支/检查/仓库策略允许。
- deploy 和生产数据变更始终不属于本功能。

## Stateful Object Census

| 对象 | 真相所有者 | 身份与持久状态 | 关键不变量 |
|---|---|---|---|
| `DesktopDevelopmentProjectBinding` | F289 | `projectId`、repo、default branch、本地 checkout 引用、reviewer roster、merge policy、pilot count、protocol version、version | TTL=0；路径仅本地返回；不得从目录/聊天猜绑定 |
| `ProjectReviewHub` | F289 + existing ThreadStore view | deterministic `hubId/projectId`、thread view | 每项目至多一个 active Hub；软删除原位恢复；视图丢失仍按同一 ID 重建 |
| `DesktopSessionBinding` | F289 | project/work、external actor runtime session、chat ref、lease、binding epoch、status | 同一 work 仅最高 epoch 可写；窗口消失不终止 work；不伪装成 F211 Cat session |
| `WorkspaceBinding` | F289 | repo identity、永久 worktree、branch、base/current SHA、validation time | 不对公共消息暴露路径；丢失只恢复 committed truth |
| `WorkAdmission` / `WorkAttempt` / terminal evidence | F275 | canonical work root、ordered attempts、typed evidence、whole-work terminal | F289 不创建平行 job/attempt/terminal ledger |
| `ReviewRound` | F253 review coordination | work/attempt、full SHA、private drafts、barrier、consensus、finding status、version | full SHA immutable；两名非作者；barrier 前草稿隔离 |
| `ResumePacket` | derived projection | project/work/attempt/session/workspace/review 的只读合成 | 不持久化第二份 phase；不含 secret/private draft |

所有用户可见、可追溯、可恢复对象 TTL=0。会话 lease 可以过期，但对应 durable binding/history 不删除。

## 生命周期

```text
design_ready
  -> ready_for_desktop
  -> implementing
  -> implementation_ready
  -> independent_review
  -> cross_review
  -> fix_required -> implementing (new attempt / new SHA / new round)
  -> approved_for_merge
  -> awaiting_manual_merge_confirmation | auto_merge_ready
  -> acceptance_pending
  -> accepted | rejected -> design_ready (new delivery cycle)
```

whole-work attempt/terminal 语义仍由 F275 拥有。若 named-consumer port 不可用，F289 必须返回 `managed_work_capability_unavailable`，不能通过 thread、branch、task 或本地 Redis key 猜测/复制 work identity。

## 核心不变量

1. 项目绑定是唯一 repo/默认分支/本地 checkout/自动化策略真相源。
2. 一个项目只有一个 Review Hub；一个 exact SHA 只有一个 active immutable ReviewRound。
3. Review 至少两名非作者，独立阶段草稿不可互见；barrier 原子打开。
4. 任意代码、测试或配置 delta 都使旧 round stale；修复后必须用新 full SHA 开新 round。
5. `openFindingCount > 0` 必须回到修复；merge 只允许最新 SHA 通过且历史共识 finding 全关闭。
6. session/lease/transition/evidence 写入同时验证 actor、项目 scope、expected version、binding epoch 与 idempotency key。
7. Resume Packet 是 server-derived projection，不能包含凭据、私有 reviewer draft 或可从远端滥用的本地绝对路径。
8. MCP 不暴露 shell、任意文件写、Git push/merge 或 deploy；Desktop 通过自身本地工具完成 repo mutation。
9. 协议版本或 capability 不兼容时写操作 fail closed；只读状态与恢复指引仍可返回。
10. Cat Café 或 ChatGPT 可见窗口删除不等于 work/ReviewRound/证据删除。

## MCP 合同

新增 strict runtime profile `desktop:development-loop`（启动模式 `development-loop`），只包含 7 个 Desktop lifecycle 工具：

- `cat_cafe_development_project_read`：按 project ID 或精确 GitHub repo 读取项目绑定、Review Hub，以及由项目 Backlog + Workflow SOP 导出的权威 managed-work candidates；多候选时 Desktop 必须请用户选择。
- `cat_cafe_development_work_read`：读取 Resume Packet、当前 attempt、检查证据与 legal actions。
- `cat_cafe_development_work_connect`：claim/rebind 当前 Desktop chat，提升 binding epoch。
- `cat_cafe_development_work_heartbeat`：续租并可刷新 committed workspace metadata。
- `cat_cafe_development_implementation_report`：报告 committed exact SHA 并触发同一 Review Hub 的新 round。
- `cat_cafe_development_merge_confirmation_record`：记录前两次试点中当前 chat 的用户确认；不执行 Git。
- `cat_cafe_development_merge_report`：记录 Desktop 原生 Git 已产生的 merge receipt；不执行 Git。

Review 猫仍运行在 full profile，通过 7 个 `cat_cafe_review_*` callback-scoped 工具完成 private draft、barrier、cross-review 与 consensus。F211 的 `antigravity-desktop` Cat session registry 不承载 `chatgpt-desktop-dev` external actor，避免伪造 `CatId`、agent-key principal 或 Antigravity provenance。

每个写动作带 side-effect annotation，返回更新后的 resource/version 与 server-derived `nextLegalActions`。

## 依赖边界（用功能说明，不要求用户记 F 号）

- **managed-work（F275）**：拥有 work/attempt/evidence/accepted-rejected 真相；F289 只消费命名接口。
- **successor lease（F167）**：只用于 Cat Café 内部把 Review 棒交给猫猫，不用于 Desktop execution lease。
- **review coordination（F253）**：拥有 independent-first、exact-SHA、barrier、cross-review、repeat-until-zero 语义。
- **Cat runtime session（F211 compatibility boundary）**：继续只登记具备 CatId/agent-key/Antigravity provenance 的 Cat session；F289 不改写也不复用这套身份模型。
- **MCP governance（F286）**：约束 strict profile、authority、annotation 和 fail-closed capability negotiation。

## Acceptance Criteria

### Project / Hub

- [x] AC-P1: 创建或更新 Cat Café 项目可绑定规范化 GitHub repo、默认分支、本地 checkout 与默认 reviewers；Desktop actor 不能进入 reviewer roster。（`desktop-development-loop.test.js`、`external-project-routes.test.js`、`desktop-development-form.test.ts`）
- [x] AC-P2: 每个项目只会 resolve 到一个 Review Hub；10 个并发 ensure 请求仍只创建/恢复一个 Hub thread。（`project-review-hub-service.test.js`）
- [x] AC-P3: Hub thread 软删除后原位恢复且 round/history 不变；底层视图不可恢复地丢失时按同一 deterministic Hub ID 重建，不复制 lifecycle truth。（`project-review-hub-service.test.js`）
- [x] AC-P4: 项目绑定和 pilot count 在服务重启后仍存在；本地路径不出现在公开 DTO/消息/日志。（`external-project-store.test.js`、`desktop-development-loop.test.js`）

### Desktop session / recovery

- [x] AC-S1: F289 以独立 external actor 持久化 Desktop session provenance；F211 继续只接受 `antigravity-desktop` Cat session，既有行为零修改。（`desktop-session-store.test.js` + source inventory）
- [x] AC-S2: 新 chat rebind 提升 epoch；旧 epoch 的 heartbeat/report 被拒绝。（`desktop-session-store.test.js`、`desktop-development-loop-service.test.js`）
- [x] AC-S3: chat/app 消失、lease 过期或 Cat Café 重启后，同一 work 可通过 Resume Packet 恢复且不重复 attempt/commit/round。（`desktop-session-store.test.js`、`desktop-development-loop-service.test.js`）
- [x] AC-S4: worktree 丢失返回 committed recovery point 和明确人工/自动重建动作，不声称恢复未提交数据。（`desktop-session-store.test.js`、`desktop-development-loop-service.test.js`、`desktop-executor-skill.test.ts`）

### Review / feedback loop

- [x] AC-R1: 至少两名非作者在同一 full SHA 上独立完成后 barrier 才打开，并发 finish 不会提前泄露草稿。（`review-round-store.test.js`）
- [x] AC-R2: 共识 finding 有稳定 finding ID/evidence/status；Desktop 只能读取 barrier-safe projection。（`review-round-store.test.js`）
- [x] AC-R3: 新 SHA 使旧 round stale；有 open finding 时不能 merge；零 finding 只批准最新 SHA。（work-current + atomic consensus regression）
- [x] AC-R4: 同一 Review Hub 可连续承载多个 feature、delivery cycle、attempt 与 round，不产生窗口爆炸。（`project-review-hub-service.test.js`、`desktop-development-loop-service.test.js`）

### Merge / acceptance

- [x] AC-M1: 前两次成功试点必须在当前 ChatGPT binding 中取得用户确认；没有确认 token/evidence 时 merge 不可执行。（`desktop-development-loop-service.test.js`、`desktop-development-loop-routes.test.js`）
- [x] AC-M2: pilot count 只在 merge + final acceptance 后幂等增加；rejected/aborted cycle 不计数。（`desktop-development-loop-service.test.js`、`managed-work-consumer-port.test.js`）
- [x] AC-M3: 两次成功后只能由用户显式启用 auto-merge；开启后仍受 exact-SHA/review/check/branch policy gate。（`desktop-development-loop.test.js`、`review-round-store.test.js`）
- [x] AC-M4: merge 后进入 `acceptance_pending`；只有用户验收可进入 `accepted`，拒绝开启新的 delivery cycle。（`desktop-development-loop-service.test.js`、`managed-work-consumer-port.test.js`、`desktop-development-form.test.ts`）

### Security / compatibility

- [x] AC-C1: `desktop:development-loop` profile 不包含 shell、任意文件写、Git mutation、merge 或 deploy primitive。（`desktop-mode.test.ts`、`desktop-development-loop-tools.test.ts`）
- [x] AC-C2: 所有写操作验证 actor/scope/version/epoch/idempotency；跨项目、过期 actor、作者自审全部 fail closed。（`desktop-development-loop-service.test.js`、`desktop-development-loop-routes.test.js`、`review-round-callback-routes.test.js`）
- [x] AC-C3: client protocol/capability 不兼容时禁止写，返回兼容性原因和安全升级指引。（`desktop-development-loop-routes.test.js`、`desktop-development-loop-service.test.js`）
- [x] AC-C4: 不把任一试点项目的 Issue、语言、ledger 或 PR comment 规则提升为 F289 核心契约。（`desktop-executor-skill.test.ts`、MCP inventory tests）

## 分阶段交付

1. **Contract + Project/Hub foundation**：类型、项目绑定、唯一 Review Hub、软删除恢复、UI 配置面。
2. **Session + Resume**：F289 external Desktop session source、binding epoch、lease、Resume Packet；F211 Cat session contract 不变。
3. **Managed work port**：接通 F275 ordered attempt/evidence/terminal 接口；不可用时 fail closed。
4. **Review coordinator**：F253 durable round、private barrier、consensus/finding closure。
5. **Strict MCP + Desktop skill**：治理 profile、executor skill、Scheduled Task 幂等 polling/recovery。
6. **Pilot rollout**：两个按项目计数的人工合入/验收试点，再开放显式 auto-merge。

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
