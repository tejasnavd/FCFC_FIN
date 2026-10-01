// Client for the club server (server.py). The server owns all data and
// rules; the browser keeps the latest snapshot here and renders from it.
//
//   state()          the latest snapshot (null until loadState resolves)
//   loadState()      GET /api/state
//   act(path, body)  POST an action; the response carries a fresh snapshot
//   startSync()      keep in step with other devices (poll + on focus)
//
// Every snapshot replacement emits a "change" on the app bus so all tabs
// re-render from the same data.
import { emit } from "./utils.js";

let S = null;
let inFlight = 0;
export const state = () => S;

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError("Can't reach the club server. Check your connection and try again.", 0);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) throw new ApiError((data && data.error) || `The server said no (${res.status}).`, res.status, data);
  return data || {};
}

function apply(next) {
  if (!next) return;
  const changed = !S || next.version !== S.version || next.me !== S.me;
  S = next;
  if (changed) emit("server");
}

export async function loadState() {
  const d = await request("GET", "/api/state");
  apply(d.state);
  return S;
}

// Run an action. Re-renders happen via the bus as soon as the new snapshot
// arrives; the caller gets the action's extra fields (moved, made, sent...).
export async function act(path, body = {}) {
  inFlight += 1;
  try {
    const d = await request("POST", path, body);
    apply(d.state);
    return d;
  } finally {
    inFlight -= 1;
  }
}

// Other devices change the same data: poll cheaply (the server answers
// "unchanged" when nothing moved) and refresh whenever the tab regains focus.
export function startSync({ every = 15000 } = {}) {
  const refresh = async () => {
    if (!S || inFlight || document.visibilityState !== "visible") return;
    try {
      const d = await request("GET", `/api/state?since=${S.version}&me=${encodeURIComponent(S.me || "")}`);
      if (!d.unchanged) apply(d.state);
    } catch (e) { /* offline for a moment: try again next tick */ }
  };
  setInterval(refresh, every);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("focus", refresh);
  return refresh;
}

// Show a short message for an action that failed (used where there's no
// better inline place to say it).
export function reportError(e) {
  const msg = e instanceof ApiError ? e.message : "Something went wrong. Try again.";
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(reportError.t);
  reportError.t = setTimeout(() => { el.hidden = true; }, 4500);
}
