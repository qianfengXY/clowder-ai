# Remote Realtime Transport Fallback Implementation Plan

**Feature:** Regression follow-up to `d88686067` (no new F-number)
**Goal:** Prefer WebSocket for low-overhead remote streaming while preserving a responsive polling fallback when corporate networks or tunnels reject WebSocket.
**Acceptance Criteria:** The primary chat socket attempts WebSocket first; Socket.IO still tries polling when WebSocket cannot connect; a polling-delivered event backlog preserves every event in FIFO order while yielding browser task/render opportunities between bounded chunks; disconnected durable-history recovery remains unchanged; transport and scheduling contracts are covered by regression tests; no runtime configuration or running process is changed.
**Architecture cell:** `transport`
**Map delta:** none
**Map delta why:** This only corrects transport preference inside the existing browser-to-Socket.IO connection; it adds no Store, Queue, Router, Adapter, Dispatcher, Binding, ownership edge, or persistent schema.
**Architecture:** `useSocket` owns one Socket.IO connection lifecycle. It asks Engine.IO to connect with WebSocket first and keeps polling as the ordered fallback through `tryAllTransports`. The existing agent-message coalescer keeps its FIFO/no-drop semantics and prompt first chunk, but backlog chunks continue in browser tasks instead of an unbroken microtask chain. Existing reconnect, room rejoin, foreground catch-up, and disconnected REST reconciliation remain the recovery path when neither transport is connected. Existing server-side `allowRequest` Origin validation remains the WebSocket security boundary.
**Tech Stack:** React, TypeScript, Socket.IO Client 4.8.3, Vitest
**前端验证:** Yes — automated option-contract coverage plus a public-tunnel WebSocket handshake check; runtime restart and runtime-config edits are explicitly out of scope.
**tips_exempt:** This is corrective transport scheduling with no new user action, capability entry point, or discoverable workflow.

---

## Finish line

Remote browsers use one persistent WebSocket whenever the network supports it instead of permanently cycling long-polling requests. A corporate network that blocks WebSocket still reaches the same chat through Socket.IO's polling fallback; tunnel-delivered backlogs yield between bounded chunks so the page remains interactive. A complete transport outage still uses the existing durable-history recovery without requiring F5.

## Scope

In scope:

- Correct the primary chat socket transport order in `packages/web/src/hooks/useSocket.ts`.
- Make only coalescer backlog continuations yield to the event loop while preserving prompt normal-stream processing, FIFO, and no-drop behavior.
- Pin WebSocket-first plus polling fallback in the existing reconnect/catch-up regression suite.
- Pin event-loop yielding and the existing burst correctness invariants in coalescer tests.
- Record the symptom, evidence, root cause, constraints, and verification in a bug report.
- Run targeted web tests, type checking, and proportional repository gates.

Out of scope:

- Runtime `.env*` changes, tunnel reconfiguration, or service restarts.
- Removing polling support.
- Changing Socket.IO server authentication, Origin policy, rooms, message ordering, or persistence.
- Introducing cross-tab socket ownership or merging/dropping streaming messages; those require separate evidence and lifecycle design.

## Stateful-object gate: primary chat socket

### Census and ownership

| Object | Authoritative owner | Created | Destroyed | Persistence |
|---|---|---|---|---|
| Primary chat `Socket` | `useSocket` effect | Effect setup | Effect cleanup | None |
| Joined-room set | `joinedRoomsRef` in `useSocket` | Hook lifetime | Hook unmount | None |
| Disconnected-recovery timers | `useSocket` effect | Effect setup / disconnect | Effect cleanup | None |
| Agent-message backlog | `createAgentMessageCoalescer` closure | First queued event | Queue drain | None |

### States and transitions

| Current state | Event | Next state | Required behavior |
|---|---|---|---|
| idle | effect setup | connecting-websocket | Attempt WebSocket first. |
| connecting-websocket | WebSocket accepted | connected-websocket | Join tracked rooms and keep one persistent transport. |
| connecting-websocket | WebSocket rejected/blocked | connecting-polling | `tryAllTransports` tries polling without user action. |
| connecting-polling | polling accepted | connected-polling | Preserve chat delivery and do not run disconnected recovery. |
| either connected state | disconnect | reconnecting | Socket.IO reconnects; durable-history recovery only runs while `socket.connected === false`. |
| reconnecting | foreground/online | connecting | Re-attempt connection and reconcile tracked threads. |
| any live state | effect cleanup | closed | Clear timers/listeners and disconnect the owned socket. |
| coalescer idle | first event | prompt-flush-scheduled | Schedule the first bounded chunk in a microtask. |
| prompt/backlog flush | queue remains | backlog-task-scheduled | Preserve FIFO and continue one bounded chunk in a timer task. |
| prompt/backlog flush | queue empty | coalescer idle | Reset the scheduling guard so the next normal event stays prompt. |

