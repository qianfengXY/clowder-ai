# 画图技能参考包

这里保存供 Cat Café 后续画图 skill 整合使用的第三方原始安装包。
这些包没有注册到 `cat-cafe-skills/manifest.yaml`，也没有挂载到任何 provider 的技能目录。

## Archify

- 入口：[原始 SKILL.md](archify/SKILL.md)。
- 来源：本机原 `~/.codex/skills/archify/` 安装包；上游为 [tt-a1i/archify](https://github.com/tt-a1i/archify)。
- 版本：`package.json` 标注 `2.12.0`；未升级或修改原始文件，不声明已核对上游某个 Git commit。
- 许可证：[MIT](archify/LICENSE)，保留 Archify 与 Cocoon AI 的原始版权声明。
- 完整性：[快照清单](archify.snapshot.json) 记录全部原始文件的大小和 SHA-256。
- 当前状态：待整合参考包。operator 要求先迁入 Cat Café，待画图 skill 方案确定后统一管理；本次移除 Codex 用户级安装入口，不新增自动触发规则。
- 来源对话：`thread_mtqp3tgqt0vfudpi`，2026-09-07 UTC。

这个快照是已安装的 skill 包，不是完整上游仓库。其 `package.json` 中部分开发命令引用包外的上游 `../scripts/`、`../docs/` 或 `../examples/`；这些引用不代表 Cat Café 中存在对应文件。本次只验证迁移完整性，不宣称完整上游测试套件可运行。

整合时按家里的 `writing-skills` 流程选择触发边界、产出契约与渲染路径，再注册和同步；不要把此目录直接批量挂入用户级技能目录。
