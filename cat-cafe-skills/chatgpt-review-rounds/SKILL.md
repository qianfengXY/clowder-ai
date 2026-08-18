---
name: chatgpt-review-rounds
tips_exempt: harness-internal operator-approved review protocol; no standalone end-user capability surface
description: >
  Execute one callback-backed independent, cross-review, or consensus stage for ChatGPT-authored Cat Café work.
  Use when: a compact Review system message supplies a Review Round, exact code SHA, and exact design-branch SHA.
  Not for: ordinary cat-authored review, implementation, Git writes, merge, push, deploy, or inventing a plan beyond the design branch.
  Output: durable Review callbacks plus the shared two-table user-visible report; pause for user resolution on design disagreement.
triggers:
  - "Review 系统消息"
  - "独立检视"
  - "交叉检视"
  - "共识整理"
  - "Review Round"
---

# ChatGPT Multi-Cat Review Rounds

本技能执行 Cat Café 已编排好的单个 Review 阶段。系统消息只负责路由和本轮事实；本文件负责稳定流程与约束。

## 权威输入

每次开始先固定并复述以下身份：

- `Review Round`
- 实现提交 `exactSha`
- `方案分支`
- `方案提交 designExactSha`
- 当前阶段、reviewer/recorder 身份与 callback 版本

代码只能按 `exactSha` 检视。方案只能按 `designExactSha` 检视；方案分支之后移动不会改变正在进行的本轮依据。
方案讨论会话可以提供背景，但不是权威方案，不能用聊天中的未提交想法覆盖方案提交。

每条 finding 的 `designRefs` 必须包含：

```text
git:refs/heads/<方案分支>@<完整 designExactSha>
```

需要更精确时，再附方案文件与章节。缺少该精确 Git ref 的 finding 不得提交。

## 方案边界

Review 只判断实现是否正确落地方案提交及其验收条件：

- 不把个人偏好、方案外重构或新增需求包装成 finding。
- 安全、性能和架构意见也必须能回指方案承诺、边界或不变量。
- 正常偏差使用 `scope=plan_conformance`。
- 只有会迫使权威方案发生重大架构改变的真实 P1 冲突，才使用 `scope=architecture_decision`。
- 对方案分歧只写“冲突事实、影响、证据和待用户决策点”，不得越权给出并推进新方案。

共识发布后，`architecture_decision` finding 会让开发链路暂停。用户可以保持当前方案，或与猫猫修改方案并把结果提交到同一方案分支；只有 Cat Café 验证方案 SHA 后才恢复 Desktop 实现。

## 阶段执行

### 独立检视

1. 调用 `cat_cafe_review_round_read` 与 `cat_cafe_review_private_draft_read` 获取本人可见状态。
2. 只读检查实现 SHA、方案 SHA、diff、源文件和风险匹配测试；Barrier 前不得读取或推测其他 reviewer 意见。
3. 调用 `cat_cafe_review_draft_submit` 提交完整私有 draft。`approve` 时 findings 必须为空；`findings` 时逐条给出证据、精确方案 ref 与 scope。
4. 调用 `cat_cafe_review_independent_finish` 完成本阶段。不得修改代码或 Git。

### 交叉检视

1. 调用 `cat_cafe_review_barrier_drafts_read`；Barrier 未开启就停止，不绕过。
2. 对全部独立 finding 逐条核验事实、证据、重复关系与方案依据；不能用多数票代替证据。
3. 调用 `cat_cafe_review_cross_finish`。本阶段仍不得修改代码或发布共识。

### 共识整理

1. 确认自己是服务端指定 recorder，读取 barrier-safe 状态与 drafts。
2. 合并仍成立的 findings，保留被驳回、重复、已解决项的可见说明。
3. 能形成共识时调用 `cat_cafe_review_consensus_publish`；approved 必须 checks 通过且 open findings 为零。
4. reviewer 无法形成共识时，不新增 reviewer、不反复自唤醒、不伪造结论：保持 `consensus_ready`，用统一表格列出分歧并等待用户介入。
5. 收到系统消息中的用户裁决后，以裁决为最终依据，直接发布本轮共识，不再等待 reviewer 自行收敛。

## 可见输出

每个阶段完成 callback 后，最终回复严格使用
[`refs/chatgpt-review-round-template.md`](../refs/chatgpt-review-round-template.md)。GPT 与 Kimi 使用同一模板。
表格之外不重复输出 findings 的纯文字清单。

## 停止条件

- 每个系统消息只执行一次对应阶段；完成 callback 后结束，不轮询、不持续刷新。
- Review 全程只读：禁止修改实现、提交、合并、推送、部署或写 Git ledger。
- 每个新实现 SHA 都开启完整的新 Round；旧 SHA 的通过不能沿用。
- 每轮捕获自己的方案 SHA；方案提交变化后，后续实现与新 Round 必须读取新的 Resume Packet。

## 常见错误

| 错误 | 正确处理 |
|---|---|
| 把方案讨论会话当最终方案 | 只认系统消息中的方案分支与精确 SHA |
| 把模板和约束复制进系统消息 | 加载本技能与引用模板 |
| Review 中顺手重设计 | 提交 `architecture_decision` P1 并暂停给用户 |
| 共识卡住就增加 reviewer | 保持 `consensus_ready`，等待用户裁决 |
| 只说“通过” | 即使无 finding 也输出模板规定的通过行 |
| callback 后继续等待下一阶段 | 结束当前 turn，由 Cat Café 投递下一条系统消息 |
