// Runs before first paint so every page — including /login, which never mounts
// the Header that owns the toggle — shows the last chosen theme. Defaults to
// light rather than prefers-color-scheme, matching useDarkMode's initial().
//
// A file rather than an inline <script> so the dashboard can ship a
// `script-src 'self'` CSP. Loaded without defer/async to keep it pre-paint.
(function () {
  try {
    if (localStorage.getItem('vyzus.theme') === 'dark') {
      document.documentElement.classList.add('dark');
      document.querySelector('meta[name="color-scheme"]').setAttribute('content', 'dark');
    }
  } catch (e) {
    // Private mode / blocked storage: light theme is the correct fallback.
  }
})();
