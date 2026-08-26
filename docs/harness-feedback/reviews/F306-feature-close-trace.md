---
title: "F306 feature-close trace feedback"
doc_kind: harness_feedback
feature_ids: [F306]
created: 2026-08-25
evidence_refs:
  - "thread_mt80fxovuy2dyh5b#0001787709974991-000205-88901fd0"
  - "thread_mt80fxovuy2dyh5b#0001787715274584-000216-5f79108e"
  - "qianfengXY/clowder-ai#11"
---

# F306 Feature-Close Trace Feedback

## Context

F306 是普通用户可见产品 Feature，本身不修改 harness。Completion checkpoint 因两项可复现 trace anomaly 触发展开：错误 remote 使门禁审计了非权威历史；typed local review settlement 未能持久化明确 verdict。

## Observed Friction

### 1. Canonical remote 未进入 gate coordinate

- 仓库权威 main 是 `fork/main`（`qianfengXY/clowder-ai`），`origin` 指向开源上游且禁止 push。
- `scripts/pre-merge-check.sh` 强制 fetch/rebase `origin/main`，把 F306 分支重放到无关上游历史并在 agent-hook 文件冲突。
- `scripts/check-hotfix-pattern.mjs` 默认 `HOTFIX_BASE=origin/main`，把 658 个上游差异与历史 `fix:` commit 投影成 F306 hotfix；显式 `HOTFIX_BASE=fork/main` 后正确得到 6 文件、93 additions、`hotfix=false`。

## 2. Local review verdict fact 未闭合

- Kimi 在 exact HEAD `c23ef42511008de93318810bbaf0edf1f26adf1a` 完成独立 review，明确 `approved` 且无 P1/P2。
- typed settlement 因 invocation 不带 review custody 被拒绝，尽管 direct carrier 与 target SHA 均可追溯。
- author 按 merge-gate 机械转录到 PR #11 comment `5420301549`，没有伪造 typed fact；但自动化状态仍不能表达该 verdict。

## Impact

- 产品代码没有因此失真：错误 rebase 已安全 abort，权威 fork base、targeted tests、exact-head CI 与 reviewer verdict 均被独立核验。
- 流程成本显著增加，并存在更危险的失败模式：不审视 remote 坐标时，猫可能手工解决无关冲突并把上游历史混入产品分支；typed verdict 丢失时，merge owner可能重复召唤 reviewer 或错误阻断。

## Recommended Harness Changes

1. 所有 latest-main、hotfix、feature-truth diff discovery 统一接受一个显式 canonical base resolver；输出 remote、repo、base SHA，并在 repo target 与 remote owner 不一致时 fail closed。
2. local review lease 在 route 时持久化 direct carrier、reviewer catId 与 terminal SHA；terminal callback 可据 lease 解析 verdict，不依赖易漂移的 invocation custody。
3. settlement 失败返回 `leaseId/generation/predecessorThreadId` 的安全摘要和唯一补救入口，避免 prose verdict 与 typed state长期分叉。
4. 一小时 managed full gate 在大型仓库应支持阶段 checkpoint/resume，或允许 CI terminal 作为明确声明的等价后半段证据。

## Disposition

本报告只沉淀 harness 证据与改进目标，不改变 F306 AC。F306 的产品门禁由 PR #11 exact-head CI、Kimi review 与 Terra post-merge browser acceptance 独立闭合。
