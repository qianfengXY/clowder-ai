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
- A repeated request ID closes the run, invalidates its first waiter and fails
  the carrier instead of publishing another interaction or racing two replies.
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
| Foreign thread or stale turn | Reject before publication |
| Duplicate ID, first request pending or answered | Close once; no second publication |
| Closed run, new request | No publication or response |
| Close, followed by a late accept from a waiter ignoring abort | No wire response |
| Opt-in timeout, before interrupt grace finishes | Interaction already invalidated |

The standalone lifecycle regression showed three baseline failures (duplicate
pending ID, duplicate answered ID, dispatch after close), then passed with the
extracted patch. Together with the existing adapter, wire-edge and canonical
registration suites, the targeted source tests passed 17/17.

The transport timeout regression was retained separately in
`codex-app-server-transport.test.js`. Its earlier RED and GREEN belong to the
combined candidate; this branch still needs its own built transport test and
full gate. No runtime, actual CUA tool, permission store or production data was
used in these tests.

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
