/** @type {import('tailwindcss').Config} */
// CORAL v2 UI — ChatGPT-inspired clean design
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
          soft:    'rgb(var(--brand) / 0.08)',
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
      },
      fontFamily: {
        heading: ['Inter', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        body: ['Inter', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'glass': 'var(--shadow-glass)',
        'glass-strong': 'var(--shadow-glass-strong)',
        'sidebar': 'var(--shadow-sidebar)',
      },
      animation: {
        'node-pulse': 'node-pulse 1.6s ease-in-out infinite alternate',
        'skeleton': 'skeleton-shimmer 1.2s ease-in-out infinite',
        'fade-in-up': 'fade-in-up 250ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'node-pulse': {
          '0%':   { boxShadow: '0 0 0 0 rgb(var(--brand) / 0.35)' },
          '100%': { boxShadow: '0 0 0 6px rgb(var(--brand) / 0.05)' },
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
        '3xl': '1.5rem',
      },
    },
  },
  plugins: [],
};
