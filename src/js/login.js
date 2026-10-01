// Login screen: pick your name -> (PIN if this name has one) -> in.
// The server decides: an unclaimed name logs straight in and is offered a
// PIN; a claimed name needs its PIN (5 tries, then a 30-second lock).
import { esc, colorFor, initials, emit } from "./utils.js";
import { effectiveRoster } from "./admin-store.js";
import { login, hasPin, setPin, validPin } from "./auth.js";

let step = "pick";          // "pick" | "pin" | "setup"
let picked = null;
let query = "";
let error = "";
let busy = false;
let lockedUntil = 0;
let claiming = false;       // free-claim login in flight: stay on the picker

// While claiming a name or showing PIN setup, keep the login screen up even
// though a session already exists.
export const setupPending = () => step === "setup" || claiming;

const members = () => effectiveRoster().filter(r => r[3].kind !== "guest").map(r => r[0]).sort((a, b) => a.localeCompare(b));
const avatar = (n, cls = "m-av") => `<span class="${cls}" style="background:${colorFor(n)}" aria-hidden="true">${initials(n)}</span>`;
const AUTH_NOTE = `Your PIN is checked by the club's server, so it protects your name on every device. It's a small club server, not bank-grade security: pick a PIN you don't use anywhere else.`;

function listHtml() {
  const q = query.trim().toLowerCase();
  const names = members().filter(n => n.toLowerCase().includes(q));
  return names.length
    ? names.map(n => `<li><button type="button" class="login-name" data-pick="${esc(n)}" ${busy ? "disabled" : ""}>${avatar(n)}<span class="ln-name">${esc(n)}</span>${hasPin(n) ? `<span class="tag">PIN set</span>` : ""}</button></li>`).join("")
    : `<li class="login-empty">No member called “${esc(query)}”. Guests can't log in; they book through a member.</li>`;
}

function pickHtml() {
  return `
    <div class="card-block login-card">
      <h2 class="login-title" id="login-title">Who's playing?</h2>
      <p class="login-sub">Pick your name from the club list.</p>
      <div class="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="login-search" placeholder="Search your name…" autocomplete="off" aria-label="Search your name" value="${esc(query)}">
      </div>
      <p class="login-err" role="alert">${esc(error)}</p>
      <ul class="login-list" id="login-list">${listHtml()}</ul>
    </div>
    <p class="login-foot">Only club members can log in. The first time you pick your name you'll be asked to set a PIN.</p>`;
}

function pinHtml() {
  const locked = Date.now() < lockedUntil;
  return `
    <div class="card-block login-card">
      <button type="button" class="link-btn" data-back>Not ${esc(picked)}? Pick another name</button>
      <div class="login-who">${avatar(picked, "avatar-lg")}<div><h2 class="login-title" id="login-title">${esc(picked)}</h2><div class="login-sub">This name has a PIN.</div></div></div>
      <form id="pin-form" class="pin-form" novalidate>
        <input type="text" name="username" value="${esc(picked)}" autocomplete="username" hidden>
        <label class="field-l">Enter your 4-digit PIN
          <input class="pin-in" name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="4" pattern="[0-9]{4}" ${locked ? "disabled" : ""}>
        </label>
        <p class="login-err" role="alert">${esc(error)}</p>
        <button type="submit" class="pay-btn" ${locked || busy ? "disabled" : ""}>${busy ? "Checking…" : "Log in"}</button>
      </form>
    </div>
    <p class="login-foot">Forgot it? An organiser can reset it from the Organiser tab. ${AUTH_NOTE}</p>`;
}

