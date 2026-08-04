---
topics: [kimi, session, resume, runtime, cli-diagnostics]
doc_kind: bug-report
created: 2026-08-04
updated: 2026-08-04
tips_exempt:
  reason: Internal recovery correction for an existing Kimi session/resume path; no new user-facing capability.
---

# Kimi session working-directory resume failure

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | 在既有 thread 中 `@kimi` 会创建 invocation，但 Kimi CLI 连续两次以 code 1 退出，猫猫无法回复。 |
| **2. 证据** | 运行日志显示路由和 invocation 创建成功；CLI stderr 明确报告旧 session 创建于另一个工作目录。旧 session 属于持久 workspace，当前 API 来自 runtime worktree。另一个使用新 session 的 Kimi thread 同期没有异常退出。 |
| **3. 根因** | CLI 错误分类只识别 `Session not found`，没有识别 Kimi 的 `was created under a different directory`。因此错误进入普通 transient retry，并携带同一个不可用 sessionId 重试。 |
| **4. 诊断策略** | 先完成 runtime preflight，再沿消息路由 → invocation → CLI diagnostics → retry 分支逆向追踪；对照既有 `session_not_found` self-heal 与 OpenCode workspace guard。 |
| **5. 超时策略** | 若精确 stderr 分类后仍未进入 self-heal，停止扩展正则，改为检查 Kimi provider 是否丢失 `cliDiagnostics.reasonCode`。 |
| **6. 预警策略** | 不删除 Kimi session 文件、不清空 SessionChain/Redis、不把所有 exit code 1 都当作 session 失效。 |
| **7. 用户可见交互修正** | 目录不匹配时丢弃本轮 resume 参数并自动新建 CLI session；旧会话记录仍保留。 |
| **8. 验收** | 真实 Kimi stderr 被分类为不可恢复 resume；session self-heal 清除 `sessionId` 与 `cliSessionId`；CLI diagnostics、spawn 和 invocation 回归全绿。 |

## Bug report 五件套

1. **报告人**：co-creator 在当前 thread 两次唤醒 Kimi 时发现。
2. **复现步骤**：让 thread 保留一个在持久 workspace 创建的 Kimi session，再从 runtime worktree 调用同一 session；Kimi CLI 拒绝跨目录恢复。
3. **根因分析**：工作目录变化是合法部署形态，真正缺口是该 CLI 错误没有进入已有 session self-heal 分类。
4. **修复方案**：扩展 `session_not_found` 分类规则以覆盖 Kimi 的目录不匹配文本，复用已有“清除 resume 参数后重试一次”路径。
5. **验证方式**：新增精确 stderr 回归测试；复跑完整 CLI diagnostics、CLI spawn 和 `invoke-single-cat` 测试。

Architecture cell: `identity-session`

Map delta: none — 复用既有 session self-heal，不新增 Store、Queue、Router、Adapter、Dispatcher 或 Binding。
