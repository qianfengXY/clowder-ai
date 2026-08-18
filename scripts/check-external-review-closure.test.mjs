import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import * as reviewGuard from './check-external-review-closure.mjs';

const { checkExternalReviewHandoffText, checkExternalReviewSourceBoundary } = reviewGuard;
const routingFixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../packages/api/test/harness-eval/fixtures/review-completion-routing.json'),
    'utf8',
  ),
);

describe('review completion dual-route hard guard', () => {
  it('locks the operator-approved ChatGPT multi-cat review round contract', () => {
    assert.equal(typeof reviewGuard.checkChatgptReviewRoundLanguage, 'function');
    if (typeof reviewGuard.checkChatgptReviewRoundLanguage !== 'function') return;

    const valid = reviewGuard.checkChatgptReviewRoundLanguage(`
      固定 \`Review Round\`、实现提交 \`exactSha\`、\`方案分支\`、\`方案提交 designExactSha\` 与当前功能的 \`设计文档\` 清单。
      方案讨论会话可以提供背景，但不是权威方案。
      每条 finding 引用 git:refs/heads/<方案分支>@<完整 designExactSha>。
      同时引用 git:refs/heads/<方案分支>@<完整 designExactSha>:<适用设计文档路径>。
      只读取系统消息选中的中文权威文档，英文翻译件不进入 Review。最终可见回复使用中文。
      从用户旅程、前端产品体验、交互、验收标准建立矩阵，并加载 \`refs/chatgpt-review-user-journey.md\`。
      独立检视时 Barrier 前不得读取或推测其他 reviewer 意见。
      调用 \`cat_cafe_review_draft_submit\`、\`cat_cafe_review_independent_finish\`、
      \`cat_cafe_review_cross_finish\` 和 \`cat_cafe_review_consensus_publish\`。
      全程不得修改代码或 Git；重大分歧使用 \`scope=architecture_decision\`。
      无法共识时保持 \`consensus_ready\`；每个系统消息只执行一次对应阶段。
      可见表格首列使用仅用于展示的短序号；完整 ID，禁止把可见短序号当作 callback 标识。
      每位 reviewer 的必需旅程均有 \`exactSha\` 真实交互通过证据，才能设置 \`checksPassed=true\`。
    `);
    assert.deepEqual(valid, []);

    const invalid = reviewGuard.checkChatgptReviewRoundLanguage(
      'Several cats review together and ChatGPT merges when it looks good.',
    );
    assert.match(invalid.join('\n'), /Review Round/);
    assert.match(invalid.join('\n'), /方案提交 designExactSha/);
    assert.match(invalid.join('\n'), /cat_cafe_review_consensus_publish/);
    assert.match(invalid.join('\n'), /consensus_ready/);
    assert.match(invalid.join('\n'), /中文权威文档/);
    assert.match(invalid.join('\n'), /短序号/);
  });

  it('keeps full finding IDs out of the visible Review table', () => {
    assert.equal(typeof reviewGuard.checkChatgptReviewRoundTemplate, 'function');
    if (typeof reviewGuard.checkChatgptReviewRoundTemplate !== 'function') return;

    const valid = reviewGuard.checkChatgptReviewRoundTemplate(`
      | 旅程 | 验证者 | 起点与操作 | 预期与实际结果 | 证据 | 结果 |
      | J1 | GPT | 空状态点击入口 | 页面打开 | 浏览器记录 | 通过 |
      | 序号 | 检视者 | 级别 | 结论 | 检视意见 | 证据 | 方案依据 | 处理要求 |
      | --- | --- | --- | --- | --- | --- | --- | --- |
      | 1 | GPT | P2 | 成立 | 示例 | 文件 | 方案 | 修复 |
      按当前表格行顺序填写 \`1\`、\`2\`、\`3\`。完整 ID 只用于 callback，短序号不得作为 callback 标识。
      静态检查不得填写为真实交互通过证据，共识不得设置 \`checksPassed=true\`。
    `);
    assert.deepEqual(valid, []);

    const invalid = reviewGuard.checkChatgptReviewRoundTemplate(`
      | 编号 | 检视者 | 级别 | 结论 | 检视意见 | 证据 | 方案依据 | 处理要求 |
      | \`<draftFindingId / findingId / 稳定编号>\` | GPT | P2 | 成立 | 示例 | 文件 | 方案 | 修复 |
    `);
    assert.match(invalid.join('\n'), /序号/);
    assert.match(invalid.join('\n'), /full internal finding ID/);
  });

  it('requires independent exact-SHA user-journey evidence for UI review', () => {
    assert.equal(typeof reviewGuard.checkChatgptReviewUserJourneyLanguage, 'function');
    if (typeof reviewGuard.checkChatgptReviewUserJourneyLanguage !== 'function') return;

    const valid = reviewGuard.checkChatgptReviewUserJourneyLanguage(`
      矩阵覆盖主路径、首次启动/空状态、正常状态和失败状态。
      从用户可见页面入口开始；直接调用 API 只能作为补充诊断。
      构建成功、单元测试、组件/快照渲染、菜单文字存在、阅读 JSX、直接调用 API 都不能单独证明通过。
      每位 reviewer 独立执行自己的矩阵；缺少真实用户旅程验收证据时保持阻断，不能设置 checksPassed=true。
      设置功能最低覆盖零 Workspace / 首次启动。
    `);
    assert.deepEqual(valid, []);

    const invalid = reviewGuard.checkChatgptReviewUserJourneyLanguage(
      'Build and unit tests passed, so the frontend user journey is approved.',
    );
    assert.match(invalid.join('\n'), /首次启动\/空状态/);
    assert.match(invalid.join('\n'), /用户可见页面入口/);
    assert.match(invalid.join('\n'), /checksPassed=true/);
  });

  it('rejects active guidance that turns every SHA change or every diff into mandatory re-review', () => {
    const errors = reviewGuard.checkReviewContinuityLanguage({
      ironLaw: 'Review 必须跨个体：自己的代码由别人 review。',
      requestReview: '有 diff 的交付至少一个非作者验证源覆盖 final HEAD。',
      mergeGate: '任何 push 都使旧证据失效，必须重审。',
      inboundPr: '只要 HEAD 变化，就不能默认沿用旧 review。',
    });

    assert.equal(errors.length, 4);
  });

  it('accepts content-bound review with mechanical continuity and optional review selection', () => {
    const errors = reviewGuard.checkReviewContinuityLanguage({
      ironLaw: '已选择 Review 时必须跨个体；低风险直推可不选择 review。',
      requestReview: '只有存在需要判断力的新内容才选择 reviewer。',
      mergeGate: 'HEAD 变化只触发 provenance 判定，不自动等于 re-review；机械三方合并可用 continuityProof。',
      inboundPr: '内容发生行为性变化才重审；SHA-only 变化先判 continuity。',
    });

    assert.deepEqual(errors, []);
  });

  it('rejects a naked external review conclusion that only says it was not delivered', () => {
    const result = checkExternalReviewHandoffText('External PR review: APPROVE. 未代发 GitHub。');
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /delivery proof|pending_delivery/);
  });

  it('accepts delivered proof or persistent pending delivery custody', () => {
    assert.equal(
      checkExternalReviewHandoffText(
        'External PR review: APPROVE. delivered proof: https://github.com/acme/widgets/pull/7#pullrequestreview-42',
      ).ok,
      true,
    );
    assert.equal(
      checkExternalReviewHandoffText(
        'External PR review: BLOCK. pending_delivery owner=reviewer reason=GitHub write rejected; callback recorded.',
      ).ok,
      true,
    );
  });

  it('does not let pending custody masquerade as completed external delivery', () => {
    const pendingClaimedComplete = checkExternalReviewHandoffText(
      'External PR review completed: BLOCK. pending_delivery owner=reviewer reason=GitHub write rejected; callback recorded.',
    );
    assert.equal(pendingClaimedComplete.ok, false);
    assert.match(pendingClaimedComplete.errors.join('\n'), /artifact URL/);

    const issueDelivered = checkExternalReviewHandoffText(
      'External issue review completed: BLOCK. https://github.com/acme/widgets/issues/9#issuecomment-77',
    );
    assert.equal(issueDelivered.ok, true, issueDelivered.errors.join('\n'));
  });

  it('requires a closed delivery union and rejects broad bot or maintainer suppression', () => {
    const good = checkExternalReviewSourceBoundary({
      outcomeSource:
        "kind: 'delivered'; githubUrl: string | kind: 'pending_delivery'; ownerCatId: string; reason: string",
      deliveryPolicySource: "if (exactSelfEcho(input)) return 'silent-log';",
      setupNoiseSource:
        "if (!bots.has(c.author)) return false; return setupSentence.test(c.body) && c.commentType === 'conversation';",
    });
    assert.equal(good.ok, true);

    const commentOnly = checkExternalReviewSourceBoundary({
      outcomeSource:
        "kind: 'delivered'; githubUrl: string | kind: 'pending_delivery'; ownerCatId: string; reason: string",
      deliveryPolicySource:
        "// OWNER/MEMBER used to return silent-log; association is now context only.\nreturn 'wake-owner';",
      setupNoiseSource:
        "if (!bots.has(c.author)) return false; return setupSentence.test(c.body) && c.commentType === 'conversation';",
    });
    assert.equal(commentOnly.ok, true, 'historical comments must not trip the executable-code guard');

    const bad = checkExternalReviewSourceBoundary({
      outcomeSource: "kind: 'delivered'",
      deliveryPolicySource:
        "if (author.endsWith('[bot]') || ['OWNER', 'MEMBER'].includes(association)) return 'silent-log';",
      setupNoiseSource: 'return true;',
    });
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join('\n'), /pending_delivery/);
    assert.match(bad.errors.join('\n'), /broad bot suppression/);
    assert.match(bad.errors.join('\n'), /OWNER\/MEMBER/);
  });

  it('replays the external/local paired fixture through one intent classifier', () => {
    assert.equal(typeof reviewGuard.evaluateReviewCompletionRoutingFixture, 'function');
    if (typeof reviewGuard.evaluateReviewCompletionRoutingFixture !== 'function') return;

    const report = reviewGuard.evaluateReviewCompletionRoutingFixture(routingFixture);
    assert.equal(report.verdict, 'pass', report.failures.join('\n'));
    assert.deepEqual(report.metrics, {
      scenarios: 10,
      intentMismatches: 0,
      entryMismatches: 0,
      completionMismatches: 0,
    });
  });

  it('does not let either completion proof compensate for the other route', () => {
    assert.equal(typeof reviewGuard.checkReviewCompletion, 'function');
    if (typeof reviewGuard.checkReviewCompletion !== 'function') return;

    const externalCounterfactual = routingFixture.pairs[0].counterfactual;
    const localCounterfactual = routingFixture.pairs[1].counterfactual;
    const externalResult = reviewGuard.checkReviewCompletion(externalCounterfactual.input);
    const localResult = reviewGuard.checkReviewCompletion(localCounterfactual.input);

    assert.equal(externalResult.ok, false);
    assert.match(externalResult.errors.join('\n'), /GitHub artifact URL/);
    assert.equal(localResult.ok, false);
    assert.match(localResult.errors.join('\n'), /author cat route/);
  });

  it('keeps an external author on the GitHub route when a local cat carried the handoff', () => {
    const externallyAuthored = structuredClone(routingFixture.pairs[0].positive.input);
    externallyAuthored.custody = 'local_cat_handoff';
    externallyAuthored.handoffSource = 'cross_thread';

    assert.equal(reviewGuard.classifyReviewCompletionIntent(externallyAuthored), 'external');
    const result = reviewGuard.checkReviewCompletion(externallyAuthored);
    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('binds an external issue verdict to the exact body and same issue comment', () => {
    const bodySha = '3333333333333333333333333333333333333333333333333333333333333333';
    const issueCompletion = {
      author: { kind: 'external', githubLogin: 'mindfn' },
      reviewer: { catId: 'codex-sol', githubLogin: 'zts212653' },
      custody: 'external_subject',
      handoffSource: 'github_connector',
      target: {
        kind: 'issue',
        repository: 'zts212653/clowder-ai',
        number: 1165,
        revision: { kind: 'body_sha', value: bodySha },
      },
      completion: {
        status: 'complete',
        route: {
          kind: 'github_artifact',
          url: 'https://github.com/zts212653/clowder-ai/issues/1165#issuecomment-5008567649',
        },
        evidenceRefs: [`body:${bodySha}`],
      },
    };
    assert.equal(reviewGuard.checkReviewCompletion(issueCompletion).ok, true);

    const wrongIssue = {
      ...issueCompletion,
      completion: {
        ...issueCompletion.completion,
        route: {
          kind: 'github_artifact',
          url: 'https://github.com/zts212653/clowder-ai/issues/1166#issuecomment-5008567649',
        },
      },
    };
    const rejected = reviewGuard.checkReviewCompletion(wrongIssue);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /GitHub artifact URL/);
  });

  it('treats catId, not a shared GitHub login, as local review independence', () => {
    assert.equal(typeof reviewGuard.checkReviewCompletion, 'function');
    if (typeof reviewGuard.checkReviewCompletion !== 'function') return;

    const localPositive = routingFixture.pairs[1].positive.input;
    const independent = reviewGuard.checkReviewCompletion(localPositive);
    assert.equal(independent.ok, true, independent.errors.join('\n'));

    const selfReview = {
      ...localPositive,
      reviewer: { ...localPositive.reviewer, catId: localPositive.author.catId },
    };
    const rejected = reviewGuard.checkReviewCompletion(selfReview);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join('\n'), /distinct catIds/);
  });
});
