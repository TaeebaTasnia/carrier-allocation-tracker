# Frontend: Carrier Allocation & Utilization

Static pages, no build step.

- `index.html` + `js/index.js`: landing video, the sign-in card (one button, "Sign in with Microsoft", the company identity provider) and the dive transition into the dashboard. See "Sign-in" below.
- `dashboard.html`: the Overview (figures, the carrier bar chart, uploads).
- `weekly.html`: Data entry, Weekly allocation (type confirmed TEU per carrier, FML forecast override, Save).
- `datewise.html`: Data entry, Date-wise (seven days). Two linked series: Stuffed (TEU per carrier from the stuffing report, read-only, feeds Utilized) and Arrived (Actual CBM per day, with a small tag saying where it came from: "from stuffing CBM", "stuffed TEU x 33", "mixed", "adjusted by you"; Actual TEU = CBM / CBM per TEU). An optional Adjust field replaces a day's computed value (PUT /daily/{date}); the cross clears the adjustment and the computed value returns. Week arrived, to be arrived and the deficit update while typing.
- `summary.html`: Reports, Weekly summary (per-week table, deficit/surplus bars, Download .xlsx).
- `allocvsutil.html`: Reports, Allocation vs Utilization (numbers only: each carrier's forecast, confirmed, confirmed - forecast, utilized, left, % of confirmed and share in a ruled table, with a status word under the name (over confirmed / nothing confirmed); days x carriers grid; Download .xlsx. The bar chart of these figures is on the Overview). Select a carrier to open Weekly allocation, a day to open Date-wise.
- `export.html`: Reports, Export (Weekly summary .xlsx for a year and week range; Allocation vs Utilization .xlsx for one week, or every week with data in a range, downloaded one after another).
- `settings.html`: Settings (uplift, CBM per TEU, FML default, split that must total 100, shipping-line mapping, MGH suppliers).

The rule: Actual (arrived) CBM per day comes from the daily stuffing report: (1) a typed adjustment for the day, else (2) the day's stuffing rows, using each row's CBM when the file has a CBM column and TEU x CBM per TEU (33) for rows without one, else (3) 0. To be arrived = max(0, forecast - total arrived TEU); Left = confirmed - utilized (stuffed TEU); Deficit / surplus = Left - To be arrived. The Overview upload says whether a CBM column was found.

Who may see the pages is decided by the server: every API call needs a signed-in session, and every signed-in page asks `GET /api/auth/me` before it shows itself (see "Sign-in"). The selected week follows you between pages (URL and localStorage).

## Run

Production: the pages and the API share ONE origin. The reverse proxy serves these static files and forwards `/api/*` to the backend with the `/api` prefix stripped (`deploy/`, `docs/GO_LIVE.md`). `js/data.js` then talks to `/api` (same origin, the session cookie goes along, no CORS). Serve HTML, JS and CSS with `Cache-Control: no-cache` so an update shows on the next load. The pages work under this Content-Security-Policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'` (no inline scripts and no `on...=` attributes anywhere; inline `<style>` and `style=` stay, hence `'unsafe-inline'` for styles only).

Local development, from `E:\c&a-newww` (two processes):

```
backend\.venv\Scripts\python.exe serve_frontend.py 5500
```
and the dev backend on :8002 WITHOUT sign-in (see `backend/README.md`, "Run locally"):
```
cd backend
$env:APP_ENV = "dev"; $env:APP_AUTH = "off"; .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8002
```

`serve_frontend.py` serves the `frontend` folder on 127.0.0.1 and sends `Cache-Control: no-store`, so the browser never keeps old CSS or scripts. Pages served from port 5500 on localhost / 127.0.0.1 call the API at `http://127.0.0.1:8002` (a second origin, so the backend allows it with CORS, and no cookie is involved: `APP_AUTH=off` makes every request a dev admin). Open http://127.0.0.1:5500/: the card says "Sign-in is off in this development setup" and its button goes straight to the dashboard. Stop the server with Ctrl+C. With sign-in switched ON, test through one origin instead (a proxy like production; the `/api/auth/login` redirect needs it).

## Overview files

| File | What it does |
|---|---|
| `dashboard.html` | Markup: top bar, figures, the carrier bar chart (stage), the Still to arrive note (tube, three rows, a short key and a "How is this worked out?" disclosure), footer |
| `css/tokens.css` | Shared design tokens: ground, ink, data colours, source accents (forecast amber, stuffing teal, suppliers coral), water sky blue (`--water*`), heading face and accent (`--display`, `--head-accent`), one hue per carrier (`--car-*`), section colours (`--sec-*`), easing |
| `js/boot.js` | In the `<head>` of every page (a plain `<script src>`, before the stylesheets): sets `html.js` and the theme (`data-theme`) before the first paint. Nothing else |
| `js/shell.js` + `css/base.css` | Shared top bar (tabs, menus, week selector, signed-in email, Sign out), ISO weeks, selected week, unsaved-changes guard, page transitions, the session check (`GET /api/auth/me`) |
| `js/index.js` | The landing: sign-in button, `#enter` dive, `?auth_error` messages (loaded after `js/data.js`) |
| `js/page.js` + `css/pages.css` | Shared helpers and styles for data entry, reports and settings |
| `css/reports.css` | Styles for Allocation vs Utilization and Export |
| `js/allocvsutil.js`, `js/export.js` | Those two pages |
| `js/numbers.js` | `CA.numbers.roll(el, value, opts)`: odometer-style number roller used for every figure (reusable, documented in its header). Also the ONE TEU display rule, `CA.numbers.teu(x, opts)` (see "TEU rounding" below) |
| `css/dashboard.css` | Palette, type, layout (1440 / 1180 / 760 / 420 breakpoints), states, entrance |
| `js/data.js` | Data source: where the API is (`API_BASE`), every fetch (`getJSON`, `postFile`, `request`, `download`) with one way of handling 401/403, `CA.auth` (me, config, loginUrl, logout). `?demo` (local hosts only) serves demo data with the backend's JSON shapes |
| `js/carrierbars.js` + `css/carrierbars.css` | The carrier bar chart on the Overview (see "Carrier bar chart" below) |
| `js/jars.js` + `css/jars.css` | The old water jars. No longer on any app page; kept only for the design mockups in `mockups/*.html` (which load `css/jars.css` after `css/dashboard.css`). Delete all four together when the mockups go |
| `js/cursor.js` | Cursor ball (follows the pointer, re-inks what is under it) and pointer tilt |
| `js/dashboard.js` | Week selection, loading, rendering, nav indicator and menus, tooltips |
| `js/uploads.js` | The forecast upload on the Overview: pick or drop, progress, result, errors |

## Week and test links

- `dashboard.html?year=2026&week=45` picks a week. Without one it opens on the current ISO week.
- The test switches below (`?demo`, `?fixture=`, and `?api=` under "Backend") work ONLY when the page itself is opened on `localhost` or `127.0.0.1`. On any other host name they are ignored, so a real site can never show demo numbers or talk to another API.
- `?demo`: built-in demo weeks instead of the backend (no sign-in check). Demo data has weeks 45, 46 and 47 of 2026. Any other week shows the "no forecast uploaded" state, for example `?demo&year=2026&week=50`.
- `&fixture=overflow` puts ONE 4 TEU over its confirmed space in week 45.
- `&fixture=error` makes the request fail, so you can see the error state.
- `&fixture=slow` makes the request take 2.5 s, so you can see the loading state.

- `&fixture=uploaderror` makes every demo upload fail.

## Uploads and navigation

- The forecast upload lives at the bottom of the Overview (or use "Upload files" in the top bar). Choose the file or drop it on the field. Daily stuffing is not uploaded: it is typed in Data entry > Daily stuffing. There is no supplier upload: the supplier list is fixed, and a new supplier is added in Settings (Add supplier form above the list). After a successful upload the Overview reloads the selected week.
- In demo mode the workbook is not read. The upload answers in the backend's response shape and lists the demo weeks. A reload of the page resets the demo data.
- Top bar: Overview, Data entry (Weekly allocation, Date-wise), Reports (Weekly summary, Allocation vs Utilization, Export), Settings. Every item is live. The menus open with click, Enter or Down arrow; Up and Down move, Esc closes.

## Backend

Every page reads the FastAPI backend (see `backend/README.md`): at `/api` on the same origin in production, at `http://127.0.0.1:8002` when the pages come from port 5500 on a local host. `?demo` (local only) shows built-in demo weeks instead.

Developers only (local hosts only): `?api=http://127.0.0.1:8001` points this browser tab at a test backend (kept for the tab in sessionStorage; `?api=default` clears it). `index.html` loads `js/data.js` too, so the flag can go on any page, but put it on EVERY page URL a test harness opens anyway.

Error lines say what happened in plain words ("Could not reach the server. Check your connection and try again."); only on a local host do they add the API address and the CORS hint.

If you start the page server with `serve_frontend.py` (no caching) an update shows on the next load. With any other static server, press Ctrl+F5 once so the browser does not keep old CSS or scripts.

## Sign-in

The server owns sign-in (Microsoft Entra ID through OpenID Connect; contract in `backend/README.md`, "Authentication contract"). The session cookie is HttpOnly: scripts never see it, they only send it (`credentials: 'same-origin'`). There is no client-side sign-in flag anymore.

- **Landing (`index.html`, `js/index.js`).** "Click here to login" opens the glass card with one button, "Sign in with <provider>" (`provider_name` from `GET /api/auth/config`; plain "Sign in" while that loads or if it fails). The button is a page navigation to `/api/auth/login`. After sign-in the server sends the browser to `index.html#enter`: the page asks `GET /api/auth/me`, and on 200 waits for the first film frame and plays the dive into `dashboard.html`; on 401 it just shows the landing. A failed sign-in comes back as `index.html?auth_error=<code>`: the card opens with a fixed message (not_allowed: "This account is not allowed to use the tracker. Ask an administrator."; inactive: "Your account has been deactivated. Ask an administrator."; cancelled: "Sign-in was cancelled."; failed / unavailable: "Sign-in did not work. Try again in a moment."), and the parameter is removed from the address bar. Unknown codes show nothing. When `/api/auth/config` says `auth: "off"` (dev only) the card says "Sign-in is off in this development setup" and the button plays the dive.
- **Signed-in pages.** The head loads `js/boot.js` (theme only). `js/shell.js` keeps the page dark (`html.auth-wait`, css/base.css) until `CA.auth.me()` answers: 200 shows the email left of Sign out (hidden below 1180px) and fades the page in, `CA.auth.user` keeps `{email, name, role}`; 401 goes to `index.html?next=<this page>` (the landing passes `next` on to `/api/auth/login`, so you come back to the same page) and the page never shows; 403 (deactivated) goes to `index.html?auth_error=inactive`; a server that cannot be reached lets the page fade in and show its own error. If no script runs at all the page still fades in after 8 s. Arrivals through a view transition (page to page) are not held, the transition fades them in. A page restored by Back from the browser's cache is checked again.
- **During work.** Every API helper in `js/data.js` handles 401 and 403 the same way: a 401 on a page load goes to the landing as above (unless the page has unsaved changes: then it shows the session message instead of leaving); a 401 on a save, upload, delete or download never leaves the page and shows "Your session ended. Sign in in a new tab, then press Save again." (upload / download say "upload the file again" / "download again"), so typed rows stay; a 403 shows the server's text in the page's own error line, e.g. Settings for a `user`: "Not saved. Only an administrator can do this." Admin-only controls are not hidden.
- **Sign out** (top bar): `POST /api/auth/logout` (ends every session of that user, in every browser), then `index.html`. Any move from a signed-in page to `index.html` skips the page view transition (`pageswap` in `js/shell.js`): the landing has none, and the browser would otherwise report an aborted transition as an error there.

## TEU rounding (display only)

Every TEU figure on screen is a whole number, rounded UP. Calculations, the backend JSON, the database, formulas, status words and the deficit/surplus band stay exact; only what is shown changes. CBM figures, percentages, dates and the settings (uplift, CBM per TEU, split) are not rounded.

Rule (`CA.numbers.teu(x, opts)` in `js/numbers.js`; `CA.page.teu`, `teuDs` and `teuSigned` wrap it for the pages):

- null, undefined or NaN: the page's empty mark (a dash).
- positive: `ceil(x - 1e-6)`: 72.66 -> 73, 72.01 -> 73, 72.0 -> 72, 28.000000000004 -> 28, 0.2 -> 1, 0 -> 0.
- negative: away from zero by the same rule: -11.67 -> -12, -8.0 -> -8.
- `opts.band` (the deficit/surplus figure only): if its absolute value is <= 0.5 (the "balanced" band) it shows 0, so a balanced week never shows 1.
- never "-0".

The number roller is given the exact value with the formatter `CA.numbers.teuFmt` / `teuDsFmt` (0 decimals), so the digits roll as integers. The Weekly allocation CONFIRMED input keeps exactly what you type, decimals included. Because each figure is rounded separately, rows may not add up to a total (e.g. 22 + 19 + 15 + 19 = 75 against a week forecast of 73); the footer says rounding is up to whole TEU (see "Footer" below); the note that rows may not add up exactly was removed. The Excel downloads use the same rule (`teu_up` in `backend/app/services/reports.py`) and write whole-number cells; CBM cells stay exact.

Check the rule with `node frontend\tests\teu-check.cjs` (same table as `backend/tests/test_teu_rounding.py`).

## Tests (node, no browser)

- `node frontend/tests/teu-check.cjs`: the TEU display rule (above).
- `node frontend/tests/xss-check.cjs`: every `innerHTML` / `outerHTML` / `insertAdjacentHTML` in `frontend/js` must be one of the audited sites listed in the script (file + exact line, with the reason it is safe: static strings, the SVG constants, numbers, `esc()`-escaped text), and so must every call of the helpers that pass HTML on (`export.js` `state()` / `emptyNote()`). It also fails on `eval` / `new Function` / string timers / `javascript:` URLs, on `on...=` attributes in HTML built by scripts, and on any inline `<script>` or `on...=` attribute in the nine pages. A new or changed sink fails until it is audited and added to the list. `frontend/mockups` is not checked (not part of the app).

## Changing the look

- Heading face: `--display` in `css/tokens.css` (Newsreader from Google Fonts; the link is in each signed-in page head). Accent colour of headings: `--head-accent`.
- Page headlines: see "Headlines" below.
- Water colour: `--water`, `--water-hi`, `--water-deep`.
- Carrier colours: `--car-maersk` ... `--car-fml`.

## Light theme

Dark is the default look; a light (paper) theme is on `html[data-theme="light"]`.

- Choosing: the round sun/moon button in the top bar, left of Sign out (`js/shell.js`, `#theme-toggle`; a toggle button with `aria-pressed`, name "Light theme"). The choice is saved in `localStorage` as `ca.theme` (`light` / `dark`). With nothing saved, the page follows the system setting (`prefers-color-scheme`) and keeps following it live. Other open tabs follow a change.
- No flash: `js/boot.js`, loaded as a plain `<script src>` in the `<head>` of every page, sets `data-theme` before anything paints, so the 0.45 s page fade-in, the view transitions and the end of the sign-in dive all land on the paper ground in light mode. `index.html` itself (video, sign-in card) stays dark by design; only the colour its dive fades to follows the theme (`html[data-theme="light"] .black`, kept equal to the light `--night`).
- Colours: every colour is a token in `css/tokens.css`. The dark values sit in `:root`; the light theme overrides them in `:root[data-theme="light"]`: cream paper ground (`--dusk` #f7f4ee to `--night` #efe9de), navy ink (`--ink` #0b141f, `--ink-2`, `--ink-3`, `--ink-in` cream on fills), and every accent re-derived darker so text stays at 4.5:1 or better on the paper: water/heading accent ocean blue (`--water` #17649a, `--head-accent` #0c6093), amber #845406, teal #0a6869, coral #9e4638, deficit red #b0301a / text #a3311a, surplus sea #246a56, steel #43637f, carriers MAERSK #165a9e, HAPAG #aa2e66, HELLMAN #745d00, ONE #106c48, FML #6152bf. Washes, rules and hover fills use channel tokens (`rgba(var(--ink-rgb), a)`, `--water-rgb`, `--red-text-rgb`, ...); surfaces and shadows have their own tokens (`--menu-bg`, `--tip-bg`, `--ground-solid`, `--shadow-pop`, ...). To add a colour, add it to both blocks.
- Canvas (mockups only): `js/jars.js` reads its glass colours from the tokens (`--ink-rgb`, `--jar-hi-rgb`, `--jar-red-rgb`, `--acc-forecast-rgb`, `--water-rgb`, each carrier's `--car`) and re-reads them on the `ca:themechange` event that `CA.theme.set()` / `toggle()` fire.
- Cursor ball: the same filter chain, retuned (`--ball-pivot` 1.6, `--ball-warm` 0.35): on paper it becomes a dark lens with cream type. Measured under the ball in light mode: about 20:1 for every text colour, and solid buttons swap (light fill, dark label). The grain ring is navy (`--ball-grain`).
- The logo PNG is white; on paper (and in forced-colors mode) it is painted in the ink colour through the same image as a CSS mask.

## Headlines

The Overview headline ("Week 45: 36 TEU left to use") and every page title use one system: `.hl` in `css/base.css`, played by `CA.page.pop()` in `js/page.js`. The look is Newsreader (an editorial serif) at a medium weight, drawn from its display optical size, with slightly tight tracking and leading, and lining figures. The rolling number does not jitter, because `js/numbers.js` holds each digit cell at its final digit's width. The text is cream, with one sky accent on the key figure or key words. Under the title sits a short hairline in the section colour, then a lighter Inter sub line.

The motion works like this. Each rendered line rises out of its own clipped mask on a long ease-out, one step after the line above. Then the hairline draws from left to right, and then the sub line rises in. On the Overview, the number lands as its line settles. When the week changes, the old line leaves upward through the same masks, the hairline retracts and the sub fades, and then the new line rises. The whole entrance takes about 1 s.

Only transform and opacity change, using the Web Animations API on a few elements, with no script running per frame. When the motion ends, the title is plain text again: selection works and screen readers read it once. With reduce motion turned on, or in a hidden tab, the final state shows at once.

Every value is a token in `css/tokens.css`:

| Change | Token(s) |
|---|---|
| Font | `--hl-family` (defaults to `--display`, Newsreader with Cormorant Garamond and Georgia as fallbacks). If you swap Newsreader, also change the Google Fonts link in the eight signed-in pages (dashboard, weekly, datewise, summary, allocvsutil, export, settings, stuffing), and re-check the mask offset in `js/page.js` (comment above the 135% keyframe). `--display` also sets the section headings on Alloc vs util and Export (`css/reports.css`), at the same weight. |
| Weight | `--hl-weight` (500). The link loads weights 400 to 700 (`Newsreader:opsz,wght@6..72,400..700`), so any weight in that range works without other edits. Outside it, the browser clamps or fakes the weight. Fraunces 800 was replaced because it read too heavy. |
| Optical size | `--hl-opsz` (72, the face's display cut; any value from 6 to 72). Lower values draw sturdier, lower-contrast letters. |
| Tracking, leading | `--hl-track` (-0.012em), `--hl-leading` (1.04) |
| Size | `--hl-size-hero` (Overview), `--hl-size-page` (page titles) |
| Accent | `--hl-accent` (sky `--head-accent`; 11.9:1 on the ground) |
| Hairline | `--hl-rule-w`, `--hl-rule-h`, `--hl-rule-c` (section colour) |
| Sub line weight | `--hl-sub-weight` (400; colour `--ink-2`, 9.6:1 or better) |
| Speed | `--hl-dur` (one line rising, 920ms), `--hl-step` (between lines, line to hairline, hairline to sub, 90ms), `--hl-ease`, `--hl-exit` (week-change exit, 260ms), `--hl-ease-exit` |

To give a page a title in this system, put `class="hl"` on the title and `class="hl-sub"` on its sub line, inside the same parent. Set both through `CA.page.pop(el, parts)`. Parts can be strings, `{ em: 'key words' }` for the accent, and nodes. The hairline is added automatically. Before the first reveal the title is hidden, so the static HTML text never flashes. A fail-safe shows it after 2.6 s anyway.

## The cursor ball

The cream ball floats above the page and re-inks everything under its core, for every element and every colour. Nothing needs to be marked up. The core is a small `backdrop-filter` disc: `grayscale(1) invert(1) brightness(pivot) contrast(k) sepia(warm)`. Inside it, the dark page turns cream and text of any colour turns dark ink: cream, muted, sky, amber, teal, coral, carrier hues and red. A solid accent button swaps instead: its fill goes dark and its label goes light. Measured contrast is at least 10:1 for normal text; the darkest text, the deficit red, sits on the edge of the cut and comes out dark grey. Clicks, focus, selection and typing go straight through the ball (`pointer-events: none`). The ball is moved with `transform` only and hidden when its scale is 0.

Tuning, all in `css/tokens.css`:
- `--ball-size`: diameter at full size (168px). The zones scale it: `data-ball="text"` is full size, `ui` is 0.34, no zone is 0.55, and `none` / `jar` hide it. The bar and the upload status lines are hidden zones; the Overview chart is a `ui` zone (small ball). The scales are in `SCALE` / `BASE` in `js/cursor.js`.
- `--ball-pivot` (0.72): where the cut between "ground" and "text" falls, at a grey of `1 - 0.5 / pivot` (0.31). Lower it and darker colours also turn to ink.
- `--ball-contrast` (3): how steep the cut is. Higher is crisper but more jagged; 2.5 is the lowest that keeps every colour at 4.5:1 or better.
- `--ball-warm` (0.4): 0 gives a white ball with black ink; higher gives a warmer cream.

`[data-ink]` on text is now only a colour hook (`color: var(--c)`). The old per-element colour flip (a `background-clip: text` gradient) was removed. Keeping both would invert text twice and make it vanish again. The sign-in page (`index.html`) has no ball: there is a video under it, and the filter would have to recompose every frame.

## Motion and accessibility

- Turning on "reduce motion" in the operating system removes the cursor ball, tilt, slosh, count-up, entrance and the headline reveal. Headlines appear in their final state, and the Overview chart appears at once in its final state.
- Page changes use a cross-document view transition. The old content leaves in 0.16 s, the new page fades in, and its title rises out of its mask.
- The ball only runs with a mouse or trackpad. It is also off in forced-colors (high contrast) mode.
- Each carrier row of the Overview chart is a button. Hover, focus or tap it to see its details (phones: one readout under the chart). Esc closes the details.
- In the week selector, Left and Right arrows change the week. Click the week label to open the browser's week picker.

## Upload (Overview)

The Overview has one upload: the forecast workbook (.xlsx). The section is a ruled row: title, one-line lede and a muted line on the left (daily stuffing is typed in Data entry > Daily stuffing, suppliers are added in Settings), the forecast field on the right; one column below 900px. States: idle, drag-over, uploading, success (weeks found, Show W.. links), error. Re-uploading replaces the forecast for every week in the file. There is no stuffing upload on the Overview (the backend POST /stuffing/upload still exists but the frontend no longer calls it). Code: `js/uploads.js`, `data.js` `upload('forecast', file)`.

## Daily stuffing (type a day instead of uploading)

Data entry > Daily stuffing (`stuffing.html`, `js/stuffing.js`, `css/stuffing.css`). A strip shows the selected week (rows and TEU per day, today marked); pick a day to edit it.

- Rows have the portal fields: Shipping line, Qty, TEUs, Feeder vessel, FVSL ETD/ETA, Mother vessel, MVSL ETD/ETA, plus an optional CBM. TEUs fills as 2 x Qty until you type TEUs yourself (clear it to go back to auto).
- A chip under each line shows its carrier (the Settings line map; `FML-`, `FML ` or `FML/` prefixes are FML). An unmapped line is flagged and links to Settings; its TEU counts for no carrier.
- Save day replaces the whole day (PUT /stuffing/{date}), like re-uploading that day's report. Delete this day asks first (DELETE). Save is disabled while a number or date is invalid. Leaving the page, changing day or changing week with unsaved rows asks first.
- Paste from Excel: paste tab-separated rows (header optional, columns in the order above, dates read day first). A preview shows the rows; Add rows appends, Replace rows swaps the day's rows on screen (still needs Save).
- Totals strip: TEU per carrier, Not mapped and the day, rounded up to whole TEU like the rest of the app.
- `?demo` uses an in-memory mock (`CA.api.stuffingWeek/stuffingDay/saveStuffingDay/deleteStuffingDay` in `js/data.js`).

## Carrier bar chart (Overview)

The Overview stage shows one row per carrier (2026-11-10, replaced the water jars):

- Left: the label block the jars had, unchanged: the name in the carrier hue, the TEU left as a big rolling figure with its unit ("18 TEU left"; nothing confirmed: the forecast in a muted tone with "TEU"; over: the red negative with "TEU"), and a status line ("10% used", "Forecast only", red "Over by 4 TEU"). Whole TEU via `CA.numbers.teu`.
- Right: a lane on one TEU scale shared by the five carriers (axis above, "TEU" once). Confirmed space is a container in the carrier hue (oblique top and end faces), utilized is the striped solid fill inside it (the pale striped rest is confirmed space left), over-use is a red hatched segment past its end, the forecast is an amber pin with its number, and a dashed bracket joins the container's end to the pin (red when confirmed is below forecast, sea above). No space confirmed: "nothing confirmed" with a dashed start line. The chart's own labels (pins, axis) are numbers only.
- Code: `js/carrierbars.js` (`CA.carrierBars.scale / maxOf / axis / lane`) builds the lane; `js/dashboard.js` builds the rows, tooltips and phone readout; `css/carrierbars.css` holds the lane look and the entrance; `css/dashboard.css` (`.cb`, `.cl`) the row layout. Phones (760px and below): the label block on one line, the lane full width under it.
- Entrance, once per week shown (first load and every week change; nothing loops): rows 40 ms apart, the container grows from the left (`scaleX`), the fill follows, then the forecast pins drop in (their numbers roll with `CA.numbers.roll`), the over-use grows and the brackets fade in; about 0.9 s, transform and opacity only. Reduced motion: final state at once.
- Hovering or focusing a figure in the list dims the parts of the chart it is not about (forecast: pins; confirmed: containers; utilized: fills).
- Empty and error weeks: the chart stays as an empty, dimmed axis and grid with the message under it (phones: the empty lanes are dropped so the message stays near the top).
- Allocation vs Utilization no longer draws the chart; it shows the same figures as numbers only.

## Footer (every signed-in page)

One short muted line on the left, #foot-source: "Figures in TEU, rounded up to whole TEU. 1 TEU is 33 CBM after the 30% uplift." (the two numbers are written by ootLine() in js/page.js from GET /config; the HTML holds the default wording). The right side is "MGH · Carrier Allocation & Utilization". The old separate rounding paragraph (.round-note) is gone. No developer text: no backend address, no test-fixture name. Only in ?demo the line adds "Demo data: weeks 45 to 47 of the 2026 workbook." because those figures are fake.

## Weekly allocation: "The week as typed"

The right column shows only To be arrived and Deficit / Surplus / Balanced (live while typing). Forecast, Confirmed and Left are in the TOTAL row of the table beside it; "FML not included" appears once, under the Forecast total.