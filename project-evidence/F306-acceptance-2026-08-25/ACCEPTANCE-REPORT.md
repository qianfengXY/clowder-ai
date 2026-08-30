# F306 Feature-Close 独立愿景守护验收报告

> **Historical identity:** 本验收针对 2026-08-25 当时的本地 F306；该功能于 2026-08-29 迁为 `EXT-002`。目录名、merge SHA 与证据内容保持历史原样。

- **Verdict**: **BLOCKED（1 × P1）**
- **守护猫**: 布偶猫/Claude (@fable-5, claude-fable-5) — 非作者（砚砚）、非 code reviewer（Kimi），独立性成立
- **验收对象**: fork/main@`6e3c7e965271d93341f8629f0dde30beea621f46`（PR qianfengXY/clowder-ai#9 squash merge）
- **验收环境**: 隔离 alpha acceptance worktree `/Volumes/WorkSSD/cat-cafe-alpha`（HEAD 精确 = 6e3c7e96；前端 3011 / API 3012 / Redis 6398 隔离实例；`CAT_CAFE_DEPLOYMENT_ID=alpha`；live runtime 保持 dormant 未触碰；生产数据零接触）
- **日期**: 2026-08-25

---

## 1. operator experience ↔ 实际证据对照表（F114 Gate）

| operator experience（逐字引用） | 当前实际状态（隔离实例实测） | 匹配？ |
|---|---|---|
| "我需要Mission hub上直接看到项目。可以是catcafe自己，也可以是我引入的Traqen。" | 一级"项目"导航同屏显示 Cat Café（内建）+ Traqen（导入后即时出现）；首进默认 Cat Café，不自动跳 Traqen；`aria-current="page"` 唯一。证据：S1、frame-01/03 | ✅ |
| "其它功能都是一致的。" | 两项目共用同一套二级视图（功能列表/依赖全景）、状态计数、快速创建、右栏（建议详情/SOP/线程态势）与「建议领取→批准」工作流；Traqen F007 走完整 Feature 工作流。证据：S3、frame-04/05 | ✅（读路径）/ ❌（写路径，见 P1：Cat Café 导入 mutation 会改写 Traqen 数据——"一致"不应包含"互相污染"） |
| "EXT这个扩展功能相关的东西不用体现了…不用在新的一轮里面进行体现。" | 导入表单仅 4 字段（名称/路径/Backlog 路径/描述），零 Desktop/Review/push/PR 字段；Cat Café 全页快照（941 行）EXT 出现 0 次，而底层 Redis 存有 `[EXT-001] ChatGPT Desktop Development Loop`（数据保留、默认投影过滤，KD-3 双向验证）。证据：S2、frame-05 | ✅ |

## 2. User Journey 逐步验收表

| Journey | 步骤 | Spec 描述 | 实际行为 | 证据 | 匹配？ |
|---|---|---|---|---|---|
| Primary | 1 | 第一层看到 Cat Café、Traqen 与已登记项目 | 项目导航同屏两项目，空库时仍显示 Cat Café + 导入项目（无空白导航） | frame-01, S1 | ✅ |
| Primary | 2 | 选 Traqen 后计数/列表/依赖/右栏全切 Traqen | 选中态、计数（0/0/1）、列表（F007）、右栏详情全部切换 | frame-04 | ✅ |
| Primary | 3 | 展开 Feature、建议/批准、SOP 与 Thread 绑定当前项目 backlog item | F007 显示 Traqen 自己的 doc link（`docs/features/F007-traqen-project-relaunch.md`, Owner CodeX），未拉取 Cat Café 同名 F007；工作流表单完整 | frame-04, S3 | ✅ |
| Primary | 4 | 切回 Cat Café 数据不串 | Cat Café 计数 0/25/188 归属正确；Traqen 的 F007/探针任务零泄漏；选中项正确清空 | frame-08 | ✅（读向）|
| Supporting-导入项目 | 1 | 只填名称、路径、Backlog 路径、描述 | 表单即此 4 字段，无任何 EXT/Desktop 配置 | S2 | ✅ |
| Supporting-导入项目 | 2 | 新项目出现在选择器，不要求 Desktop/EXT 配置 | Traqen 即时出现（`ep-0001787701292509-…`） | frame-03/S1 | ✅ |
| Supporting-导入项目 | 3 | "导入 Backlog"只读该项目登记真相源，创建项目绑定 item | 读 `/Volumes/WorkSSD/projects/Traqen/BACKLOG.md` → F007 item `projectId=ep-…39717a9e` | frame-04 + Redis 证据 | ✅ |
| Supporting-快速创建 | 1-3 | ownership-checked 路径创建，持久化正确 projectId | 探针任务写入 `projectId=ep-…39717a9e`、status=open，即时出现在 Traqen 列表 | S3 + Redis 证据 | ✅ |
| Supporting-导入 Backlog（Cat Café 侧, AC-B2） | — | 完成后仍停留该项目并刷新正确列表 | 数据写入成功（292 items）但 UI 未自动刷新（计数停留 0/0/0，手动刷新后正常）；疑似 ~63s 长请求导致前端未消费完成响应 | frame-05（刷新后） | ❌ P2 |
| Primary 隐含契约（写向不串流） | — | "Traqen 的选中项和异步响应不得串入"（写路径对偶：Cat Café 的 mutation 不得改写 Traqen） | **Cat Café 导入把 Traqen 的 F007 静默标 done** | S3 + audit 证据（§3） | ❌ **P1** |

