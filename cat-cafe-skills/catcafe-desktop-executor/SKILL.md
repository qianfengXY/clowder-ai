---
name: catcafe-desktop-executor
tips_exempt: activation-bound Desktop capability; the user must explicitly enable the scoped development-loop profile and credential
description: >
  ChatGPT Desktop 侧执行 Cat Café 项目中的权威 managed work，并把精确提交交回该功能的 Review 会话闭环。
  Use when: 用户在 ChatGPT Desktop 中要求实现、恢复或修复一个已经绑定 Cat Café 的 GitHub 项目。
  Not for: Cat Café 猫猫自己写代码、没有项目绑定的任意仓库任务、替用户开启权限或自动合入。
  Output: 可恢复的 Desktop binding + 精确 commit SHA + 最新 Resume Packet，或明确的安全阻断原因。
triggers:
  - "实现 Cat Café 方案"
  - "连接 Cat Café 项目"
  - "继续修复检视意见"
  - "恢复 Desktop 开发"
  - "Cat Café review"
---

# Cat Café Desktop Executor

这条技能把 ChatGPT Desktop 当作外部实现者连接到 Cat Café 的项目、managed work 和 ReviewRound。
Cat Café 保管项目、工作、Review 与验收真相；Desktop 只用原生本地文件与 Git 能力改代码，并通过严格 MCP
报告状态。聊天记录、PR、窗口 ID 和 Scheduled Task 引用都不是工作身份；实现依据是 Resume Packet 中项目共用
方案分支捕获的精确提交，以及为当前功能指定的设计文档，而不是方案讨论会话。

## 启动前提

只有同时满足以下条件才进入执行流程：

1. 当前 Desktop runtime 已由用户启用 `desktop:development-loop` profile 和项目范围 credential。
2. 用户给出当前本地仓库，或仓库可从当前 workspace 的 Git remote 精确读出。
3. `cat_cafe_development_project_read` 能通过 `repository=owner/name` 返回绑定项目和
   `managedWorkDiscovery`。

遇到 `managed_work_capability_unavailable`、`desktop_development_auth_unavailable` 或
`desktop_development_protocol_mismatch` 时立即停止所有 lifecycle 写入，原样说明安全升级动作。禁止猜 token、
改配置、借用 Cat 身份或改走宽权限 profile。

## 1. 解析项目与权威工作

调用 `cat_cafe_development_project_read`，优先使用从当前 Git workspace 验证出的 `owner/name`；已知精确
`projectId` 时也可以使用，但二者只能传一个。

从 `managedWorkDiscovery.works` 选择工作：

- 只选择 `lifecycle=active` 的权威候选。
- 只有一个活跃候选时直接使用它返回的 `workId`、`attemptId` 和 `managedWorkVersion`。
- 有多个活跃候选且用户请求不能唯一对应标题时，展示标题与 backlog item ID，请用户选择；禁止按列表顺序猜。
- 没有活跃候选时停止，说明项目尚无可执行的 Workflow SOP managed work；禁止自造 ID 或本地 fallback ledger。

若候选已经连接或 detached，先用 `cat_cafe_development_work_read` 读取最新 Resume Packet。若没有 binding，
首次连接使用候选的版本和 `expectedBindingEpoch=0`。

## 2. 绑定当前 Desktop 会话

用 `cat_cafe_development_work_connect` 绑定当前 runtime session 和可选 opaque chat reference：

- 首次连接使用 epoch 0；恢复连接使用 Resume Packet 的最新 epoch。
- 每次连接都提交当前 Git workspace 的 repository、branch、base SHA、current SHA、last committed SHA、
  permanent worktree path 和校验时间。
- 同一请求重试必须复用 idempotency key；新动作必须使用新 key。
- 新 chat 恢复同一 work 时会提升 binding epoch；旧 chat 随后只能读，不能 heartbeat/report。

连接后只执行 Resume Packet 的 `nextLegalActions`。不要从旧聊天、旧卡片或记忆推断当前阶段。

Resume Packet 必须同时给出非空 `designBranch`、`designExactSha` 与 `designDocuments`。`designBranch` 是项目级
唯一共用方案分支，不是当前功能的开发分支；只在其精确提交中读取 `designDocuments` 列出的文件，并确认当前任务
的 Feature ID、实现边界与验收条件。方案分支之后移动时重新读取 Resume Packet；不得把方案讨论会话里的未提交
想法当作新方案，也不得擅自把其他功能文档加入实现范围。

