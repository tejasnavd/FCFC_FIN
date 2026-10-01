// Read model + actions for fixtures, players and the balance ledger.
// All data comes from the club server's latest snapshot (api.js); every
// change is a server action. Nothing here is stored in the browser.
import { state, act } from "./api.js";

const S = () => state() || { fixtures: [], people: {}, ledger: [], guests: [], roster: [], extras: null };

/* ---------------- dates & times (display helpers) ---------------- */

const pad = n => String(n).padStart(2, "0");
export const dateOf = fx => fx.date;
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

export const allFixtures = () => S().fixtures;

// The server runs the rules (date maths, duplicate checks, weekly/monthly
// series); these return what it created.
export const createFixtures = async ({ turf, date, time, capacity, price, every = "week", count = 1 }) =>
  (await act("/api/admin/fixtures/create", { turf, date, time: to24(time), capacity, price, every, count })).made;
export const editFixture = (id, { turf, date, time, capacity, price }) =>
  act("/api/admin/fixtures/edit", { id, turf, date, time: to24(time), capacity, price });
export const cancelFixture = (id, reason) => act("/api/admin/fixtures/cancel", { id, reason });
export const restoreFixture = id => act("/api/admin/fixtures/restore", { id });
export const duplicateFixture = async id => (await act("/api/admin/fixtures/duplicate", { id })).made;
export const scheduleRegulars = async () => (await act("/api/admin/fixtures/regulars", {})).made;
export const markPlayed = id => act("/api/admin/fixtures/played", { id });

// The club's fixed weekly pattern (shown in the organiser tab; the server
// holds the same list).
export const REGULARS = [
  { day: 2, time: "6:30 AM", capacity: 14 },   // Tue
  { day: 4, time: "6:30 AM", capacity: 14 },   // Thu
  { day: 6, time: "7:00 AM", capacity: 18 },   // Sat
];

/* ---------------- players ---------------- */

export const kindOf = (name, fallback) => (S().people[name] || {}).kind || fallback;
export const isRemoved = name => Boolean((S().people[name] || {}).removed);
export const setKind = (name, kind) => act("/api/admin/players/kind", { name, kind });
export const setRemoved = (name, removed) => act("/api/admin/players/removed", { name, removed });
export const addAdjustment = (name, amt, reason) => act("/api/admin/players/adjust", { name, amt, reason });

// Member-initiated transfer for shared extras: the server writes the paired
// ledger rows (debit the member, credit the payer) once, atomically.
export const transferExtras = ({ ref }) => act("/api/extras/settle", { id: ref });
export const paidViaWallet = () => new Set((S().extras || {}).viaWallet || []);

// Ledger entries for one person: organiser corrections, extras transfers
// and game / guest-fee charges (top-ups are listed with payments).
export const adjustmentsFor = name => S().ledger.filter(a => a.name === name);
export const adjustmentTotal = name => adjustmentsFor(name).reduce((t, a) => t + a.amt, 0);

export const knownGuests = () => S().guests;

// Each row: [name, balance, playedThisMonth, meta] computed by the server.
export const effectiveRoster = () => S().roster;

// DEMO-ONLY SCAFFOLDING (server side: demo_reset_settle in server.py).
// Remove once the settle-from-wallet demo is done.
export const resetDemoSettle = () => act("/api/demo/reset-settle", {});
