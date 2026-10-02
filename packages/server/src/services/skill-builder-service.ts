import { resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { nanoid } from 'nanoid';
import { llmClient } from './llm-client.js';
import { eventBus } from '../event/event-bus.js';
import {
  writeSkillAtomic,
  validateSkillName,
  SkillExistsError,
} from '../skill-runtime/skill-writer.js';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';
import type { SkillBuilderSession, ParsedSkillManifest } from '../types/index.js';
import { PROJECT_ROOT } from './config.js';

const SESSIONS_PATH = resolve(PROJECT_ROOT, 'data', 'skill_builder_sessions.json');

const REQUIRED_FIELDS = [
  'name',
  'description',
  'execution_mode',
  'input_schema',
  'output_schema',
  'tags',
];

const FIELD_HUMAN: Record<string, string> = {
  name: '技能名称（小写连字符，如 my-skill）',
  description: '一句话能力描述',
  execution_mode: '执行模式（llm_only / script / hybrid）',
  input_schema: '输入参数（字段+类型）',
  output_schema: '输出结构（字段+类型）',
  tags: '关键词标签（数组）',
};

/**
 * Skill Builder 多轮对话状态机（DESIGN §5）
 */
export class SkillBuilderService {
  private sessions = new Map<string, SkillBuilderSession>();
  private registry: FilesystemSkillRegistry;

  constructor(registry: FilesystemSkillRegistry) {
    this.registry = registry;
    this.load();
  }

  private load() {
    try {
      if (existsSync(SESSIONS_PATH)) {
        const raw = readFileSync(SESSIONS_PATH, 'utf-8');
        const items: SkillBuilderSession[] = JSON.parse(raw);
        for (const item of items) this.sessions.set(item.sessionId, item);
      }
    } catch (err) {
      console.warn('[SkillBuilder] 加载会话历史失败', err);
    }
  }

  private save() {
    try {
      const dir = resolve(PROJECT_ROOT, 'data');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(SESSIONS_PATH, JSON.stringify([...this.sessions.values()], null, 2), 'utf-8');
    } catch (err) {
      console.warn('[SkillBuilder] 保存会话失败', err);
    }
  }

  createSession(userId: string): SkillBuilderSession {
    const sessionId = `sess_${nanoid(10)}`;
    const now = new Date().toISOString();
    const session: SkillBuilderSession = {
      sessionId,
      userId: userId || 'anonymous',
      status: 'collecting',
      conversation: [],
      draft: {
        version: '1.0.0',
        domain: 'general',
        capabilities: [],
        executionMode: 'llm_only',
        humanGate: false,
        estimatedDurationMs: 30000,
        costLevel: 'low',
        status: 'experimental',
        tags: [],
        source: 'user',
        creatorSessionId: sessionId,
        createdBy: userId,
      },
      draftFilledFields: [],
      pendingFields: [...REQUIRED_FIELDS],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(sessionId, session);
    this.save();
    eventBus.emit('skill_builder.session_started', { sessionId, userId });
    return session;
  }

  getSession(sessionId: string): SkillBuilderSession | null {
    return this.sessions.get(sessionId) || null;
  }

  listSessions(userId?: string): SkillBuilderSession[] {
    const all = [...this.sessions.values()];
    if (userId) return all.filter(s => s.userId === userId);
    return all;
  }

  cancelSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = 'cancelled';
    session.updatedAt = new Date().toISOString();
    this.save();
    return true;
  }

  patchDraft(sessionId: string, draftPatch: Record<string, any>): SkillBuilderSession {
    const session = this.requireSession(sessionId);
    session.draft = { ...session.draft, ...draftPatch };
    session.draftFilledFields = this.computeFilledFields(session.draft);
    session.pendingFields = REQUIRED_FIELDS.filter(f => !session.draftFilledFields.includes(f));
    session.updatedAt = new Date().toISOString();
    this.save();
    eventBus.emit('skill_builder.draft_updated', {
      sessionId,
      filled: session.draftFilledFields,
      pending: session.pendingFields,
    });
    return session;
  }

  /**
   * 用户发送一条消息 → 调用 LLM → 解析 reply + draft_updates → 更新 session
   */
  async sendMessage(sessionId: string, userMessage: string): Promise<SkillBuilderSession & { aiReply: string; readyToPreview: boolean }> {
    const session = this.requireSession(sessionId);
    if (session.status !== 'collecting' && session.status !== 'previewing') {
      throw new Error('当前会话已结束');
    }

    const now = new Date().toISOString();
    session.conversation.push({ role: 'user', content: userMessage, timestamp: now });
    eventBus.emit('skill_builder.message', { sessionId, role: 'user', content: userMessage });

    const prompt = this.buildBuilderPrompt(session, userMessage);
    let aiReply = '';
    let draftUpdates: Record<string, any> = {};
    let pendingFields: string[] = session.pendingFields;
    let readyToPreview = false;

    try {
      // 把历史助手消息中的 Python 代码块裁剪掉，避免 context window 被脚本撑爆
      // 业务字段 / scriptContent 已经持久化在 session.draft 中，LLM 看 prompt 即可
      // 同时对超长（>2000 字）的旧助手消息（多半是协议升级前的脏数据）做截断
      const slimHistory = session.conversation.slice(-10).map(m => {
        let content = m.content;
        if (m.role === 'assistant') {
          content = stripPythonFences(content);
          if (content.length > 2000) {
            content = content.slice(0, 1000)
              + '\n\n[...历史响应过长已截断（脏数据），请按当前 system 协议重新输出 <JSON> + <SCRIPT> 双段...]\n\n'
              + content.slice(-500);
          }
        }
        return { role: m.role as 'user' | 'assistant', content };
      });

      const { content: rawContent } = await llmClient.complete(
        [
          { role: 'system', content: prompt.system },
          ...slimHistory,
          { role: 'user', content: prompt.userContext },
        ],
        // maxTokens 调高至 6000：长 Python 脚本（200+ 行）也能完整生成
        { temperature: 0.3, maxTokens: 6000 }
      );

      const parsed = parseBuilderResponse(rawContent);
      aiReply = parsed.reply || '已记下你的描述。请继续。';
      draftUpdates = parsed.draft_updates;
      if (parsed.fields_pending) pendingFields = parsed.fields_pending;
      readyToPreview = parsed.ready_to_preview;

      // 代码块抽取的脚本**优先**于 JSON.scriptContent 字段
      // 避免 LLM 把整段 Python 塞 JSON 字符串时漏转义 / 被截断
      if (parsed.fencedScript) {
        draftUpdates.scriptContent = parsed.fencedScript;
      }

      if (parsed.parseStrategy === 'none' && !parsed.fencedScript) {
        aiReply = rawContent?.trim() || '抱歉，我没能正确解析返回结果，请你再描述一次。';
      }
    } catch (err: any) {
      aiReply = `[LLM 调用失败] ${err?.message || err}。你可以直接在右侧手动编辑草稿后点击「预览」。`;
    }

    // 把 draft_updates 写回 session（做好字段映射 snake_case → 实际字段）
    const draftPatch: Record<string, any> = {};
    if (draftUpdates.name) draftPatch.name = String(draftUpdates.name);
    if (draftUpdates.description) draftPatch.description = String(draftUpdates.description);
    if (draftUpdates.domain) draftPatch.domain = String(draftUpdates.domain);
    if (Array.isArray(draftUpdates.capabilities)) draftPatch.capabilities = draftUpdates.capabilities;
    if (draftUpdates.input_schema && typeof draftUpdates.input_schema === 'object') draftPatch.inputSchema = draftUpdates.input_schema;
    if (draftUpdates.output_schema && typeof draftUpdates.output_schema === 'object') draftPatch.outputSchema = draftUpdates.output_schema;
    if (draftUpdates.execution_mode) draftPatch.executionMode = draftUpdates.execution_mode;
    if (typeof draftUpdates.estimated_duration_ms === 'number') draftPatch.estimatedDurationMs = draftUpdates.estimated_duration_ms;
    if (Array.isArray(draftUpdates.tags)) draftPatch.tags = draftUpdates.tags;
    if (typeof draftUpdates.promptContent === 'string') draftPatch.promptContent = draftUpdates.promptContent;
    if (typeof draftUpdates.scriptContent === 'string') draftPatch.scriptContent = draftUpdates.scriptContent;
    if (typeof draftUpdates.referenceContent === 'string') draftPatch.referenceContent = draftUpdates.referenceContent;

    if (Object.keys(draftPatch).length > 0) {
      this.patchDraft(sessionId, draftPatch);
    }

    // 重新计算 pendingFields：若 mode=script/hybrid 但 scriptContent 缺失 → 加 'script_content'
    const mode = session.draft.executionMode;
    const isScripted = mode === 'script' || mode === 'hybrid';
    const hasScript = !!(session.draft as any).scriptContent;
    const augmentedPending = new Set<string>(pendingFields);
    // 总字段：从 LLM 反馈的 fields_pending 出发，再合并我们后端的硬规则
    if (isScripted && !hasScript) {
      augmentedPending.add('script_content');
    } else {
      augmentedPending.delete('script_content');
    }
    const finalPending = Array.from(augmentedPending);

    // readyToPreview 必要条件：所有 REQUIRED_FIELDS 已 filled + script 校验通过
    const baselineReady = REQUIRED_FIELDS.every(f => session.draftFilledFields.includes(f));
    const scriptOk = !isScripted || hasScript;
    const finalReady = readyToPreview && baselineReady && scriptOk;

    const ts = new Date().toISOString();
    session.conversation.push({ role: 'assistant', content: aiReply, timestamp: ts });
    session.pendingFields = finalPending;
    if (finalReady) {
      session.status = 'previewing';
    }
    session.updatedAt = ts;
    this.save();
    eventBus.emit('skill_builder.message', { sessionId, role: 'assistant', content: aiReply });

    // 把额外字段（脚本预览、是否包含脚本）一并返回，便于前端 UI 直接渲染
    return {
      ...session,
      aiReply,
      readyToPreview: finalReady,
    };
  }

  /** 拼装预览的 SKILL.md 文本 */
  buildPreview(sessionId: string): string {
    const session = this.requireSession(sessionId);
    const fm = this.draftToFrontmatter(session);
    const promptContent = session.draft.promptContent || `# ${session.draft.name || 'unnamed-skill'}\n\n${session.draft.description || ''}`;
    const matter = `---\n${this.yamlStringify(fm)}---\n\n${promptContent}\n`;
    return matter;
  }

  /**
   * 落盘到 skills/<name>/，触发热重载，返回新 Skill manifest
   * 重名 + 不带 overwrite=true → 抛 SkillExistsError
   */
  async commitSession(sessionId: string, opts: { overwrite?: boolean } = {}): Promise<ParsedSkillManifest> {
    const session = this.requireSession(sessionId);
    const draft = session.draft;
    if (!draft.name) throw new Error('技能名 name 必填');
    if (!draft.description) throw new Error('描述 description 必填');
    if (!draft.executionMode) draft.executionMode = 'llm_only';

    // mode=script/hybrid 必须带脚本，否则禁止提交
    const isScripted = draft.executionMode === 'script' || draft.executionMode === 'hybrid';
    const scriptContent = (draft as any).scriptContent;
    if (isScripted && (!scriptContent || !String(scriptContent).trim())) {
      throw new Error(
        `执行模式为 ${draft.executionMode}，必须提供脚本代码（scripts/main.py）。请继续与 AI 对话补全脚本，或将模式改为 llm_only。`
      );
    }

    validateSkillName(draft.name);

    if (this.registry.has(draft.name) && !opts.overwrite) {
      throw new SkillExistsError(`Skill "${draft.name}" 已存在`);
    }

    const fm = this.draftToFrontmatter(session);
    const promptContent = draft.promptContent || `# ${draft.name}\n\n${draft.description}`;

    try {
      writeSkillAtomic(this.registry.getSkillsDir(), draft.name, {
        frontmatter: fm,
        promptContent,
        referenceContent: draft.referenceContent,
        scriptContent: draft.scriptContent,
        scriptEntry: fm.script_entry,
      }, { overwrite: !!opts.overwrite, keepHistory: true });

      await this.registry.reloadSkill(draft.name);

      session.status = 'committed';
      session.committedSkillName = draft.name;
      session.updatedAt = new Date().toISOString();
      this.save();

      eventBus.emit('skill_builder.committed', {
        sessionId,
        skillName: draft.name,
      });

      const manifest = this.registry.getByName(draft.name);
      if (!manifest) throw new Error('落盘成功但注册失败，请刷新或检查日志');
      return manifest;
    } catch (err: any) {
      eventBus.emit('skill_builder.failed', { sessionId, error: err.message });
      throw err;
    }
  }

  // ──────────────────────────────────────────────────────

  private requireSession(sessionId: string): SkillBuilderSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Skill Builder 会话不存在: ${sessionId}`);
    return s;
  }

  private computeFilledFields(draft: SkillBuilderSession['draft']): string[] {
    const filled: string[] = [];
    if (draft.name) filled.push('name');
    if (draft.description) filled.push('description');
    if (draft.executionMode) filled.push('execution_mode');
    if (draft.inputSchema && Object.keys(draft.inputSchema.properties || {}).length > 0) filled.push('input_schema');
    if (draft.outputSchema && Object.keys(draft.outputSchema.properties || {}).length > 0) filled.push('output_schema');
    if (Array.isArray(draft.tags) && draft.tags.length > 0) filled.push('tags');
    return filled;
  }

  private draftToFrontmatter(session: SkillBuilderSession): Record<string, any> {
    const d = session.draft;
    const fm: Record<string, any> = {
      name: d.name,
      version: d.version || '1.0.0',
      description: d.description,
      domain: d.domain || 'general',
      capabilities: d.capabilities || [],
      input_schema: d.inputSchema || { type: 'object', properties: {} },
      output_schema: d.outputSchema || { type: 'object', properties: {} },
      execution_mode: d.executionMode || 'llm_only',
      human_gate: d.humanGate ?? false,
      estimated_duration_ms: d.estimatedDurationMs ?? 30000,
      cost_level: d.costLevel || 'low',
      status: d.status || 'experimental',
      tags: d.tags || [],
      source: 'user',
      created_by: d.createdBy || session.userId,
      creator_session_id: session.sessionId,
    };
    if (d.executionMode === 'script' || d.executionMode === 'hybrid') {
      fm.script_entry = (d as any).scriptEntry || 'scripts/main.py';
      fm.script_runtime = (d as any).scriptRuntime || 'py';
      fm.script_timeout_ms = d.scriptTimeoutMs || 60000;
    }
    return fm;
  }

  private yamlStringify(obj: Record<string, any>): string {
    // 使用 gray-matter 的 stringify 间接做（避免引入额外依赖）；
    // 简化实现：手动序列化常用字段
    const lines: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        if (v.length === 0) lines.push(`${k}: []`);
        else {
          lines.push(`${k}:`);
          for (const item of v) lines.push(`  - ${jsonStable(item)}`);
        }
      } else if (typeof v === 'object' && v !== null) {
        lines.push(`${k}:`);
        const nested = JSON.stringify(v, null, 2)
          .split('\n').map(s => '  ' + s).join('\n');
        lines.push(nested);
      } else if (typeof v === 'string') {
        lines.push(`${k}: ${escapeYamlString(v)}`);
      } else {
        lines.push(`${k}: ${v}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  private buildBuilderPrompt(session: SkillBuilderSession, userMessage: string): { system: string; userContext: string } {
    const filled = session.draftFilledFields;
    const pending = session.pendingFields;
    const draftSummary = JSON.stringify(this.draftToFrontmatter(session), null, 2);
    const fieldHints = pending.map(f => `- ${f}: ${FIELD_HUMAN[f] || ''}`).join('\n');
    const mode = session.draft.executionMode;
    const isScripted = mode === 'script' || mode === 'hybrid';
    const hasScript = !!(session.draft as any).scriptContent;
    const scriptStatus = isScripted
      ? (hasScript
          ? '当前 scriptContent 已存在，本次可继续完善或保持不变'
          : '⚠️ 当前 execution_mode 是 script/hybrid，但 scriptContent 仍为空，请在本次回复的 draft_updates 中生成完整 Python 脚本')
      : '当前 execution_mode 是 llm_only，无需脚本';

    const system = `你是 CORAL 平台的 Skill 创建助手，需要通过多轮中文对话，把用户的「能力需求」转换为可执行的 SKILL.md（必要时含 scripts/main.py）。

# 当前已收集字段
${filled.length > 0 ? filled.join(', ') : '（暂无）'}

# 当前 Draft 草稿
\`\`\`yaml
${draftSummary}
\`\`\`

# 还需要澄清的字段
${fieldHints || '（已基本完整，可询问用户是否继续完善 prompt 或直接预览）'}

# 脚本状态
${scriptStatus}

# 严格输出协议（极其重要，请逐字遵守）

每次回复**必须**包含一段 \`<JSON>...</JSON>\` 块。当且仅当 execution_mode 是 script 或 hybrid 且需要生成/更新脚本时，**额外**再输出一段 \`<SCRIPT>\` 块。两段块之间可以有自然语言文本，但解析器只会读取标签内的内容。

## 第一段：<JSON> 块（必须）
\`\`\`
<JSON>
{
  "reply": "中文回复，可以追问 1-2 个问题；所有字段就绪时明确告知用户『信息已收集完毕，可以提交了』",
  "draft_updates": {
    "name": "kebab-case 名称（^[a-z][a-z0-9-]{1,40}$）",
    "description": "一句话能力描述",
    "domain": "general | data-processing | text-processing | information-processing | ...",
    "capabilities": ["..."],
    "input_schema": { "type": "object", "properties": { "字段名": { "type": "string", "description": "..." } }, "required": ["字段名"] },
    "output_schema": { "type": "object", "properties": { ... } },
    "execution_mode": "llm_only|script|hybrid",
    "estimated_duration_ms": 30000,
    "tags": ["..."],
    "promptContent": "Markdown 文本，包含技能用途、执行步骤、参数说明",
    "scriptEntry": "scripts/main.py",
    "referenceContent": "可选 reference.md"
  },
  "fields_pending": ["还需要用户回答的字段名（snake_case）"],
  "ready_to_preview": false
}
</JSON>
\`\`\`

**关键约束**：
- JSON 内**绝对不要**放 \`scriptContent\` 字段。脚本永远写到下面的 \`<SCRIPT>\` 块中，避免 JSON 字符串转义错误。
- JSON 必须是合法的（双引号、无尾逗号、字符串内换行用 \\n 转义）。

## 第二段：<SCRIPT> 块（仅 script/hybrid 模式且需要生成脚本时输出）
\`\`\`
<SCRIPT>
\`\`\`python
#!/usr/bin/env python3
import sys, json, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '_lib'))
from coral_progress import emit_progress, emit_log, emit_artifact

def main():
    raw = sys.stdin.read()
    inputs = json.loads(raw) if raw else {}
    emit_progress(0, 100, '开始执行')
    # ... 业务逻辑 ...
    emit_progress(100, 100, '完成')
    print(json.dumps({"ok": True, "result": "..."}, ensure_ascii=False))

if __name__ == '__main__':
    main()
\`\`\`
</SCRIPT>
\`\`\`

**关键约束**：
- 脚本写在 \`\`\`python ... \`\`\` 围栏中，**原样输出 Python 源码**，不需要任何转义
- 每行长度合理，不要把整个脚本压成一行
- 必须 \`from coral_progress import emit_progress, emit_log, emit_artifact\`
- JSON stdin 读输入，JSON stdout 输出最终结果，stderr 走 emit_progress / emit_log
- 如果脚本未变化无需重发可以省略 <SCRIPT> 块；但当**当前 scriptContent 仍为空**时**必须**输出完整 <SCRIPT>

# 反问优先级
1. name & description
2. execution_mode（默认 llm_only；如果用户说"抓取/采集/转换/计算/Word/Excel/网页交互"等 → 推荐 script）
3. input_schema / output_schema
4. tags & domain（可自动推断）
5. promptContent（生成完整 prompt 草稿）
6. **当 mode=script/hybrid → 立即在本轮的 <SCRIPT> 块中给出完整脚本**

# 规则
- 一次只问 1-2 个问题
- 当所有 P0 字段（name/description/execution_mode/input_schema/output_schema/tags + 必要时脚本）确定 → 设 ready_to_preview: true，并在 reply 中**主动告知用户『信息已收集完毕，可点击右上角"提交"生成技能』**
- name 必须满足 ^[a-z][a-z0-9-]{1,40}$
- mode=script/hybrid 但 <SCRIPT> 仍未输出时，**严禁** ready_to_preview: true
- 不论上下文倾向都必须严格输出 <JSON> 块，否则解析失败用户体验会很差`;

    const userContext = userMessage;

    return { system, userContext };
  }
}

function escapeYamlString(s: string): string {
  if (/[:#&*!|>'"%@`{}[\]]/.test(s) || s.includes('\n') || s.startsWith(' ') || s.endsWith(' ')) {
    return JSON.stringify(s);
  }
  return s;
}

function jsonStable(v: any): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return escapeYamlString(v);
  return JSON.stringify(v);
}

// ────────────────────────────────────────────────────────────────────
// LLM 响应鲁棒解析器（v1.1.1 新增）
// ────────────────────────────────────────────────────────────────────

interface ParsedBuilderResponse {
  reply: string;
  draft_updates: Record<string, any>;
  fields_pending: string[] | null;
  ready_to_preview: boolean;
  /** 从 fenced 代码块独立抽取的 Python 脚本（优先级高于 JSON 内字段） */
  fencedScript: string | null;
  /** 调试用：哪种策略解析成功 */
  parseStrategy: 'tagged' | 'fenced-json' | 'raw-json' | 'brace-balanced' | 'none';
}

/**
 * 优先抽取 <SCRIPT> 标签或 ```python``` 代码块中的 Python 脚本
 * 这种方式让 Python 源码不需要 JSON 转义，避免 LLM 输出大量 \\n / \\" 时的格式破损
 */
function extractFencedPython(text: string): string | null {
  if (!text) return null;
  // 1) <SCRIPT>...</SCRIPT> 标签内的代码块（首选）
  const taggedScript = text.match(/<SCRIPT>([\s\S]*?)<\/SCRIPT>/i);
  if (taggedScript) {
    const inner = taggedScript[1];
    const fenced = inner.match(/```(?:python|py)?\s*\n?([\s\S]*?)```/i);
    if (fenced && fenced[1].trim()) return fenced[1].trim();
    // 标签内若直接是裸代码（没有 ``` fence），原样返回
    const naked = inner.trim();
    if (naked && /\b(import|def|print)\b/.test(naked)) return naked;
  }

  // 2) 退化：全文里最长的 ```python``` 代码块
  const fences = [...text.matchAll(/```(?:python|py)\s*\n?([\s\S]*?)```/gi)];
  if (fences.length === 0) return null;
  const longest = fences.map(m => m[1]).sort((a, b) => b.length - a.length)[0];
  return longest.trim() || null;
}

/** 抽 <JSON>...</JSON> 标签内的 JSON 字符串 */
function extractTaggedJson(text: string): string | null {
  const m = text.match(/<JSON>([\s\S]*?)<\/JSON>/i);
  return m ? m[1].trim() : null;
}

/** 抽 ```json ... ``` 围栏内的 JSON */
function extractFencedJson(text: string): string | null {
  const m = text.match(/```json\s*\n?([\s\S]*?)```/i);
  return m ? m[1].trim() : null;
}

/** 鲁棒 JSON 解析：直接 parse → brace-balanced 抽取 */
function tryJsonParseRobust(text: string): { value: any; strategy: 'raw-json' | 'brace-balanced' } | null {
  if (!text) return null;
  const s = text.trim();
  try { return { value: JSON.parse(s), strategy: 'raw-json' }; } catch { /* 容错 */ }

  // brace-balanced 抽取第一个完整 {...} 子串
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const cand = s.slice(start, i + 1);
          try { return { value: JSON.parse(cand), strategy: 'brace-balanced' }; } catch { return null; }
        }
      }
    }
  }
  return null;
}

