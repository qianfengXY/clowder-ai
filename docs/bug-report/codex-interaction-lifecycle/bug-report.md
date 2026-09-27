# Codex interaction lifecycle: reject replies after the carrier has ended

## Scope and reproduction

This is the independently deployable lifecycle portion of the investigation in
`thread_mujrlphvcvzgvzsx`, authorized by source message
`thread_muevjiaa8wh9f98a#0001790510144932-000252-cb06b780`.
It is based on `f20b505d05d0c9f111270bb75145e67ca17dd8cb` and extracts two
provider files from candidate `8fda4be9d6f38e060b9cef849f778b5613873837`.

With a synthetic runtime-interaction port, send the same numeric request ID
twice, or dispatch a request after closing its run. On the baseline the port is
called twice for the duplicate, and once after close. A pending first answer
can therefore remain live alongside a duplicate request. Separately, a positive
opt-in client timeout initiates interrupt grace without immediately invalidating
the pending interaction.

## Root cause and change

The run suppressed outgoing replies after close but did not stop new dispatches.
It also had no per-run record of consumed runtime-interaction request IDs.
The client's timeout callback waited for lifecycle termination to close the
interaction, leaving the interrupt-grace interval exposed.

- Closed runs return before calling the interaction port.
- Every numeric server-request ID is recorded before dispatching to either an
  interactive or rejection path. A repeated ID closes the run, invalidates its
  first waiter and fails the carrier without another reply. Foreign coordinates,
  unsupported methods and legacy approval replies share this wire ID namespace.
- A positive opt-in timeout closes interactions before sending the interrupt.

This branch does not change the consent adapter, request classification, choices,
permission ownership, persistence metadata, or the default disabled timeout.
It creates no grant cache. In particular, it does not include the blanket
unverified-connector denial candidate from branch `fix/cua-consent-boundary`.
Ordinary form, URL and user-input adapter behavior remains the baseline behavior.

## State invariants and tests

| State / event | Required result |
|---|---|
| Live, first valid request ID | Existing adapter behavior |
| Fresh ID with foreign thread or stale turn | Record ID; reject before publication; other fresh IDs remain usable |
| Duplicate ID, first request pending or answered | Close once; no second publication or reply |
| Valid pending request, then same ID with foreign coordinates or another method | Close; suppress the first request's late answer and the second reply |
| Rejected request, then same ID with valid coordinates | Close; no new interaction or reply |
| New run, ID previously used by another run | Independent ID set; existing adapter behavior |
| Closed run, new request | No publication or response |
| Close, followed by a late accept from a waiter ignoring abort | No wire response |
| Opt-in timeout, before interrupt grace finishes | Interaction already invalidated |

The ID rule is a Host compatibility policy scoped to one run, not a general
[JSON-RPC guarantee](https://www.jsonrpc.org/specification) that completed IDs
can never be reused. The upstream
[OutgoingMessageSender implementation](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/outgoing_message.rs)
observed on 2026-09-27 initializes an atomic counter and increments it when
allocating new server-request IDs. That supports the expected allocation pattern;
it does not prove the installed binary matches that source or establish a promise
for every upstream version. If an upstream deliberately reuses an ID within the
same run after completion, this Host will terminate that run. A new run starts
with a fresh ID set.

Opt-in inactivity timeout currently invalidates with `transport_lost`, the
existing terminal reason also used for a broken connection. The card therefore
shows the connection-interrupted wording even when an idle timeout triggered
invalidation. This patch does not add a distinct timeout reason or change the
default disabled timeout; production run input currently does not set timeoutMs.

The standalone lifecycle regression showed three baseline failures (duplicate
pending ID, duplicate answered ID, dispatch after close), then passed with the
extracted patch. Together with the existing adapter, wire-edge and canonical
registration suites, the targeted source tests passed 17/17.

The transport timeout regression was retained separately in
`codex-app-server-transport.test.js`. The independent branch at
`43c165c6750626c91fb9e9c39956a723e6e5dcfa` subsequently passed the MCP/API builds,
the complete built transport suite, and the canonical runtime-interaction suite
(43 passed, none failed). The managed command exited 0 after 211 seconds. Tests
used an isolated HOME with inherited Redis and Codex home settings removed.
No runtime, actual CUA tool, permission store or production data was used.
The full risk gate remains outstanding; these targeted results do not replace it.

Before the full gate, the known baseline Collective route fixture failure was
reproduced independently on this branch: its session header defaults to
`owner-user`, while its callback and thread fixture defaulted to `owner_1`.
The successful owner-route test therefore correctly received 422. The fixture
now derives the callback owner from the same session header; production ownership
checks are unchanged. This is the same one-line fixture correction as the
attachment branch, not a runtime permission change.
The complete Collective connector route suite then passed 9/9.

## Remaining acceptance

This is not a repair of persistent Computer Use authorization. Verified connector
provenance and the supported headless grant-owner contract remain unresolved.
The browser policy load failure, `cgWindowNotFound` and the reported multi-day
wait still have no proven common cause; these synthetic lifecycle bugs do not
establish that causal link.

Independent review, full gate, merge and isolated acceptance remain required.
No deployment is authorized by this report and no production configuration has
been changed. The exact canonical `gh pr list` command is currently rejected by
the native guard as `protected_target_unparsed`; remote overlap verification and
PR publication remain pending without switching to an unguarded executable.
