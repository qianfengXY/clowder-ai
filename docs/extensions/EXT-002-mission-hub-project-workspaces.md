---
related_features: [F049, F058, F076, F152, EXT-001]
topics: [mission-hub, projects, backlog, workflow, external-projects, ui]
doc_kind: spec
created: 2026-08-25
status: done
completed: 2026-08-25
reflection: project-reflections/2026-08-25-f306-mission-hub-project-workspaces-capsule.md
harness_feedback: docs/harness-feedback/reviews/F306-feature-close-trace.md
description: "把 Mission Hub 的一级坐标从功能/依赖/外部项目混排，归一为 Cat Café 与外部项目对等的项目工作区；每个项目复用同一套 Feature、任务、Thread、Review 与 SOP 体验。"
description_source: human
description_author: co-creator
description_updated_at: 2026-08-25T08:30:00Z
cvo_signoff: "2026-08-25 — sourceMessageId 0001787646630262-000070-97b500b9：备份当前 main 后开始改造；Mission Hub 直接看到 Cat Café 与 Traqen，功能一致，EXT 定制不在新一轮体现。"
---

# EXT-002: Mission Hub Project Workspaces — 项目工作区归一

> **Identity migration (2026-08-29):** 本功能于 2026-08-25 以本地 `F306` 完成交付；上游随后将 `F306` 分配给 Codex App Capability Parity。为保留两项功能且避免未来同步继续冲突，本地功能迁为 `EXT-002`。历史提交、PR、验收目录和消息中的 `F306` 坐标保持原样；extension catalog 的 `legacyIds` 只迁移标题精确匹配本功能的旧 Backlog/SOP 记录，不会别名化上游 F306。

> **Status**: done | **Completed**: 2026-08-25 | **Owner**: 砚砚/CodeX (@cat-idwxwjba, GPT-5.6) | **Priority**: P0

Architecture cell: `mission-hub-projects`

Map delta: implemented in `docs/architecture/ownership/cells/mission-hub-projects.md`

Why: F049/F058 拥有 Feature 工作流，F076 首次登记外部项目但把它实现成与“功能列表/依赖全景”并列的特殊 Tab，EXT-001 又把 Desktop 定制入口叠在外部项目表面。EXT-002 建立项目 registry 到统一工作区的投影边界；不接管 Feature 生命周期、Thread、Review、SOP 或 EXT-001 的业务真相。

## Why

Mission Hub 当前不是以项目为第一坐标：Cat Café 的 Feature 和依赖是两个固定 Tab，Traqen 则是另一个“外部项目 Tab”，进入后看到一套不同的功能与 Desktop 定制。这让“项目”成了 Cat Café 之外的例外，也让同名 Feature（例如两个仓库都存在 `F007`）可能错误读取另一项目的文档或 Thread。

operator 要的是一个稳定、可扩展的项目入口：Mission Hub 第一眼看到 Cat Café、Traqen，以及未来导入的项目；选中任何项目后都使用同一套 Feature / 任务 / Thread / Review / SOP 工作流。项目差异只决定真相源与作用域，不决定 UI 能力等级。

## Product Contract

### 核心模型

```text
Mission Hub
└── Project Workspace（当前作用域）
    ├── Cat Café（内建项目）
    ├── Traqen（登记项目）
    └── 未来项目…
        ├── 功能列表
        ├── 依赖全景
        ├── 任务/Thread/Review/SOP 操作
        └── 该项目自己的 Backlog 导入
```

- Cat Café 是内建项目，不再以“无 projectId 的首页”伪装成全局空间。
- 外部项目仍由现有 `ExternalProject` 持久化 registry 管理；导入不复制、不移动、不清空项目仓库。
- Backlog item 的 `projectId` 是外部项目作用域；Cat Café 继续使用无 `projectId` 的兼容存储，但 UI 将其显式投影为内建项目。
- Feature 行为按 backlog item ID 绑定。仅凭 `Fxxx` 标识进行文档/Thread 查询时必须带项目作用域，或在外部项目中 fail closed，不能跨项目猜测。
- 项目切换时，旧请求不得覆盖新项目视图；计数、选中项、详情、依赖和右栏都必须来自当前项目。

