import { catIdSchema } from '@cat-cafe/shared';
import { z } from 'zod';

/** Shared HTTP input contract for home and ownership-checked project backlog creation. */
export const createBacklogItemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2000),
  priority: z.enum(['p0', 'p1', 'p2', 'p3']),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]),
  createdBy: z
    .union([z.literal('user'), catIdSchema()])
    .optional()
    .default('user'),
});
