import { loadJSON, saveJSON, bus, isOrganiser } from "./utils.js";
import { renderGames, initGamesControls } from "./games.js";
import { renderWallet, initWalletControls } from "./wallet.js";
import { renderRoster, initGroupControls } from "./group.js";
import { initSettings, renderProfile, restoreRole } from "./settings.js";
import { sessionName, currentUser, login } from "./auth.js";
import { initLogin, renderLogin, setupPending, resetLogin, previewStep } from "./login.js";
import { resetDemoSettle } from "./admin-store.js";
import { loadState, state, startSync } from "./api.js";
import { renderAdmin, initAdmin, initialPane, setOpenPlayer } from "./admin.js";

const TAB_ORDER = ["games", "wallet", "group", "admin"];

// Tabs whose buttons are currently shown (the Organiser tab only appears
// while organiser mode is on).
const visibleTabs = () =>
  [...document.querySelectorAll("nav.tabbar button")].filter(b => !b.hidden).map(b => b.dataset.tab);

function initTabs() {
  const TAB_KEY = "fcfc_tab";
  const main = document.querySelector("main");
  const nav = document.querySelector("nav.tabbar");
  let current = null;

  const place = () => {
    const vis = visibleTabs();
    nav.style.setProperty("--tab-n", vis.length);
    nav.style.setProperty("--tab-i", Math.max(0, vis.indexOf(current)));
  };

  const show = (tab, { user = true } = {}) => {
    if (!visibleTabs().includes(tab) || tab === current) return;
    // direction lets the incoming panel ease in from the side its tab is on
    main.dataset.dir = current !== null && TAB_ORDER.indexOf(tab) < TAB_ORDER.indexOf(current) ? "back" : "fwd";
    current = tab;
    place();
    document.querySelectorAll("nav.tabbar button").forEach(b => {
      const on = b.getAttribute("data-tab") === tab;
      b.classList.toggle("active", on);
      if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.querySelectorAll("section.tab").forEach(s => s.classList.toggle("active", s.id === `tab-${tab}`));
    if (user) {
      saveJSON(TAB_KEY, tab);
      // each tab starts at its top rather than inheriting the last tab's scroll
      window.scrollTo({ top: 0 });
    }
  };

  // show/hide the Organiser tab to match organiser mode
  const syncRole = () => {
    document.getElementById("admin-tab-btn").hidden = !isOrganiser();
    if (current === "admin" && !isOrganiser()) show("games", { user: false });
    place();
  };

  document.querySelectorAll("nav.tabbar button").forEach(btn => {
    btn.addEventListener("click", () => show(btn.getAttribute("data-tab")));
  });
  syncRole();
  const requestedTab = new URLSearchParams(location.search).get("tab");
  show(requestedTab || loadJSON(TAB_KEY, "games"), { user: false });
  if (!current) show("games", { user: false });
  return { show, syncRole };
}

// The data boundary: one snapshot from the club server (server.py). Every
// later change arrives the same way, from an action or from syncing.
async function loadClubData() {
  // Dev-only: ?latency=1500 simulates a slow connection to preview loading.
  const latency = Number(new URLSearchParams(location.search).get("latency")) || 0;
  if (latency) await new Promise(r => setTimeout(r, latency));
  return loadState();
}

function showLoadError(main) {
  const msg = `
    <div class="load-error" role="alert">
      <strong>Couldn't reach the club server</strong>
      Check your connection, then try again.
      <div><button type="button" data-reload>Try again</button></div>
    </div>`;
  ["games-list", "hist-list", "roster-list"].forEach(id => { document.getElementById(id).innerHTML = msg; });
  document.querySelectorAll("[data-reload]").forEach(b => b.addEventListener("click", () => location.reload()));
  main.setAttribute("aria-busy", "false");
}

async function init() {
  const main = document.querySelector("main");
  restoreRole();
  initSettings();
  const tabs = initTabs();
  initAdmin({ showTab: tab => tabs.show(tab) });
  initialPane(new URLSearchParams(location.search).get("admin"));
  setOpenPlayer(new URLSearchParams(location.search).get("player"));   // dev/screenshot convenience
  initGamesControls();
  initWalletControls();
  initGroupControls();

  let data;
  try {
    data = await loadClubData();
  } catch (e) {
    console.error("[app] failed to load club data", e);
    showLoadError(main);
    return;
  }

  // DEMO-ONLY: restart the Tejas -> Hemant extras settle on every load
  // (server.py demo_reset_settle). Remove with the demo scaffolding.
  try { await resetDemoSettle(); } catch (e) { /* not essential */ }
  initLogin();
  const params = new URLSearchParams(location.search);
  if (params.get("login")) previewStep(params.get("login"), params.get("step"));   // dev/screenshot convenience
  // Dev/screenshot convenience: ?as=Name logs in as a member whose name has
  // no PIN yet (exactly what tapping the name does; claimed names still need
  // their PIN).
  if (params.get("as") && !state().me) {
    try { await login(params.get("as")); } catch (e) { console.warn("[app] ?as= login refused:", e.message); }
  }

  // Logged out (or mid PIN setup): show only the login screen.
  let wasOut = null;
  const applyAuth = () => {
    const out = !sessionName() || !currentUser() || setupPending();
    document.body.dataset.auth = out ? "out" : "in";
    document.getElementById("login").hidden = !out;
    if (out) {
      if (wasOut === false) resetLogin();          // just logged out: start at the name picker
      renderLogin();
    } else if (wasOut) {
      tabs.show("games", { user: false });         // just logged in
    }
    wasOut = out;
    return out;
  };

  const renderAll = () => {
    if (applyAuth()) return;
    tabs.syncRole();
    const S = state();
    document.getElementById("price-pill").textContent = `₹${S.PRICE_PER_HEAD} per game`;
    renderProfile(currentUser());
    renderGames(S);
    renderWallet(S);
    renderRoster(S);
    renderAdmin(S);
  };
  renderAll();
  // organiser mode, payment confirmations etc. touch more than one tab
  bus.addEventListener("change", renderAll);
  startSync();      // other devices' changes arrive within ~15s, or on focus


  // Clear the busy state and play the one arrival moment (squad bars fill).
  // The class is removed afterwards so later re-renders (RSVP taps) don't replay it.
  main.setAttribute("aria-busy", "false");
  main.classList.add("is-arriving");
  setTimeout(() => main.classList.remove("is-arriving"), 1200);
}

document.addEventListener("DOMContentLoaded", init);