### EXT 边界

EXT-001 是这套实例曾经增加的 ChatGPT Desktop 定制适配器，不是项目模型：

- EXT-002 默认项目工作区、项目导入表单和项目导航不展示 Desktop 开发闭环、EXT Feature 或 EXT 专属状态。
- 现有 EXT 源码、历史 backlog、Workflow SOP、Review 与 Desktop binding 均保留；本轮不删除、不迁移、不伪造完成。
- EXT-001 可在未来以显式 opt-in 插件/适配器重新挂载，但不得重新定义项目、Feature 或工作流真相。

## User Journey

### Primary — 在 Mission Hub 选择项目并推进 Feature

1. 用户打开 Mission Hub，第一层看到 `Cat Café`、`Traqen` 与其他已登记项目。
2. 选择 `Traqen` 后，标题、状态计数、功能列表、依赖视图和右侧工作流都切到 Traqen。
3. 用户展开 Feature、选择任务、建议/批准/派发、查看 SOP 与 Thread，所有动作都绑定当前项目的 backlog item。
4. 用户切回 `Cat Café`，看到完全相同的结构和 Cat Café 自己的数据；Traqen 的选中项和异步响应不得串入。

### Supporting — 导入新项目

1. 用户点击“导入项目”，只填写项目名称、路径、Backlog 路径和描述。
2. 导入成功后，新项目出现在项目选择器；不要求也不展示 Desktop/EXT 配置。
3. 在该项目内点击“导入 Backlog”，系统只读取该项目登记的真相源并创建项目绑定的 backlog item。

### Supporting — 项目内快速创建任务

1. 用户在任一项目工作区填写快速创建表单。
2. 服务端根据当前项目使用 ownership-checked 路径创建任务。
3. 客户端提交的任意 projectId 都不能绕过项目所有权校验。

## Scope

### Phase A: 项目坐标与安全作用域

- 新增 Cat Café 内建项目 + 外部项目的统一工作区选择模型。
- 把 Feature 列表、依赖全景、状态计数、选中项和右栏绑定到当前项目。
- 为外部项目提供 ownership-checked 快速创建入口。
- 外部项目不再使用只按 Feature ID 查询 Cat Café 文档/Thread 的路径。
- 项目切换具备 stale-response fence。

### Phase B: 体验归一与 EXT 退场

- 项目是一级导航，功能列表/依赖全景是每个项目一致的二级视图。
- 项目导入表单移除 Desktop/EXT 配置。
- 默认项目工作区过滤历史 EXT catalog item，底层记录保持不变。
- 延续现有暖色、列表/详情、键盘焦点和窄屏设计语言。

### Phase C: 验证与文档闭环

- API、组件与切换竞态的 TDD 覆盖。
- 隔离 Redis 6398 和独立端口运行真实 Mission Hub。
- browser-preview 验证 Cat Café ↔ Traqen 主旅程、空态、错误态与窄屏。
- 非作者 review 后才进入 merge gate。

## Acceptance Criteria

### Phase A（项目坐标与安全作用域）

- [x] AC-A1: Mission Hub 一级项目选择器同时显示 Cat Café、Traqen 与其他已登记项目，且默认/恢复逻辑不再偏爱 Traqen。
- [x] AC-A2: 当前项目唯一决定 Feature 列表、状态计数、依赖视图、选中项、SOP、Thread 与所有 mutation 的 backlog 作用域。
- [x] AC-A3: 外部项目快速创建只能通过服务端 ownership check，跨用户/不存在项目均 fail closed，创建结果持久化正确 `projectId`。
- [x] AC-A4: 外部项目不使用 Cat Café-only Feature doc 或无项目限定的 Feature-ID Thread 匹配；同名 Feature 不发生跨项目归因。
- [x] AC-A5: 快速切换项目时，较晚返回的旧请求不能覆盖当前项目数据、loading、error 或 selection。

