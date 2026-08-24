/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#5b7fa6',
          hover: '#7b9fc6',
          dim: 'rgba(91, 127, 166, 0.15)',
        },
        muted: {
          teal: '#4a9988',
          'teal-dim': 'rgba(68, 170, 153, 0.12)',
          red: '#c44',
          'red-dim': 'rgba(204, 68, 68, 0.12)',
          amber: '#b8966a',
          'amber-dim': 'rgba(184, 150, 106, 0.12)',
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'pulse-soft': 'pulseSoft 1.5s ease-in-out infinite',
        'bounce-in': 'bounceIn 0.5s ease-out',
        'spin-slow': 'spin 3s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        bounceIn: {
          '0%': { opacity: '0', transform: 'scale(0.3)' },
          '50%': { transform: 'scale(1.05)' },
          '70%': { transform: 'scale(0.9)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [],
};
