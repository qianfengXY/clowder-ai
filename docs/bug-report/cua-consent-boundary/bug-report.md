# Computer Use consent provenance and lifecycle candidate

Status: isolated candidate, not approved, merged, deployed or functionally accepted.
Owner: 砚砚; thread `thread_mujrlphvcvzgvzsx`, task `0001790510419015-000258-d3f5900d`.
Base: `f20b505d05d0c9f111270bb75145e67ca17dd8cb`.
Accepted source: `thread_muevjiaa8wh9f98a#0001790510144932-000252-cb06b780`.

## User intent and release separation

用户要的是 Computer Use 能用，并复用此前同范围授权。这个候选补丁没有实现该终态。
它从附件发布补丁中拆出：交付 PPT 不需要一并部署这项能力降级。
附件分支 `fix/agent-delivery-consent` 不包含这里的 adapter/transport 改动。

## Exact behavior and consequence

以下任一条件会拒绝整个 MCP elicitation（form 或 URL），不创建可接受的表单：

- `serverName === 'cua_repl'`；
- `_meta.codex_approval_kind` 字段存在，不论其值；
- `_meta.persist` 字段存在，不论其值；
- `_meta.connector_id === 'computer-use'`。

Adapter 返回 JSON-RPC `-32602`，reasonCode 为 `unverified_connector_source`。
已安装 app-server 的真实双服务探针把此错误转换成 MCP `action: decline`；
这不是用户点击拒绝。未带上述标记的普通 MCP form 仍沿原通路处理。

**若部署此候选，Codex 猫的 Computer Use，以及其他带上述审批标记的 MCP 请求，
都会直接被拒绝，不再弹卡。** 基线则显示“<server> 需要补充信息”，用户可每次接受。
因此不能把“没有再问”宣称为“已经复用授权”。这项可用性与安全取舍必须在生产启用前
明确呈现给 operator，不能随附件发布隐含接受。

恢复到原有可用性可以回滚本候选 commit（会同时撤回其中的生命周期修复）；
正确开放原生授权则需要两个尚未具备的契约：可验证的 invocation connector 来源绑定，
以及上游 grant owner 的持久授权读/复用协议。不能用名字 allowlist、本地 grant cache、
工作区自报 plugin 字段或聊天中的授权代替这两者。

## Evidence and root causes

- 旧调查 `thread_mu2dqozm1zf04ygu` 的纠正
  `0001789459797384-000353-40482e7a` 只证明 generic accept，未证明用户看见或选择 session/always。
- Installed CUA policy sends approval kind, connector id and persistence choices;
  the current generic adapter drops that classification/options/response metadata.
  Desktop owns native app approvals; no supported headless read/reuse API is proven.
  No grant file was read or modified. A successful `_meta` round trip cannot prove reuse.
- Terra's retraction `0001790518209591-000291-89bc06ad` supersedes the earlier
  connection-name conclusion. Workspace `.cat-cafe/capabilities.json` can register
  arbitrary external capabilities as `cua_repl`, including duplicate same IDs.
  `CodexAgentService` prefers this file; the launch descriptor carries no verified
  native vendor identity. An app-server-injected name proves only connection naming.
- RED on the earlier implementation: that workspace capability produced an
  actionable Computer Use approval card. The special approval branch and its
  unused call tracker were withdrawn. Current tests reject same-name/duplicate/
  forged-plugin requests without falling back to an approvable generic form.
- A deterministic RED proved opted-in inactivity timeout left requests live until
  interrupt grace ended. This candidate invalidates them at timeout onset and
  rejects duplicate IDs/closed runs. It does not change the default timeout of zero.
- `Unable to load browser request-header policy` originates in policy loading;
  `cgWindowNotFound` and a 68.9-hour tool interval still lack a proven shared cause.
  Neither error proves missing user authorization. No live CUA call was made here.

## Verification and remaining work

The identical code previously passed 8 source/lifecycle tests, 37 transport tests,
the canonical runtime-interaction suite, TypeScript build and an isolated real
app-server probe at `2efdc23906ac2d1b80c7220be16b7e3e8e9ef77d`.
This is continuity evidence, not a full gate for this new branch.

Probe (synthetic MCP connections, no model turn or CUA/grant access):

```sh
bash packages/api/scripts/with-test-home.sh env -u CODEX_HOME node --import tsx \
  packages/api/test/probes/computer-use-wire.mjs \
  /Applications/ChatGPT.app/Contents/Resources/codex
```

Before any activation: settle the supported upstream owner contract, review the
exact source boundary, pass final-tree tests/full gate and independent security
review, and validate merged code in isolated acceptance. No runtime config,
vendor code, permission cache or production upload was changed.
