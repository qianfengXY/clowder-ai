export const BacklogKeys = {
  detail: (id: string) => `backlog:item:${id}`,
  userList: (userId: string) => `backlog:items:user:${userId}`,
  dispatchLock: (itemId: string) => `backlog:dispatch-lock:${itemId}`,
  projectFeatureSequence: (userId: string, projectId: string) =>
    `backlog:feature-sequence:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`,
} as const;
