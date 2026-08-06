/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Data-viz skill "chrome & ink" roles (references/palette.md) — kept as
        // Tailwind tokens so every component draws from the same palette.
        surface: {
          DEFAULT: '#fcfcfb',
          dark: '#1a1a19',
        },
        plane: {
          DEFAULT: '#f9f9f7',
          dark: '#0d0d0d',
        },
        ink: {
          DEFAULT: '#0b0b0b',
          dark: '#ffffff',
        },
        'ink-secondary': {
          DEFAULT: '#52514e',
          dark: '#c3c2b7',
        },
        'ink-muted': '#898781',
        hairline: {
          DEFAULT: '#e1e0d9',
          dark: '#2c2c2a',
        },
        baseline: {
          DEFAULT: '#c3c2b7',
          dark: '#383835',
        },
        status: {
          good: '#0ca30c',
          warning: '#fab219',
          serious: '#ec835a',
          critical: '#d03b3b',
        },
        series: {
          1: '#2a78d6',
          2: '#1baf7a',
          3: '#eda100',
          4: '#008300',
          5: '#4a3aa7',
          6: '#e34948',
          7: '#e87ba4',
          8: '#eb6834',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        driftA: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(40px, 30px) scale(1.12)' },
        },
        driftB: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '50%': { transform: 'translate(-35px, -45px) scale(1.15)' },
        },
      },
      animation: {
        driftA: 'driftA 22s ease-in-out infinite',
        driftB: 'driftB 27s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
