---
title: Retire expired session directory exceptions
status: in-progress
tips_exempt: Internal module organization and directory governance; no new user-facing behavior or capability.
---

# Retire expired session directory exceptions

Architecture cell: identity-session. Map delta: code anchor update only; ownership and runtime contracts stay with the existing session services.

## Diagnosis capsule

| Field | Evidence / decision |
| --- | --- |
| Symptom | Directory Size Guard and the Lint job fail before checking an otherwise unrelated change. |
| Reproduction | Run `bash scripts/check-dir-size.sh` after 2026-09-15 on the prior base; both session and redis-keys exceptions have expired. |
| Root cause | The temporary exceptions outlived their deadlines. Session has 33 direct TypeScript files, while redis-keys has 24 and no longer needs an exception to the 25-file error threshold. |
| Strategy | Retire both exceptions. Group the six transcript storage/reading/formatting/archive modules in `session/transcript`, and the three handoff digest/proposal/approval modules in `session/handoff`. Update module references and the architecture code anchor. |
| Timeout | Stop if a move requires changing a persistence format, authorization rule, runtime path or public contract; this correction is structural. |
| Warning | Module-loading errors or changed transcript/handoff behavior invalidate the move even if the directory counter is green. |
| Interaction | Existing session, transcript, invocation and handoff APIs continue through their existing routes. No UI or operator action changes. |
| Acceptance | The existing guard must go from expired-exception failure to success, and API builds plus session/transcript/handoff route and recovery tests must pass. Independent review is required before merge. |

## Scope and remaining warnings

The session root now has 24 modules, transcript has 6 and handoff has 3. The Redis-key root remains at 24. The roots still exceed the warning threshold of 15: the remaining session modules own lifecycle, continuity and invocation projection, and Redis-key modules retain their existing key-family ownership. Splitting additional domains is unnecessary to retire these two expired exceptions and would enlarge this correction. No dates, thresholds, persistence paths, key names, exported symbols or data formats are changed; no compatibility re-export layer is introduced.

This is a permanent boundary split, not a renewed exception or a temporary bypass. Runtime activation remains separately authorized.
