# Agent document attachment publication

Status: attachment-only candidate under review; not merged, deployed or delivered.
Owner: 砚砚; thread `thread_mujrlphvcvzgvzsx`, task `0001790510418940-000257-261da656`.
Base: `f20b505d05d0c9f111270bb75145e67ca17dd8cb`.
Accepted source: `thread_muevjiaa8wh9f98a#0001790510144932-000252-cb06b780`.

## Diagnosis

| Field | Evidence / decision |
| --- | --- |
| Symptom | An approved local PPTX could not be delivered as a remotely downloadable attachment. |
| Evidence | Author testimony `0001790510419006-000263-64d6ae20`: Claude Bash copied bytes directly into runtime uploads, then attached a manually constructed URL. Codex's native effect guard rejected that kind of write. |
| Root cause | No agent publisher for existing documents; a file card only attaches a URL. Several rules/skills directed cats to write the protected runtime directory. Claude lacked the guard registration applied to Codex. |
| Fix | Authenticated current-invocation byte publisher, API-managed storage, durable cat-authored attachment before ACK, and consistent callable-tool instructions. |
| Acceptance | Approved PPT unchanged; formal attachment readback matches its recorded SHA256. Local HTTP 200, rich-block ACK or queued preview cannot establish remote-user access. |
| Boundaries | No runtime/config/vendor writes, forged grants, operator impersonation, other-cat private-session access, corporate files in Git, or third-party cloud upload. |

The publisher removes the need for direct runtime writes for its supported document
types only: PDF, DOC/DOCX, PPT/PPTX, XLS/XLSX, TXT, MD and CSV, up to 50 MiB.
It does not implement image/video publishing or repair provider guard parity.

## Publication contract and retention

`cat_cafe_publish_file({ sourcePath, expectedSha256? })` reads a local regular file
without following symlinks and sends bytes with current invocation credentials.
The API accepts no source path, alternate actor or target thread. It verifies the
filename/MIME pair, bounded canonical base64 and SHA256, checks current invocation
and live thread, saves through the existing store, then verifies stored bytes.

The API appends an idempotent, durable cat-authored file message before ACK.
The key binds invocation, filename, MIME and bytes. A lost-ACK retry returns and
rebroadcasts the same message; deleted-message tombstones prevent resurrection.
The receipt proves server persistence, not remote-user receipt or download.
Required remote acceptance uses the agreed download entry; if inaccessible,
record it as unverified rather than impersonating the user.

**Retention:** saved bytes follow the existing upload store's no-TTL policy. A thread
deletion, invocation expiry or persistence failure after saving can leave an
unreferenced upload, including confidential bytes. Do not unlink on rejection:
an identical concurrent retry may already reference that deterministic path.
Cleanup requires operator-authorized, reference-aware storage maintenance.
This patch adds no automatic expiry or garbage collector. Before-save rejection
writes nothing; post-save rejection does not roll back bytes or prove delivery.
Soft or hard deletion of an attachment message also retains the stored upload;
the original URL remains downloadable. Removing a message neither revokes access
to its file URL nor destroys the file bytes.

## Instruction sweep and owned gaps

Server rules and rich-messaging, rich-blocks, video-forge, anime-forge and
image-generation now direct supported documents to the publisher, prohibit runtime
copying and provider switching to bypass protection. API-internal
`publishGeneratedImage()` is not an MCP/callback tool. Automatic publishing covers
Codex `image_gen` and Antigravity native generated images only. Local screenshots,
PPT preview PNGs and browser downloads lack a general path-based image publisher.
Track that implementation in owned task `0001790524992646-000311-ae93f8fa` (砚砚):
MCP reads file bytes, the authenticated API manages image storage and a durable
gallery message, and synthetic preview-size fixtures verify the actual carrier.
Task creation is not implementation or acceptance. Local video also lacks a publisher.

