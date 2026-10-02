/** @type {import('tailwindcss').Config} */
// CORAL v1.1.0 - 设计 tokens（Glassmorphism + 双主题深/浅色）
// 详见 docs/DESIGN.md §16 视觉设计系统
//
// 所有颜色通过 CSS 变量驱动，业务代码无需关心当前主题：
//  - 浅色定义在 :root         （src/index.css）
//  - 深色定义在 .dark         （src/index.css）
//  - 主题切换：在 <html> 上加/去 .dark class
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          base:  'rgb(var(--bg-base) / <alpha-value>)',
          panel: 'rgb(var(--bg-panel) / <alpha-value>)',
          raise: 'rgb(var(--bg-raise) / <alpha-value>)',
          elev:  'rgb(var(--bg-elev) / <alpha-value>)',
        },
        fg: {
          primary:   'rgb(var(--fg-primary) / <alpha-value>)',
          secondary: 'rgb(var(--fg-secondary) / <alpha-value>)',
          muted:     'rgb(var(--fg-muted) / <alpha-value>)',
          disabled:  'rgb(var(--fg-disabled) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          hover:   'rgb(var(--brand-hover) / <alpha-value>)',
          active:  'rgb(var(--brand-active) / <alpha-value>)',
          soft:    'rgb(var(--brand) / 0.12)',
          50:  '#F0FDF4',
          100: '#DCFCE7',
          400: '#4ADE80',
          500: '#22C55E',
          600: '#16A34A',
          700: '#15803D',
        },
        status: {
          info:    'rgb(var(--status-info) / <alpha-value>)',
          success: 'rgb(var(--status-success) / <alpha-value>)',
          warn:    'rgb(var(--status-warn) / <alpha-value>)',
          danger:  'rgb(var(--status-danger) / <alpha-value>)',
          pending: 'rgb(var(--status-pending) / <alpha-value>)',
        },
        glass: {
          border:       'rgb(var(--glass-border) / var(--glass-border-alpha))',
          borderStrong: 'rgb(var(--glass-border) / var(--glass-border-strong-alpha))',
        },
        coral: {
          50: '#F0FDF4', 100: '#DCFCE7', 200: '#BBF7D0', 300: '#86EFAC',
          400: '#4ADE80', 500: '#22C55E', 600: '#16A34A', 700: '#15803D',
          800: '#166534', 900: '#14532D',
        },
      },
      fontFamily: {
        heading: ['Poppins', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        body: ['Open Sans', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      backdropBlur: {
        xs: '4px',
      },
      boxShadow: {
        'glass': 'var(--shadow-glass)',
        'glass-strong': 'var(--shadow-glass-strong)',
        'brand-glow': '0 0 0 0 rgb(var(--brand) / 0.45)',
      },
      animation: {
        'progress-flow': 'progress-flow 1.8s linear infinite',
        'node-pulse': 'node-pulse 1.6s ease-in-out infinite alternate',
        'skeleton': 'skeleton-shimmer 1.2s ease-in-out infinite',
        'fade-in-up': 'fade-in-up 250ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'progress-flow': {
          '0%': { backgroundPosition: '0% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'node-pulse': {
          '0%':   { boxShadow: '0 0 0 0 rgba(34,197,94,0.45)' },
          '100%': { boxShadow: '0 0 0 8px rgba(34,197,94,0.05)' },
        },
        'skeleton-shimmer': {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
        'fade-in-up': {
          'from': { opacity: '0', transform: 'translateY(8px)' },
          'to':   { opacity: '1', transform: 'translateY(0)' },
        },
      },
      borderRadius: {
        'xl': '0.75rem',
        '2xl': '1rem',
      },
    },
  },
  plugins: [],
};
