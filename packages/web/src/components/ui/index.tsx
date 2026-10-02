import { forwardRef, type ButtonHTMLAttributes, type ReactNode, useEffect } from 'react';
import {
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  PlayCircle,
  PauseCircle,
  X,
} from 'lucide-react';

// ─── Button ─────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover active:bg-brand-active active:scale-[0.98] shadow-sm',
  secondary:
    'glass text-fg-primary border border-glass-borderStrong hover:bg-bg-elev/60 hover:border-glass-borderStrong',
  ghost: 'text-fg-secondary hover:text-fg-primary hover:bg-bg-elev/40',
  danger:
    'bg-status-danger/15 text-status-danger border border-status-danger/30 hover:bg-status-danger/25',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs rounded-lg',
  md: 'px-4 py-2 text-sm rounded-xl',
  lg: 'px-5 py-2.5 text-sm rounded-xl',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', variant = 'primary', size = 'md', loading, icon, children, disabled, ...props },
  ref
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      disabled={isDisabled}
      className={`inline-flex items-center justify-center gap-2 font-semibold transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...props}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {!loading && icon}
      {children}
    </button>
  );
});

// ─── Card ─────────────────────────────────────

interface CardProps {
  className?: string;
  children?: ReactNode;
  interactive?: boolean;
  onClick?: () => void;
}

export function Card({ className = '', children, interactive, onClick }: CardProps) {
  const base = 'glass rounded-2xl p-5';
  const hoverable = interactive ? 'glass-hover cursor-pointer' : '';
  return (
    <div className={`${base} ${hoverable} ${className}`} onClick={onClick}>
      {children}
    </div>
  );
}

// ─── Tag / Badge ─────────────────────────────────────

type TagVariant = 'default' | 'success' | 'warn' | 'danger' | 'info' | 'brand';

const TAG_VARIANT: Record<TagVariant, string> = {
  default: 'bg-bg-elev/60 text-fg-secondary border border-glass-border',
  success: 'bg-status-success/15 text-status-success border border-status-success/30',
  warn: 'bg-status-warn/15 text-status-warn border border-status-warn/30',
  danger: 'bg-status-danger/15 text-status-danger border border-status-danger/30',
  info: 'bg-status-info/15 text-status-info border border-status-info/30',
  brand: 'bg-brand-soft text-brand border border-brand/30',
};

export function Tag({ variant = 'default', children, className = '' }: { variant?: TagVariant; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full text-xs px-2.5 py-0.5 font-medium ${TAG_VARIANT[variant]} ${className}`}>
      {children}
    </span>
  );
}

// ─── ProgressBar ─────────────────────────────────────

