# Review Request: Agent Hook runtime MCP baseline

Review-Target-ID: fix-agent-hook-health-cpolar
Branch: fix/agent-hook-health-cpolar

## What

Agent Hook 的 MCP 健康检查和同步现在通过既有的 `redirectRuntimeProjectPath()` 边界，把一次性 runtime worktree 映射到持久 workspace。持久根不可用时，健康检查显式报错，能力同步 fail-closed。

## Why

运行中的 runtime capabilities 没有 MCP，而持久 workspace 保存全部配置。旧实现把 runtime 当成全局基线，误报 6 个核心 MCP 为 `project-orphan`，同步存在删除它们的风险。

## Original Requirements

> “我的项目上有很多skill与mcp，都涉及7类异常。同步问题，是否能帮我处理一下？”

- 来源：`docs/bug-report/agent-hook-runtime-mcp-root/bug-report.md`
- **请对照上面的摘录判断交付物是否解决了 operator 的问题。**

## Tradeoff

不复制 runtime 配置、不新建第二套真相源，也不放宽 cpolar 远程写门禁。复用现有持久项目路径边界；根解析失败时宁可跳过能力同步，也不猜测或删除 MCP。

## Architecture Ownership

Architecture cell: capability synchronization boundary（F249；当前 ownership map 未单列该 cell）
Map delta: none
Why: 复用既有 persistent-project-path 边界，没有新增 Store / Queue / Router / Adapter / Dispatcher / Binding，也没有改变 owner 或 extension point。

请 reviewer 检查：

- diff 是否与 `Map delta: none` 一致；
- 是否存在 runtime→workspace 越界或符号链接绕过；
- 持久根缺失或 capabilities 无法解析时是否真正 fail-closed；
- MCP 同步是否仍可能把 6 个核心 MCP 当作 orphan 删除。

## Open Questions

### 技术 OQ

`resolveAgentHookGlobalRoot()` 是否应该继续作为 Agent Hook 内部边界导出，还是应直接测试更底层的 `redirectRuntimeProjectPath()`？当前导出用于锁住 Agent Hook 必须经过该边界的回归契约。

### 价值 OQ

无。

## Next Action

请对 commit `c96071e90` 以及本请求信组成的最终 HEAD 做独立安全审查，并给出带 P1/P2/P3 严重度的 APPROVE 或 REQUEST-CHANGES。

## Review Sandbox

- Path: `/tmp/cat-cafe-review/fix-agent-hook-health-cpolar/codex-peer`
- Start Command: `pnpm review:start`
- Ports: `web=3213`, `api=3214`

### 沙盒 Bootstrap

```bash
unset NODE_ENV
pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/shared build
pnpm --filter @cat-cafe/api run build
```

## 自检证据

### Spec 合规

- 不放宽远程 localhost 门禁；
- 不复制 `.cat-cafe/capabilities.json`；
- 持久配置只读复查：48 Skills、11 MCPs、6 core MCPs；
- 实际漂移：Skills `new=0, stale=0, conflicts=0`；MCP issues `0`；
- 根目录媒体/设计工件闸门为空；无 UI delta，设计与浏览器门禁不适用；
- Architecture map delta 为 none。

### 测试结果

```bash
pnpm exec biome check packages/api/src/agent-hooks/health.ts \
  packages/api/src/agent-hooks/index.ts packages/api/test/agent-hooks.test.js
# clean

pnpm --filter @cat-cafe/api build
# exit 0

pnpm --filter @cat-cafe/api exec node --test test/agent-hooks.test.js
# 29 passed, 0 failed

git diff --check
# clean
```

完整 `pnpm --filter @cat-cafe/api test` 在此 worktree 退出 1；失败集中于隔离 checkout 缺少未纳入 Git 的 `.claude`/根文档/launchd 文件、宿主未安装 `tmux`，以及依赖本机全局 capability 环境的既有测试。本次相关 Agent Hook 套件 29/29 全绿，build/tsc/Biome 均通过。鉴于完整门禁在干净 worktree 中不可满足，本轮以定向高风险回归 + 实际持久配置只读验收 + 独立 review 作为替代证据。

### 相关文档

- Bug report: `docs/bug-report/agent-hook-runtime-mcp-root/bug-report.md`
- Prior fix commit: `cf065e51a`
- Code fix commit: `c96071e90`

[砚砚/GPT-5.6🐾]
