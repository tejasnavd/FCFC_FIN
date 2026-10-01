// Organiser overlays on top of seed.js. Device-local (localStorage) until a
// backend exists; every read merges seed + overlay, nothing mutates seed.
//
//   fcfc_admin_fixtures: { created: [fixture], edits: { id: patch }, cancelled: { id: { reason, at } } }
//   fcfc_admin_players:  { kind: { name: "member"|"guest" }, removed: [name],
//                          adjustments: [{ name, amt, reason, at, kind, ref?, counterpart? }] }
//   kind: "organiser" (manual correction) | "extras-paid" | "extras-received"
//   (a member settling shared extras from their wallet writes a pair)
import { loadJSON, saveJSON, emit, isObj, asObj, asArr, strArr, isStr, isNum } from "./utils.js";
import { confirmedTotalFor } from "./payments.js";

const FX_KEY = "fcfc_admin_fixtures";
const PL_KEY = "fcfc_admin_players";
const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const WDAYS = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
const YEAR = 2026;   // seed fixtures carry day + month only

let seed = { fixtures: [], turfs: [], roster: [], PRICE_PER_HEAD: 250 };
export const setAdminSeed = d => { seed = d; };

// Both overlays are normalised on every read: a value saved by an older
// version (missing fields, nulls, wrong types) is repaired or dropped
// instead of throwing and stopping the app from starting.
const validFixture = f => isObj(f) && isStr(f.id) && isStr(f.turf) && isStr(f.time) && isNum(Number(f.capacity)) &&
  (isStr(f.date) || (isStr(f.mo) && isNum(f.num)));
function fxState() {
  const s = asObj(loadJSON(FX_KEY, null));
  return {
    created: asArr(s.created).filter(validFixture).map(f => ({
      status: "upcoming", ...f, capacity: Number(f.capacity), signups: asArr(f.signups).filter(e => isObj(e) && isStr(e.name)),
    })),
    edits: Object.fromEntries(Object.entries(asObj(s.edits)).filter(([, v]) => isObj(v))),
    cancelled: Object.fromEntries(Object.entries(asObj(s.cancelled)).filter(([, v]) => isObj(v))
      .map(([k, v]) => [k, { ...v, reason: isStr(v.reason) ? v.reason : "Cancelled by the organiser" }])),
  };
}
function plState() {
  const s = asObj(loadJSON(PL_KEY, null));
  return {
    kind: Object.fromEntries(Object.entries(asObj(s.kind)).filter(([, v]) => v === "member" || v === "guest")),
    removed: strArr(s.removed),
    adjustments: asArr(s.adjustments).filter(a => isObj(a) && isStr(a.name) && isNum(a.amt))
      .map(a => ({ ...a, reason: isStr(a.reason) ? a.reason : "", at: isStr(a.at) ? a.at : "2026-09-01T00:00:00Z" })),
  };
}
const saveFx = s => { saveJSON(FX_KEY, s); emit("fixtures"); };
const savePl = s => { saveJSON(PL_KEY, s); emit("players"); };

/* ---------------- dates & times ---------------- */