当 `phase=fix_required` / `nextLegalActions=[start_fix_attempt]` 时（包括 Review 要求修改或用户拒绝本轮合入验收），
先用当前 Resume Packet 的 attempt、managed-work version 和 binding epoch 再调用一次
`cat_cafe_development_work_connect`。服务端会幂等创建下一个 F275 attempt，并把同一个 Desktop chat 绑定到新
attempt；返回的 `attemptNumber` 必须递增且 phase 回到 `implementing`。未取得新 attempt 前不得报告修复 SHA。

当 `phase=awaiting_design_branch`、`phase=awaiting_review_continuation` 或
`phase=awaiting_architecture_decision` 时立即停止 Desktop 写入：

- `configure_design_branch` 只能由用户在 Cat Café 功能列表绑定项目共用的本地已提交方案分支，并为功能选择设计
  文档；Desktop 不自造方案分支名或文档清单。
- `request_review_continuation_approval` 只允许用户在 Cat Café 界面批准下一组最多 15 次 Review；Desktop 不代批、
  不重连、不中途创建 attempt。
- `request_user_architecture_decision` 表示 Review 与方案分支有重大分歧。用户可以保持当前方案，或和猫猫修改并提交
  方案分支；Desktop 不得自行选择，也不得先按 reviewer 的方案外建议改代码。
- 用户完成全部必要决策后，Cat Café 会向原绑定窗口投递新的单次通知；收到前不要轮询。

## 3. 实现、测试与提交

在项目的永久 worktree 中使用 ChatGPT Desktop 原生文件、终端和 Git 能力：

1. 确认 repository、实现 branch、base SHA、共用方案分支、方案 SHA 与设计文档都和 Resume Packet 一致。实现
   branch 可由多个功能共用，也可为当前功能单独创建，不能据此反推方案分支。
2. 严格按 `designExactSha` 中列出的 `designDocuments` 实现，并运行风险匹配测试；每次系统任务都重新核对依据。
3. 提交所有准备交付的改动，确认 worktree 的 current SHA 等于 last committed SHA。
4. 调用 `cat_cafe_development_implementation_report` 报告完整 commit SHA。

MCP 不负责 shell、文件写、Git commit、push、merge 或 deploy。不要寻找绕过严格 profile 的 MCP 工具。

workspace 的 committed SHA 或 worktree 状态变化时，用 `cat_cafe_development_work_heartbeat` 刷新绑定元数据。
绑定不会因时间或应用休眠而过期；Heartbeat 失败时先重新读取 Resume Packet，epoch 已被显式重绑替换就停止
写入，不能抢回旧会话所有权。

## 4. 异步 Review 与下一轮恢复

implementation report 会在当前 backlog 功能的独立 Review 会话中启动精确 SHA 的多猫 ReviewRound。Review 猫猫始终
使用 Cat Café 自己的 provider/app-server；不得复用或写入 ChatGPT Desktop 的 app-server。implementation report 成功后，
当前 Desktop turn 必须结束，不得调用 `cat_cafe_development_review_wait`、不得短轮询，也不得为了等待共识持续刷新。
Review 由 Cat Café 在后台独立完成；原 Desktop chat 的永久 binding 保持不变。

- `review_in_progress`：向用户说明本轮 committed SHA 已交给 Cat Café Review，然后结束当前 turn；不得在 Desktop 内等待。
- implementation report 成功后，Cat Café 会通过 Desktop IPC 向当前实现 turn 追加一条 Review 系统停止消息。收到后立即调用
  `update_goal` 将当前 Goal 标为 `complete`，然后结束；不得再次读取 Resume Packet，也不得让 Goal 自动续跑。
- Cat Café 共识完成后，先向原绑定 `chatRef` 写入带项目、功能、attempt、ReviewRound 和精确 SHA 的非 active goal，
  再通过 ChatGPT Desktop 本地 IPC 定位当前 owner，以 `thread-follower-start-turn` 请求 owner 窗口提交且仅提交一个通知 turn。
  真正的 `turn/start` 由 owner 窗口自己的 app-server 执行；Cat Café 不得用 daemon 抢写该 thread，不得启动第二个
  app-server，也不得创建替代窗口。原生 deep link 只负责聚焦窗口，不承担消息提交。
- goal 唤醒在 IPC owner 接受前失败时，由 Cat Café 的持久化 outbox 使用同一个幂等 message id 重试。IPC owner
  已接受但通知 turn 暂时尚不可读时，outbox 只重复验证可见性，不得再次发送同一消息；只有用户显式重投当前节点
  才能发起新的发送尝试。Desktop 不需要为此保持 turn 或轮询。
- 原绑定任务休眠且暂时没有 IPC owner 时，Cat Café 可以用 deep link 原位打开同一个任务并做有界 owner-discovery
  重试；已有 owner 成功接受消息时不得再用 deep link 抢占当前 Codex 焦点，也不得因此创建替代任务或新会话。
