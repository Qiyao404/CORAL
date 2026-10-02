import chokidar, { type FSWatcher } from 'chokidar';
import { basename, relative } from 'path';
import type { FilesystemSkillRegistry } from './filesystem-registry.js';

/**
 * 文件系统监控 — 自动发现 Skill 变更并触发热重载
 */
export class SkillWatcher {
  private watcher: FSWatcher | null = null;
  private registry: FilesystemSkillRegistry;
  private debounceMs: number;
  private pendingReloads: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(registry: FilesystemSkillRegistry, debounceMs: number = 300) {
    this.registry = registry;
    this.debounceMs = debounceMs;
  }

  start(): void {
    const dir = this.registry.getSkillsDir();
    console.log(`[Skill 监控] 开始监控目录: ${dir}`);

    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 3,
      ignored: /(^|[\/\\])\../, // 忽略隐藏文件
    });

    this.watcher.on('add', (path: string) => this.handleChange(path));
    this.watcher.on('change', (path: string) => this.handleChange(path));
    this.watcher.on('unlink', (path: string) => this.handleRemoval(path));
    this.watcher.on('unlinkDir', (path: string) => this.handleDirRemoval(path));
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.pendingReloads.values()) {
      clearTimeout(timer);
    }
    this.pendingReloads.clear();
    console.log('[Skill 监控] 已停止');
  }

  private handleChange(filePath: string): void {
    const skillName = this.extractSkillName(filePath);
    if (!skillName) return;

    this.debounceReload(skillName);
  }

  private handleRemoval(filePath: string): void {
    if (basename(filePath) === 'SKILL.md') {
      const skillName = this.extractSkillName(filePath);
      if (skillName) {
        this.registry.removeSkill(skillName);
      }
    }
  }

  private handleDirRemoval(dirPath: string): void {
    const skillName = this.extractSkillName(dirPath);
    if (skillName) {
      this.registry.removeSkill(skillName);
    }
  }

  private extractSkillName(path: string): string | null {
    const rel = relative(this.registry.getSkillsDir(), path);
    const parts = rel.split(/[\/\\]/);
    if (parts.length === 0 || !parts[0]) return null;
    return parts[0];
  }

  private debounceReload(skillName: string): void {
    const existing = this.pendingReloads.get(skillName);
    if (existing) clearTimeout(existing);

    this.pendingReloads.set(skillName, setTimeout(async () => {
      this.pendingReloads.delete(skillName);
      console.log(`[Skill 监控] 检测到变更，重载: ${skillName}`);
      await this.registry.reloadSkill(skillName);
    }, this.debounceMs));
  }
}
