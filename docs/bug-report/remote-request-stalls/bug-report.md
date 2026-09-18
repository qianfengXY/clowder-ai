---
feature_ids: [F299]
topics: [network, performance, transcript]
doc_kind: note
created: 2026-09-18
updated: 2026-09-18
---

# HTTP/1.1 远程访问周期性 pending / canceled

## 报告与复现

用户通过 cpolar 在 Windows Chrome 使用猫咖，HTTP/1.1。页面运行一段时间后，
health、ready、cats、vote、queue 大面积 pending，随后 canceled；刷新也会等待，
过一段时间恢复。Mac Chrome 访问同一公网地址也观察到相同现象。

检查基线为运行中的 a0dd24c503f0f255a6399a8bdb0eab336989b079，包含既有
Socket.IO 请求释放修复。整个调查及隔离验证没有修改、重启在线服务。

## 根因与边界

1. Workbox `NetworkOnly` 仍会拦截 `/api/` 和 `/socket.io/`，在 Service Worker 中
   发起自己的 fetch。页面 AbortController 超时后，worker fetch 继续占据连接。
   浏览器观察到 vote 在页面层 8 秒取消、worker 层 27.3 秒才 200。
   两层 Network 记录不是两次实际网络传输，但生命周期确实没有同步取消。
2. ChatContainer 和 ThreadChatSurface 同时使用 useConnectionStatus，原来每个
   hook 独立启动 15 秒轮询和连接恢复探测，导致重复 health / ready / cats。
3. invocation 列表先 Promise.all 全部 session 的完整 transcript，再做 projection
   和 limit。活跃文件通过 readFile/split/parse 全量展开，指纹合并同步 stringify。
   即使 canonical 源为空，外层 merge 仍再次序列化所有 active payload。
   现场两个活跃文件分别约 132 MiB、76 MiB；API native sample 捕获 JSON.stringify
   与 GC，同期列表查询最高 111 秒。主机内存竞争是放大因素，尚不能把全部线上延迟
   精确归因到这一个函数；本修复也不声称消除独立的隧道波动。

writer 的 live 文件和 reader 的 canonical 文件不是同一个文件。不能因为 active
非空而跳过 canonical，也不能按 eventNo 或 Set 去重，否则会损坏重启/封存重叠语义。

## 修复

- 自定义 worker 在 Workbox 注册 fetch handler 之前截断 API / Socket.IO 的事件传播，
  不调用 respondWith，让浏览器直接拥有原请求及取消语义。静态缓存、导航、push 不变。
- 同一 document 共享一个连接探测批次和定时器；多个 surface 订阅同一结果；不重叠，
  后台页暂停新探测，最后一个订阅释放时取消请求，旧批次不能覆盖新挂载。
- live 文件流式解析；读取和指纹合并每 128 条让出事件循环，并检查取消信号。
  空源合并不再序列化 payload。保持多重计数、补充源优先及 eventNo 语义。
- invocation 列表逐 session 读取和投影，避免同时展开全部原始日志；连接关闭后
  中断读取，停止剩余 session。总数、排序、limit 和访问控制不变。
- 不更改 transcript 写入/封存的同步合并规则，不清理任何持久数据。

## 验证

真实 Chrome、隔离 HTTP/1.1 服务、相同 Workbox bundle，连续取消 6 个挂起请求：

| 指标 | 原行为 | 修复 |
| --- | --- | --- |
| 服务端收到取消 | 0/6 | 6/6 |
| 同时占据连接峰值 | 6 | 1 |
| 随后的 health | 1002 ms 超时 | 3 ms 返回 |

约 50 MiB 合成 live JSONL（12,000 个事件，无生产消息正文），同机单次隔离读取：

| 指标 | 原行为 | 修复 |
| --- | --- | --- |
| 最长事件循环间隔 | 99 ms | 4 ms |
| 进程 RSS | 432 MiB | 289 MiB |
| 总读取耗时 | 121 ms | 78 ms |

这些是隔离对照数字，不是线上 SLA 或长时间公网验收结果。

- API build 通过；7 个相关测试文件 77 项通过，包含原历史合并/封存/权限用例、
  空源不序列化、可中断合并、追加新鲜度、逐 session 读取、真实 HTTP 断开取消。
- Web 5 个相关文件 21 项通过，包含共享计时器、取消、后台暂停、旧请求与重挂载竞态。
- Web TypeScript 与 worker TypeScript（skipLibCheck）通过。
- 独立 reviewer 修复后未发现 P1/P2，确认 Workbox 注册顺序及写入/取消边界。
- 生产 Web 构建及上线后公网复验另记录交付结果；未获确认不得重启。

## 激活与回退

改动仅保存在本地隔离分支，没有远程写入。用户明确要求：**任何重启必须重新确认**。
授权后才把经过验证的精确提交用于 runtime 构建/部署；不得用自动同步引入无关 main
变更。新 service worker 激活后需确认客户端加载新 worker 和 bundle，再验证长期访问。
若需回退，只回退本补丁和构建，保留全部数据；回退后的重启同样须用户确认。
