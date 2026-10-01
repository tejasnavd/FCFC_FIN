// Identity: a single-device SIMULATION, not real authentication.
// - Session: which roster member this browser is logged in as.
// - PINs: a salted SHA-256 hash per name, stored in this browser only. They
//   are checked when someone picks an already-registered name on this device,
//   and nowhere else. Other devices don't see them until there's a backend.
//
// The logged-in person is derived from their roster row (one record per
// person): balance, games played, etc. all come from effectiveRoster().
import { loadJSON, saveJSON, emit, isObj, asObj, isStr } from "./utils.js";
import { effectiveRoster } from "./admin-store.js";

const SESSION_KEY = "fcfc_session";
const PINS_KEY = "fcfc_pins";          // { [name]: { salt, hash } }

let seed = { roster: [], PRICE_PER_HEAD: 250 };
export const setAuthSeed = d => { seed = d; };

export const sessionName = () => { const n = loadJSON(SESSION_KEY, null); return isStr(n) ? n : null; };
export const isMember = name => seed.roster.some(r => r[0] === name) || effectiveRoster().some(r => r[0] === name && r[3].kind !== "guest");

export function currentUser() {
  const name = sessionName();
  if (!name) return null;
  const row = effectiveRoster().find(r => r[0] === name);
  if (!row) return null;
  const [, balance, played] = row;
  const seedRow = seed.roster.find(r => r[0] === name);
  return {
    name,
    balance,                                  // includes confirmed top-ups + organiser adjustments
    playedThisMonth: played,
    gamesLeft: Math.max(0, Math.floor(balance / seed.PRICE_PER_HEAD)),
    openingBalance: seedRow ? seedRow[1] : 0,
  };
}

export function login(name) { saveJSON(SESSION_KEY, name); emit("session"); }
export function logout() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  emit("session");
}

/* ---------------- PINs ---------------- */

const pins = () => Object.fromEntries(Object.entries(asObj(loadJSON(PINS_KEY, null))).filter(([, v]) => isObj(v) && isStr(v.salt) && isStr(v.hash)));
export const hasPin = name => Boolean(pins()[name]);

async function digest(text) {
  if (globalThis.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  // non-secure origins have no crypto.subtle: fall back to FNV-1a (still local-only)
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `fnv-${h.toString(16)}`;
}

export async function setPin(name, pin) {
  const salt = Math.random().toString(36).slice(2, 10);
  const all = pins();
  all[name] = { salt, hash: await digest(`${salt}:${pin}`) };
  saveJSON(PINS_KEY, all);
  emit("pins");
}

export async function checkPin(name, pin) {
  const rec = pins()[name];
  if (!rec) return true;
  return (await digest(`${rec.salt}:${pin}`)) === rec.hash;
}

// Organiser action: forget a name's PIN on this device.
export function resetPin(name) {
  const all = pins();
  delete all[name];
  saveJSON(PINS_KEY, all);
  emit("pins");
}

export const validPin = pin => /^\d{4}$/.test(pin);