const pad = n => String(n).padStart(2, "0");
export const dateOf = fx => fx.date || `${YEAR}-${pad(MONTHS.indexOf(fx.mo) + 1)}-${pad(fx.num)}`;
export function partsFromDate(iso) {
  const d = new Date(`${iso}T00:00:00`);
  return { wd: WDAYS[d.getDay()], num: d.getDate(), mo: MONTHS[d.getMonth()] };
}
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function to24(t12) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t12 || "");
  if (!m) return t12 || "00:00";
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return `${pad(h)}:${m[2]}`;
}
export function to12(t24) {
  const [h, m] = t24.split(":").map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

/* ---------------- fixtures ---------------- */

export function allFixtures() {
  const s = fxState();
  const createdIds = new Set(s.created.map(f => f.id));
  return [...seed.fixtures, ...s.created]
    .map(f => {
      const x = { ...f, ...(s.edits[f.id] || {}) };
      if (s.edits[f.id] && s.edits[f.id].date) Object.assign(x, partsFromDate(s.edits[f.id].date));
      x.date = dateOf(x);
      x.price = x.price ?? seed.PRICE_PER_HEAD;
      x.hosted = createdIds.has(f.id);
      if (s.cancelled[f.id]) x.cancelled = s.cancelled[f.id];
      return x;
    })
    .sort((a, b) => (a.date + to24(a.time)).localeCompare(b.date + to24(b.time)));
}

const exists = (list, date, time, turf) =>
  list.some(f => f.date === date && to24(f.time) === to24(time) && f.turf === turf);

// Same weekday and week-of-month, k months later ("2nd Tuesday"). A 5th
// weekday that doesn't exist next month becomes that month's last one.
export function addMonthsSameWeekday(iso, k) {
  const d = new Date(`${iso}T00:00:00`);
  const wd = d.getDay();
  const nth = Math.floor((d.getDate() - 1) / 7);          // 0-based; 4 = "5th"
  const y = d.getFullYear(), m = d.getMonth() + k;
  const first = new Date(y, m, 1);
  let day = 1 + ((wd - first.getDay() + 7) % 7) + 7 * nth;
  const daysIn = new Date(y, m + 1, 0).getDate();
  while (day > daysIn) day -= 7;
  const t = new Date(y, m, day);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

// Creates one game, or a series repeating weekly or monthly `count` times.
// Skips any date that already has a game at the same turf and time.
// Returns the created fixtures. (`weeks` kept for older callers.)
export function createFixtures({ turf, date, time, capacity, price, every = "week", count, weeks = 1 }) {
  const s = fxState();
  const existing = allFixtures();
  const n = count || weeks;
  const series = n > 1 ? `series-${Date.now()}` : null;
  const made = [];
  for (let i = 0; i < n; i++) {
    const d = every === "month" ? addMonthsSameWeekday(date, i) : addDays(date, 7 * i);
    if (exists([...existing, ...made], d, time, turf)) continue;
    made.push({
      id: `hosted-${d}-${turf}-${to24(time).replace(":", "")}-${Date.now().toString(36)}${i}`,
      ...partsFromDate(d), date: d, time, turf,
      capacity: Number(capacity), price: Number(price),
      status: "upcoming", signups: [], series, repeat: n > 1 ? every : null,
    });
  }
  s.created.push(...made);
  saveFx(s);
  return made;
}

export function editFixture(id, patch) {
  const s = fxState();
  const i = s.created.findIndex(f => f.id === id);
  if (i >= 0) {
    s.created[i] = { ...s.created[i], ...patch, ...(patch.date ? partsFromDate(patch.date) : {}) };
  } else {
    s.edits[id] = { ...(s.edits[id] || {}), ...patch };
  }
  saveFx(s);
}

export function cancelFixture(id, reason) {
  const s = fxState();
  s.cancelled[id] = { reason, at: new Date().toISOString() };
  saveFx(s);
}
export function restoreFixture(id) {
  const s = fxState();
  delete s.cancelled[id];
  saveFx(s);
}

// "Same as last week": copy turf/time/capacity/price one week later, no sign-ups.
export function duplicateFixture(id) {
  const f = allFixtures().find(x => x.id === id);
  if (!f) return [];
  let d = addDays(f.date, 7);
  const list = allFixtures();
  while (exists(list, d, f.time, f.turf)) d = addDays(d, 7);
  return createFixtures({ turf: f.turf, date: d, time: f.time, capacity: f.capacity, price: f.price });
}

// The club's fixed weekly pattern. Adds the next week that isn't already
// fully scheduled, after the latest game on the calendar.
export const REGULARS = [
  { day: 2, time: "6:30 AM", capacity: 14 },   // Tue
  { day: 4, time: "6:30 AM", capacity: 14 },   // Thu
  { day: 6, time: "7:00 AM", capacity: 18 },   // Sat
];
export function scheduleRegulars() {
  const list = allFixtures();
  const last = list.length ? list[list.length - 1].date : `${YEAR}-01-01`;
  // Monday after the last scheduled game
  let monday = addDays(last, 1);
  while (new Date(`${monday}T00:00:00`).getDay() !== 1) monday = addDays(monday, 1);
  const made = [];
  REGULARS.forEach(r => {
    const d = addDays(monday, r.day - 1);
    made.push(...createFixtures({ turf: "sufc", date: d, time: r.time, capacity: r.capacity, price: seed.PRICE_PER_HEAD }));
  });
  return made;
}

/* ---------------- players ---------------- */

export const kindOf = (name, fallback) => plState().kind[name] || fallback;
export const isRemoved = name => plState().removed.includes(name);

export function setKind(name, kind) {
  const s = plState();
  s.kind[name] = kind;
  savePl(s);
}
export function setRemoved(name, removed) {
  const s = plState();
  s.removed = s.removed.filter(n => n !== name);
  if (removed) s.removed.push(name);
  savePl(s);
}
export function addAdjustment(name, amt, reason) {
  const s = plState();
  s.adjustments.push({ name, amt: Math.round(amt), reason, at: new Date().toISOString(), kind: "organiser" });
  savePl(s);
}

// Member-initiated internal transfer for shared extras: debit the member,
// credit the payer, in one write. Returns false if already settled.
export function transferExtras({ from, to, amt, ref, title }) {
  const s = plState();
  if (s.adjustments.some(a => a.kind === "extras-paid" && a.ref === ref && a.name === from)) return false;
  const at = new Date().toISOString();
  s.adjustments.push(
    { name: from, amt: -amt, reason: title, at, kind: "extras-paid", ref, counterpart: to },
    { name: to, amt, reason: title, at, kind: "extras-received", ref, counterpart: from },
  );
  savePl(s);
  return true;
}
export const paidViaWallet = ref =>
  new Set(plState().adjustments.filter(a => a.kind === "extras-paid" && a.ref === ref).map(a => a.name));
const isOrgAdj = a => !a.kind || a.kind === "organiser";
export const adjustmentsFor = name => plState().adjustments.filter(a => a.name === name);
export const adjustmentTotal = name => adjustmentsFor(name).reduce((t, a) => t + a.amt, 0);

// Guests seen in any fixture's sign-ups (with who brought them).
export function knownGuests() {
  const seen = new Map();
  allFixtures().forEach(f => f.signups.forEach(e => {
    if (e.kind === "guest" && !seen.has(e.name)) seen.set(e.name, e.host);
  }));
  return [...seen].map(([name, host]) => ({ name, host }));
}

// Roster with every organiser change applied: promoted guests join (₹0,
// 0 games), balances include confirmed top-ups and manual adjustments.
// Each row: [name, balance, played, meta]
export function effectiveRoster() {
  const names = new Set(seed.roster.map(r => r[0]));
  const promoted = knownGuests().filter(g => kindOf(g.name, "guest") === "member" && !names.has(g.name));
  return [...seed.roster, ...promoted.map(g => [g.name, 0, 0])].map(([name, bal, played]) => {
    const adj = adjustmentTotal(name);
    return [name, bal + confirmedTotalFor(name) + adj, played, {
      kind: kindOf(name, "member"),
      removed: isRemoved(name),
      adjusted: adjustmentsFor(name).some(isOrgAdj),
      promoted: !names.has(name),
    }];
  });
}

// ---------------------------------------------------------------------------
// DEMO-ONLY SCAFFOLDING. Remove once the settle-from-wallet demo is done.
// On every page load, forget Tejas's settle-from-wallet transfer for one
// extras item (both halves of the pair: his "extras-paid" and the payer's
// "extras-received" from him), so the demo always starts at "Tejas owes".
// Nothing else is touched: other people's settles and organiser corrections
// stay exactly as they are.
export function resetDemoSettle(ref, name = "Tejas") {
  const s = plState();
  const keep = s.adjustments.filter(a => !(
    a.ref === ref && (
      (a.kind === "extras-paid" && a.name === name) ||
      (a.kind === "extras-received" && a.counterpart === name)
    )
  ));
  if (keep.length !== s.adjustments.length) saveJSON(PL_KEY, { ...s, adjustments: keep });   // no emit: runs before first render
}
// ---------------------------------------------------------------------------
