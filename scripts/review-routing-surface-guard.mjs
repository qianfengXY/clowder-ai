function requireTokens(source, label, tokens) {
  return tokens.filter((token) => !source.includes(token)).map((token) => `${label} is missing ${token}.`);
}

export function checkReviewContinuityLanguage({ ironLaw, requestReview, mergeGate, inboundPr }) {
  const errors = [];
  if (/Review 必须跨个体/.test(ironLaw) && !/已选择 Review 时必须跨个体/.test(ironLaw)) {
    errors.push('iron law turns conditional review selection into a universal review obligation.');
  }
  if (/有 diff 的交付至少一个非作者/.test(requestReview)) {
    errors.push('request-review forces every diff to pay an independent-review tax.');
  }
  if (/(?:任何|每次).{0,16}(?:push|HEAD).{0,24}(?:失效|重审|re-review)/i.test(mergeGate)) {
    errors.push('merge-gate treats SHA movement as automatic review invalidation.');
  }
  if (/只要 HEAD 变化，就不能默认沿用旧 review/.test(inboundPr)) {
    errors.push('inbound PR guidance makes SHA movement the primary review boundary.');
  }
  return errors;
}

export function checkChatgptReviewRoundLanguage(source) {
  return requireTokens(source, 'chatgpt-review-rounds convention', [
    '`Review Round`',
    '实现提交 `exactSha`',
    '`方案分支`',
    '`方案提交 designExactSha`',
    '当前功能的 `设计文档` 清单',
    '方案讨论会话可以提供背景，但不是权威方案',
    'git:refs/heads/<方案分支>@<完整 designExactSha>',
    'git:refs/heads/<方案分支>@<完整 designExactSha>:<适用设计文档路径>',
    '中文权威文档',
    '英文翻译件',
    '最终可见回复使用中文',
    '用户旅程、前端产品体验、交互、验收标准',
    '`refs/chatgpt-review-user-journey.md`',
    'Barrier 前不得读取或推测其他 reviewer 意见',
    '`cat_cafe_review_draft_submit`',
    '`cat_cafe_review_independent_finish`',
    '`cat_cafe_review_cross_finish`',
    '`cat_cafe_review_consensus_publish`',
    '不得修改代码或 Git',
    '`scope=architecture_decision`',
    '保持 `consensus_ready`',
    '仅用于展示的短序号',
    '完整 ID，禁止把可见短序号当作 callback 标识',
    '每位 reviewer 的必需旅程均有 `exactSha` 真实交互通过证据',
    '才能设置 `checksPassed=true`',
    '每个系统消息只执行一次对应阶段',
  ]);
}

export function checkChatgptReviewUserJourneyLanguage(source) {
  return requireTokens(source, 'chatgpt-review-rounds user-journey gate', [
    '主路径',
    '首次启动/空状态',
    '正常状态',
    '失败状态',
    '从用户可见页面入口开始',
    '直接调用 API 只能作为补充诊断',
    '构建成功、单元测试、组件/快照渲染、菜单文字存在、阅读 JSX、直接调用 API',
    '每位 reviewer 独立执行自己的矩阵',
    '缺少真实用户旅程验收证据',
    'checksPassed=true',
    '零 Workspace / 首次启动',
  ]);
}

export function checkChatgptReviewRoundTemplate(source) {
  const errors = requireTokens(source, 'chatgpt-review-rounds visible template', [
    '| 序号 | 检视者 | 级别 | 结论 | 检视意见 | 证据 | 方案依据 | 处理要求 |',
    '| 旅程 | 验证者 | 起点与操作 | 预期与实际结果 | 证据 | 结果 |',
    '按当前表格行顺序填写 `1`、`2`、`3`',
    '完整 ID 只用于 callback',
    '短序号不得作为 callback 标识',
    '不得填写为真实交互通过证据',
    '共识不得设置 `checksPassed=true`',
  ]);
  if (/\|\s*`?<draftFindingId\s*\/\s*findingId/i.test(source)) {
    errors.push('chatgpt-review-rounds visible template exposes a full internal finding ID in the table.');
  }
  return errors;
}

export function checkReviewRoutingSurfaces({
  handoffSkill,
  requestReviewSkill,
  receiveReviewSkill,
  chatgptReviewRoundsSkill,
  chatgptReviewRoundsTemplate,
  chatgptReviewUserJourneyReference,
  mergeGateSkill,
  ironLaw,
  inboundPrReference,
  trackerToolSource,
  capabilityWakeupDomain,
  capabilityWakeupFixture,
}) {
  const errors = [
    ...requireTokens(handoffSkill, 'cross-cat-handoff convention', [
      'Review Completion Intent Classifier',
      'author/custody/handoff source',
      'cat_cafe_record_external_review_verdict',
      'pending_delivery',
      'delivery proof',
      'exact target evidence',
      'author cat route',
      'Review Entry Mode Classifier',
      'reviewMode=formal',
      'advisory_read_only',
      'no-comment',
      'task/tracker',
      'review-complete',
      'coordination.phase=active',
      'coordination.phase=terminal',
      'reviewReentry',
    ]),
    ...requireTokens(requestReviewSkill, 'request-review convention', [
      'author/custody/handoff source',
      'author cat route',
      'merge-gate、repository rule 或 operator',
      'Review Entry Mode Classifier',
      'advisory_read_only',
      'no-comment',
      'review-complete',
      'coordination.phase=active',
      'coordination.phase=terminal',
      'reviewReentry',
    ]),
    ...requireTokens(receiveReviewSkill, 'receive-review re-entry convention', [
      'request-review',
      'action.mode=single',
      'coordination.phase=active',
      'reviewReentry',
    ]),
    ...checkChatgptReviewRoundLanguage(chatgptReviewRoundsSkill),
    ...checkChatgptReviewRoundTemplate(chatgptReviewRoundsTemplate),
    ...checkChatgptReviewUserJourneyLanguage(chatgptReviewUserJourneyReference),
    ...requireTokens(mergeGateSkill, 'merge-gate review provenance convention', [
      'reviewReentry',
      'already-consumed exact-HEAD review',
      'no new information',
      '机械三方合并',
    ]),
    ...checkReviewContinuityLanguage({
      ironLaw,
      requestReview: requestReviewSkill,
      mergeGate: mergeGateSkill,
      inboundPr: inboundPrReference,
    }),
    ...requireTokens(trackerToolSource, 'register_pr_tracking description', [
      'Review Entry Mode Classifier',
      'advisory_read_only',
      'no-comment',
      'review-complete',
    ]),
    ...requireTokens(trackerToolSource, 'action successor tool description', [
      'reviewReentry',
      'behavioral_delta',
      'stale_or_blocking',
      'explicit_matrix_route',
    ]),
    ...requireTokens(capabilityWakeupDomain, 'capability-wakeup domain', [
      'external-pr-review-route-classifier',
      'docs/harness-feedback/fixtures/external-pr-review-route-classifier.md',
    ]),
    ...requireTokens(capabilityWakeupFixture, 'capability-wakeup fixture', [
      'exact-HEAD',
      'PR tracking',
      'advisory_read_only',
      'cross-cat-handoff',
    ]),
  ];
  if (requestReviewSkill.includes('标准做法是 reviewer 用 PR comment')) {
    errors.push('request-review still forces every local verdict onto GitHub.');
  }
  return errors;
}
