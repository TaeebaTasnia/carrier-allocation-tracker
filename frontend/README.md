# Frontend: Carrier Allocation & Utilization

Static pages, no build step.

- `index.html`: landing video, demo login (demo_user / demo1234) and the dive transition into the dashboard.
- `dashboard.html`: the Overview (figures, water jars, uploads).
- `weekly.html`: Data entry, Weekly allocation (type confirmed TEU per carrier, FML forecast override, Save).
- `datewise.html`: Data entry, Date-wise (seven days). Two linked series: Stuffed (TEU per carrier from the stuffing report, read-only, feeds Utilized) and Arrived (Actual CBM per day, with a small tag saying where it came from: "from stuffing CBM", "stuffed TEU x 33", "mixed", "adjusted by you"; Actual TEU = CBM / CBM per TEU). An optional Adjust field replaces a day's computed value (PUT /daily/{date}); the cross clears the adjustment and the computed value returns. Week arrived, to be arrived and the deficit update while typing.
- `summary.html`: Reports, Weekly summary (per-week table, deficit/surplus bars, Download .xlsx).
- `allocvsutil.html`: Reports, Allocation vs Utilization (each carrier's forecast, confirmed and utilized on one TEU scale; days x carriers grid; Download .xlsx). Select a carrier to open Weekly allocation, a day to open Date-wise.
- `export.html`: Reports, Export (Weekly summary .xlsx for a year and week range; Allocation vs Utilization .xlsx for one week, or every week with data in a range, downloaded one after another).
- `settings.html`: Settings (uplift, CBM per TEU, FML default, split that must total 100, shipping-line mapping, MGH suppliers).

The rule: Actual (arrived) CBM per day comes from the daily stuffing report: (1) a typed adjustment for the day, else (2) the day's stuffing rows, using each row's CBM when the file has a CBM column and TEU x CBM per TEU (33) for rows without one, else (3) 0. To be arrived = max(0, forecast - total arrived TEU); Left = confirmed - utilized (stuffed TEU); Deficit / surplus = Left - To be arrived. The Overview upload says whether a CBM column was found.

Every signed-in page needs the demo sign-in flag and sends you back to `index.html` without it. The selected week follows you between pages (URL and localStorage).

## Run

From `E:\c&a-newww`:

```
backend\.venv\Scripts\python.exe serve_frontend.py 5500
```

`serve_frontend.py` serves the `frontend` folder on 127.0.0.1 and sends `Cache-Control: no-store`, so the browser never keeps old CSS or scripts. (It replaces the old `http.server` command, which let the browser cache files.) Open http://127.0.0.1:5500/ and sign in, or go straight to http://127.0.0.1:5500/dashboard.html once you have signed in. Stop the server with Ctrl+C.

## Overview files

| File | What it does |
|---|---|
| `dashboard.html` | Markup: top bar, figures, jar stage, the two notes, footer |
| `css/tokens.css` | Shared design tokens: ground, ink, data colours, source accents (forecast amber, stuffing teal, suppliers coral), water sky blue (`--water*`), heading face and accent (`--display`, `--head-accent`), one hue per carrier (`--car-*`), section colours (`--sec-*`), easing |
| `js/shell.js` + `css/base.css` | Shared top bar (tabs, menus, week selector, Sign out), ISO weeks, selected week, unsaved-changes guard, page transitions |
| `js/page.js` + `css/pages.css` | Shared helpers and styles for data entry, reports and settings |
| `css/reports.css` | Styles for Allocation vs Utilization and Export |
| `js/allocvsutil.js`, `js/export.js` | Those two pages |
| `js/numbers.js` | `CA.numbers.roll(el, value, opts)`: odometer-style number roller used for every figure (reusable, documented in its header). Also the ONE TEU display rule, `CA.numbers.teu(x, opts)` (see "TEU rounding" below) |
| `css/dashboard.css` | Palette, type, layout (1440 / 1180 / 760 / 420 breakpoints), states, entrance |
| `js/data.js` | Data source. `USE_BACKEND = false` serves demo data with the backend's JSON shapes |
| `js/jars.js` | The water jars: glass on a small canvas drawn only on change; water as CSS-animated layers (waves, bob, bubbles), paused off screen |
| `js/cursor.js` | Cursor ball (follows the pointer, re-inks what is under it) and pointer tilt |
| `js/dashboard.js` | Week selection, loading, rendering, nav indicator and menus, tooltips |
| `js/uploads.js` | The three upload columns: pick or drop, progress, result, errors |

## Week and test links

- `dashboard.html?year=2026&week=45` picks a week. Without one it opens on the current ISO week.
- Demo data has weeks 45, 46 and 47 of 2026. Any other week shows the "no forecast uploaded" state, for example `?week=50`.
- `&fixture=overflow` puts ONE 4 TEU over its confirmed space in week 45.
- `&fixture=error` makes the request fail, so you can see the error state.
- `&fixture=slow` makes the request take 2.5 s, so you can see the loading state.

- `&fixture=uploaderror` makes every demo upload fail.

## Uploads and navigation

- Uploads live at the bottom of the Overview (or use "Upload files" in the top bar): forecast and daily stuffing (several files at once, each with its own date). Choose a file or drop it on its column. There is no supplier upload: the supplier list is fixed, and a new supplier is added in Settings (Add supplier form above the list). After a successful upload the Overview reloads the selected week.
- In demo mode the workbook is not read. The upload answers in the backend's response shape. The stuffing demo books 4 TEU on the chosen date (or the Monday of the selected week), so you can see the jars refresh. A reload of the page resets the demo data.
- Top bar: Overview, Data entry (Weekly allocation, Date-wise), Reports (Weekly summary, Allocation vs Utilization, Export), Settings. Every item is live. The menus open with click, Enter or Down arrow; Up and Down move, Esc closes.

## Backend

Every page reads the FastAPI backend at http://127.0.0.1:8000 (see `backend/README.md`). `?demo` on the Overview shows built-in demo weeks instead.

Developers only: `?api=http://127.0.0.1:8001` points this browser tab at a test backend (kept for the tab in sessionStorage; `?api=default` clears it). Put it on a dashboard page, not on `index.html`: the sign-in page does not load `js/data.js`, so it ignores the flag and the next page uses the real backend at :8000.

If you start the page server with `serve_frontend.py` (no caching) an update shows on the next load. With any other static server, press Ctrl+F5 once so the browser does not keep old CSS or scripts.

## TEU rounding (display only)

Every TEU figure on screen is a whole number, rounded UP. Calculations, the backend JSON, the database, formulas, status words and the deficit/surplus band stay exact; only what is shown changes. CBM figures, percentages, dates and the settings (uplift, CBM per TEU, split) are not rounded.

Rule (`CA.numbers.teu(x, opts)` in `js/numbers.js`; `CA.page.teu`, `teuDs` and `teuSigned` wrap it for the pages):

- null, undefined or NaN: the page's empty mark (a dash).
- positive: `ceil(x - 1e-6)`: 72.66 -> 73, 72.01 -> 73, 72.0 -> 72, 28.000000000004 -> 28, 0.2 -> 1, 0 -> 0.
- negative: away from zero by the same rule: -11.67 -> -12, -8.0 -> -8.
- `opts.band` (the deficit/surplus figure only): if its absolute value is <= 0.5 (the "balanced" band) it shows 0, so a balanced week never shows 1.
- never "-0".

The number roller is given the exact value with the formatter `CA.numbers.teuFmt` / `teuDsFmt` (0 decimals), so the digits roll as integers. The Weekly allocation CONFIRMED input keeps exactly what you type, decimals included. Because each figure is rounded separately, rows may not add up to a total (e.g. 22 + 19 + 15 + 19 = 75 against a week forecast of 73); each page with tables or totals says so in one small note. The Excel downloads use the same rule (`teu_up` in `backend/app/services/reports.py`) and write whole-number cells; CBM cells stay exact.

Check the rule with `node frontend\tests\teu-check.cjs` (same table as `backend/tests/test_teu_rounding.py`).

## Changing the look

- Heading face: `--display` in `css/tokens.css` (Fraunces from Google Fonts; the link is in each page head). Accent colour of headings: `--head-accent`.
- Page headlines: see "Headlines" below.
- Water colour: `--water`, `--water-hi`, `--water-deep`.
- Carrier colours: `--car-maersk` ... `--car-fml`.

## Light theme

Dark is the default look; a light (paper) theme is on `html[data-theme="light"]`.

- Choosing: the round sun/moon button in the top bar, left of Sign out (`js/shell.js`, `#theme-toggle`; a toggle button with `aria-pressed`, name "Light theme"). The choice is saved in `localStorage` as `ca.theme` (`light` / `dark`). With nothing saved, the page follows the system setting (`prefers-color-scheme`) and keeps following it live. Other open tabs follow a change.
- No flash: a tiny inline script in the `<head>` of every page sets `data-theme` before anything paints, so the 0.45 s page fade-in, the view transitions and the end of the sign-in dive all land on the paper ground in light mode. `index.html` itself (video, sign-in card) stays dark by design; only the colour its dive fades to follows the theme (`html[data-theme="light"] .black`, kept equal to the light `--night`).
- Colours: every colour is a token in `css/tokens.css`. The dark values sit in `:root`; the light theme overrides them in `:root[data-theme="light"]`: cream paper ground (`--dusk` #f7f4ee to `--night` #efe9de), navy ink (`--ink` #0b141f, `--ink-2`, `--ink-3`, `--ink-in` cream on fills), and every accent re-derived darker so text stays at 4.5:1 or better on the paper: water/heading accent ocean blue (`--water` #17649a, `--head-accent` #0c6093), amber #845406, teal #0a6869, coral #9e4638, deficit red #b0301a / text #a3311a, surplus sea #246a56, steel #43637f, carriers MAERSK #165a9e, HAPAG #aa2e66, HELLMAN #745d00, ONE #106c48, FML #6152bf. Washes, rules and hover fills use channel tokens (`rgba(var(--ink-rgb), a)`, `--water-rgb`, `--red-text-rgb`, ...); surfaces and shadows have their own tokens (`--menu-bg`, `--tip-bg`, `--ground-solid`, `--shadow-pop`, ...). To add a colour, add it to both blocks.
- Canvas: `js/jars.js` reads its glass colours from the tokens (`--ink-rgb`, `--jar-hi-rgb`, `--jar-red-rgb`, `--acc-forecast-rgb`, `--water-rgb`, each carrier's `--car`) and re-reads them on the `ca:themechange` event that `CA.theme.set()` / `toggle()` fire.
- Cursor ball: the same filter chain, retuned (`--ball-pivot` 1.6, `--ball-warm` 0.35): on paper it becomes a dark lens with cream type. Measured under the ball in light mode: about 20:1 for every text colour, and solid buttons swap (light fill, dark label). The grain ring is navy (`--ball-grain`).
- The logo PNG is white; on paper (and in forced-colors mode) it is painted in the ink colour through the same image as a CSS mask.

## Headlines

The Overview headline ("Week 45: 36 TEU left to use") and every page title use one system: `.hl` in `css/base.css`, played by `CA.page.pop()` in `js/page.js`. The look is heavy Fraunces at a display optical size with tight tracking and leading, and lining figures. This Fraunces build has no tabular figures. The rolling number still does not jitter, because `js/numbers.js` holds each digit cell at its final digit's width. The text is cream, with one sky accent on the key figure or key words. Under the title sits a short hairline in the section colour, then a lighter Inter sub line.

The motion works like this. Each rendered line rises out of its own clipped mask on a long ease-out, one step after the line above. Then the hairline draws from left to right, and then the sub line rises in. On the Overview, the number lands as its line settles. When the week changes, the old line leaves upward through the same masks, the hairline retracts and the sub fades, and then the new line rises. The whole entrance takes about 1 s.

Only transform and opacity change, using the Web Animations API on a few elements, with no script running per frame. When the motion ends, the title is plain text again: selection works and screen readers read it once. With reduce motion turned on, or in a hidden tab, the final state shows at once.

Every value is a token in `css/tokens.css`:

| Change | Token(s) |
|---|---|
| Font | `--hl-family` (defaults to `--display`). If you swap Fraunces, also change the Google Fonts link in the seven signed-in pages (dashboard, weekly, datewise, summary, allocvsutil, export, settings). |
| Weight | `--hl-weight` (800). The link loads weights 600 to 900 (`Fraunces:opsz,wght,SOFT,WONK@9..144,600..900,0,0`), so any weight in that range works without other edits. Outside it, the browser fakes the weight. |
| Optical size | `--hl-opsz` (72; any value from 9 to 144). Higher values give finer hairlines and a tighter fit; 144 was too spindly and cramped. |
| Softness / wonky letters | Fixed at 0 in the link (sharp, no leaning letters). CSS cannot change them; edit the `,0,0` at the end of the link. |
| Tracking, leading | `--hl-track` (-0.018em), `--hl-leading` (1.02) |
| Size | `--hl-size-hero` (Overview), `--hl-size-page` (page titles) |
| Accent | `--hl-accent` (sky `--head-accent`; 11.9:1 on the ground) |
| Hairline | `--hl-rule-w`, `--hl-rule-h`, `--hl-rule-c` (section colour) |
| Sub line weight | `--hl-sub-weight` (400; colour `--ink-2`, 9.6:1 or better) |
| Speed | `--hl-dur` (one line rising, 920ms), `--hl-step` (between lines, line to hairline, hairline to sub, 90ms), `--hl-ease`, `--hl-exit` (week-change exit, 260ms), `--hl-ease-exit` |

To give a page a title in this system, put `class="hl"` on the title and `class="hl-sub"` on its sub line, inside the same parent. Set both through `CA.page.pop(el, parts)`. Parts can be strings, `{ em: 'key words' }` for the accent, and nodes. The hairline is added automatically. Before the first reveal the title is hidden, so the static HTML text never flashes. A fail-safe shows it after 2.6 s anyway.

## The cursor ball

The cream ball floats above the page and re-inks everything under its core, for every element and every colour. Nothing needs to be marked up. The core is a small `backdrop-filter` disc: `grayscale(1) invert(1) brightness(pivot) contrast(k) sepia(warm)`. Inside it, the dark page turns cream and text of any colour turns dark ink: cream, muted, sky, amber, teal, coral, carrier hues and red. A solid accent button swaps instead: its fill goes dark and its label goes light. Measured contrast is at least 10:1 for normal text; the darkest text, the deficit red, sits on the edge of the cut and comes out dark grey. Clicks, focus, selection and typing go straight through the ball (`pointer-events: none`). The ball is moved with `transform` only and hidden when its scale is 0.

Tuning, all in `css/tokens.css`:
- `--ball-size`: diameter at full size (168px). The zones scale it: `data-ball="text"` is full size, `ui` is 0.34, no zone is 0.55, and `none` / `jar` hide it. The bar, the jars and the upload status lines are hidden zones. The scales are in `SCALE` / `BASE` in `js/cursor.js`.
- `--ball-pivot` (0.72): where the cut between "ground" and "text" falls, at a grey of `1 - 0.5 / pivot` (0.31). Lower it and darker colours also turn to ink.
- `--ball-contrast` (3): how steep the cut is. Higher is crisper but more jagged; 2.5 is the lowest that keeps every colour at 4.5:1 or better.
- `--ball-warm` (0.4): 0 gives a white ball with black ink; higher gives a warmer cream.

`[data-ink]` on text is now only a colour hook (`color: var(--c)`). The old per-element colour flip (a `background-clip: text` gradient) was removed. Keeping both would invert text twice and make it vanish again. The sign-in page (`index.html`) has no ball: there is a video under it, and the filter would have to recompose every frame.

## Motion and accessibility

- Turning on "reduce motion" in the operating system removes the cursor ball, tilt, slosh, count-up, entrance and the headline reveal. Headlines appear in their final state, and jars draw once at their final level.
- Page changes use a cross-document view transition. The old content leaves in 0.16 s, the new page fades in, and its title rises out of its mask.
- The ball only runs with a mouse or trackpad. It is also off in forced-colors (high contrast) mode.
- Each jar is a button. Hover, focus or tap it to see its details. Esc closes the details.
- In the week selector, Left and Right arrows change the week. Click the week label to open the browser's week picker.

## Daily stuffing: many files at once

Pick or drop several stuffing .xlsx files (for example one per day). A ruled list appears under the three upload columns: one row per file with its name, a date, a status (Waiting, Uploading, done, Error) and a remove cross. Code: `js/uploads.js` (it sets `multiple` on the input and injects the list) and `css/uploads-multi.css` (injected from the script).

- The date is read from the file name: 2026-11-05, 2026_11_05, 2026.11.05, 20261105, 05-11-2026, 05.11.2026, 5/11/26, 05112026, 5 Nov 2026, 5-Nov-26, 07-Nov-26, 5th November 2026, Nov 5 2026, November 5th 2026 (no year = this year). dd-mm vs mm-dd is read day first unless one part is above 12. If the name has no date, the Report date box above is used, else the row is highlighted and needs a date. Rows sort by date.
- "Upload N files" is disabled, with the reason shown, while a row has no date, while two rows share a date and "I know" is not ticked, and while uploading. Tick "These files have their own date column" to let rows without a date go up (the backend then reads the date column; a 400 shows on that row).
- Files upload one at a time in date order. A failed file shows its error and the rest go on. "Cancel remaining" stops after the current file. After a run the button says Retry for failed or cancelled files.
- One result at the end: days, TEU per carrier, unmapped shipping lines (union), CBM column, skipped rows, failed files. The Overview reloads once, after the last file. Non-.xlsx files are left out with a note.

## Daily stuffing (type a day instead of uploading)

Data entry > Daily stuffing (`stuffing.html`, `js/stuffing.js`, `css/stuffing.css`). A strip shows the selected week (rows and TEU per day, today marked); pick a day to edit it.

- Rows have the portal fields: Shipping line, Qty, TEUs, Feeder vessel, FVSL ETD/ETA, Mother vessel, MVSL ETD/ETA, plus an optional CBM. TEUs fills as 2 x Qty until you type TEUs yourself (clear it to go back to auto).
- A chip under each line shows its carrier (the Settings line map; `FML-`, `FML ` or `FML/` prefixes are FML). An unmapped line is flagged and links to Settings; its TEU counts for no carrier.
- Save day replaces the whole day (PUT /stuffing/{date}), like re-uploading that day's report. Delete this day asks first (DELETE). Save is disabled while a number or date is invalid. Leaving the page, changing day or changing week with unsaved rows asks first.
- Paste from Excel: paste tab-separated rows (header optional, columns in the order above, dates read day first). A preview shows the rows; Add rows appends, Replace rows swaps the day's rows on screen (still needs Save).
- Totals strip: TEU per carrier, Not mapped and the day, rounded up to whole TEU like the rest of the app.
- `?demo` uses an in-memory mock (`CA.api.stuffingWeek/stuffingDay/saveStuffingDay/deleteStuffingDay` in `js/data.js`).
