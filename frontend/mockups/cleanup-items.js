/* MOCKUP ONLY, not part of the app. The 14 pieces of repeated information on the Overview, Weekly
 * allocation and Allocation vs Utilization, as proposed for removal. Shared by the mockup chrome
 * (cleanup-before-after.js: the list in "Changes") and the screens (cleanup-screen.js: the
 * outlines in "Changes" and the edits in "After").
 *   n      the number on the badge
 *   page   overview | weekly | avu | all
 *   title  what goes (the list)
 *   cap    the short caption on the badge
 *   after  what the page shows instead (the list)
 *   keep   true when nothing changes (item 8): the badge is drawn as a "kept" mark
 */
window.MK_ITEMS = [
  { n: 1, page: 'overview', title: 'Headline sub line repeats the balance',
    cap: 'Shortfall sentence goes',
    after: 'Only the date range: “2 to 8 November 2026.”' },
  { n: 2, page: 'overview', title: 'Still to arrive: Forecast and To be arrived rows',
    cap: 'Both rows are in the figure list',
    after: 'Bar, Arrived so far, the deficit key and “How is this worked out?” stay.' },
  { n: 3, page: 'overview', title: 'Chart key line “TEU left = confirmed − utilized”',
    cap: 'Said again under How is this worked out?',
    after: 'The chart legend stays; the formula line goes.' },
  { n: 4, page: 'overview', title: 'Upload: two headings and two intro lines',
    cap: 'One heading, one intro line',
    after: 'Heading “Upload” with one intro line; the “Forecast” title and its own line go. The Data entry pointer stays as a small line.' },
  { n: 5, page: 'overview', title: 'Small “TEU” after every figure',
    cap: 'Footer already says figures are in TEU',
    after: 'Numbers only in the figure list.' },
  { n: 6, page: 'weekly', title: 'The week as typed: Forecast, Confirmed, Left in hand',
    cap: 'Same as the TOTAL row of the table',
    after: 'Only To be arrived and Deficit, under Save and its status line.' },
  { n: 7, page: 'weekly', title: '“FML not included” said twice',
    cap: 'Kept once, under the Forecast total',
    after: 'Only the note under the table’s Forecast total.' },
  { n: 8, page: 'weekly', title: 'Link “Date-wise for this week”',
    cap: 'Kept, no change', keep: true,
    after: 'No change.' },
  { n: 9, page: 'avu', title: 'Headline sentence repeats the WEEK 45 row',
    cap: 'Week totals are in the table',
    after: 'Only the date range: “2 to 8 November 2026.”' },
  { n: 10, page: 'avu', title: '“Below forecast” / “Above forecast” words',
    cap: 'Sign and colour say it',
    after: 'Number only; “On forecast” keeps its word.' },
  { n: 11, page: 'avu', title: 'Day by day intro repeats the Date-wise hint',
    cap: 'One sentence',
    after: '“Stuffed TEU per carrier for each day; the deeper the colour, the busier the cell. Select a day to open it in Date-wise.”' },
  { n: 12, page: 'avu', title: 'Small bar beside each Day total',
    cap: 'The number is enough',
    after: 'Day total shows the number only.' },
  { n: 13, page: 'all', title: 'Footer: two rounding and unit notes',
    cap: 'One short line',
    after: '“Figures in TEU, rounded up to whole TEU. 1 TEU is 33 CBM after the 30% uplift.”' },
  { n: 14, page: 'all', title: 'Developer text in the footer',
    cap: 'Test-only text',
    after: 'Gone (backend address, demo data and test fixture notes).' }
];