export function ProgressBar({
  value,
  status = 'running',
  showText = true,
  className = '',
  compact = false,
}: {
  value: number;
  status?: 'running' | 'completed' | 'failed' | 'pending';
  showText?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const heightClass = compact ? 'h-1.5' : 'h-2';
  const isRunning = status === 'running' && pct < 100;
  const fillClass = (() => {
    if (status === 'failed') return 'bg-status-danger';
    if (status === 'completed' || pct >= 100) return 'bg-status-success';
    if (status === 'pending') return 'bg-fg-disabled';
    return 'progress-bar-fill';
  })();

  return (
    <div className={className}>
      <div className={`w-full bg-bg-raise/60 rounded-full overflow-hidden ${heightClass}`}>
        <div
          className={`${heightClass} rounded-full ${fillClass} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showText && !compact && (
        <div className="text-xs text-fg-muted mt-1.5 flex items-center justify-between">
          <span>{isRunning ? '运行中' : status === 'completed' || pct >= 100 ? '已完成' : status === 'failed' ? '失败' : '等待中'}</span>
          <span className="font-mono">{pct.toFixed(0)}%</span>
        </div>
      )}
    </div>
  );
}

// ─── StatusIcon ─────────────────────────────────────

const STATUS_ICONS: Record<string, ReactNode> = {
  pending: <Clock className="w-4 h-4 text-status-pending" />,
  running: <PlayCircle className="w-4 h-4 text-status-info animate-pulse" />,
  suspended: <PauseCircle className="w-4 h-4 text-status-warn" />,
  completed: <CheckCircle2 className="w-4 h-4 text-status-success" />,
  failed: <XCircle className="w-4 h-4 text-status-danger" />,
  cancelled: <AlertTriangle className="w-4 h-4 text-fg-muted" />,
};

export function StatusIcon({ status, className = '' }: { status: string; className?: string }) {
  const icon = STATUS_ICONS[status] || STATUS_ICONS.pending;
  return <span className={className}>{icon}</span>;
}

// ─── Skeleton ─────────────────────────────────────

export function Skeleton({ className = '', height = 'h-4', width = 'w-full' }: { className?: string; height?: string; width?: string }) {
  return <div className={`skeleton ${height} ${width} ${className}`} />;
}

// ─── EmptyState ─────────────────────────────────────

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {icon && <div className="mb-4 text-fg-muted">{icon}</div>}
      <h3 className="text-fg-primary font-semibold mb-1">{title}</h3>
      {description && <p className="text-fg-muted text-sm max-w-md">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ─── Modal ─────────────────────────────────────

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-md' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in-up"
        onClick={onClose}
      />
      <div className={`relative glass rounded-2xl w-full ${width} animate-fade-in-up`}>
        {title && (
          <div className="flex items-center justify-between p-5 border-b border-glass-border">
            <h3 className="font-semibold text-fg-primary">{title}</h3>
            <button onClick={onClose} className="text-fg-muted hover:text-fg-primary cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        )}
        <div className="p-5">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-glass-border flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

// ─── Drawer ─────────────────────────────────────

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  side?: 'right' | 'left';
}

export function Drawer({ open, onClose, title, children, footer, width = 'max-w-3xl', side = 'right' }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const sideClass = side === 'right' ? 'right-0' : 'left-0';
  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={`absolute top-0 ${sideClass} h-full w-full ${width} glass rounded-none border-r-0 border-l border-glass-borderStrong animate-fade-in-up flex flex-col`}
      >
        {title && (
          <div className="flex items-center justify-between p-5 border-b border-glass-border">
            <h3 className="font-semibold text-fg-primary">{title}</h3>
            <button onClick={onClose} className="text-fg-muted hover:text-fg-primary cursor-pointer">
              <X className="w-5 h-5" />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-auto p-5">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-glass-border flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

// ─── Input / Textarea / Select ─────────────────────────────────────

export function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full bg-bg-panel/60 backdrop-blur border border-glass-border rounded-lg px-3 py-2 text-sm text-fg-primary placeholder:text-fg-disabled focus:border-brand focus:ring-2 focus:ring-brand/30 focus:outline-none transition-colors ${className}`}
      {...props}
    />
  );
}

export function Textarea({ className = '', ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full bg-bg-panel/60 backdrop-blur border border-glass-border rounded-lg px-3 py-2 text-sm text-fg-primary placeholder:text-fg-disabled focus:border-brand focus:ring-2 focus:ring-brand/30 focus:outline-none transition-colors resize-y ${className}`}
      {...props}
    />
  );
}

export function Select({ className = '', children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full bg-bg-panel/60 backdrop-blur border border-glass-border rounded-lg px-3 py-2 text-sm text-fg-primary focus:border-brand focus:ring-2 focus:ring-brand/30 focus:outline-none transition-colors cursor-pointer ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

// ─── ConnectionDot ─────────────────────────────────────

export function ConnectionDot({
  state,
  label,
}: {
  state: 'connected' | 'disconnected' | 'connecting' | 'partial';
  label?: string;
}) {
  const color = state === 'connected'
    ? 'bg-status-success'
    : state === 'connecting'
    ? 'bg-status-warn animate-pulse'
    : state === 'partial'
    ? 'bg-status-info'
    : 'bg-status-danger';

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}