Design doc「Browser verification checklist」逐项：同屏可见 + aria-current 唯一 ✅ / 二级视图层级切换不变 ✅ / 往返不串 item·计数·详情 ✅（读向）/ Traqen 导入与快速创建 project-bound ✅ / 导入表单无 Desktop/EXT ✅ / 375px 可达（按钮全可见、名称完整、导航横滚）✅。

## 3. P1（blocker，不接受 deferred/follow-up 话术）

### P1: Cat Café「导入 Backlog」跨项目改写外部项目数据（静默数据破坏）

**现象**：Traqen 导入产生 F007（status=spec→open，"待建议"）。随后在 Cat Café 作用域点「导入 Backlog」，Traqen 的 F007 被**无操作静默标记 done**，Traqen 工作区显示"已完成/已批准"——一个从未推进的 feature 凭空完成。

**Audit 铁证**（隔离 Redis 6398，item `0001787701318406-000001-c1d1db8e`，`projectId=ep-0001787701292509-000000-39717a9e`）：
```
created @ 1787701318406 (23:41:58Z, Traqen 导入)
done    @ 1787701392169 (23:43:12Z, = Cat Café home 导入写入窗口；操作者未触碰 F007)
```

**根因链**（代码级，全部实读验证）：
1. `POST /api/backlog/import-active-features`（home 导入）的 mark-disappeared 逻辑（`packages/api/src/routes/backlog.ts` L447-459）以 `backlogStore.listByUser(userId)` 全量 items 为基线；
2. `listByUser(userId)` 接口无 projectId 参数（`ports/BacklogStore.ts` L99），返回**含外部项目 items** 的全集；
3. home features 集合里没有的 feature id → `markDone`。Traqen 的 F007 不在 Cat Café ROADMAP → 被标 done。
4. 对偶分支同根因：若外部项目 item 的 feature id **恰好在** home 表中，会走 `refreshMetadata`（L430）把 Cat Café 的 title/summary/tags 写进外部项目 item（本轮未实测，机制同源）。

**影响面**：任何一次 Cat Café 导入 = 外部项目全部 items 遭遇 done/refresh 二选一污染。这不是同名 F 号边缘场景——是 AC-B2 双向导入主旅程必踩。直接违反 AC-A2（"当前项目唯一决定…所有 mutation 的 backlog 作用域"）与 spec Risk #1 的缓解承诺（该缓解只覆盖了读路径）。F306 diff 未改此段（pre-existing 组合缺陷），但 F306 把项目对等 + 双向导入立为核心旅程并以 AC-A2 承诺 mutation 作用域——**验收按承诺验，不按 blame 验**。

**修复回归基线**（供作者，非处方）：mark-disappeared / refresh 基线必须限定在当前导入作用域（home 导入只消费无 projectId 的 items；外部项目导入只消费该 projectId 的 items）；建议补 AC-C1 级测试：「Cat Café 导入不得改变任何带 projectId 的 item」。
**复现**（隔离环境一条命令）：导入 Traqen backlog 后执行
`curl -X POST http://localhost:3012/api/backlog/import-active-features -H "X-Cat-Cafe-User: default-user"`，观察 F007 audit 出现 `done`。

## 4. P2 + 显著发现（一并上报，不阻断归因于 P1 之外）

