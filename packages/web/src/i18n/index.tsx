import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { zh } from './zh';
import { en } from './en';

/**
 * 平台国际化（中/英一键切换）。
 *
 * · key 形如 '<ns>.<id>'（扁平字典，zh 为权威语言；en 缺失时回退 zh）
 * · t(key, params) 支持 {name} 占位符插值
 * · 语言持久化在 localStorage（coral-lang）；未设置时按浏览器语言检测
 * · 渐进式覆盖：尚未迁移的字符串不包 t() 时原样显示 — 不影响功能
 */

export type Lang = 'zh' | 'en';

export const LANG_STORAGE_KEY = 'coral-lang';

export const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* localStorage 不可用（隐私模式） */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'zh';
  return nav && nav.toLowerCase().startsWith('en') ? 'en' : 'zh';
}

interface I18nValue {
  lang: Lang;
  setLang(lang: Lang): void;
  toggle(): void;
  t(key: string, params?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(detectLang);

  useEffect(() => {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch { /* 忽略持久化失败 */ }
    document.documentElement.setAttribute('lang', lang);
  }, [lang]);

  const value = useMemo<I18nValue>(() => ({
    lang,
    setLang,
    toggle: () => setLang(l => (l === 'zh' ? 'en' : 'zh')),
    t: (key, params) => {
      const dict = lang === 'en' ? en : zh;
      let text: string = dict[key] ?? zh[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          text = text.split(`{${k}}`).join(String(v));
        }
      }
      return text;
    },
  }), [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n 必须在 I18nProvider 内使用');
  return ctx;
}
