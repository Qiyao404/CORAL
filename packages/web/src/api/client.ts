const BASE_URL = '/api';

interface RequestOptions extends RequestInit {
  /** 自动附加 X-Confirm-Builtin 头（仅删除/编辑内置 Skill 时） */
  confirmBuiltin?: string;
  /** raw response（不解析 JSON） */
  raw?: boolean;
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
  resolveApproval: (runId: string, approvalId: string, approved: boolean) =>
    request<any>(`/runs/${runId}/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    }),

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