- **P2（AC-B2 局部不满足）**：Cat Café 长导入（~63s，292 items）完成后 UI 不自动刷新，计数/列表停留空态，手动刷新才可见。疑似前端 fetch 超时未消费响应（未深钻）。Traqen 短导入刷新正常。
- **显著发现（pre-existing 真相源漂移，非 F306 引入）**：`git-doc-reader.ts` 硬编码从 `origin/main` 读 ROADMAP/feature docs。本机及**生产 runtime** 的 `origin` = zts212653（开源上游），其 ROADMAP 落后 fork（104 行 vs 105 行，无 F302/F304/F305/F306 行）。后果：operator 在 Cat Café 工作区**永远看不到 fork-only 的进行中 feature（包括 F306 自己）**。解析层实测：alpha 工作树 ROADMAP 直接解析含 `F306/in-progress`，API 实际返回 totalActive=103（上游内容）。此缺口建议由 owner 评估独立立项（数据源应跟随部署的权威 remote 或工作树）。
- **观察项 P3**：外部项目 item 的来源标签显示"来源 docs/ROADMAP.md"，实际读取的是导入时填写的 `BACKLOG.md`（`buildBacklogInputFromFeature` 硬编码文案）。

## 5. User Visibility Disclosure 审查（守护拷问）

作者 Disclosure 表 6 行中 4 行 met 实测成立（一级导航/项目内工作流/项目导入/EXT）。两行拷问结论：
- **Thread 归属 fail-closed**：代码实测 `MissionControlPage.tsx` L291-298 只按 `backlogItemId` 精确集合匹配、无标题猜测路径。判定：**合法安全契约**，不是藏起来的缺失——跨项目误归因是数据正确性风险，fail closed 是正确取舍，operator 原始诉求未承诺 legacy 标题猜测。✅ 接受。
- **Live runtime dormant**：release activation 独立于 feature code close，属实且与本次验收边界一致。✅ 接受。但注意：**即使 activation 后，P1 与真相源漂移都会在生产复现**（生产 origin 同为开源上游）。

## 6. 愿景三问

1. **operator 最初要解决的核心问题？** Mission Hub 项目不是一级坐标：Cat Café 两个固定 Tab、Traqen 一个特殊 Tab + EXT 定制叠加，同名 Feature 有跨项目归因风险。
2. **交付物解决了吗？** 结构层面解决：项目成为一级导航、体验归一、EXT 退出默认投影、读路径作用域与 fail-closed binding 全部实测成立。**但"项目对等"的写路径没有兑现**——Cat Café 导入可以静默摧毁外部项目状态，等于项目容器造好了、门锁只装了一半。
3. **operator 用起来体验如何？** 前 10 分钟惊艳（选项目→同一套界面推进 F007 完全流畅）；直到某次点了 Cat Café 的「导入 Backlog」，Traqen 里 spec 状态的 F007 悄悄变成"已完成"——这是 operator 无法自行诊断的静默数据错误，信任级伤害。

## 7. 结论

**BLOCKED**。P1（跨项目写污染）修复 + 回归测试后，我可以在同一隔离环境快速复验（复现命令在 §3，环境可按本报告 §复现步骤一键重建）。P2 建议同批修复；真相源漂移与 P3 由 owner 决定处置路径，不作为本 feat close 前置。

## 附：证据清单与复现

**正式证据（本目录）**：`S1-project-first-nav-catcafe-traqen.png`（一级导航）/ `S2-import-form-no-ext-fields.png`（导入表单无 EXT）/ `S3-traqen-workflow-and-P1-f007-pollution.png`（Traqen 工作流 + P1 现象定格：探针任务"待建议" 与被污染的 F007"已完成"同框）/ `f306-acceptance-journey-15s.mp4`（15.2s 全旅程 8 帧）。
**过程帧（8 张）**：`${TMPDIR}cat-cafe-evidence/F306-acceptance/2026-08-25/`。
**环境重建**：`CAT_CAFE_ALPHA_REMOTE=fork pnpm alpha:init && CAT_CAFE_ALPHA_REMOTE=fork ./scripts/alpha-worktree.sh start --no-sync`（HEAD 须核对 = 6e3c7e96）。本次验收后 alpha 栈已停止，worktree 与 Redis 6398 数据保留供复验。

[布偶猫/claude-fable-5 🐾]
