const BASE_URL = '/api';

interface RequestOptions extends RequestInit {
  /** 自动附加 X-Confirm-Builtin 头（仅删除/编辑内置 Skill 时） */
  confirmBuiltin?: string;
  /** raw response（不解析 JSON） */
  raw?: boolean;
  /** 终审 P1：超时毫秒（默认 30s；长操作如 AI 编排/技能测试/上传传 120000-300000） */
  timeoutMs?: number;
}

async function request<T>(url: string, options?: RequestOptions): Promise<T> {
  // 仅当请求带 body 时才声明 application/json
  // 否则 Fastify 看到 Content-Type: application/json 但 body 为空会返回 415
  // （影响 commitBuilder / cancelTask / activateLlmConfig 等无 body 的 POST 调用）
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> | undefined),
  };
  if (options?.body !== undefined && options?.body !== null) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  if (options?.confirmBuiltin) {
    headers['X-Confirm-Builtin'] = options.confirmBuiltin;
  }
  const res = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers,
    // 终审 P1：调用方 signal 优先；默认 30s 但长操作（AI 编排/技能测试/上传）可覆盖
    signal: options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 30_000),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: '请求失败' }));
    const err = new Error(error.error || `HTTP ${res.status}`) as any;
    err.status = res.status;
    err.code = error.code;
    throw err;
  }
  if (options?.raw) return (res as unknown) as T;
  return res.json();
}