### Phase B（体验归一与 EXT 退场）

- [x] AC-B1: Cat Café 和外部项目共享同一套“功能列表 / 依赖全景”二级导航及 Feature 工作流组件，不再渲染 `ExternalProjectTab` 的独立体验。
- [x] AC-B2: “导入 Backlog”根据当前项目调用 Cat Café 或对应外部项目入口，完成后仍停留在该项目并刷新正确列表。
- [x] AC-B3: 项目导入表单不出现 ChatGPT Desktop、Review roster、push/PR 等 EXT-001 配置，也不提交 `desktopDevelopment`。
- [x] AC-B4: 默认项目工作区不展示 `feature-kind:extension` / `EXT-*` 项；既有 EXT 数据与源码不删除。
- [x] AC-B5: 项目选择、二级视图和主操作具备可见 focus、语义状态与窄屏可达性。

### Phase C（验证与闭环）

- [x] AC-C1: 自动化测试覆盖项目选择、持久化恢复、项目作用域、错误/空态、导入端点、EXT 隐藏与请求竞态。
- [x] AC-C2: 隔离开发实例完成 Cat Café → Traqen → Cat Café 的真实旅程验证，并保存 browser-preview 证据。
- [x] AC-C3: 非作者 review 对项目隔离、持久化安全、EXT 兼容与 UI 契约给出无阻塞 verdict。

## Tips Contribution（F244）

- [x] Added/updated 1-2 tips in `packages/web/src/lib/capability-tips.seed.json`
- [x] Existing tip sourceRef still covers this user-visible change

## Dependencies

- **Evolved from**: F049/F058（Mission Hub Feature 与依赖工作流）
- **Evolved from**: F076（外部项目 registry 与项目 backlog 导入）
- **Related**: F152（外部项目记忆与经验回流）
- **Related**: EXT-001（保留的可选 Desktop adapter，明确不属于默认项目工作区）

## Risk

| 风险 | 缓解 |
|------|------|
| 同名 Feature 跨项目读取错误文档或 Thread | 外部项目只消费 backlog item 绑定；未具备 project-aware resolver 的路径 fail closed |
| 切换项目时旧异步响应污染新视图 | request sequence/AbortController 同时保护 data、loading 与 error |
| 为了“隐藏 EXT”破坏历史和在飞闭环 | 只改变默认投影与导入表单，不删除记录、字段、路由或源码 |
| 把 Cat Café 特例硬编码扩散到更多组件 | 统一 `ProjectWorkspaceRef`，仅数据端点按项目种类分流 |
| 外部项目路径带来任意文件读取 | 所有读取继续从 ownership-checked server-side registry 派生；客户端不提交读取路径 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 新立 EXT-002，而不是重开 F007 或扩 EXT-001 | F007 属于 Traqen，EXT-001 是定制 adapter；本次改变 Mission Hub 核心项目坐标 | 2026-08-25 |
| KD-2 | Cat Café 作为内建项目显式呈现 | 让所有项目对等，同时保持现有无 `projectId` 数据兼容 | 2026-08-25 |
| KD-3 | 默认工作区不渲染 EXT，底层历史保留 | 满足新一轮产品边界，同时遵守持久化与可恢复性 | 2026-08-25 |
| KD-4 | 外部项目禁用无作用域 Feature-ID 猜测 | 安全和正确归因优先于不可靠的“功能看起来一样” | 2026-08-25 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-08-25 | operator 明确项目一级导航、Cat Café/Traqen 对等与 EXT 退场；完成 main 完整备份后立项开工 |
| 2026-08-25 | 初始实现 PR #9 合入 `6e3c7e965`；首次独立验收发现跨项目写污染与长导入不刷新，结论 BLOCKED |
| 2026-08-25 | 验收修复 PR #11 合入 `2ab1335c7`；Kimi exact-HEAD review 与 GitHub 五项 CI 全绿 |
| 2026-08-25 | Terra 在隔离浏览器完成 68.064 秒长导入、同名 F305 跨项目隔离、往返切换与窄屏验收，APPROVED；Feature closed |

