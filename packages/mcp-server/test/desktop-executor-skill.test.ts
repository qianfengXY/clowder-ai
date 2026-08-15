import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const skill = readFileSync(`${repoRoot}cat-cafe-skills/catcafe-desktop-executor/SKILL.md`, 'utf8');
const manifest = readFileSync(`${repoRoot}cat-cafe-skills/manifest.yaml`, 'utf8');

describe('F289 Desktop executor skill contract', () => {
  test('discovers canonical project/work state and never invents identity', () => {
    assert.match(skill, /cat_cafe_development_project_read/);
    assert.match(skill, /managedWorkDiscovery\.works/);
    assert.match(skill, /lifecycle=active/);
    assert.match(skill, /fallback ledger/);
  });

  test('fences replaced chats and limits recovery to committed state', () => {
    assert.match(skill, /expectedBindingEpoch=0/);
    assert.match(skill, /binding epoch/);
    assert.match(skill, /lastCommittedSha/);
    assert.match(skill, /last committed SHA/);
  });

  test('starts one canonical next attempt before fixing a changes-requested round', () => {
    assert.match(skill, /phase=fix_required/);
    assert.match(skill, /start_fix_attempt/);
    assert.match(skill, /cat_cafe_development_work_connect/);
    assert.match(skill, /attemptNumber.*递增/s);
    assert.match(skill, /未取得新 attempt 前不得报告修复 SHA/);
  });

  test('keeps merge confirmation and final acceptance at their intended user gates', () => {
    assert.match(skill, /cat_cafe_development_merge_confirmation_record/);
    assert.match(skill, /acceptance_pending/);
    assert.match(skill, /auto-merge/);
    assert.match(skill, /前两次成功试点完成后.*自动把项目策略切换为自动合入/s);
  });

  test('stops at the bounded Review and architecture decision gates', () => {
    assert.match(skill, /phase=awaiting_review_continuation/);
    assert.match(skill, /下一组最多 15 次 Review/);
    assert.match(skill, /phase=awaiting_architecture_decision/);
    assert.match(skill, /Desktop 不代批/);
    assert.match(skill, /scope=plan_conformance/);
    assert.match(skill, /designRefs/);
    assert.match(skill, /禁止把 Review 中新增的个人偏好、方案外重构或需求扩张带入实现/);
  });

  test('does not promise unsupported background polling or project-specific publication', () => {
    assert.match(skill, /Scheduled Task/);
    assert.match(skill, /GitHub Issue/);
    assert.doesNotMatch(skill, /GITHUB_TOKEN|github_issues_bilingual|TraqenGitHubIssuePublisher/);
  });

  test('keeps Review providers separate and ends the Desktop turn instead of polling', () => {
    assert.match(skill, /Cat Café 自己的 provider\/app-server/);
    assert.match(skill, /不得调用 `cat_cafe_development_review_wait`/);
    assert.match(skill, /当前 Desktop turn 必须结束/);
    assert.match(skill, /不得短轮询/);
    assert.match(skill, /非 active goal/);
    assert.match(skill, /持久化 outbox/);
    assert.match(skill, /同一个幂等\s*message id/);
    assert.match(skill, /ChatGPT Desktop 本地 IPC/);
    assert.match(skill, /thread-follower-start-turn/);
    assert.match(skill, /`update_goal` 将当前 Goal 标为 `complete`/);
    assert.match(skill, /不得让 Goal 自动续跑/);
    assert.match(skill, /真正的 `turn\/start` 由 owner 窗口自己的 app-server 执行/);
    assert.match(skill, /不得用 daemon 抢写该 thread/);
    assert.match(skill, /第二个\s+app-server/);
    assert.match(skill, /不得创建替代窗口/);
  });

  test('is registered in the canonical manifest', () => {
    assert.match(manifest, /^ {2}catcafe-desktop-executor:/m);
    assert.match(manifest, /Recoverable Desktop binding \+ exact commit SHA/);
  });
});
