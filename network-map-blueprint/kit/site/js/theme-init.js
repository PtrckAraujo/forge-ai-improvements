/* Theme before first paint, so the page never flashes the wrong colours.
   An external file rather than an inline script keeps the CSP free of hashes. */
(function () {
  var t = null;
  try { t = localStorage.getItem('nm-theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = t;
})();
