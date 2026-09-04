// @ts-check

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const H = { 'x-cat-cafe-user': 'user1' };

describe('External Project Routes', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  /** @type {import('../dist/domains/cats/services/stores/ports/BacklogStore.js').BacklogStore} */
  let backlogStore;
  /** @type {import('../dist/domains/cats/services/stores/ports/ThreadStore.js').ThreadStore} */
  let threadStore;
  const workflowSops = new Map();
  let workflowSopDeleteError;

  beforeEach(async () => {
    const { ExternalProjectStore } = await import('../dist/domains/projects/external-project-store.js');
    const { IntentCardStore } = await import('../dist/domains/projects/intent-card-store.js');
    const { NeedAuditFrameStore } = await import('../dist/domains/projects/need-audit-frame-store.js');
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { externalProjectRoutes } = await import('../dist/routes/external-projects.js');
    const { intentCardRoutes } = await import('../dist/routes/intent-card-routes.js');

    const externalProjectStore = new ExternalProjectStore();
    backlogStore = new BacklogStore();
    threadStore = new ThreadStore();
    workflowSops.clear();
    workflowSopDeleteError = null;
    app = Fastify();
    await app.register(externalProjectRoutes, {
      externalProjectStore,
      needAuditFrameStore: new NeedAuditFrameStore(),
      backlogStore,
      threadStore,
      workflowSopStore: {
        async get(backlogItemId) {
          return workflowSops.get(backlogItemId) ?? null;
        },
        async upsert(backlogItemId, featureId, input, updatedBy) {
          const restored = { backlogItemId, featureId, ...input, updatedBy };
          workflowSops.set(backlogItemId, restored);
          return restored;
        },
        async restoreSnapshot(snapshot) {
          if (workflowSops.has(snapshot.backlogItemId)) return false;
          workflowSops.set(snapshot.backlogItemId, structuredClone(snapshot));
          return true;
        },
        async delete(backlogItemId) {
          if (workflowSopDeleteError) throw workflowSopDeleteError;
          return workflowSops.delete(backlogItemId);
        },
      },
    });
    await app.register(intentCardRoutes, {
      externalProjectStore,
      intentCardStore: new IntentCardStore(),
    });
  });

  // --- External Project CRUD ---

  test('POST /api/external-projects creates project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: {
        name: 'studio-flow',
        description: 'Freelance project',
        sourcePath: '/tmp/studio-flow',
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.project.id.startsWith('ep-'));
    assert.equal(body.project.name, 'studio-flow');
    assert.equal(body.project.backlogPath, 'docs/ROADMAP.md');
  });

  test('POST /api/external-projects can bind the GitHub repository in the same project action', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: {
        name: 'desktop-loop',
        sourcePath: '/tmp/desktop-loop',
        desktopDevelopment: {
          repository: 'https://github.com/qianfengXY/clowder-ai.git',
          defaultBranch: 'main',
          defaultReviewers: ['cat-idwxwjba', 'cat-kimi'],
        },
      },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().project.desktopDevelopment.repository.fullName, 'qianfengXY/clowder-ai');
    assert.equal(res.json().project.desktopDevelopment.mergeMode, 'manual_confirm_in_chatgpt');
  });

  test('PATCH development-loop enforces ownership and optimistic policy version', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: {
        name: 'desktop-loop',
        sourcePath: '/tmp/desktop-loop',
        desktopDevelopment: {
          repository: 'owner/repo',
          defaultBranch: 'main',
          defaultReviewers: ['cat-a', 'cat-b'],
        },
      },
    });
    const projectId = createRes.json().project.id;

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/external-projects/${projectId}/development-loop`,
      headers: H,
      payload: {
        expectedVersion: 1,
        allowPush: true,
        defaultReviewers: ['cat-a', 'cat-b'],
        defaultReviewRecorder: 'cat-b',
      },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().project.desktopDevelopment.allowPush, true);
    assert.equal(updated.json().project.desktopDevelopment.defaultReviewRecorder, 'cat-b');
    assert.equal(updated.json().project.desktopDevelopment.version, 2);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/external-projects/${projectId}/development-loop`,
      headers: H,
      payload: { expectedVersion: 1, allowPush: false },
    });
    assert.equal(stale.statusCode, 409);

    const otherUser = await app.inject({
      method: 'PATCH',
      url: `/api/external-projects/${projectId}/development-loop`,
      headers: { 'x-cat-cafe-user': 'user2' },
      payload: { expectedVersion: 2, allowPush: false },
    });
    assert.equal(otherUser.statusCode, 404);
  });

  test('POST /api/external-projects rejects missing sourcePath', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'test' },
    });
    assert.equal(res.statusCode, 400);
  });

  test('GET /api/external-projects lists projects', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'a', description: '', sourcePath: '/a' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/external-projects',
      headers: H,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().projects.length, 1);
  });

  test('GET /api/external-projects/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/external-projects/nonexistent',
      headers: H,
    });
    assert.equal(res.statusCode, 404);
  });

  test('DELETE /api/external-projects/:id removes project', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'del', description: '', sourcePath: '/del' },
    });
    const id = createRes.json().project.id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${id}`,
      headers: H,
    });
    assert.equal(delRes.statusCode, 204);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${id}`,
      headers: H,
    });
    assert.equal(getRes.statusCode, 404);
  });

  test('POST project backlog item injects the owned project scope', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: '/tmp/traqen' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/backlog/items`,
      headers: H,
      payload: {
        title: '[F008] Project task',
        summary: 'Must belong to Traqen',
        priority: 'p1',
        tags: ['feature:f008'],
        projectId: 'attacker-controlled',
        userId: 'other-user',
      },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.json().projectId, projectId);
    assert.equal(res.json().userId, 'user1');
    const stored = await backlogStore.listByUser('user1');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].projectId, projectId);
  });

  test('POST project backlog item rejects invalid input', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: '/tmp/traqen' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/backlog/items`,
      headers: H,
      payload: { title: '', summary: '', priority: 'urgent' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal((await backlogStore.listByUser('user1')).length, 0);
  });

  test('POST project backlog item rejects unknown and cross-user projects', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Private', description: '', sourcePath: '/tmp/private' },
    });
    const projectId = createRes.json().project.id;
    const payload = { title: 'Task', summary: 'Private', priority: 'p2', tags: [] };

    const missing = await app.inject({
      method: 'POST',
      url: '/api/external-projects/missing/backlog/items',
      headers: H,
      payload,
    });
    assert.equal(missing.statusCode, 404);

    const crossUser = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/backlog/items`,
      headers: { 'x-cat-cafe-user': 'other' },
      payload,
    });
    assert.equal(crossUser.statusCode, 404);
    assert.equal((await backlogStore.listByUser('user1')).length, 0);
  });

  // --- Intent Card routes ---

  test('POST intent-cards creates card', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: {
        actor: 'Admin',
        goal: 'Approve orders',
        originalText: 'Admin approves orders',
        sourceTag: 'Q',
      },
    });
    assert.equal(res.statusCode, 201);
    assert.ok(res.json().card.id.startsWith('ic-'));
    assert.equal(res.json().card.sourceTag, 'Q');
  });

  test('GET intent-cards lists by project', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cards.length, 1);
  });

  test('POST triage sets bucket and A-tag hard gate', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: { actor: 'Admin', goal: 'Do X', originalText: 'X', sourceTag: 'A' },
    });
    const cardId = cardRes.json().card.id;

    const triageRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards/${cardId}/triage`,
      headers: H,
      payload: { clarity: 3, groundedness: 3, necessity: 3, coupling: 1, sizeBand: 'S' },
    });
    assert.equal(triageRes.statusCode, 200);
    assert.notEqual(triageRes.json().card.triage.bucket, 'build_now');
    assert.equal(triageRes.json().card.triage.bucket, 'validate_first');
  });

  test('DELETE intent-card returns 204', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });
    const cardId = cardRes.json().card.id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${projectId}/intent-cards/${cardId}`,
      headers: H,
    });
    assert.equal(delRes.statusCode, 204);
  });

  // --- Audit Frame routes ---

  test('POST frame creates/updates frame', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
      payload: {
        sponsor: 'CEO',
        motivation: 'Digitize',
        successMetric: 'Review < 2h',
        constraints: '3 months',
        currentWorkflow: 'Excel',
        provenanceMap: 'CEO interview',
      },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().frame.id.startsWith('frame-'));
    assert.equal(res.json().frame.sponsor, 'CEO');
  });

  test('GET frame returns 404 when not set', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
    });
    assert.equal(res.statusCode, 404);
  });

  test('POST frame rejects empty sponsor', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
      payload: { sponsor: '', successMetric: 'X' },
    });
    assert.equal(res.statusCode, 400);
  });

  // --- Ownership isolation ---

  test('GET /api/external-projects/:id rejects cross-user access', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { name: 'private', description: '', sourcePath: '/x' },
    });
    const id = createRes.json().project.id;

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${id}`,
      headers: { 'x-cat-cafe-user': 'other' },
    });
    assert.equal(getRes.statusCode, 404);
  });

  test('DELETE /api/external-projects/:id rejects cross-user delete', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { name: 'private', description: '', sourcePath: '/x' },
    });
    const id = createRes.json().project.id;

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${id}`,
      headers: { 'x-cat-cafe-user': 'other' },
    });
    assert.equal(delRes.statusCode, 404);
  });

  // --- Intent card projectId isolation ---

  test('GET intent-card rejects cross-project access', async () => {
    const p1 = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'a', description: '', sourcePath: '/a' },
    });
    const p2 = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'b', description: '', sourcePath: '/b' },
    });
    const pid1 = p1.json().project.id;
    const pid2 = p2.json().project.id;

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${pid1}/intent-cards`,
      headers: H,
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });
    const cardId = cardRes.json().card.id;

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${pid2}/intent-cards/${cardId}`,
      headers: H,
    });
    assert.equal(getRes.statusCode, 404);
  });

  test('PATCH intent-card rejects cross-project mutation', async () => {
    const p1 = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'a', description: '', sourcePath: '/a' },
    });
    const p2 = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'b', description: '', sourcePath: '/b' },
    });

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${p1.json().project.id}/intent-cards`,
      headers: H,
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });
    const cardId = cardRes.json().card.id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/external-projects/${p2.json().project.id}/intent-cards/${cardId}`,
      headers: H,
      payload: { actor: 'HACKED' },
    });
    assert.equal(patchRes.statusCode, 404);
  });

  // --- Path traversal prevention ---

  test('POST /api/external-projects rejects backlogPath with traversal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: {
        name: 'evil',
        description: '',
        sourcePath: '/tmp/project',
        backlogPath: '../../etc/passwd',
      },
    });
    assert.equal(res.statusCode, 400);
  });

  // --- Cross-user access on sub-routes ---

  test('POST intent-cards rejects cross-user create', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: { 'x-cat-cafe-user': 'other' },
      payload: { actor: 'A', goal: 'G', originalText: 'T' },
    });
    assert.equal(res.statusCode, 404);
  });

  test('POST frame rejects cross-user write', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = createRes.json().project.id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/frame`,
      headers: { 'x-cat-cafe-user': 'other' },
      payload: { sponsor: 'X', successMetric: 'Y' },
    });
    assert.equal(res.statusCode, 404);
  });

  // --- Missing identity returns 401 ---

  test('POST /api/external-projects without identity returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    assert.equal(res.statusCode, 401);
  });

  test('GET /api/external-projects without identity returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/external-projects',
    });
    assert.equal(res.statusCode, 401);
  });

  // --- E2E Integration: full Need Audit flow ---

  test('e2e: create project → frame → cards → triage → filter by bucket', async () => {
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'studio-flow', description: 'Client project', sourcePath: '/tmp/sf' },
    });
    assert.equal(projRes.statusCode, 201);
    const projectId = projRes.json().project.id;

    const frameRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
      payload: {
        sponsor: 'CEO',
        motivation: 'Digitize workflow',
        successMetric: 'Review time < 2h',
        constraints: '3 months',
        currentWorkflow: 'Excel sheets',
        provenanceMap: 'CEO interview 2026-03-07',
      },
    });
    assert.equal(frameRes.statusCode, 200);
    assert.equal(frameRes.json().frame.sponsor, 'CEO');

    const qCard = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: {
        actor: 'Admin',
        contextTrigger: 'New order arrives',
        goal: 'Approve within SLA',
        objectState: 'Order approved',
        successSignal: 'Approval < 2h',
        nonGoal: 'Auto-approve',
        originalText: 'Admin needs to approve orders quickly',
        sourceTag: 'Q',
        confidence: 3,
      },
    });
    assert.equal(qCard.statusCode, 201);

    const aCard = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: {
        actor: 'System',
        goal: 'Optimize performance',
        originalText: 'The system should be optimized',
        sourceTag: 'A',
        riskSignals: ['hollow_verbs', 'missing_success_signal'],
      },
    });
    assert.equal(aCard.statusCode, 201);

    const dCard = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: {
        actor: 'Manager',
        goal: 'View team stats',
        originalText: 'Manager dashboard per PRD section 4',
        sourceTag: 'D',
        sourceDetail: 'PRD-V1 section 4.2',
        confidence: 2,
      },
    });
    assert.equal(dCard.statusCode, 201);

    const triageQ = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards/${qCard.json().card.id}/triage`,
      headers: H,
      payload: { clarity: 3, groundedness: 3, necessity: 3, coupling: 1, sizeBand: 'S' },
    });
    assert.equal(triageQ.json().card.triage.bucket, 'build_now');

    const triageA = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards/${aCard.json().card.id}/triage`,
      headers: H,
      payload: { clarity: 3, groundedness: 3, necessity: 3, coupling: 1, sizeBand: 'S' },
    });
    assert.equal(triageA.json().card.triage.bucket, 'validate_first');

    const triageD = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards/${dCard.json().card.id}/triage`,
      headers: H,
      payload: { clarity: 1, groundedness: 2, necessity: 3, coupling: 2, sizeBand: 'M' },
    });
    assert.equal(triageD.json().card.triage.bucket, 'clarify_first');

    const buildNow = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards?bucket=build_now`,
      headers: H,
    });
    assert.equal(buildNow.json().cards.length, 1);
    assert.equal(buildNow.json().cards[0].sourceTag, 'Q');

    const validateFirst = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards?bucket=validate_first`,
      headers: H,
    });
    assert.equal(validateFirst.json().cards.length, 1);
    assert.equal(validateFirst.json().cards[0].sourceTag, 'A');

    const allCards = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
    });
    assert.equal(allCards.json().cards.length, 3);
    assert.ok(allCards.json().cards.every((/** @type {{ triage: unknown }} */ c) => c.triage !== null));

    const getFrame = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/frame`,
      headers: H,
    });
    assert.equal(getFrame.statusCode, 200);
    assert.equal(getFrame.json().frame.sponsor, 'CEO');
  });

  test('GET intent-cards with bucket filter returns empty for unmatched bucket', async () => {
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = projRes.json().project.id;

    const res = await app.inject({
      method: 'GET',
      url: `/api/external-projects/${projectId}/intent-cards?bucket=build_now`,
      headers: H,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cards.length, 0);
  });

  test('PATCH intent-card updates fields', async () => {
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'p', description: '', sourcePath: '/p' },
    });
    const projectId = projRes.json().project.id;

    const cardRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/intent-cards`,
      headers: H,
      payload: { actor: 'Old', goal: 'G', originalText: 'T' },
    });
    const cardId = cardRes.json().card.id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/external-projects/${projectId}/intent-cards/${cardId}`,
      headers: H,
      payload: { actor: 'New Actor', goal: 'New Goal' },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().card.actor, 'New Actor');
    assert.equal(patchRes.json().card.goal, 'New Goal');
    assert.equal(patchRes.json().card.originalText, 'T');
  });

  test('import-backlog refreshes a bound importer item without backfilling its orphan', async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'import-test-'));
    const docsDir = join(tmpDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    const backlogPath = join(docsDir, 'ROADMAP.md');
    await writeFile(
      backlogPath,
      [
        '| ID | 名称 | Status | Owner | Link |',
        '|---|---|---|---|---|',
        '| F001 | Test Feature | in-progress | 布偶猫 | [F001](features/F001.md) |',
      ].join('\n'),
    );

    // 1. Create project
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'import-test', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projRes.json().project.id;

    // 2. Create an orphan item (no projectId) and a bound item for F001
    const orphan = await backlogStore.create({
      userId: 'user1',
      title: '[F001] Orphan',
      summary: 's',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f001'],
      createdBy: 'user',
    });
    assert.equal(orphan.projectId, undefined);

    const bound = await backlogStore.create({
      userId: 'user1',
      title: '[F001] Bound',
      summary: 's',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f001'],
      createdBy: 'user',
      projectId,
    });
    assert.equal(bound.projectId, projectId);

    // 3. Import backlog — refresh the managed bound item, but never backfill its orphan.
    const importRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/import-backlog`,
      headers: H,
    });
    assert.equal(importRes.statusCode, 200);
    const body = importRes.json();
    assert.equal(body.imported, 0);
    assert.equal(body.refreshed, 1);
    assert.equal(body.skipped, 0);
    assert.equal(body.orphans, 1);

    // 4. Verify orphan remains unassigned (no auto-backfill in hot path).
    assert.equal(backlogStore.get(bound.id)?.title, '[F001] Test Feature');
    const orphanAfter = backlogStore.get(orphan.id);
    assert.equal(orphanAfter.projectId, undefined);
  });

  test('import-backlog refreshes a stale imported name without deleting a source-absent feature', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'import-refresh-test-'));
    await mkdir(join(tmpDir, 'docs'), { recursive: true });
    await writeFile(
      join(tmpDir, 'docs', 'ROADMAP.md'),
      [
        '| ID | 名称 | Status | Owner | Link |',
        '|---|---|---|---|---|',
        '| F004 | Change Impact Analysis | in-progress | Maine Coon | [F004](features/F004.md) |',
      ].join('\n'),
    );

    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projectRes.json().project.id;
    const stale = backlogStore.create({
      userId: 'user1',
      projectId,
      title: '[F004] Claim review',
      summary: 'old source text',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f004', 'status:in-progress'],
      createdBy: 'user',
    });
    const retired = backlogStore.create({
      userId: 'user1',
      projectId,
      title: '[F007] Project relaunch discovery',
      summary: 'historical source text',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f007', 'status:in-progress'],
      createdBy: 'user',
    });

    const imported = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/import-backlog`,
      headers: H,
    });

    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().refreshed, 1);
    assert.equal(backlogStore.get(stale.id)?.title, '[F004] Change Impact Analysis');
    assert.equal(backlogStore.get(retired.id)?.status, 'open');
  });

  test('DELETE external backlog item removes an imported feature and detaches its thread', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'retired-feature-delete-test-'));
    await mkdir(join(tmpDir, 'docs'), { recursive: true });
    await writeFile(
      join(tmpDir, 'docs', 'ROADMAP.md'),
      [
        '| ID | 名称 | Status | Owner | Link |',
        '|---|---|---|---|---|',
        '| F004 | Change Impact Analysis | spec | Maine Coon | [F004](features/F004.md) |',
      ].join('\n'),
    );
    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projectRes.json().project.id;
    const item = backlogStore.create({
      userId: 'user1',
      projectId,
      title: '[F007] Project relaunch discovery',
      summary: 'retired feature',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f007', 'status:in-progress'],
      createdBy: 'user',
    });
    const thread = threadStore.create('user1', 'F007 historical discussion');
    threadStore.linkBacklogItem(thread.id, item.id);
    backlogStore.suggestClaim(item.id, {
      catId: 'cat-4v94tazw',
      why: 'Historical feature thread',
      plan: 'remove retired feature',
      requestedPhase: 'coding',
    });
    backlogStore.decideClaim(item.id, { decision: 'approve', decidedBy: 'user1', note: 'historical fixture' });
    backlogStore.markDispatched(item.id, {
      threadId: thread.id,
      threadPhase: 'coding',
      dispatchedBy: 'user1',
    });
    workflowSops.set(item.id, { backlogItemId: item.id });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
      headers: H,
      payload: {
        expectedFeatureId: 'F007',
        expectedUpdatedAt: backlogStore.get(item.id).updatedAt,
        reason: 'Retired from the authoritative project roadmap',
      },
    });

    assert.equal(removed.statusCode, 204);
    assert.equal(backlogStore.get(item.id), null);
    assert.equal(threadStore.get(thread.id)?.backlogItemId, undefined);
    assert.equal(workflowSops.has(item.id), false);
  });

  test('DELETE refuses an active feature even when a manual item spoofs importer tags', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'active-feature-delete-test-'));
    await mkdir(join(tmpDir, 'docs'), { recursive: true });
    await writeFile(
      join(tmpDir, 'docs', 'ROADMAP.md'),
      [
        '| ID | 名称 | Status | Owner | Link |',
        '|---|---|---|---|---|',
        '| F004 | Change Impact Analysis | spec | Maine Coon | [F004](features/F004.md) |',
      ].join('\n'),
    );
    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projectRes.json().project.id;
    const item = backlogStore.create({
      userId: 'user1',
      projectId,
      title: '[F004] user-created task',
      summary: 'manual item with spoofed source tag',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f004'],
      createdBy: 'user',
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
      headers: H,
      payload: {
        expectedFeatureId: 'F004',
        expectedUpdatedAt: item.updatedAt,
        reason: 'Spoofed importer provenance must not authorize deletion',
      },
    });

    assert.equal(removed.statusCode, 409);
    assert.match(removed.json().error, /active project catalog/i);
    assert.ok(backlogStore.get(item.id));
  });

  test('DELETE refuses a retired feature when the matching item is not importer-managed', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'manual-retired-feature-delete-test-'));
    await mkdir(join(tmpDir, 'docs'), { recursive: true });
    await writeFile(
      join(tmpDir, 'docs', 'ROADMAP.md'),
      ['| ID | 名称 | Status | Owner | Link |', '|---|---|---|---|---|'].join('\n'),
    );
    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projectRes.json().project.id;
    const item = backlogStore.create({
      userId: 'user1',
      projectId,
      title: '[F007] Manual retrospective',
      summary: 'user-authored history that happens to reuse the feature tag',
      priority: 'p2',
      tags: ['feature:f007'],
      createdBy: 'user',
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
      headers: H,
      payload: {
        expectedFeatureId: 'F007',
        expectedUpdatedAt: item.updatedAt,
        reason: 'Manual records must never be selected by importer reconciliation',
      },
    });

    assert.equal(removed.statusCode, 409);
    assert.match(removed.json().error, /not importer-managed/i);
    assert.ok(backlogStore.get(item.id));
  });

  test('DELETE detaches every owned thread that references the retired backlog item', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'multi-thread-delete-test-'));
    await mkdir(join(tmpDir, 'docs'), { recursive: true });
    await writeFile(
      join(tmpDir, 'docs', 'ROADMAP.md'),
      ['| ID | 名称 | Status | Owner | Link |', '|---|---|---|---|---|'].join('\n'),
    );
    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projectRes.json().project.id;
    const item = backlogStore.create({
      userId: 'user1',
      projectId,
      title: '[F007] retired feature',
      summary: 'retired',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f007'],
      createdBy: 'user',
    });
    const primary = threadStore.create('user1', 'primary');
    const additional = threadStore.create('user1', 'additional');
    threadStore.linkBacklogItem(primary.id, item.id);
    threadStore.linkBacklogItem(additional.id, item.id);
    backlogStore.suggestClaim(item.id, {
      catId: 'cat-4v94tazw',
      why: 'historical',
      plan: 'retire',
      requestedPhase: 'brainstorm',
    });
    backlogStore.decideClaim(item.id, { decision: 'approve', decidedBy: 'user1' });
    backlogStore.markDispatched(item.id, {
      threadId: primary.id,
      threadPhase: 'brainstorm',
      dispatchedBy: 'user1',
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
      headers: H,
      payload: {
        expectedFeatureId: 'F007',
        expectedUpdatedAt: backlogStore.get(item.id).updatedAt,
        reason: 'Retired from the authoritative project roadmap',
      },
    });

    assert.equal(removed.statusCode, 204);
    assert.equal(threadStore.get(primary.id)?.backlogItemId, undefined);
    assert.equal(threadStore.get(additional.id)?.backlogItemId, undefined);
  });

  test('DELETE rejects a stale item snapshot and restores detached thread and workflow state', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'stale-retired-feature-delete-test-'));
    await mkdir(join(tmpDir, 'docs'), { recursive: true });
    await writeFile(
      join(tmpDir, 'docs', 'ROADMAP.md'),
      ['| ID | 名称 | Status | Owner | Link |', '|---|---|---|---|---|'].join('\n'),
    );
    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projectRes.json().project.id;
    const item = backlogStore.create({
      userId: 'user1',
      projectId,
      title: '[F007] retired feature',
      summary: 'retired',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f007'],
      createdBy: 'user',
    });
    const thread = threadStore.create('user1', 'historical');
    threadStore.linkBacklogItem(thread.id, item.id);
    const originalWorkflowSop = {
      backlogItemId: item.id,
      featureId: 'F007',
      sopDefinitionId: 'development',
      stage: 'discussion',
      batonHolder: 'user1',
      nextSkill: null,
      resumeCapsule: { goal: 'retire', done: [], currentFocus: 'cleanup' },
      checks: {
        remoteMainSynced: 'unknown',
        qualityGatePassed: 'unknown',
        reviewApproved: 'unknown',
        visionGuardDone: 'unknown',
      },
      version: 1,
      updatedAt: item.updatedAt,
      updatedBy: 'user1',
    };
    workflowSops.set(item.id, structuredClone(originalWorkflowSop));

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
      headers: H,
      payload: {
        expectedFeatureId: 'F007',
        expectedUpdatedAt: item.updatedAt - 1,
        reason: 'Stale snapshots must never authorize permanent deletion',
      },
    });

    assert.equal(removed.statusCode, 409);
    assert.ok(backlogStore.get(item.id));
    assert.equal(threadStore.get(thread.id)?.backlogItemId, item.id);
    assert.deepEqual(workflowSops.get(item.id), originalWorkflowSop);
  });

  test('DELETE keeps backlog and thread links intact when workflow cleanup fails', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'workflow-failure-delete-test-'));
    await mkdir(join(tmpDir, 'docs'), { recursive: true });
    await writeFile(
      join(tmpDir, 'docs', 'ROADMAP.md'),
      ['| ID | 名称 | Status | Owner | Link |', '|---|---|---|---|---|'].join('\n'),
    );
    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projectRes.json().project.id;
    const item = backlogStore.create({
      userId: 'user1',
      projectId,
      title: '[F007] retired feature',
      summary: 'retired',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f007'],
      createdBy: 'user',
    });
    const thread = threadStore.create('user1', 'historical');
    threadStore.linkBacklogItem(thread.id, item.id);
    workflowSops.set(item.id, { backlogItemId: item.id });
    workflowSopDeleteError = new Error('injected workflow cleanup failure');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
      headers: H,
      payload: {
        expectedFeatureId: 'F007',
        expectedUpdatedAt: item.updatedAt,
        reason: 'Retired from the authoritative project roadmap',
      },
    });

    assert.equal(removed.statusCode, 500);
    assert.ok(backlogStore.get(item.id));
    assert.equal(threadStore.get(thread.id)?.backlogItemId, item.id);
    assert.equal(workflowSops.has(item.id), true);
  });

  test('Traqen reconciliation refreshes canonical titles and priorities and removes only F005/F007', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'traqen-reconciliation-test-'));
    await mkdir(join(tmpDir, 'docs'), { recursive: true });
    await writeFile(
      join(tmpDir, 'docs', 'ROADMAP.md'),
      [
        '| ID | Priority | Feature | Status | Owner | Source | Spec |',
        '|---|---|---|---|---|---|---|',
        '| F001 | P0 | Workspace & Source Truth | spec | CodeX | approved | [F001](features/F001.md) |',
        '| F002 | P0 | Deterministic Evidence & API Structure | spec | TBD | confirmed | [F002](features/F002.md) |',
        '| F003 | P1 | Agent Candidates & Reviewed Business Function Tree | spec | TBD | confirmed | [F003](features/F003.md) |',
        '| F004 | P0 | Change Impact Analysis | spec | TBD | confirmed | [F004](features/F004.md) |',
        '| F006 | P2 | Workspace capability settings | spec | TBD | authorized | [F006](features/F006.md) |',
      ].join('\n'),
    );
    const projectRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projectRes.json().project.id;
    const oldNames = {
      F001: 'Workspace and legacy-system analysis foundation',
      F002: 'Feature and API traceability',
      F003: 'Traceability graph',
      F004: 'Claim review',
      F005: 'Change impact',
      F006: 'Workspace capability settings',
      F007: 'Project relaunch discovery',
    };
    for (const [featureId, name] of Object.entries(oldNames)) {
      backlogStore.create({
        userId: 'user1',
        projectId,
        title: `[${featureId}] ${name}`,
        summary: 'stale persisted snapshot',
        priority: 'p2',
        tags: ['source:docs-backlog', `feature:${featureId.toLowerCase()}`, 'status:spec'],
        createdBy: 'user',
      });
    }

    const imported = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/import-backlog`,
      headers: H,
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().refreshed, 5);

    for (const featureId of ['F005', 'F007']) {
      const item = backlogStore
        .listByUser('user1')
        .find((candidate) => candidate.tags.includes(`feature:${featureId.toLowerCase()}`));
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/external-projects/${projectId}/backlog/items/${item.id}`,
        headers: H,
        payload: {
          expectedFeatureId: featureId,
          expectedUpdatedAt: item.updatedAt,
          reason: `Co-creator authorized retirement of ${featureId}`,
        },
      });
      assert.equal(removed.statusCode, 204);
    }

    const finalItems = backlogStore
      .listByUser('user1')
      .filter((item) => item.projectId === projectId)
      .map((item) => ({
        featureId: item.tags
          .find((tag) => tag.startsWith('feature:'))
          .slice('feature:'.length)
          .toUpperCase(),
        title: item.title,
        priority: item.priority,
      }))
      .sort((left, right) => left.featureId.localeCompare(right.featureId));
    assert.deepEqual(finalItems, [
      { featureId: 'F001', title: '[F001] Workspace & Source Truth', priority: 'p0' },
      { featureId: 'F002', title: '[F002] Deterministic Evidence & API Structure', priority: 'p0' },
      { featureId: 'F003', title: '[F003] Agent Candidates & Reviewed Business Function Tree', priority: 'p1' },
      { featureId: 'F004', title: '[F004] Change Impact Analysis', priority: 'p0' },
      { featureId: 'F006', title: '[F006] Workspace capability settings', priority: 'p2' },
    ]);
  });

  test('import-backlog creates a project-bound replacement for orphaned historical data', async () => {
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = await mkdtemp(join(tmpdir(), 'import-test-'));
    const docsDir = join(tmpDir, 'docs');
    await mkdir(docsDir, { recursive: true });
    const backlogPath = join(docsDir, 'ROADMAP.md');
    await writeFile(
      backlogPath,
      [
        '| ID | 名称 | Status | Owner | Link |',
        '|---|---|---|---|---|',
        '| F002 | Solo Feature | in-progress | 布偶猫 | [F002](features/F002.md) |',
      ].join('\n'),
    );

    // 1. Create project
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'import-test', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projRes.json().project.id;

    // 2. Create an orphan item (no projectId) for F002
    const orphan = await backlogStore.create({
      userId: 'user1',
      title: '[F002] Orphan',
      summary: 's',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f002'],
      createdBy: 'user',
    });
    assert.equal(orphan.projectId, undefined);

    // 3. Import backlog — should report orphan and create a bound replacement, NOT backfill
    const importRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/import-backlog`,
      headers: H,
    });
    assert.equal(importRes.statusCode, 200);
    const body = importRes.json();
    assert.equal(body.imported, 1);
    assert.equal(body.skipped, 0);
    assert.equal(body.orphans, 1);

    // 4. Verify orphan remains unassigned
    const orphanAfter = backlogStore.get(orphan.id);
    assert.equal(orphanAfter.projectId, undefined);

    // 5. Verify the user-visible project list has the recovered feature
    const projectItems = backlogStore.listByUser('user1').filter((item) => item.projectId === projectId);
    assert.equal(projectItems.length, 1);
    assert.equal(projectItems[0].title, '[F002] Solo Feature');
  });

  test('import-backlog exposes EXT catalog entries and preserves legacy Desktop loop identity', async () => {
    const { mkdir, mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'extension-import-test-'));
    await mkdir(join(tmpDir, 'docs', 'extensions'), { recursive: true });
    await writeFile(
      join(tmpDir, 'docs', 'ROADMAP.md'),
      [
        '| ID | 名称 | Status | Owner | Link |',
        '|---|---|---|---|---|',
        '| F289 | Canonical Data Root | in-progress | Maine Coon | [F289](features/F289-canonical-data-root.md) |',
      ].join('\n'),
    );
    await writeFile(
      join(tmpDir, 'docs', 'extensions', 'catalog.json'),
      JSON.stringify({
        schemaVersion: 1,
        extensions: [
          {
            id: 'EXT-001',
            name: 'ChatGPT Desktop Development Loop',
            status: 'implementation',
            owner: 'CodeX',
            specPath: 'docs/extensions/EXT-001-chatgpt-desktop-development-loop.md',
            legacyIds: ['F289'],
          },
        ],
      }),
    );

    const projRes = await app.inject({
      method: 'POST',
      url: '/api/external-projects',
      headers: H,
      payload: { name: 'Traqen', description: '', sourcePath: tmpDir, backlogPath: 'docs/ROADMAP.md' },
    });
    const projectId = projRes.json().project.id;
    const legacy = await backlogStore.create({
      userId: 'user1',
      projectId,
      title: '[F289] ChatGPT Desktop Development Loop',
      summary: 'legacy fork feature',
      priority: 'p1',
      tags: ['source:docs-backlog', 'feature:f289', 'status:implementation'],
      createdBy: 'user',
    });

    const importRes = await app.inject({
      method: 'POST',
      url: `/api/external-projects/${projectId}/import-backlog`,
      headers: H,
    });
    assert.equal(importRes.statusCode, 200);
    assert.equal(importRes.json().total, 2);

    const projectItems = backlogStore.listByUser('user1').filter((item) => item.projectId === projectId);
    const extension = projectItems.find((item) => item.tags.includes('feature:ext-001'));
    const upstream = projectItems.find((item) => item.title === '[F289] Canonical Data Root');
    assert.equal(extension?.id, legacy.id);
    assert.ok(extension?.tags.includes('feature-kind:extension'));
    assert.ok(upstream);
  });
});
