---
feature_ids: [F306]
related_features: [F056, F076, F305]
topics: [mission-hub, project-workspace, interaction-design]
doc_kind: design
created: 2026-08-25
---

# F306 Mission Hub Project Workspaces — Design Gate

> **Status**: approved for implementation by operator direction | **Owner**: 砚砚/CodeX (@cat-idwxwjba, GPT-5.6)

## Design source and constraint

operator 已明确主任务：Mission Hub 第一眼直接看到项目，Cat Café 与 Traqen 对等；进入任一项目后使用相同功能；EXT 定制不在新一轮体现。

当前会话没有暴露 Pencil MCP，因此无法生成或保存 `.pen`。本轮不创造新视觉语言，使用现有 Mission Hub 真页面的暖色 surface、圆角卡片、列表/详情和 focus token 作为在地设计基线；正式实现后以独立开发实例的 browser-preview 作为真实页面 Design Gate 证据。

## Information architecture

```text
┌ Mission Hub ─────────────────────────────────────────────┐
│ Projects: [ Cat Café ] [ Traqen ] [ + 导入项目 ]         │
│ Current: Traqen                         [导入 Backlog]    │
├───────────────────────────────────────────────────────────┤
│ Views: [ 功能列表 ] [ 依赖全景 ]                          │
│ ● 0 待审批   ● 1 执行中   ● 3 已完成                     │
├─────────────────────────────┬─────────────────────────────┤
│ 快速创建                    │ 建议详情 | SOP | Threads   │
│ F007 重新启动与发现         │ 当前 Feature / Task 详情    │
│ F008 ...                    │                             │
│ 已完成 (3)                  │                             │
└─────────────────────────────┴─────────────────────────────┘
```

层级语义：

1. 第一排只回答“我现在在哪个项目”。
2. 第二排只回答“我在这个项目里看什么”。
3. 状态计数、列表、详情和操作共同消费当前项目作用域。
4. `+ 导入项目` 是项目集合操作；`导入 Backlog` 是当前项目操作，二者不混淆。

## Key states

### Default

- 首次进入默认选择 Cat Café，不根据项目名称猜测或自动跳 Traqen。
- 兼容旧 `active-tab` 偏好：`features` / `dependencies` 映射到 Cat Café；合法外部项目 ID 映射到对应项目。
- 新偏好分别记录 active project 与 per-project active view；它们只是导航便利，不是业务真相。

### Loading and switching

- 切换项目立即更新项目标题/选中态并进入 loading；旧项目数据不继续伪装成新项目。
- 旧请求迟到时静默丢弃，不改变当前项目的 data、error、loading 或 selection。
- 项目切换后，若原 selected item 不属于新项目，选择新项目第一项或空值。

### Empty

- 项目存在但尚未导入 Backlog：保留共同页面骨架，显示空态与当前项目的“导入 Backlog”动作。
- 没有任何外部项目：仍显示 Cat Café 和“导入项目”，不出现空白导航。

### Error

- 项目列表加载失败不阻断 Cat Café 工作区。
- 当前项目 backlog 加载失败时错误文案位于当前项目 surface 内，不能保留另一项目内容。
- 导入/创建权限错误原样 fail closed，不切换项目或假装成功。

### Narrow width

- 项目选择器横向可滚动，不能挤压名称到不可识别。
- 一级项目与二级视图保持两个独立行；主操作可换行但不沉到 Feature 列表之后。
- 列表/详情沿用现有单列降级，所有 button 保持可见 focus。

## Interaction contract

| 动作 | 用户可见结果 | 数据边界 |
|------|--------------|----------|
| 选 Cat Café | 同一页显示 Cat Café Feature 与计数 | `GET /api/backlog/items` |
| 选 Traqen | 同一页显示 Traqen Feature 与计数 | `GET /api/backlog/items?projectId=<owned-id>` |
| 切功能/依赖 | 只换当前项目内的视图 | 不改变项目 |
| 导入 Backlog | 刷新当前项目列表 | home/external endpoint 按 server registry 分流 |
| 快速创建 | 新 item 出现在当前项目 | external 必须 ownership check |
| 导入项目 | 新项目加入第一排 | 不创建 Desktop/EXT binding |

## Explicit non-surfaces

F306 默认页面不呈现：

- `开发闭环`；
- ChatGPT Desktop repository/default branch；
- Review 猫 roster、push/PR policy；
- `EXT-*` Feature badge 或 extension catalog item；
- Need Audit/health/risk/slice 等与共同 Feature 工作流不对称的旧外部项目子 Tab。

这些能力的源码或数据不因“不呈现”而删除。若未来重新产品化，应作为显式项目能力入口另行设计，而不是让外部项目再次变成特殊页面。

## Browser verification checklist

- Cat Café、Traqen 同屏可见且只能有一个 `aria-current` 项目。
- 两个项目均有功能列表/依赖全景；切项目后视图层级不变化。
- Cat Café → Traqen → Cat Café 不串 item、计数、详情、Thread 或错误。
- Traqen 导入与快速创建产生 project-bound item。
- 项目导入表单无 Desktop/EXT 文案与字段。
- 375px 宽度下项目选择、导入按钮、二级视图和 Feature 展开仍可达。
