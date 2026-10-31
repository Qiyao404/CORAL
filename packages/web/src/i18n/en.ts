/** en 字典：合并全部命名空间。缺失 key 回退 zh（i18n/index.tsx 的取值顺序）。 */
import { en as app } from './en.app';
import { en as error } from './en.error';
import { en as chat } from './en.chat';
import { en as tasks } from './en.tasks';
import { en as taskdetail } from './en.taskdetail';
import { en as dashboard } from './en.dashboard';
import { en as skills } from './en.skills';
import { en as skillbuilder } from './en.skillbuilder';
import { en as connectors } from './en.connectors';
import { en as workflow } from './en.workflow';
import { en as timetravel } from './en.timetravel';
import { en as approvals } from './en.approvals';
import { en as execlog } from './en.execlog';
import { en as settings } from './en.settings';
import { en as hooks } from './en.hooks';

export const en: Record<string, string> = Object.assign(
  {},
  app, error, chat, tasks, taskdetail, dashboard,
  skills, skillbuilder, connectors, workflow,
  timetravel, approvals, execlog, settings, hooks,
);
