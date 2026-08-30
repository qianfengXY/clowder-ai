---
capsule_id: 2026-08-25-f306-mission-hub-project-workspaces
feature_ids: [EXT-002]
context: "Mission Hub 项目工作区归一从首次实现、独立验收阻断、修复到终态关闭"
---

# EXT-002 Mission Hub Project Workspaces — Reflection Capsule (legacy F306 delivery)

> **Identity note (2026-08-29):** 本胶囊记录的是 2026-08-25 以本地 `F306` 完成的历史交付；上游同号功能进入 main 后，canonical identity 迁为 `EXT-002`。历史验收目录继续保留旧名。

## Context

operator 要求 Mission Hub 直接把 Cat Café、Traqen 和未来项目作为对等一级入口；项目内复用同一套 Feature、依赖、任务、Thread、Review 与 SOP，EXT 定制退出默认表面。PR #9 建立项目工作区，首次独立验收发现跨项目写污染和长导入不刷新；PR #11 修复后由不同的 reviewer 与愿景守护猫完成独立验证。

## What Worked

- 先保存 `main` 完整 bundle，再做项目坐标重构，保住历史与可恢复性。
- Kimi 的 exact-HEAD review 捕获并验证项目归因不变量；Fable 的首次 post-merge 浏览器验收进一步发现读路径以外的写污染。
- P1/P2 均先用失败测试固定根因，再做窄而终态的修复：home import 建立 home-only 工作集；长 mutation 使用显式 120 秒预算并在成功后刷新当前项目。
- Terra 在最终 merge SHA 上以独立 Redis/API/Web 和真实 Chromium 复验 68.064 秒导入与同名 F305 全对象不变，证明产品旅程闭合。
- 失败与通过证据成对保留，避免“最终绿”抹去问题发现过程。

## What Failed

- 初始实现只严查外部项目路由与读归因，没有对 home import 的 refresh/mark-done 做对偶项目隔离，导致 PR #9 合入后才被愿景守护发现 P1。
- 设计和作者验证没有覆盖真实导入超过 API client 30 秒的生命周期；服务端成功与客户端失败被错误拆开。
- `pre-merge-check` 与 hotfix detector 默认使用非权威 `origin/main`，分别制造无关 rebase 冲突和 658 文件的 false-hotfix 投影。
- local review typed settlement 因 custody 缺失被拒绝，只能由 author 机械转录 exact-HEAD verdict 到 PR comment；事实被保留，但机器态没有闭合。
- 首次验收媒体虽落在正式 `project-evidence/`，却未显式 `git add`，长期停留为根 checkout 未跟踪工件。

## Trigger Missed

- 项目隔离 contract 需要“读取、创建、refresh、mark-done”四向矩阵；当时只从 external endpoint 和 UI 切换出发，没有把 home mutation 当成同一不变量的反向入口。
- 所有文档导入/扫描类 mutation 都应在设计时比较真实 P95 时长与 client deadline；只测快速 mock 会漏掉“服务端完成、客户端超时”的 split-brain。
- 多 remote 仓库的门禁应先解析部署权威 remote，再生成 base；看到 `origin/main` 不应默认等于产品 main。

## Doc Links

- `docs/extensions/EXT-002-mission-hub-project-workspaces.md`
- `docs/design/EXT-002-mission-hub-project-workspaces.md`
- `docs/architecture/ownership/cells/mission-hub-projects.md`
- `project-evidence/F306-acceptance-2026-08-25/`
- `project-evidence/F306-acceptance-2026-08-25-final/`
- `docs/harness-feedback/reviews/F306-feature-close-trace.md`

## Rule Update Target

- Merge gate/hotfix detector：接受显式 canonical remote/base，并在输出中展示最终 base SHA，避免 fork 仓库误扫上游历史。
- Local review settlement：当 direct carrier 中存在 exact action lease 时，typed verdict 应由 lease 解析，而不是被后续 invocation 的 custody 投影拒绝；失败需返回可修复的 owner/lease 坐标。
- Quality gate：项目级 import 必须运行 home↔external mutation symmetry test；长 mutation 必须包含越过默认 deadline 的真实或虚拟时钟用例。
- Completion index：当前仓库没有 `docs/features/README.md`，且 Feature Truth 明确从文档 fresh-generate 临时 index；创建只含该功能的“已完成索引”会造成新的不完整真相源，因此本次以 EXT-002 catalog/spec `done`、ROADMAP 数字 F 队列移除和对应检查通过作为仓库在地等价闭环。