Only tiny icons/diagrams are suitable candidates for inline data URIs. The existing
tool takes a complete JSON string; it does not read a local path. Ordinary model-filled
calls must reproduce the entire base64 string (about 4/3 of source size) within
context/output/cost limits without transcription errors. A host with programmatic
composition is a separate carrier capability, not a guarantee for all cats. The
1 MiB HTTP body limit proves server admission only, not practical delivery capacity.
Data URIs do not write uploads; rich-block ACK only means buffered, and persistence
requires the host message to be appended. Already published media URLs remain usable.

### Delivery contract audit after repeated review corrections

Invariant: a server-admitted payload is not proof of a usable producer, durable
message, or remote-user receipt. The earlier image guidance stopped at admission;
the following edges now govern all document/image/video instructions in this diff.

| Transition | Required evidence / boundary |
| --- | --- |
| Local bytes → tool payload | Document MCP reads the path itself; inline media requires complete parameter bytes within the actual carrier's limits. No assumed image path reader. |
| Payload → server admission | Invocation authentication, supported format and body bound; admission alone says nothing about message persistence. |
| Admission → durable message | Document publisher appends before ACK; ordinary rich blocks first enter a transient buffer, then attach at host-message append. |
| Durable message → remote access | Agreed client/download entry readback; never substitute localhost 200 or server ACK. |
| Message deletion → later retry | Tombstone prevents resurrection; stored upload bytes and original URL remain until authorized storage maintenance. |

Claude guard parity is tracked by persistent task `0001790522982588-000302-63c160ac`,
owner 砚砚. F306's feature owner remains codex-sol; exact F306 thread discovery on
2026-09-27 returned none, so dispatch is explicitly `not_dispatched`.
The task requires actual registration evidence and isolated provider parity tests.
This publisher does not close the gap.

## Computer Use is a separate release decision

Review `0001790522455016-000300-769222df` identified a capability downgrade in the
combined candidate. This attachment branch removes all consent adapter/transport
changes relative to base. CUA remains at baseline; repeated authorization and
persistent reuse remain unresolved.

Separate branch `fix/cua-consent-boundary`, owned by task
`0001790510419015-000258-d3f5900d`, preserves that candidate and its evidence.
It rejects on any of: `serverName === 'cua_repl'`, a present
`_meta.codex_approval_kind`, a present `_meta.persist`, or
`_meta.connector_id === 'computer-use'`. If deployed it would directly reject CUA
and other MCP elicitations with those markers, without a card; baseline instead
shows a generic information form users can accept each time.
This is capability loss, not grant reuse. PPT delivery does not require it.
Recovery from that candidate is a revert, or verified connector binding plus a
supported upstream grant-owner contract before enabling native choices.
No local grant cache or workspace self-asserted trust is acceptable.

## Verification and remaining acceptance

- Publisher RED was endpoint 404. API/MCP tests cover authentication, byte/MIME/hash
  validation, scope, durable idempotence, lost ACK and tombstones. Real isolated
  HTTP MCP → API → download verifies synthetic bytes/SHA256, not real-user access.
- Current-skills Markdown regression first failed with 10 unsafe/manual-helper
  instructions, then passed after the sweep.
- Deletion regression exposed a Memory/Redis mismatch: Memory hard delete removed
  the idempotency index, so retry recreated the attachment (200 instead of 409).
  Memory now retains the content-free claim like Redis. Soft/hard deletion retries
  must return 409, retain one tombstone and never rebroadcast a new attachment.
- Earlier combined gates found an obsolete rules assertion and Collective fixture
  owner mismatch; corrected without changing production ownership checks.
  A later unchanged process-liveness test timed out on its child marker and passed
  alone. Timing cause remains unproven; no full green is claimed.
- Ongoing gate at combined HEAD `2efdc239` cannot validate the split's final tree.
  Still required: final-tree tests/full gate, independent semantic and security/
  contract review, merged isolated acceptance, governed activation.
- Approved PPT remains unchanged in the user's delivery directory, outside Git.
  Formal file-card publication and remote readback are outstanding.
  Publish from the current repair-thread invocation into `thread_mujrlphvcvzgvzsx`;
  after acceptance, the one final source-thread report references that durable
  attachment message and its verified download URL. No cross-thread publisher
  override or intermediate source-thread wake is required.
  Source business thread receives one final report after the full task is complete.
