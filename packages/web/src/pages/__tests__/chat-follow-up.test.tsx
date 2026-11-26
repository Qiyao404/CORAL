// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ChatPage from '../ChatPage';

const { createRun, injectRunInput } = vi.hoisted(() => ({
  createRun: vi.fn(async (_payload: { sessionId: string; goal: string; workspaceId?: string }) => ({ runId: 'new-run' })),
  injectRunInput: vi.fn(),
}));

vi.mock('../../api/client', () => {
  const rows = [
    { id: 'a', session_id: 'session-a', status: 'running' },
    { id: 'b', session_id: 'session-b', status: 'completed' },
    { id: 'eval', session_id: 'benchmark', status: 'running' },
  ].map(row => ({ ...row, goal: row.id, automation_session: row.id === 'eval', created_at: '2026-11-01' }));
  return { api: {
    listRuns: async ({ sessionId }: { sessionId?: string }) => ({ items: rows.filter(r => !sessionId || r.session_id === sessionId) }),
    getRun: async (id: string) => ({
      run: rows.find(row => row.id === id),
      events: id === 'b' ? [completed(id)] : [],
    }),
    listWorkspaces: async () => ({ items: [{ id: 'ws-a', name: 'A' }, { id: 'ws-b', name: 'B' }] }),
    commands: async () => ({ items: [] }),
    workspaceFiles: async () => ({ items: [] }),
    sessionArtifacts: async () => ({ byRun: {} }),
    getSessionContextUsage: async () => ({}),
    createRun, injectRunInput,
  } };
});
vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function completed(runId: string) {
  return { eventId: runId + '-end', seq: 1, type: 'run.completed', runId, payload: {} };
}

class Stream {
  static open = new Set<Stream>();
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) { Stream.open.add(this); }
  close() { Stream.open.delete(this); }
}

let mount: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', Stream);
  localStorage.setItem('coral.workspaceId', 'ws-a');
  mount = document.body.appendChild(document.createElement('div'));
  root = createRoot(mount);
  await act(async () => root.render(<MemoryRouter><ChatPage /></MemoryRouter>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  mount.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function openSession(id: string) {
  const item = Array.from(mount.querySelectorAll<HTMLElement>('aside p.truncate')).find(p => p.textContent === id)!;
  await act(async () => item.click());
}
async function typeMessage(text: string) {
  const area = mount.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return area;
}
async function submit(text: string) {
  const area = await typeMessage(text);
  await act(async () => { area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}

it('在 B 中浏览时，A 的排队消息只在 A 结束后发往原会话和工作区', async () => {
  await openSession('a');
  await submit('A follow-up');
  const queue = Array.from(mount.querySelectorAll('button')).find(b => b.textContent.includes('chat.injectQueue'))!;
  await act(async () => queue.click());
  await openSession('b');
  expect(createRun).not.toHaveBeenCalled();

  const workspace = mount.querySelector('select')!;
  await act(async () => {
    workspace.value = 'ws-b';
    workspace.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const draft = await typeMessage('B draft');
  await act(async () => {
    for (const stream of Stream.open) {
      if (stream.url === '/api/runs/a/stream') stream.onmessage?.({ data: JSON.stringify(completed('a')) });
    }
  });
  expect(createRun).toHaveBeenCalledTimes(1);
  expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ goal: 'A follow-up', sessionId: 'session-a', workspaceId: 'ws-a' }));
  expect(draft.value).toBe('B draft');
});

it('运行中的评测会话直接新开个人会话', async () => {
  await openSession('eval');
  await submit('personal request');
  expect(createRun).toHaveBeenCalledTimes(1);
  expect(createRun.mock.calls[0][0].sessionId).toMatch(/^sess_/);
  expect(injectRunInput).not.toHaveBeenCalled();
  expect([...Stream.open].map(stream => stream.url)).toContain('/api/runs/new-run/stream');
});
