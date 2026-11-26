/* Runs in the <head> of every page before the first paint: load it as a plain <script src="js/boot.js">
 * (no defer, no async), after the meta tags and before the stylesheets.
 *   - html.js: scripts run. css/base.css keeps page titles hidden until their reveal (js/page.js),
 *     with a fail-safe.
 *   - data-theme: the saved choice (localStorage 'ca.theme'), else the system setting, so nothing
 *     paints in the wrong theme. The toggle is in the top bar (js/shell.js); the colours are in
 *     css/tokens.css. index.html (video, sign-in card) stays dark; only its dive fade follows it.
 * Nothing about sign-in here: the server decides. Every signed-in page asks GET /api/auth/me
 * (js/shell.js) and goes to index.html when there is no session. */
(function () {
  var root = document.documentElement, t = null;
  root.classList.add('js');
  try { t = localStorage.getItem('ca.theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.setAttribute('data-theme', t);
})();
