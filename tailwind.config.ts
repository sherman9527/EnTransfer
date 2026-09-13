import type { Config } from 'tailwindcss'

export default {
  content: ['./renderer/index.html', './renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark theme palette (avoid purple)
        base: '#1a1a2e',
        card: '#16213e',
        panel: '#0f3460',
        accent: '#e94560',
        line: '#233554',
        ink: '#e6e9f0',
        ink2: '#aab3c5',
        ink3: '#6b7590',
        ok: '#3fb950',
        warn: '#d29922',
        danger: '#e94560'
      },
      borderRadius: {
        card: '12px',
        btn: '8px',
        pill: '999px'
      },
      fontFamily: {
        sans: ['"Segoe UI"', '"Microsoft YaHei"', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
} satisfies Config
