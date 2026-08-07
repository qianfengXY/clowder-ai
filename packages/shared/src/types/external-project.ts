/**
 * F076: External Project types
 * 跨项目作战面板 — 外部项目实体
 */

import type {
  CreateDesktopDevelopmentProjectBindingInput,
  DesktopDevelopmentProjectBinding,
} from './desktop-development-loop.js';

export interface ExternalProject {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly backlogPath: string;
  /** F289: optional project-scoped ChatGPT Desktop development-loop binding. */
  readonly desktopDevelopment?: DesktopDevelopmentProjectBinding;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateExternalProjectInput {
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly backlogPath?: string;
  readonly desktopDevelopment?: CreateDesktopDevelopmentProjectBindingInput;
}
