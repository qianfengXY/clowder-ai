# Remote polling browser lag

## 1. 报告人

- 报告人：operator
- 时间：2026-08-12
- 场景：从公司网络经 cpolar 远程访问 Hub；切到 polling-first 后，对话运行一段时间，浏览器逐渐明显卡顿。

## 2. 复现步骤

1. 使用公网 Hub 地址从远程网络打开一个对话 thread。
2. 保持页面运行并接收持续的流式回复。
3. 在浏览器控制台观察 Socket.IO 实际 transport，在 tunnel 日志观察前端连接创建频率。

期望行为：

- 网络支持 WebSocket 时，主聊天流使用一个持久连接。
- 公司网络阻止 WebSocket 时，自动退回 polling，消息仍完整、有序，突发包处理期间页面仍能响应输入和绘制。

实际行为：

- `d88686067` 把主聊天 Socket.IO transport 顺序从 `['websocket', 'polling']` 改为 `['polling', 'websocket']`。
- 现场连接的 transport 连续约 43 分钟保持 `polling`。
- cpolar 前端 tunnel 的新本地连接由空闲约 11–13 次/分钟上升到对话期间约 188–225 次/分钟。
- long-polling 经 tunnel 往返时会把积压的 `agent_message` 同步交给当前 coalescer；其 backlog 使用连续 microtask 排空，没有输入或绘制边界。

## 3. 根因分析

### Runtime preflight

```text
PORT=3004
PID=72322
START_TIME=Wed Aug 12 14:51:54 2026
HEAD=4bfa0bb4b feat(codex): expose app-server preparation latency (#4)
TARGET_COMMIT=d88686067a4d
PROCESS_AFTER_TARGET=yes
LOG_EVIDENCE=25692
```

运行进程在目标回归 commit 之后启动，且当前 PID 有持续日志证据，因此不是“runtime 未更新/未重启”。

### 调查与排除

- 最近变更：`d88686067` 是 transport 顺序变化的直接来源；变更前为 WebSocket-first，变更后为 polling-first。
- 运行证据：Socket.IO 连接建立后长期报告 `transport: polling`；Engine.IO 的 upgrade probing 发生在连接打开阶段，未升级的连接不会在数十分钟后自行重新选择 WebSocket。
- tunnel 证据：对话期间的新 HTTP 连接频率相对空闲增加一个数量级，与 long-polling 的重复请求模型一致。
- 公网路径：当前公网 API tunnel 和前端同源代理路径都接受 WebSocket upgrade（测试返回 `101 Switching Protocols`）；但这不能证明公司代理允许 WebSocket，因此不能删除 polling fallback。
- 放大项：页面另有 vote、active-pane、health/ready/cats 等周期 REST 请求，多 tab 会叠加；它们解释一部分基线请求，但数量不足以解释主要增幅。
- UI 数据流：`agent_message` coalescer 保证不丢事件并按 6 条分块，但 backlog 使用 chained microtasks。它能限制每块的 Zustand 同步通知数，却会在 tunnel 一次送达较大积压时连续占用 main thread，不给浏览器输入/paint 机会。
- 排除项：两个高 CPU TypeScript 编译进程会放大整机卡顿，但与 transport 变更无因果关系；运行配置也不是本修复授权范围。

### 确认根因

根因由两部分组成：

1. polling-first 使支持 WebSocket 的远程路径也优先承担长期 HTTP 请求 churn；一旦打开阶段没有成功升级，该连接就持续 polling。
2. polling/tunnel 可能把积压事件成批交付，而 coalescer 的 microtask backlog 没有浏览器调度边界，突发处理会造成可见卡顿。

失败测试分别确认了两个行为：transport 契约测试实际收到 `['polling', 'websocket']`；事件循环测试显示第二个 Promise turn 已继续处理下一块（12 条），证明 backlog 会被 microtasks 连续排空。

## 4. 修复方案

采用两层、无丢包的修复：

1. 主聊天连接改回 `['websocket', 'polling']`，同时保留 `tryAllTransports: true`。WebSocket 可用时避免长期 HTTP churn；公司网络拒绝时仍自动尝试 polling。
2. 保留 coalescer 的 FIFO、每事件处理和 `CHUNK_SIZE=6` 约束。第一块仍用 microtask 低延迟处理，只有 backlog continuation 改为 `setTimeout(..., 0)`，让浏览器在每块之间获得输入/绘制机会。

明确放弃的备选：

- 不移除 polling：公司网络兼容性是硬约束。
- 不合并或丢弃 text events：会改变 `seq` gap detection、append/replace 和 done ordering 语义。
- 不修改 `.env.local`、tunnel 地址或运行服务：runtime config 属于 operator 管理边界，且当前两条公网路径本身都能完成 WebSocket handshake。
- 不把所有流事件固定延迟到 animation frame：后台 tab 会节流 rAF，可能造成不可控消息延迟。

## 5. 验证方式

- RED：`useSocket-reconnect-catchup.test.ts` 在生产修改前明确收到 polling-first，WebSocket-first 断言失败。
- RED：`useSocket-message-coalescer.test.ts` 在调度修改前证明 Promise turns 会连续把 handler 从 6 次推进到 12 次。
- GREEN：transport、coalescer unit、真实 Zustand burst integration 共 21 个测试通过。
- GREEN：web TypeScript `--noEmit` 通过；Biome touched-file check 无新增 error（只报告既有 complexity/non-null warnings）。
- FULL SUITE：5854 tests passed，4 个失败；同一 4 个测试在未包含本次实现的 main 上精确复跑也失败，确认是既有基线问题（F232 PR URL 两项、artifact path 一项、F252 `@co-creator` 一项）。
- 公网验证：WebSocket handshake 能返回 101；公司网络若拒绝，浏览器控制台应显示最终 transport 为 polling，但大 backlog 会跨 task 排空而不是连续 microtask 独占主线程。

## Bug 诊断胶囊：远程 polling 对话运行后浏览器卡顿

| 栏位 | 内容 |
|---|---|
| **1. 现象** | 远程访问 Hub 并持续对话后，浏览器逐渐卡顿；期望远程流式对话长期保持可交互。 |
| **2. 证据** | 引入 commit `d88686067`；现场 transport 约 43 分钟保持 polling；tunnel 新连接从约 11–13/min 增至 188–225/min；runtime preflight 证明运行代码包含目标变更。 |
| **3. 问题假设或根因** | 已确认：polling-first 增加长期 HTTP churn；tunnel-delivered backlog 又被 chained microtasks 连续排空，缺少输入/paint 边界。 |
| **4. 诊断策略** | 对照引入 commit 前后 transport options；读取 Engine.IO upgrade 生命周期；对照 tunnel 连接速率、runtime transport 和 coalescer 调度；用两个最小失败测试分别钉住。 |
| **5. 超时策略** | 若公司实测仍卡，保留本次无损修复，收集 Performance trace、单包事件数和长任务记录，再决定是否在序列赋值前做 server-side text aggregation；不在缺少证据时合并客户端事件。 |
| **6. 预警策略** | 消息 seq gap、done 先于 text、后台恢复变慢或 polling fallback 连接失败，任一出现都说明修复越过了传输/排序边界，必须回退并重新调查。 |
| **7. 用户可见交互修正** | 可用网络优先一个持久 WebSocket；受限公司网络继续 polling，但突发消息分块之间允许浏览器处理输入和绘制。 |
| **8. 验收** | transport option contract、200-event FIFO/no-drop、每块通知上限、event-loop yield、正常单事件低延迟、reconnect/catch-up 测试全部通过；typecheck/lint/diff gate 通过；公司网络最终由 operator 实测。 |
