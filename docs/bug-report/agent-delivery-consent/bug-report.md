# Agent attachment publication and Computer Use consent

Status: implementation under review preparation / not accepted. Owner: 砚砚, thread_mujrlphvcvzgvzsx.

## Authorization and scope

Operator message `thread_muevjiaa8wh9f98a#0001790510144932-000252-cb06b780` explicitly
requests a separate repair conversation. Read directly through thread context; T0
authorization verified for implementation. F306 remains owned by codex-sol in the
feature document; its index and title discovery expose no owner thread. This repair
does not reassign that feature or revive F246 generic authorization.

## Diagnosis capsule

| Field | Evidence / decision |
| --- | --- |
| Symptom | Existing local PPTX lacks a remote file attachment; native Computer Use repeatedly opens a generic information form. |
| Evidence | Current adapter drops approval classification and persistence choices; its response only contains action/content. Installed CUA policy advertises session/always and consumes response `_meta.persist`. Old investigation: thread_mu2dqozm1zf04ygu, correction 0001789459797384-000353-40482e7a. The temporary report no longer exists. |
| Hypothesis / root cause | Host cannot express the native app-consent choice. This proves a round-trip gap, not that a previous persistent choice existed or that a grant is reusable. The successful attachment author used a direct runtime write; Claude lacked the guard applied to Codex. Rules explicitly recommended that conflicting path. There was no general agent-file publishing endpoint. |
| Strategy | Trace installed protocol, compare successful publisher, reproduce with synthetic bytes and deterministic wire fixtures before changing code. |
| Timeout strategy | Bound test requests; use existing provider cancellation/timeout lifecycle, preserve durable records. After 20 minutes without new protocol evidence, obtain independent contract review instead of speculative grant logic. |
| Warning | Never write runtime uploads directly, impersonate operator messages, fabricate grants, modify vendor/config/permissions, or use another cat's protected session. Three failed hypotheses require reconsideration. |
| User-visible correction | Recognizable app-consent card with only upstream-offered choices; authenticated agent-file publication returning a real attachment URL. |
| Acceptance | Metadata choices round-trip; ordinary forms unchanged; unknown/foreign/stale requests fail closed; cancellation/timeout; same-scope upstream reuse verified; real remote attachment bytes match original. Local HTTP 200 or queued preview is insufficient. |

## Runtime preflight (2026-09-27)

PORT=3004; PID=73677; START_TIME=2026-09-21 19:37:53 local.
Runtime cwd=/Volumes/WorkSSD/cat-cafe-runtime/packages/api.
HEAD/TARGET_COMMIT=1d0467b390181dd1bc3927e9f958b700532c0e42 (2026-09-21 19:35:22 -0700).
PROCESS_AFTER_TARGET=yes. LOG_EVIDENCE=157088 matching lines in the process stdout log.
Implementation base=f20b505d05d0c9f111270bb75145e67ca17dd8cb; local main,
fork/main and read-only `git ls-remote fork refs/heads/main` agree. The native
guard rejects `git fetch fork main` because its refresh allowlist recognizes only
origin/main; no guard bypass used. No deployment freshness claim follows from this.

## Separate error paths

Installed browser-service.mjs throws `Unable to load browser request-header policy`
when Statsig policy initialization/refresh is unsuccessful or not Ready. That is
not an app-consent denial. `cgWindowNotFound` and the long elapsed interval still
need separate causal evidence; do not infer either cause from the authorization bug.
The author's own session (9b116a26, CLI 01a0d11c) confirms getState ran from
2026-09-24T14:58:45.165Z to 14:59:14.323Z, then getApp(com.google.Chrome)
from 2026-09-24T14:59:19.556Z to 2026-09-27T11:52:52.384Z. The latter tool
reported 248012.7857 seconds and error -10005/cgWindowNotFound. Only timestamps,
call ids and error strings were extracted; no raw session or credentials are copied here.
Separately, a deterministic regression proves opted-in inactivity timeout failed
to invalidate pending interactions until interrupt grace ended. The fix closes
them at timeout onset; it does not invent a default timeout or explain the entire
68.9-hour incident without additional carrier evidence.

## Independent evidence and remaining boundary

- Successful attachment author evidence: current-thread message
  `0001790510419006-000263-64d6ae20`. Direct native Bash copy followed by a manual
  file rich block; replaying the command through the guard's pure classifier
  denies both provider formats. No repeat copy or guard bypass was performed.
- Upstream grant ownership: Terra's `0001790511114185-000267-c869f934` independently
  identified Desktop's native app-approval owner and its settings methods. This
  does not expose a supported grant read/reuse API to the headless carrier.
- Installed app-server protocol export explicitly supports request and response
  `_meta`. An isolated real-binary probe uses a fake MCP, no credentials, no model
  turn and no CUA: `bash packages/api/scripts/with-test-home.sh env -u CODEX_HOME
  node --import tsx packages/api/test/probes/computer-use-wire.mjs
  /Applications/ChatGPT.app/Contents/Resources/codex`. Our actual adapter round-trips
  session/always/decline/cancel through app-server back to that fake MCP.
- This proves wire compatibility, not persistent grant reuse. No Desktop approval
  file is read, no local grant cache exists, and no persisted-state marker is forged.
  Product activation of persistent choices remains blocked on a supported owner
  contract; transporting `always` alone is not a promise that it has been saved.
- Provider guard registration parity is a separate F306 security finding requiring
  owner disposition. The new publisher removes the need for direct runtime writes;
  it does not silently modify another provider's hook or runtime configuration.

## Verification evidence so far

- Initial consent tests failed on generic choice/metadata loss and closed-run
  publication; duplicate-id test failed with two publications. Corrected tests pass.
- Publisher initially returned 404; API and discoverable MCP tests now pass,
  including a real isolated HTTP upload/download byte and SHA256 round trip.
- Newly added suites: 15 tests pass (8 consent, 5 API publication, 2 MCP publication).
  Existing renderer DOM suite passes 7 tests, including both explicit scope choices
  and no submission before a click. No production browser was invoked.
- API/MCP full builds passed before the timeout regression, which produced the
  expected RED at `codex-app-server-transport.test.js:619`. Green recheck, full
  transport/buffer/registration recheck now passes 51 tests; the canonical runtime
  interaction suite also passes 51. API TypeScript build passes. Full integration
  gate, independent review and remote delivery remain required.

Publication now appends an idempotent, durable cat-authored file message before
returning its messageId, rather than relying on the 15-minute rich-block buffer.
The real MessageStore regression covers identical retries and a lost persistence
acknowledgement. The same stored message is rebroadcast on retry; no duplicate
message or file is created and no other cat is routed.

## Implementation and verification plan

1. RED: exercise a sanitized native consent request through adapter and canonical
   response validation; reject malformed metadata and unavailable choices.
2. Map scoped choices using existing elicitation decisions, preserving upstream
   ownership of grant storage. No local grant cache or historical-accept replay.
3. Exercise cancellation, foreign provider identity and timeout using existing
   runtime service/transport fixtures; correct demonstrated lifecycle gaps.
4. Add an authenticated byte-upload publisher using the existing file store,
   callback ownership, stale/deleted-thread checks and file rich blocks. Test with
   synthetic data only; corporate documents remain outside Git.
5. Independent security/contract review, full gate, merged isolated acceptance;
   production activation remains a separate explicit boundary. Only then deliver
   the real artifact and verify remote readback. Final-only report to source thread.
