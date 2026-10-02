import { readdirSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import type { ParsedSkillManifest } from '../types/index.js';
import { parseSkillMd } from './skill-resolver.js';
import { eventBus } from '../event/event-bus.js';

/**
 * 文件系统 Skill 注册表 — Skill 以目录形式存在于文件系统
 */
export class FilesystemSkillRegistry {
  private cache: Map<string, ParsedSkillManifest> = new Map();
  private skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = resolve(skillsDir);
  }

  async reloadAll(): Promise<void> {
    if (!existsSync(this.skillsDir)) return;

    const entries = readdirSync(this.skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const skillDir = join(this.skillsDir, entry.name);
      const skillMdPath = join(skillDir, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      await this.reloadSkill(entry.name);
    }

    console.log(`[Skill 注册表] 已加载 ${this.cache.size} 个 Skill`);
  }

  async reloadSkill(name: string): Promise<void> {
    const skillDir = join(this.skillsDir, name);
    const manifest = parseSkillMd(skillDir);

    if (manifest) {
      const existed = this.cache.has(name);
      this.cache.set(name, manifest);
      eventBus.emit(existed ? 'skill.updated' : 'skill.registered', {
        skillName: name,
        description: manifest.description,
        version: manifest.version,
      });
      console.log(`[Skill 注册表] ${existed ? '更新' : '注册'}: ${name} v${manifest.version}`);
    } else {
      eventBus.emit('skill.reload_failed', {
        skillName: name,
        error: '解析 SKILL.md 失败',
      });
      console.warn(`[Skill 注册表] 加载失败: ${name}`);
    }
  }

  removeSkill(name: string): void {
    if (this.cache.has(name)) {
      this.cache.delete(name);
      eventBus.emit('skill.removed', { skillName: name });
      console.log(`[Skill 注册表] 移除: ${name}`);
    }
  }

  /** 是否已注册 */
  has(name: string): boolean {
    return this.cache.has(name);
  }

  getByName(name: string): ParsedSkillManifest | null {
    return this.cache.get(name) ?? null;
  }

  findByDomain(domain: string): ParsedSkillManifest[] {
    return this.listAvailable().filter(s => s.domain === domain);
  }

  findByCapabilities(caps: string[]): ParsedSkillManifest[] {
    return this.listAvailable().filter(s =>
      caps.some(c => s.capabilities.includes(c))
    );
  }

  listAvailable(): ParsedSkillManifest[] {
    return Array.from(this.cache.values()).filter(s => s.status !== 'deprecated');
  }

  listAll(): ParsedSkillManifest[] {
    return Array.from(this.cache.values());
  }

  getPromptAndReference(name: string): { prompt: string; reference?: string } | null {
    const manifest = this.cache.get(name);
    if (!manifest) return null;
    return {
      prompt: manifest.promptContent,
      reference: manifest.referenceContent,
    };
  }

  getSkillsDir(): string {
    return this.skillsDir;
  }
}
