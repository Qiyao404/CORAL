/**
 * M1-6 先导 CLI：技能导入（正式 `coral skill import <src>` 子命令随 M4-3 的 cli.ts 落地）。
 *
 * 用法：
 *   npx tsx packages/server/src/cli/import-skill.ts <本地目录|git-url> [--overwrite]
 */
import { importSkills } from '../skill-runtime/skill-importer.js';
import { platformConfig } from '../services/config.js';

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--overwrite');
  const overwrite = process.argv.includes('--overwrite');
  const source = args[0];

  if (!source) {
    console.error('用法: import-skill <本地目录|git-url> [--overwrite]');
    process.exit(1);
  }

  console.log(`[导入] 源: ${source}`);
  const reports = await importSkills(source, { skillsDir: platformConfig.skillsDir, overwrite });

  for (const r of reports) {
    const icon = r.status === 'imported' ? '✓' : r.status === 'skipped' ? '⏭' : '✗';
    console.log(`${icon} [${r.status}] ${r.skillName ?? '(无名)'} — ${r.source}`);
    if (r.mapped) {
      console.log(`   映射: ${r.mapped.name} v${r.mapped.version} · ${r.mapped.executionMode}`);
    }
    for (const w of r.warnings) console.log(`   ⚠ ${w}`);
    if (r.error) console.log(`   错误: ${r.error}`);
    if (r.copiedFiles.length > 0) {
      console.log(`   附属文件 ${r.copiedFiles.length} 个: ${r.copiedFiles.slice(0, 5).join(', ')}${r.copiedFiles.length > 5 ? ' …' : ''}`);
    }
  }

  const failed = reports.filter(r => r.status === 'failed').length;
  console.log(`\n完成: ${reports.filter(r => r.status === 'imported').length} 导入 / ${reports.filter(r => r.status === 'skipped').length} 跳过 / ${failed} 失败`);
  if (failed > 0) process.exit(2);
}

main().catch(err => {
  console.error('[致命错误]', err);
  process.exit(1);
});
