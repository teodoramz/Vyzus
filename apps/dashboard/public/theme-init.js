// Applied synchronously (before first paint) so every page — including /login,
// which never mounts the Header that owns the toggle — shows the theme the user
// last explicitly chose. Default is light: we do NOT fall back to
// prefers-color-scheme here, matching useDarkMode's initial() logic exactly.
//
// A separate file rather than an inline <script> so the dashboard can ship a
// `script-src 'self'` CSP (infra/nginx-security-headers.conf). Loaded without
// defer/async, so it still runs before the first paint.
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
