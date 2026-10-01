// Monthly sheets per member, mirroring the club spreadsheet's monthly tabs
// (a row per member: per-date game charges, total, carry-forward).
//
// SYNTHESIZED - placeholder history until the real sheet tabs are imported.
// What's REAL and what's made up:
// - REAL: member names; current balances; September games-played counts
//   (roster); Tejas's July/August top-ups and August games (walletHistory).
// - SYNTHESIZED: which September dates each game fell on (the last 5 are
//   mapped from recentAttendance so the "Last 5" dots agree), every month
//   from Jul 2025 to Aug 2026, and all top-ups outside Tejas's history.
// Balances are generated backwards from today's real balances, so each
// month's carry-forward equals the next month's opening balance exactly.
// Deterministic: the same seed data always produces the same history.

const PRICE = 250;
const FIRST = { y: 2025, m: 7 };      // the sheet starts in July 2025
const CURRENT = { y: 2026, m: 9 };
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const pad = n => String(n).padStart(2, "0");
const keyOf = (y, m) => `${y}-${pad(m)}`;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function rng(seed) {             // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The club's fixed pattern: every Tue, Thu and Sat.
function gameDates(y, m) {
  const out = [];
  const days = new Date(y, m, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const wd = new Date(y, m - 1, d).getDay();
    if (wd === 2 || wd === 4 || wd === 6) out.push(`${y}-${pad(m)}-${pad(d)}`);
  }
  return out;
}

function monthsList() {
  const out = [];
  let { y, m } = FIRST;
  while (y < CURRENT.y || (y === CURRENT.y && m <= CURRENT.m)) {
    out.push({ y, m });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const pick = (arr, n, r) => arr.map(x => [r(), x]).sort((a, b) => a[0] - b[0]).slice(0, n).map(x => x[1]).sort();
const round250 = v => Math.round(v / PRICE) * PRICE;

export function buildMonthSheets({ roster, recentAttendance = {}, walletHistory = {} }) {
  const months = monthsList();
  const cur = months[months.length - 1];
  const sheets = months.map(({ y, m }) => ({
    key: keyOf(y, m),
    label: `${MONTH_NAMES[m - 1]} ${y}`,
    current: y === cur.y && m === cur.m,
    dates: gameDates(y, m),
    rows: {},
  }));
  const byKey = Object.fromEntries(sheets.map(s => [s.key, s]));

  roster.forEach(([name, balance, playedNow]) => {
    const r = rng(hash(name));
    const history = walletHistory[name];

    // ---- current month: real games count, dates synthesized ----
    const sep = byKey[keyOf(cur.y, cur.m)];
    const last5Dates = sep.dates.slice(-5);
    const last5 = recentAttendance[name] || [0, 0, 0, 0, 0];
    let played = last5Dates.filter((_, i) => last5[i]);
    const need = Math.max(0, playedNow - played.length);
    played = [...pick(sep.dates.slice(0, -5), need, r), ...played].sort();
    // pay-as-you-play this month, so the balance carried into September
    // equals today's balance (matches the wallet's "carried forward" line)
    sep.rows[name] = { games: played, spent: played.length * PRICE, topups: played.length * PRICE, carried: balance };

    // ---- earlier months, walking backwards from today's balance ----
    let endBalance = balance;
    const past = sheets.slice(0, -1).reverse();           // Aug 2026 back to Jul 2025

    if (history) {
      // members with a real dated wallet history: use it, and only for the
      // months it covers (they joined then)
      const byMonth = {};
      history.forEach(h => {
        const k = h.date.slice(0, 7);
        const b = (byMonth[k] = byMonth[k] || { topups: 0, games: 0 });
        if (h.kind === "topup") b.topups += h.amt;
        if (h.kind === "games") b.games += Math.round(-h.amt / PRICE);
      });
      const first = Object.keys(byMonth).sort()[0];
      past.forEach(s => {
        if (s.key < first) return;
        const b = byMonth[s.key] || { topups: 0, games: 0 };
        const games = pick(s.dates, b.games, r);
        s.rows[name] = { games, spent: games.length * PRICE, topups: b.topups, carried: endBalance };
        endBalance = endBalance - b.topups + games.length * PRICE;
      });
      return;
    }

    // everyone else: an activity level, with inactive members tapering off
    // toward now (they used to play, then stopped)
    const nowRate = playedNow / sep.dates.length;
    const base = 0.15 + r() * 0.5;
    past.forEach((s, i) => {
      const ago = i + 1;                                   // months before now
      const rate = nowRate > 0
        ? Math.min(0.95, nowRate * (0.75 + r() * 0.5))
        : Math.min(0.9, base * Math.min(1, ago / 4));      // quiet recently, more active earlier
      const n = Math.max(0, Math.min(s.dates.length, Math.round(rate * s.dates.length + (r() - 0.5) * 2)));
      const games = pick(s.dates, n, r);
      const spent = games.length * PRICE;
      // steer the opening balance toward 0 by July 2025, in ₹250 steps
      const monthsLeft = past.length - i;
      const target = endBalance * ((monthsLeft - 1) / monthsLeft) + (r() - 0.5) * 500;
      const topups = Math.max(0, round250(endBalance + spent - target));
      s.rows[name] = { games, spent, topups, carried: endBalance };
      endBalance = endBalance - topups + spent;
    });
  });

  return sheets.reverse();          // newest first
}
