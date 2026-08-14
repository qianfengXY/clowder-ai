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
报告状态。聊天记录、分支名、PR、窗口 ID 和 Scheduled Task 引用都不是工作身份。

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

当 `phase=fix_required` / `nextLegalActions=[start_fix_attempt]` 时，先用当前 Resume Packet 的 attempt、
managed-work version 和 binding epoch 再调用一次 `cat_cafe_development_work_connect`。服务端会幂等创建下一个
F275 attempt，并把同一个 Desktop chat 绑定到新 attempt；返回的 `attemptNumber` 必须递增且 phase 回到
`implementing`。未取得新 attempt 前不得报告修复 SHA。

## 3. 实现、测试与提交

在项目的永久 worktree 中使用 ChatGPT Desktop 原生文件、终端和 Git 能力：

1. 确认 repository、branch、base SHA 与 Resume Packet 一致。
2. 按项目规范实现并运行风险匹配测试。
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
- Cat Café 共识完成后，只向原绑定 `chatRef` 写入带项目、功能、attempt、ReviewRound 和精确 SHA 的 active goal，
  再打开该 thread 的原生 deep link。ChatGPT Desktop 负责把 goal 转成下一轮可见消息；Cat Café 不得调用
  `thread/resume` / `turn/start`，不得启动第二个 app-server 抢写该 thread，也不得创建替代窗口。
- goal 唤醒暂时失败时由 Cat Café 的持久化 outbox 重试；Desktop 不需要为此保持 turn 或轮询。
- 原 chat 收到继续指令或被用户重新打开后，先调用 `cat_cafe_development_work_read` 读取最新 Resume Packet；禁止沿用
  implementation report 返回时的旧状态。
- `start_fix_attempt`：先按第 2 节重连并取得递增的 attempt，再处理所有仍 open 且可安全执行的 consensus
  findings，补测试，提交新 SHA，再次 report。
- finding 有事实错误或需要产品取舍：保留证据并停下请用户裁决，不能假装修复。
- 每个新 SHA 都必须开启完整的新 ReviewRound；旧 SHA 的批准不能沿用。

Scheduled Task 或 chat reference 只可作为唤醒提示，不能替代 work/attempt/epoch。删除它们不会终止 work。

## 5. 合入与最终验收

严格按 Resume Packet 的 legal action 执行：

- 项目前两次成功试点：在当前 ChatGPT chat 明确询问用户是否合入；得到确认后调用
  `cat_cafe_development_merge_confirmation_record`，再用 Desktop 原生 Git 合入，最后调用
  `cat_cafe_development_merge_report` 报告 merge commit。
- 项目已满足两次试点且用户显式开启自动合入：仍需 exact SHA、零 open finding、checks 和 branch policy
  全部通过；不要仅凭计数自行开启自动合入。
- 合入后进入 `acceptance_pending`。最终体验验收只在 Cat Café 项目界面由用户记录；Desktop 不代签验收。

验收不通过时继续同一个项目、功能 Review 会话和 canonical work lineage，按 Resume Packet 进入新 attempt/cycle。

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

- 不把 GitHub Issue、双语文本、Git ledger 或 PR comment 当作 F289 核心完成条件。
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
- merge confirmation、merge report 与最终用户验收按项目策略分别完成。
