/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,ts}",
  ],
  theme: {
    extend: {
      colors: {
        ink: '#12233f',
        'ink-soft': '#51617d',
        mist: '#f4f7fb',
        line: '#e3e9f2',
        cobalt: {
          DEFAULT: '#2e5bff',
          deep: '#1e46e0',
          soft: '#eaefff',
        },
      },
      fontFamily: {
        display: ['"Bricolage Grotesque Variable"', 'sans-serif'],
        sans: ['"Inter Variable"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