## Review Gate

- [x] Phase A/B: Kimi 对最终修复 HEAD `c23ef4251` 完成非作者 review，0 个开放 P1/P2。
- [x] Phase C: Terra 对 merge SHA `2ab1335c7` 完成非作者、非 reviewer 的隔离浏览器愿景验收并 APPROVED。

## Completion Gate

### User Visibility Disclosure

| Surface | 用户达成态 | Feature close 时实际状态 | 缺失/退化 | 处置 |
|---------|------------|--------------------------|-----------|------|
| 一级项目导航 | 同屏选择 Cat Café、Traqen 与未来项目 | 隔离浏览器实测 Cat Café 默认、Traqen 可导入并往返切换 | 无 | met |
| 项目内工作流 | 两项目共用 Features、Dependencies、右侧 Suggestion/SOP/Threads | 同一套组件与交互已实测 | 无 | met |
| 导入与刷新 | 当前项目独立导入，长任务成功后自动刷新 | 真实浏览器请求 68,064 ms，跨过 30 秒后 200 并自动刷新 | 无 | met |
| 项目数据隔离 | home mutation 不得读取或改写 external item | Traqen 同名 F305 在 Cat Café 导入前后全对象一致 | 无 | met |
| EXT 默认表面 | 不展示 Desktop/EXT 配置，历史数据保留 | 项目导入表单仅 4 字段，默认工作区无 EXT；底层记录与源码未删除 | 无 | met |
| 窄屏与语义 | 375px 可达、焦点与 `aria-current` 正确 | Terra 在 375×812 与键盘路径实测通过 | 无 | met |
| Live runtime | 合入代码可由正式启动流程加载 | `main=landed:2ab1335c7`；`live=dormant`，未经 operator 授权未重启 | 当前在线实例未激活新代码 | release activation 不属于代码 close；保持真实 dormant 状态 |

### Independent Vision Sign-off

| 守护猫 | 独立性 | 愿景三问与 User Journey | 结论 |
|--------|--------|--------------------------|------|
| 搬砖工 / GPT-5.6 Terra | 非作者、非 reviewer | 读取本 spec、Design、ownership cell；在隔离 Web `5172` / API `3172` / Redis `6328` 重走项目导航、EXT 隐藏、跨项目隔离、68 秒导入和窄屏旅程 | **APPROVED**，无开放 P1/P2（message `0001787718046678-000224-9447de8f`） |

证据历史保留为两份互不覆盖的归档：

- 首次阻断：`project-evidence/F306-acceptance-2026-08-25/`
- 最终通过：`project-evidence/F306-acceptance-2026-08-25-final/`

### CloseGateReport

