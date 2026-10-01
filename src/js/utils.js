// Muted "matte enamel" kit colours — same hues as before, lower chroma.
const AVATAR_COLORS = ["#8C98E0","#E59AB0","#8CC4A3","#E9B27A","#B39BDF","#86C3CF","#D98C9C","#A7A2E6"];

export function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(name) {
  const clean = name.replace(/[^\w\s]/g, "").trim();
  const parts = clean.split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

export function inr(n) {
  const neg = n < 0;
  n = Math.abs(Math.round(n));
  const s = n.toString();
  let last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  if (rest) last3 = "," + last3;
  const formatted = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + last3;
  return (neg ? "-" : "") + "₹" + formatted;
}

// try/catch wrappers — artifact storage rules apply here too: per-viewer
// convenience only, never load-bearing state.
export function loadJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (e) {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* ignore — private mode / blocked storage */
  }
}

// Tiny app-wide change bus: modules emit after changing local state so other
// tabs that show the same data can re-render (e.g. organiser mode toggling).
export const bus = new EventTarget();
export const emit = what => bus.dispatchEvent(new CustomEvent("change", { detail: what }));

// Organiser mode is a device-local view toggle, not a permission.
export const isOrganiser = () => document.documentElement.dataset.role === "organiser";

export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Shape guards for anything read back from localStorage. Data saved by an
// older version of the app can parse fine but have the wrong shape; readers
// run it through these and drop anything that doesn't fit.
export const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const asObj = v => (isObj(v) ? v : {});
export const asArr = v => (Array.isArray(v) ? v : []);
export const strArr = v => asArr(v).filter(x => typeof x === "string");
export const isStr = v => typeof v === "string";
export const isNum = v => typeof v === "number" && Number.isFinite(v);
// { key: [strings] } maps (dropped players, attendance, settled lists)
export const strArrMap = v => Object.fromEntries(Object.entries(asObj(v)).filter(([, a]) => Array.isArray(a)).map(([k, a]) => [k, strArr(a)]));

// Erase every key this app saved on this device, then start fresh.
export function resetDevice() {
  try {
    Object.keys(localStorage).filter(k => k.startsWith("fcfc_")).forEach(k => localStorage.removeItem(k));
  } catch (e) { /* storage blocked: nothing to clear */ }
  location.href = location.pathname;
}