export const api = {
  // 系统
  health: () => request<any>('/health'),
  config: () => request<any>('/config'),
  stats: () => request<any>('/stats'),

  // LLM 配置
  listLlmConfigs: () => request<any>('/llm/configs'),
  saveLlmConfig: (payload: {
    profileId?: string;
    name: string;
    provider?: 'openai-compat' | 'anthropic';
    baseUrl: string;
    model: string;
    apiKey?: string;
    setActive?: boolean;
  }) =>
    request<any>('/llm/configs', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  activateLlmConfig: (profileId: string) =>
    request<any>(`/llm/configs/${profileId}/activate`, { method: 'POST' }),
  deleteLlmConfig: (profileId: string) =>
    request<any>(`/llm/configs/${profileId}`, { method: 'DELETE' }),

  // 任务
  createTask: (goal: string, constraints?: any) =>
    request<any>('/tasks', {
      method: 'POST',
      body: JSON.stringify({ goal, constraints }),
    }),
  listTasks: (params?: { status?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.limit) qs.set('limit', String(params.limit));
    return request<any>(`/tasks?${qs}`);
  },
  getTask: (taskId: string) => request<any>(`/tasks/${taskId}`),
  cancelTask: (taskId: string) =>
    request<any>(`/tasks/${taskId}/cancel`, { method: 'POST' }),

  // 聊天
  chat: (message: string) =>
    request<any>('/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  // Skills
  listSkills: (params?: { source?: 'builtin' | 'user'; domain?: string; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.source) qs.set('source', params.source);
    if (params?.domain) qs.set('domain', params.domain);
    if (params?.status) qs.set('status', params.status);
    return request<any>(`/skills?${qs}`);
  },
  getSkill: (name: string, full = false) => request<any>(`/skills/${name}${full ? '?full=1' : ''}`),
  testSkill: (name: string, input: any, companyProfileOverride?: any) =>
    request<any>(`/skills/${name}/test`, {
      method: 'POST',
      body: JSON.stringify({ input, companyProfileOverride }),
    }),
  updateSkill: (name: string, payload: { frontmatter: any; promptContent: string; referenceContent?: string; scriptContent?: string }, confirmBuiltin?: string) =>
    request<any>(`/skills/${name}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      confirmBuiltin,
    }),
  deleteSkill: (name: string, opts: { physical?: boolean; confirmBuiltin?: string } = {}) =>
    request<any>(`/skills/${name}${opts.physical ? '?physical=true' : ''}`, {
      method: 'DELETE',
      confirmBuiltin: opts.confirmBuiltin,
    }),
  artifactUrl: (skillName: string, path: string) =>
    `${BASE_URL}/skills/${skillName}/artifacts?path=${encodeURIComponent(path)}`,

  // Skill Builder
  createBuilderSession: (userId: string = 'anonymous') =>
    request<any>('/skill-builder/sessions', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  getBuilderSession: (sessionId: string) => request<any>(`/skill-builder/sessions/${sessionId}`),
  listBuilderSessions: (userId?: string) => {
    const qs = userId ? `?userId=${userId}` : '';
    return request<any>(`/skill-builder/sessions${qs}`);
  },
  sendBuilderMessage: (sessionId: string, content: string) =>
    request<any>(`/skill-builder/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  patchBuilderDraft: (sessionId: string, patch: Record<string, any>) =>
    request<any>(`/skill-builder/sessions/${sessionId}/draft`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  getBuilderPreview: (sessionId: string) =>
    request<any>(`/skill-builder/sessions/${sessionId}/preview`),
  commitBuilder: (sessionId: string, overwrite = false) =>
    request<any>(`/skill-builder/sessions/${sessionId}/commit${overwrite ? '?overwrite=true' : ''}`, {
      method: 'POST',
    }),
  cancelBuilder: (sessionId: string) =>
    request<any>(`/skill-builder/sessions/${sessionId}`, { method: 'DELETE' }),

  // 公司画像
  getCompanyProfile: () => request<any>('/company-profile'),
  putCompanyProfile: (payload: any) =>
    request<any>('/company-profile', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  resetCompanyProfile: () =>
    request<any>('/company-profile/reset', { method: 'POST' }),

  // 事件
  listEvents: (params?: { taskId?: string; limit?: number; type?: string }) => {
    const qs = new URLSearchParams();
    if (params?.taskId) qs.set('taskId', params.taskId);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.type) qs.set('type', params.type);
    return request<any>(`/events?${qs}`);
  },

  // ─── M1-8：v2 Runs（Free 模式 agent 会话）────────────────
  createRun: (payload: { goal: string; sessionId?: string; workspaceId?: string; continueSession?: boolean; extraSystem?: string; budget?: { maxSteps?: number; maxTokens?: number } }) =>
    request<any>('/runs', { method: 'POST', body: JSON.stringify(payload) }),
  listRuns: (params?: { sessionId?: string; status?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.sessionId) qs.set('sessionId', params.sessionId);
    if (params?.status) qs.set('status', params.status);
    if (params?.limit) qs.set('limit', String(params.limit));
    return request<any>(`/runs?${qs}`);
  },
  getRun: (runId: string) => request<any>(`/runs/${runId}`),
  getRunEvents: (runId: string, afterSeq = 0) =>
    request<any>(`/runs/${runId}/events?afterSeq=${afterSeq}`),
  cancelRun: (runId: string) =>
    request<any>(`/runs/${runId}/cancel`, { method: 'POST' }),
  deleteRun: (runId: string) =>
    request<any>(`/runs/${runId}`, { method: 'DELETE' }),
  deleteSession: (sessionId: string) =>
    request<any>(`/sessions/${sessionId}`, { method: 'DELETE' }),
  resolveApproval: (runId: string, approvalId: string, approved: boolean, input?: Record<string, any>) =>
    request<any>(`/runs/${runId}/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ approved, ...(input ? { input } : {}) }),
    }),

  // ─── M2：Graph 模式 ───────────────────────────────────────
  createGraphRun: (payload: { goal: string; graph: string; input?: Record<string, any>; workspaceId?: string }) =>
    request<any>('/runs', {
      method: 'POST',
      body: JSON.stringify({ ...payload, mode: 'graph' }),
    }),
  validateGraph: (graph: string) =>
    request<any>('/graphs/validate', { method: 'POST', body: JSON.stringify({ graph }) }),
  compileGraph: (goal: string) =>
    request<any>('/graphs/compile', { method: 'POST', body: JSON.stringify({ goal }), timeoutMs: 180_000 }), // AI 编排含自愈重试
  listResumable: () => request<any>('/runs/graph/resumable'),
  resumeRun: (runId: string) => request<any>(`/runs/${runId}/resume`, { method: 'POST' }),
  listPendingApprovals: () => request<any>('/approvals/pending'),

  // ─── M3：连接器（MCP + 触发器）────────────────────────────
  listMcpServers: () => request<any>('/mcp/servers'),
  addMcpServer: (payload: { name: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; env?: Record<string, string> }) =>
    request<any>('/mcp/servers', { method: 'POST', body: JSON.stringify(payload) }),
  toggleMcpServer: (id: string, enabled: boolean) =>
    request<any>(`/mcp/servers/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  reconnectMcpServer: (id: string) =>
    request<any>(`/mcp/servers/${id}/reconnect`, { method: 'POST' }),
  deleteMcpServer: (id: string) =>
    request<any>(`/mcp/servers/${id}`, { method: 'DELETE' }),
  getClaudeConfig: () => request<any>('/mcp/claude-desktop-config'),
  listTriggers: () => request<any>('/triggers'),
  // ─── M4-1：Time-Travel ───────────────────────────────────
  getRunCheckpoints: (runId: string) => request<any>(`/runs/${runId}/checkpoints`),
  forkRun: (runId: string, fromSeq: number, instruction?: string) =>
    request<any>(`/runs/${runId}/fork`, {
      method: 'POST',
      body: JSON.stringify({ fromSeq, ...(instruction ? { instruction } : {}) }),
    }),
  createTrigger: (payload: { name: string; kind: string; spec: string; action: { mode: string; goal: string } }) =>
    request<any>('/triggers', { method: 'POST', body: JSON.stringify(payload) }),
  toggleTrigger: (id: string, enabled: boolean) =>
    request<any>(`/triggers/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteTrigger: (id: string) =>
    request<any>(`/triggers/${id}`, { method: 'DELETE' }),

  // ─── M1-10：工作区 ────────────────────────────────────────
  listWorkspaces: () => request<any>('/workspaces'),
  createWorkspace: (payload: { name: string; dir: string; permission?: string }) =>
    request<any>('/workspaces', { method: 'POST', body: JSON.stringify(payload) }),
  activateWorkspace: (id: string) =>
    request<any>(`/workspaces/${id}/activate`, { method: 'POST' }),
  updateWorkspace: (id: string, patch: { name?: string; permission?: string }) =>
    request<any>(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWorkspace: (id: string) =>
    request<any>(`/workspaces/${id}`, { method: 'DELETE' }),

  // ─── 创新点：上传 / 记忆 / 导出 ──────────────────────────
  uploadWorkspaceFile: (id: string, path: string, content: string, encoding?: 'base64') =>
    request<any>(`/workspaces/${id}/files`, { method: 'POST', body: JSON.stringify({ path, content, encoding }) }),
  listWorkspaceFiles: (id: string) => request<any>(`/workspaces/${id}/files`),
  listMemory: () => request<any>('/memory'),
  getMemory: (name: string) => request<any>(`/memory/${encodeURIComponent(name)}`),
  saveMemory: (name: string, content: string) =>
    request<any>(`/memory/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  deleteMemory: (name: string) =>
    request<any>(`/memory/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};