function setupHtml() {
  return `
    <div class="card-block login-card">
      <div class="login-who">${avatar(picked, "avatar-lg")}<div><h2 class="login-title" id="login-title">You're in, ${esc(picked)}</h2><div class="login-sub">This device will stay logged in as you.</div></div></div>
      <form id="setup-form" class="pin-form" novalidate>
        <input type="text" name="username" value="${esc(picked)}" autocomplete="username" hidden>
        <p class="login-text">Set a 4-digit PIN. Anyone picking ${esc(picked)} on another device will need it.</p>
        <div class="pin-pair">
          <label class="field-l">New PIN<input class="pin-in" name="pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="4" pattern="[0-9]{4}"></label>
          <label class="field-l">Type it again<input class="pin-in" name="pin2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="4" pattern="[0-9]{4}"></label>
        </div>
        <p class="login-err" role="alert">${esc(error)}</p>
        <button type="submit" class="pay-btn" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Save PIN"}</button>
        <button type="button" class="link-btn skip" data-skip>Skip for now</button>
      </form>
      <div class="sim-note">
        <strong>Until you set a PIN, anyone can pick your name.</strong>
        ${AUTH_NOTE}
      </div>
    </div>`;
}

export function renderLogin() {
  const el = document.getElementById("login-body");
  el.innerHTML = step === "pin" ? pinHtml() : step === "setup" ? setupHtml() : pickHtml();
  const first = el.querySelector(step === "pick" ? "#login-search" : ".pin-in:not([disabled])");
  if (first && step !== "pick") first.focus({ preventScroll: true });
}

// A new session always starts from the name picker.
export function resetLogin() { step = "pick"; picked = null; error = ""; query = ""; busy = false; claiming = false; }

async function tryLogin(name, pin) {
  busy = true; error = ""; claiming = pin === undefined; renderLogin();
  try {
    const { needsPinSetup } = await login(name, pin);
    busy = false; claiming = false;
    if (needsPinSetup) { step = "setup"; renderLogin(); }
    else { step = "pick"; emit("login"); }
  } catch (e) {
    busy = false; claiming = false;
    if (e.data && e.data.needsPin) { step = "pin"; error = ""; }
    else if (e.status === 423) {
      step = "pin";
      lockedUntil = Date.now() + (e.data.retryIn || 30) * 1000;
      error = e.message;
      setTimeout(() => { if (step === "pin") { error = ""; renderLogin(); } }, (e.data.retryIn || 30) * 1000);
    } else { step = pin === undefined ? "pick" : "pin"; error = e.message; }
    renderLogin();
  }
}

export function initLogin() {
  const el = document.getElementById("login-body");
  el.addEventListener("input", e => {
    if (e.target.id === "login-search") { query = e.target.value; document.getElementById("login-list").innerHTML = listHtml(); }
    if (e.target.classList.contains("pin-in")) e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4);
  });
  el.addEventListener("click", e => {
    const pick = e.target.closest("[data-pick]");
    if (pick && !busy) {
      picked = pick.dataset.pick;
      error = "";
      if (hasPin(picked)) { step = "pin"; renderLogin(); }
      else tryLogin(picked);                              // unclaimed name: free login, then offer a PIN
      return;
    }
    if (e.target.closest("[data-back]")) { resetLogin(); renderLogin(); return; }
    if (e.target.closest("[data-skip]")) { step = "pick"; error = ""; emit("login"); }
  });
  el.addEventListener("submit", async e => {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.target);
    if (e.target.id === "pin-form") {
      const pin = String(fd.get("pin") || "");
      if (!validPin(pin)) { error = "Enter all 4 digits."; renderLogin(); return; }
      tryLogin(picked, pin);
    } else if (e.target.id === "setup-form") {
      const pin = String(fd.get("pin") || ""), pin2 = String(fd.get("pin2") || "");
      if (!validPin(pin)) { error = "Use exactly 4 digits."; renderLogin(); return; }
      if (pin !== pin2) { error = "Those two PINs don't match."; renderLogin(); return; }
      busy = true; error = ""; renderLogin();
      try {
        await setPin(pin);
        busy = false; step = "pick"; emit("login");
      } catch (err) {
        busy = false; error = err.message; renderLogin();
      }
    }
  });
}

// dev/screenshot convenience: ?login=Name&step=pin|setup previews a step
export function previewStep(name, which) {
  if (!name) return;
  picked = name;
  step = which === "setup" ? "setup" : which === "pin" ? "pin" : "pick";
}
