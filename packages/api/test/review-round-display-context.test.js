import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Review display context resolves the external project feature instead of the CatCafe mechanism id', async () => {
  const { ReviewRoundDisplayContextResolver } = await import(
    '../dist/domains/desktop-development-loop/review-round-display-context.js'
  );
  const resolver = new ReviewRoundDisplayContextResolver(
    {
      getById: async () => ({
        id: 'project-traqen',
        userId: 'owner-1',
        name: 'Traqen',
        desktopDevelopment: { repository: { fullName: 'qianfengXY/Traqen' } },
      }),
    },
    {
      listByUser: async () => [
        {
          id: 'backlog-f006',
          projectId: 'project-traqen',
          title: '[F006] Workspace capability settings',
          tags: ['feature:F006'],
        },
      ],
    },
    {
      read: async () => ({
        admission: { producerRef: 'backlog-f006' },
        attempt: { attemptNumber: 3 },
      }),
    },
  );

  assert.deepEqual(
    await resolver.resolve({
      ownerUserId: 'owner-1',
      projectId: 'project-traqen',
      workId: 'work-f006',
      attemptId: 'attempt-3',
    }),
    {
      projectName: 'Traqen',
      repository: 'qianfengXY/Traqen',
      backlogItemId: 'backlog-f006',
      featureId: 'F006',
      featureTitle: 'Workspace capability settings',
      attemptNumber: 3,
      planThreadId: 'project-feature-plan:project-traqen:backlog-f006',
    },
  );
});
