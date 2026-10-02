import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 兜底错误边界。
 * - 任何子组件抛出渲染期错误，都不会再让整个页面变黑屏
 * - 显示友好的错误信息 + 一键刷新按钮
 * - 同时把错误打到 console，便于排查
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[CORAL ErrorBoundary]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    const msg = this.state.error.message || String(this.state.error);
    return (
      <div className="min-h-screen flex items-center justify-center p-8 bg-bg-base text-fg-primary">
        <div className="glass rounded-2xl p-8 max-w-2xl w-full">
          <h1 className="text-xl font-heading font-bold text-status-danger mb-2">
            页面渲染异常
          </h1>
          <p className="text-sm text-fg-muted mb-4">
            前端遇到一个意外错误，但平台后端仍在运行。你可以：
          </p>
          <pre className="bg-bg-panel/60 rounded-lg p-3 text-xs font-mono text-status-danger whitespace-pre-wrap break-all max-h-60 overflow-auto mb-4">
            {msg}
          </pre>
          <div className="flex gap-3">
            <button
              onClick={this.reset}
              className="px-4 py-2 rounded-lg bg-brand text-white font-medium text-sm hover:bg-brand-hover transition-colors cursor-pointer"
            >
              重试
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg bg-bg-elev/50 text-fg-secondary text-sm hover:bg-bg-elev transition-colors cursor-pointer"
            >
              刷新页面
            </button>
            <button
              onClick={() => (window.location.href = '/tasks')}
              className="px-4 py-2 rounded-lg bg-bg-elev/50 text-fg-secondary text-sm hover:bg-bg-elev transition-colors cursor-pointer"
            >
              返回任务列表
            </button>
          </div>
        </div>
      </div>
    );
  }
}
