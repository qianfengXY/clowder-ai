# Agent Hook runtime MCP root bug

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | Agent Hook 健康检查把当前 Clowder AI 项目的 6 个核心 `cat-cafe-*` MCP 报为 stale；直接同步会把它们当作 project orphan 删除。期望 runtime 模式使用持久工作区作为全局 MCP 基线。 |
| **2. 证据** | Runtime API PID 40025 运行于 commit `7f86fd208`；`getAgentHookStatus` 返回其余 6 类 configured、MCP `6 drift issues`。逐项检查为 6 个 `project-orphan`，而 runtime worktree 的 capabilities 中没有 MCP，持久工作区包含全部 6 个核心 MCP。 |
| **3. 根因** | `agent-hooks/health.ts` 直接使用 `resolveStartupProjectRoot()` 作为 MCP 全局根。在 runtime 模式该值是一次性二进制 worktree；它没有持久 MCP 配置。其他 MCP/Skills 路由会先用 `redirectRuntimeProjectPath()` 映射到 `CAT_CAFE_WORKSPACE_ROOT`，Agent Hook 健康检查遗漏了这一步。 |
| **4. 诊断策略** | 对照 `routes/mcp-drift.ts` 的工作实现；给 Agent Hook 全局根解析增加同样的 runtime→workspace 映射，并让检测与同步复用同一解析结果。 |
| **5. 超时策略** | 若根映射回归测试不能稳定复现，停止修改同步器，转而把根解析抽成可注入依赖后测试。 |
| **6. 预警策略** | 任何方案若需要复制 runtime `.cat-cafe/capabilities.json`、删除项目 MCP 或增加第二套配置真相源，立即停止。 |
| **7. 用户可见交互修正** | 七类健康状态应全部 configured；本机同步不会删除核心 MCP。远程 localhost 门禁保持不变。 |
| **8. 验收** | 新测试证明 runtime root 映射到持久 workspace；Agent Hook API 测试全绿；使用实际两套根目录复查 MCP drift 为 0，核心 MCP 数量保持 6。 |

## Bug report 五件套

1. **报告人**：co-creator 在 cpolar 远程使用时发现 Agent 同步状态异常。
2. **复现步骤**：runtime worktree 与持久 workspace 分离；runtime capabilities 无 MCP、workspace 有核心 MCP；运行 Agent Hook 健康检查。
3. **根因分析**：Agent Hook MCP 路径遗漏持久根重定向，错误地把二进制 worktree 当作配置真相源。
4. **修复方案**：复用 `redirectRuntimeProjectPath()`；不复制配置、不放宽远程门禁、不删除 MCP。
5. **验证方式**：Red→Green 根映射测试、Agent Hook 定向测试、实际配置只读复查。