```yaml
close_gate_report:
  feature_id: EXT-002
  spec_path: docs/extensions/EXT-002-mission-hub-project-workspaces.md
  head_sha: "2ab1335c70f9bd29d1b3ee59b2c86cd280362418"
  report_date: 2026-08-25
  guardian: "搬砖工/GPT-5.6 Terra (cat-4v94tazw; non-author, non-reviewer)"
  reflection: project-reflections/2026-08-25-f306-mission-hub-project-workspaces-capsule.md
  harness_feedback: docs/harness-feedback/reviews/F306-feature-close-trace.md
  ac_matrix:
    - ac_id: AC-A1
      status: met
      evidence: [{kind: screenshot, ref: "project-evidence/F306-acceptance-2026-08-25-final/S1-project-first-nav-catcafe-traqen.png"}]
      resolution: null
    - ac_id: AC-A2
      status: met
      evidence: [{kind: pr, ref: "qianfengXY/clowder-ai#11", description: "home import is limited to items without projectId"}]
      resolution: null
    - ac_id: AC-A3
      status: met
      evidence: [{kind: test, ref: "packages/api/test/external-project-routes.test.js", description: "ownership and project-bound creation, 32/32"}]
      resolution: null
    - ac_id: AC-A4
      status: met
      evidence: [{kind: test, ref: "packages/web/src/components/__tests__/mission-control-page.test.ts", description: "project-bound thread and Feature attribution"}]
      resolution: null
    - ac_id: AC-A5
      status: met
      evidence: [{kind: test, ref: "packages/web/src/components/__tests__/mission-control-page.test.ts", description: "stale request fences for data, loading, error and selection"}]
      resolution: null
    - ac_id: AC-B1
      status: met
      evidence: [{kind: screenshot, ref: "project-evidence/F306-acceptance-2026-08-25-final/S1-project-first-nav-catcafe-traqen.png"}]
      resolution: null
    - ac_id: AC-B2
      status: met
      evidence: [{kind: doc, ref: "project-evidence/F306-acceptance-2026-08-25-final/acceptance-browser-report.json", description: "68,064 ms real browser import returned 200 and auto-refreshed"}]
      resolution: null
    - ac_id: AC-B3
      status: met
      evidence: [{kind: screenshot, ref: "project-evidence/F306-acceptance-2026-08-25-final/S2-import-form-no-ext-fields.png"}]
      resolution: null
    - ac_id: AC-B4
      status: met
      evidence: [{kind: screenshot, ref: "project-evidence/F306-acceptance-2026-08-25-final/S2-import-form-no-ext-fields.png", description: "default surface omits EXT/Desktop configuration while source and records remain"}]
      resolution: null
    - ac_id: AC-B5
      status: met
      evidence: [{kind: doc, ref: "project-evidence/F306-acceptance-2026-08-25-final/ACCEPTANCE-REPORT.md", description: "375x812, keyboard focus and aria-current passed"}]
      resolution: null
    - ac_id: AC-C1
      status: met
      evidence: [{kind: test, ref: "PR #11 exact-head CI", description: "five GitHub checks green; API 34/34 and Web 46/46 focused regressions"}]
      resolution: null
    - ac_id: AC-C2
      status: met
      evidence: [{kind: doc, ref: "project-evidence/F306-acceptance-2026-08-25-final/ACCEPTANCE-REPORT.md", description: "isolated Cat Café to Traqen to Cat Café browser journey"}]
      resolution: null
    - ac_id: AC-C3
      status: met
      evidence: [{kind: message, ref: "0001787715274584-000216-5f79108e", description: "Kimi exact-HEAD approved"}, {kind: message, ref: "0001787718046678-000224-9447de8f", description: "Terra post-merge APPROVED"}]
      resolution: null
```

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Design Gate** | `docs/design/EXT-002-mission-hub-project-workspaces.md` | 在地双层导航与关键状态 |
| **Plan** | `feature-specs/2026-08-25-mission-hub-project-workspaces.md` | TDD 实施计划 |
| **Pre-change backup** | `/Volumes/WorkSSD/clowder-ai-history/2026-08-25-pre-mission-hub-project-workspaces/` | `bb9e8c4e` 的完整 bundle + 校验说明 |
| **Reflection** | `project-reflections/2026-08-25-f306-mission-hub-project-workspaces-capsule.md` | 实施、验收与流程反思 |
| **Harness feedback** | `docs/harness-feedback/reviews/F306-feature-close-trace.md` | 历史 F306 坐标与 review settlement trace anomaly |
| **Acceptance — blocked** | `project-evidence/F306-acceptance-2026-08-25/` | 初次守护发现 P1/P2 的历史证据 |
| **Acceptance — approved** | `project-evidence/F306-acceptance-2026-08-25-final/` | 修复后 exact-merge 隔离浏览器证据 |
