# Remote Realtime Transport Fallback Implementation Plan

**Feature:** Regression follow-up to `d88686067` (no new F-number)
**Goal:** Prefer WebSocket for low-overhead remote streaming while preserving polling fallback when corporate networks or tunnels reject WebSocket.
**Acceptance Criteria:** The primary chat socket attempts WebSocket first; Socket.IO still tries polling when WebSocket cannot connect; disconnected durable-history recovery remains unchanged; the transport contract is covered by a regression test; no runtime configuration or running process is changed.
**Architecture cell:** `transport`
**Map delta:** none
**Map delta why:** This only corrects transport preference inside the existing browser-to-Socket.IO connection; it adds no Store, Queue, Router, Adapter, Dispatcher, Binding, ownership edge, or persistent schema.
**Architecture:** `useSocket` owns one Socket.IO connection lifecycle. It asks Engine.IO to connect with WebSocket first and keeps polling as the ordered fallback through `tryAllTransports`. Existing reconnect, room rejoin, foreground catch-up, and disconnected REST reconciliation remain the recovery path when neither transport is connected. Existing server-side `allowRequest` Origin validation remains the WebSocket security boundary.
**Tech Stack:** React, TypeScript, Socket.IO Client 4.8.3, Vitest
**前端验证:** Yes — automated option-contract coverage plus a public-tunnel WebSocket handshake check; runtime restart and runtime-config edits are explicitly out of scope.

---

## Finish line

Remote browsers use one persistent WebSocket whenever the network supports it instead of permanently cycling long-polling requests. A corporate network that blocks WebSocket still reaches the same chat through Socket.IO's polling fallback, and a complete transport outage still uses the existing durable-history recovery without requiring F5.

## Scope

In scope:

- Correct the primary chat socket transport order in `packages/web/src/hooks/useSocket.ts`.
- Pin WebSocket-first plus polling fallback in the existing reconnect/catch-up regression suite.
- Record the symptom, evidence, root cause, constraints, and verification in a bug report.
- Run targeted web tests, type checking, and proportional repository gates.

Out of scope:

- Runtime `.env*` changes, tunnel reconfiguration, or service restarts.
- Removing polling support.
- Changing Socket.IO server authentication, Origin policy, rooms, message ordering, or persistence.
- Introducing cross-tab socket ownership or batching streaming messages; those require separate evidence and lifecycle design.

## Stateful-object gate: primary chat socket

### Census and ownership

| Object | Authoritative owner | Created | Destroyed | Persistence |
|---|---|---|---|---|
| Primary chat `Socket` | `useSocket` effect | Effect setup | Effect cleanup | None |
| Joined-room set | `joinedRoomsRef` in `useSocket` | Hook lifetime | Hook unmount | None |
| Disconnected-recovery timers | `useSocket` effect | Effect setup / disconnect | Effect cleanup | None |

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

### Invariants

- **INV-1:** One mounted `useSocket` effect owns exactly one primary chat Socket.IO client.
- **INV-2:** The ordered first attempt is `websocket` so a capable tunnel does not stay on long-polling for the whole session.
- **INV-3:** `polling` remains the second transport and `tryAllTransports` remains enabled, so WebSocket failure is not a hard disconnect.
- **INV-4:** A connected polling fallback is considered connected and does not activate the disconnected REST recovery loop.
- **INV-5:** Server-side `allowRequest` Origin validation remains unchanged; transport preference must not weaken F156/LL-047.

### Adversarial cases

- Corporate proxy rejects WebSocket upgrade: the client tries polling next and remains usable.
- Tunnel accepts WebSocket: the client does not create recurring long-poll requests for the primary chat stream.
- Both transports fail: existing reconnect and disconnected-history reconciliation continue to operate.
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

### Task 3: Preserve diagnosis evidence

**Files:**

- Add: `docs/bug-report/remote-polling-browser-lag/bug-report.md`

1. Record the exact symptom and introducing commit.
2. Record runtime transport and tunnel-connection-rate evidence.
3. Explain why polling-first can remain polling for the lifetime of the connection.
4. Record the fallback constraint and verification matrix.

### Task 4: Verify proportionally

**Files:** none

1. Re-run the focused reconnect/catch-up test and the adjacent socket coalescer tests.
2. Run the web package type check and lint/format checks for touched files.
3. Verify the public tunnel accepts a WebSocket handshake while treating corporate-network reachability as unproven; the fallback contract covers that case.
4. Review the final diff for runtime-config, persistence, security-boundary, and unrelated-file changes.
