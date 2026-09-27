# Rich Blocks Reference

> 降级自 `rich-messaging` skill。按需查阅。

## 何时用 Rich Block

结构化信息默认用 rich block；随意聊天用纯文本。发 block 前先写 1-2 句自然语言摘要。

**适用场景**：不只是对话！定时任务唤醒、主动触发、connector 通知等场景中，猫同样拥有全部 rich block 能力。

### 用 rich block

| Kind | 场景 |
|------|------|
| card | Review 结论、状态报告、决策摘要 |
| diff | 代码修改建议、重构前后对比 |
| checklist | 待办项、检查清单、验证步骤 |
| file | 已有文件、成片视频、导出物；`video/*` 文件会内联播放 |
| media_gallery | 发送已有图片（头像、照片）、截图、设计稿、多图对比 — 不需要现场生成！ |
| audio | 问候、情感表达、定时播报（系统自动合成语音） |
| interactive | 需要用户选择/确认的场景（选方案、选猫、确认操作） |
| html_widget | 数据可视化、自己写的 HTML 面板、交互 demo、mini 工具（沙盒 iframe） |

### 不用 rich block

随意聊天、短回答、技术讨论、不确定用哪种时。

## 字段规格

**关键：字段是 `"kind"` 不是 `"type"`！每个 block 必须有 `"v": 1` 和唯一 `id`。**

| Kind | 必填 | 可选 |
|------|------|------|
| card | title | bodyMarkdown, tone (info/success/warning/danger), fields |
| diff | filePath, diff | languageHint |
| checklist | items (id+text) | title |
| file | url, fileName | mimeType, fileSize |
| media_gallery | items (url) | title, alt, caption |
| audio | text | — |
| interactive | interactiveType, options (id+label) | title, description, maxSelect, allowRandom, messageTemplate |
| html_widget | html | title, height (50-2000, default 300) |

### media_gallery 图片 URL 规范

`items[].url` 只接受以下四种格式（路径遍历 `../` 会被 `safeResolve` 拦截）：

| 格式 | 示例 | 说明 |
|------|------|------|
| `/uploads/xxx.png` | `/uploads/opus-happy.png` | API 已发布的图片 URL，不是让猫写入的磁盘目录 |
| `/api/connector-media/xxx` | `/api/connector-media/img.jpg` | 文件在 `data/connector-media/` |
| `data:image/png;base64,...` | 完整 base64 编码 | 小图可用，会自动转临时文件上传 |
| `https://...` | `https://example.com/img.png` | 外部链接 |

**禁止**：`/api/connector-media/../assets/...` 等含 `../` 的路径 — 会被路径遍历保护拒绝，前端裂图。

> **发布入口与磁盘路径不能混用**：`/uploads/...` 由 API 管理。猫不得把文件直接复制到 runtime 或源码仓的上传目录，也不得换 provider 绕过保护。已有本地文档使用 `cat_cafe_publish_file`；图片自动发布的适用范围见下。没有可调用发布入口的类型如实报告缺口。

### 关于本地生成图的额外说明（F172 共享发布合约）

Codex `image_gen` 和 Antigravity 生成的图片现已**自动发布**：
- Codex：`CodexAgentService` 在 invocation 结束后自动扫描 `~/.codex/generated_images/<sessionId>/` 并发布
- Antigravity：`AntigravityAgentService` 自动从工具结果中检测图片路径并发布
- 两者都通过 `publishGeneratedImage()` 合约，自动解析当前 runtime 的 `uploadDir`、生成幂等文件名、返回 `/uploads/...` URL + `media_gallery` 富块

`publishGeneratedImage()` 是 API 内部函数，没有供猫调用的 MCP/callback。它不能作为本地截图、PPT 预览 PNG 或浏览器下载图片的手动发布工具；这类本地文件尚无通用发布入口，如实报告缺口。

不要把”源码仓里存在这个文件”和”当前 API 正在服务这个文件”混为一谈。runtime 可能跑在另一套 worktree / 另一份 `packages/api/uploads/`。

### file 文件 / 视频 URL 规范

`file.url` 同样只接受 `/uploads/...`、`/api/...` 或 `https://...`。

- 文档、压缩包等普通文件：显示下载卡片
- `mimeType` 以 `video/` 开头，或文件名扩展是 `mp4/mov/webm/avi/mkv/m4v/ogv`：Web UI 直接渲染内联 `<video>` 播放器
- 已有本地文档（PDF、DOC/DOCX、PPT/PPTX、XLS/XLSX、TXT、MD、CSV）用 `cat_cafe_publish_file({ sourcePath, expectedSha256? })`，自动附当前 thread 的文件卡。支持最多 50 MiB 的普通文件，不接受符号链接。
- 本地视频、压缩包等不在该工具白名单中的类型尚无正式发布入口，如实报告缺口；已有合法发布 URL 可用文件卡。不要直写 runtime 或伪装 MIME。

## 创建方式

1. **MCP Tool（推荐）** — `cat_cafe_create_rich_block`
2. **Callback surface reference** — 见 `refs/mcp-callbacks.md` 的工具映射表；不要手写第一方 HTTP callback 作为主路径
3. **Inline Text（fallback）**：
````
```cc_rich
{"v":1,"blocks":[{"id":"b1","kind":"card","v":1,"title":"标题","tone":"info"}]}
```
````

优先用 `cat_cafe_create_rich_block`。`cc_rich` 仅在 MCP/callback surface 不可用时使用。

### interactive 类型

| interactiveType | 说明 | 用户操作 | 自动发送消息 |
|-----------------|------|---------|-------------|
| select | 单选列表 | 点选→确认 | "我选了：方案 A" |
| multi-select | 多选列表 | 勾选多个→确认 | "我选了：Node.js, pnpm" |
| card-grid | 卡片网格 | 点一张卡片 | "我选了：🎲 猫猫盲盒" |
| confirm | 确认/取消 | 点按钮 | "确认" / "取消" |

- `messageTemplate`：自定义模板，`{selection}` 占位符。例："我选了 {selection} 作为引导猫"
- `allowRandom`：card-grid 显示"🎲 随机抽"按钮
- `maxSelect`：multi-select 最大选择数
- `options[].customInput: true`：点该选项后展开理由输入框；可用
  `customInputPlaceholder` 定制提示。当前 UI 在输入为空时禁用确认，因此适合
  “不同意【请写理由】 / 其他【请写处理方式】”。
- 普通 option 不要求输入文字，适合“同意，按建议执行”这类免打字路径。
- 用户选择后 block 自动变 disabled，选择结果持久化（刷新不丢）

### card tone 语义

| Tone | 用途 |
|------|------|
| info | 一般信息 |
| success | 成功/通过 |
| warning | 需注意 |
| danger | 错误/阻塞 |
