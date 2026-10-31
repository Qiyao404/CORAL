/** zh 字典（权威语言）：合并全部命名空间。各命名空间文件由对应页面的迁移补齐。 */
import { zh as app } from './zh.app';
import { zh as error } from './zh.error';
import { zh as chat } from './zh.chat';
import { zh as tasks } from './zh.tasks';
import { zh as taskdetail } from './zh.taskdetail';
import { zh as dashboard } from './zh.dashboard';
import { zh as skills } from './zh.skills';
import { zh as skillbuilder } from './zh.skillbuilder';
import { zh as connectors } from './zh.connectors';
import { zh as workflow } from './zh.workflow';
import { zh as timetravel } from './zh.timetravel';
import { zh as approvals } from './zh.approvals';
import { zh as execlog } from './zh.execlog';
import { zh as settings } from './zh.settings';
import { zh as hooks } from './zh.hooks';

export const zh: Record<string, string> = Object.assign(
  {},
  app, error, chat, tasks, taskdetail, dashboard,
  skills, skillbuilder, connectors, workflow,
  timetravel, approvals, execlog, settings, hooks,
);
