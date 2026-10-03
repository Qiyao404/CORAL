import type { Migration } from '../migrate.js';
import m001 from './001-init.js';
import m002 from './002-run-session.js';
import m003 from './003-run-workspace.js';

/** 全部迁移 — 按版本号升序由 migrate() 应用；新迁移只允许追加，禁止修改已发布版本 */
export const MIGRATIONS: Migration[] = [m001, m002, m003];
