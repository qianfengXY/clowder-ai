---
title: Cross-thread receipt context
status: in-progress
tips_exempt: Clarifies existing cross-thread provenance and receipt copy; no new capability or operator action.
---

# Cross-thread receipt context

Reported by the operator; investigated by 砚砚 / gpt-6-astra on 2026-09-16.

Architecture cell: bubble-pipeline. Map delta: none. Why: this changes the existing source pill and receipt presentation, without adding a state owner or delivery path.

## Diagnosis capsule

| Field | Evidence / decision |
| --- | --- |
| Symptom | An incoming message from another conversation resembles a local reply from the same cat. Its source link and generic “系统回执” heading can be mistaken for an unrelated conversation or receipt leaking into the current one. |
| Reproduction | Deliver a callback message from conversation A to B with `extra.crossPost.sourceThreadId=A` and `queueReceipt.scope=cross_thread_delivery`; inspect B. Source provenance and the receiving invocation are distinct persisted facts. Read-only inspection of reported live examples confirmed explicit cross-posts, not random message placement. |
| Root cause | The source pill lists a cat, an abbreviated ID and a title without naming the cross-conversation relationship. The receipt heading does not identify the receiving conversation. A missing sidebar title is incorrectly described as an unnamed conversation. |
| Strategy | Compare the visible message with its persisted crossPost, target and outcome invocation; inspect source navigation and exact-message receipt projection; then reproduce the missing explanation in component tests. |
| Timeout | If persisted provenance and visible placement disagree, stop presentation-only work and trace the exact message through history/socket projection. Do not repair routing based on copied prose. |
| Warning | A source/target mismatch, local replies gaining cross-thread labels, or a source-navigation regression would invalidate this bounded fix. |
| Interaction | Label the source link “跨会话来信 · 来自 …”; label the receipt “跨会话来信 · 本会话处理回执” and explain its receiving-side scope. Unknown titles remain explicitly unavailable with the source ID still accessible. |
| Acceptance | Observed two assertion failures before implementation, then 91 passing component/postmark/socket-thread-guard tests and Web typecheck. Preserve source href, invocation-scroll intent, local reply rendering, terminal-silent identity and existing receipt state semantics. Isolated browser preview and independent review are required before release. |

## Separate invocation failure

The recurring managed-work executor conflict is already fixed by PR #23 (`a6fcf07813f7c78565afee61f5fe90fbd113b0b9`). Read-only inspection found a newer process still loading an older checkout/build stamp. This presentation change neither rebinds the parent executor nor activates a runtime. Activation and a fresh authenticated operator call remain separate acceptance steps.

This is the permanent presentation correction; it introduces no temporary fallback, data migration or public contract change.