/**
 * 解析 SkillBuilder LLM 响应，鲁棒到这些场景：
 *  · 严格的 <JSON>+<SCRIPT> 双段输出
 *  · ```json ... ``` + ```python ... ``` 围栏
 *  · 裸 JSON
 *  · JSON 不闭合（截断） → brace-balanced 部分恢复
 *  · 把 Python 脚本错塞进 JSON 字符串导致解析失败 → 仍能从 ```python``` 围栏抽出脚本
 */
export function parseBuilderResponse(raw: string): ParsedBuilderResponse {
  const text = raw || '';
  const fencedScript = extractFencedPython(text);

  let json: any = null;
  let strategy: ParsedBuilderResponse['parseStrategy'] = 'none';

  // 1) <JSON> 标签
  const tagged = extractTaggedJson(text);
  if (tagged) {
    const r = tryJsonParseRobust(tagged);
    if (r) { json = r.value; strategy = 'tagged'; }
  }

  // 2) ```json``` 围栏
  if (!json) {
    const fenced = extractFencedJson(text);
    if (fenced) {
      const r = tryJsonParseRobust(fenced);
      if (r) { json = r.value; strategy = 'fenced-json'; }
    }
  }

  // 3) 裸 JSON / brace-balanced（先剥掉 python 围栏与 SCRIPT 标签，避免干扰）
  if (!json) {
    const stripped = text
      .replace(/<SCRIPT>[\s\S]*?<\/SCRIPT>/gi, '')
      .replace(/```(?:python|py)\s*\n?[\s\S]*?```/gi, '')
      .replace(/```json\s*\n?/gi, '')
      .replace(/```/g, '')
      .trim();
    const r = tryJsonParseRobust(stripped);
    if (r) { json = r.value; strategy = r.strategy; }
  }

  return {
    reply: typeof json?.reply === 'string' ? json.reply : '',
    draft_updates: (json?.draft_updates && typeof json.draft_updates === 'object') ? json.draft_updates : {},
    fields_pending: Array.isArray(json?.fields_pending) ? json.fields_pending : null,
    ready_to_preview: Boolean(json?.ready_to_preview),
    fencedScript: fencedScript || null,
    parseStrategy: strategy,
  };
}

/**
 * 把助手历史消息中的大块 Python 代码裁剪掉，防止 context window 被脚本撑爆
 * scriptContent 已持久化在 session.draft，下一轮 prompt 通过 draftSummary 让 LLM 知道
 */
function stripPythonFences(text: string): string {
  if (!text) return '';
  return text
    .replace(/<SCRIPT>[\s\S]*?<\/SCRIPT>/gi, '<SCRIPT>...（已存档于 draft.scriptContent）...</SCRIPT>')
    .replace(/```(?:python|py)\s*\n?[\s\S]*?```/gi, '```python\n...（已存档于 draft.scriptContent）...\n```');
}
