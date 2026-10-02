import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
export type EffectiveTheme = 'dark' | 'light';

interface ThemeContextValue {
  /** 用户配置：'dark' | 'light' | 'system' */
  mode: ThemeMode;
  /** 实际生效的主题（system 模式会被解析） */
  effective: EffectiveTheme;
  setMode: (mode: ThemeMode) => void;
  /** 在 dark / light 之间快速切换（system 模式会被切换为反向的固定模式） */
  toggle: () => void;
}

const STORAGE_KEY = 'coral.theme';
const DEFAULT_MODE: ThemeMode = 'dark';

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): EffectiveTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    // ignore (private mode / 受限环境)
  }
  return DEFAULT_MODE;
}

function applyDarkClass(effective: EffectiveTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (effective === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  root.dataset.theme = effective;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
  const [systemTheme, setSystemTheme] = useState<EffectiveTheme>(() => getSystemTheme());

  // 监听系统主题变化（仅在 mode === 'system' 时生效）
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);

  const effective: EffectiveTheme = mode === 'system' ? systemTheme : mode;

  // 主题变化时立刻同步到 <html>
  useEffect(() => {
    applyDarkClass(effective);
  }, [effective]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const toggle = useCallback(() => {
    setMode(effective === 'dark' ? 'light' : 'dark');
  }, [effective, setMode]);

  const value = useMemo(
    () => ({ mode, effective, setMode, toggle }),
    [mode, effective, setMode, toggle]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}

/**
 * 在 React 应用挂载之前同步初始化主题，避免「闪一下浅色再变深色」。
 * 在 main.tsx 中尽早调用一次。
 */
export function bootstrapTheme(): void {
  const stored = readStoredMode();
  const sys = getSystemTheme();
  const effective: EffectiveTheme = stored === 'system' ? sys : stored;
  applyDarkClass(effective);
}