### Invariants

- **INV-1:** One mounted `useSocket` effect owns exactly one primary chat Socket.IO client.
- **INV-2:** The ordered first attempt is `websocket` so a capable tunnel does not stay on long-polling for the whole session.
- **INV-3:** `polling` remains the second transport and `tryAllTransports` remains enabled, so WebSocket failure is not a hard disconnect.
- **INV-4:** A connected polling fallback is considered connected and does not activate the disconnected REST recovery loop.
- **INV-5:** Server-side `allowRequest` Origin validation remains unchanged; transport preference must not weaken F156/LL-047.
- **INV-6:** Every queued `agent_message` is handled once in FIFO order; scheduling changes do not merge, drop, or reorder sequence-bearing events.
- **INV-7:** A fully drained queue handles the next normal event in a prompt microtask; only an actual backlog pays the task-boundary delay.

### Adversarial cases

- Corporate proxy rejects WebSocket upgrade: the client tries polling next and remains usable.
- Tunnel accepts WebSocket: the client does not create recurring long-poll requests for the primary chat stream.
- Both transports fail: existing reconnect and disconnected-history reconciliation continue to operate.
- A tunnel delivers a 200-event burst: all 200 events are processed in order, each chunk stays below the React notification limit, and backlog chunks yield between browser tasks.
- A single normal event arrives after a full drain: it is processed in the next microtask without artificial polling delay.
- Reconnect/foreground event: tracked rooms and durable history are reconciled exactly as before.
- Malicious Origin attempts WebSocket: existing server `allowRequest` gate still rejects it; this client-only change does not bypass that boundary.

## Tasks

### Task 1: Capture the regression contract

**Files:**

- Modify: `packages/web/src/hooks/__tests__/useSocket-reconnect-catchup.test.ts`

1. Change the transport test name and expectation to require `['websocket', 'polling']`.
2. Keep the assertion that `tryAllTransports` is `true`.
3. Run the focused test before the production edit and record the expected failure.

### Task 2: Correct transport preference

**Files:**

- Modify: `packages/web/src/hooks/useSocket.ts`

1. Put `websocket` first and retain `polling` second.
2. Update the nearby rationale to describe low-overhead preference plus corporate-network fallback accurately.
3. Do not alter authentication, reconnect, catch-up, room, or cleanup behavior.

### Task 3: Yield during polling-delivered backlogs

**Files:**

- Modify: `packages/web/src/hooks/useSocket-message-coalescer.ts`
- Modify: `packages/web/src/hooks/__tests__/useSocket-message-coalescer.test.ts`
- Modify: `packages/web/src/hooks/__tests__/useSocket-burst-coalesce.integration.test.ts`

1. Add a failing test proving that chained Promise turns cannot drain more than the prompt chunk.
2. Keep the first chunk on a microtask, but schedule backlog continuations with a timer task.
3. Preserve the existing FIFO, no-drop, chunk-size, normal-stream latency, and Zustand-notification invariants.

### Task 4: Preserve diagnosis evidence

**Files:**

- Add: `docs/bug-report/remote-polling-browser-lag/bug-report.md`

1. Record the exact symptom and introducing commit.
2. Record runtime transport and tunnel-connection-rate evidence.
3. Explain why polling-first can remain polling for the lifetime of the connection.
4. Record the fallback constraint and verification matrix.

### Task 5: Verify proportionally

**Files:** none

1. Re-run the focused reconnect/catch-up test and the adjacent socket coalescer tests.
2. Run the web package type check and lint/format checks for touched files.
3. Verify the public tunnel accepts a WebSocket handshake while treating corporate-network reachability as unproven; the fallback contract covers that case.
4. Review the final diff for runtime-config, persistence, security-boundary, and unrelated-file changes.