- 原 chat 收到继续指令或被用户重新打开后，先调用 `cat_cafe_development_work_read` 读取最新 Resume Packet；禁止沿用
  implementation report 返回时的旧状态。
- `start_fix_attempt`：先按第 2 节重连并取得递增的 attempt，再处理所有仍 open 且可安全执行的 consensus
  findings，补测试，提交新 SHA，再次 report。
- 只实现 `scope=plan_conformance` 且 `designRefs` 同时引用
  `git:refs/heads/<designBranch>@<designExactSha>` 与该功能已选设计文档 ref 的 finding；经用户裁决的架构 finding 必须严格服从
  Cat Café 记录的决定。禁止把 Review 中新增的个人偏好、方案外重构或需求扩张带入实现。
- 对启用该约束前已落库的历史 finding，只能作为迁移证据；继续实现前仍必须配置共用方案分支和功能设计文档。
- finding 有事实错误或需要产品取舍：保留证据并停下请用户裁决，不能假装修复。
- 每个新 SHA 都必须开启完整的新 ReviewRound；旧 SHA 的批准不能沿用。

Scheduled Task 或 chat reference 只可作为唤醒提示，不能替代 work/attempt/epoch。删除它们不会终止 work。

## 5. 合入验收与合入

严格按 Resume Packet 的 legal action 执行：

- Review 对当前 exact SHA 清零且 checks 通过后，先进入 `acceptance_pending`。同意/拒绝合入只在 Cat Café 项目界面
  由用户记录；Desktop 不在 chat 中代问、代签，也不把旧的 chat confirmation 当成新流程授权。
- 用户同意后，Cat Café 记录该 exact SHA 的验收通过证据并唤醒原绑定窗口。Desktop 必须重新读取 Resume Packet；
  只有 `nextLegalActions=[merge_with_native_git]` 时才用原生 Git 合入 main，然后调用
  `cat_cafe_development_merge_report` 报告 merge commit。merge receipt 成功后 work 才进入 `accepted`。
- 用户拒绝后，本轮不得合入；Cat Café 记录验收未通过并唤醒原窗口。Resume Packet 进入 `fix_required`，Desktop
  先取得递增的新 attempt，再修复、提交新 SHA 并开启完整的新 ReviewRound。
- `cat_cafe_development_merge_confirmation_record` 仅兼容升级前已经明确返回
  `request_merge_confirmation` 的在途 protocol-v1 packet；它不能替代 Cat Café 的合入验收，也不能单独授权新流程合入。
- 项目历史 pilot/auto-merge 字段继续兼容持久化，但任何新 delivery cycle 都必须先取得当前 exact SHA 的用户验收；
  自动策略不得绕过同意/拒绝门禁。

## 6. 删除与故障恢复

- **ChatGPT chat 被删**：新 chat 从当前 Git repository 重新 resolve 项目，选择同一 active work，读取 Resume
  Packet，再以更高 epoch rebind。
- **Cat Café 功能 Review 会话软删除**：按 projectId + backlogItemId 恢复同一个会话 identity；Desktop 不创建新窗口。
- **永久 worktree 丢失**：只从 Resume Packet 的 `lastCommittedSha` 重建；明确声明未提交内容无法保证恢复。
- **临时 MCP/网络失败**：保留同一 idempotency key 重试读/写；空 poll 不是终态。
- **Desktop 在 Review 期间关闭**：Review 继续由 Cat Café 完成；重开原 chat 后先调用
  `cat_cafe_development_work_read`，再从最新 Resume Packet 恢复，不创建替代窗口。
- **项目绑定消失或变得歧义**：停止写入，请用户在 Cat Café 修复绑定；不得用目录名猜项目。

## 禁止事项

- 不把 GitHub Issue、双语文本、Git ledger 或 PR comment 当作 EXT-001 核心完成条件。
- 不把 branch、PR、chat、thread 或任务唤醒引用当作 work identity。
- 不从另一个项目复制 work/attempt/epoch，也不提交客户端 actor/user ID。
- 不修改 runtime 配置、credential、审批策略或 auto-merge 开关。
- 不在未 commit 的 workspace 上报告 implementation complete。

## 完成证据

一次 Desktop 执行只在以下证据齐全时才能报告对应阶段完成：

- project read 返回唯一绑定项目与权威 work candidate；
- 当前 binding epoch 和 managed-work version 来自最新 Resume Packet；
- implementation report 的 SHA 等于本地完整 committed SHA；
- ReviewRound 对该 SHA 零 open finding；
- 用户合入验收先于 merge，且 merge report 精确对应本轮已验收的 SHA。
