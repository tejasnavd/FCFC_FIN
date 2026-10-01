import { loadJSON, saveJSON, bus, isOrganiser } from "./utils.js";
import { renderGames, initGamesControls } from "./games.js";
import { renderWallet, initWalletControls } from "./wallet.js";
import { renderRoster, initGroupControls } from "./group.js";
import { initSettings, renderProfile, restoreRole } from "./settings.js";
import { setAuthSeed, sessionName, currentUser } from "./auth.js";
import { initLogin, renderLogin, setupPending, resetLogin, previewStep } from "./login.js";
import { setSeedPayments } from "./payments.js";
import { setAdminSeed, resetDemoSettle } from "./admin-store.js";
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

// The single data boundary. Today it's the bundled seed module, loaded with a
// real dynamic import (a separate network request), so the skeleton state is
// genuine rather than staged. When a backend exists, replace the import with
// fetch() calls returning the same shape; nothing else needs to change.
async function loadClubData() {
  // Dev-only: ?latency=1500 simulates a slow connection to preview loading.
  const latency = Number(new URLSearchParams(location.search).get("latency")) || 0;
  if (latency) await new Promise(r => setTimeout(r, latency));
  return import("../data/seed.js");
}

function showLoadError(main) {
  const msg = `
    <div class="load-error" role="alert">
      <strong>Couldn't load the club's data</strong>
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

  setSeedPayments(data.pendingPayments);
  setAdminSeed(data);
  // DEMO-ONLY: restart the Tejas -> Hemant extras settle on every load (see admin-store.js)
  if (data.extras) resetDemoSettle(data.extras.id, "Tejas");
  setAuthSeed(data);
  initLogin();
  const params = new URLSearchParams(location.search);
  if (params.get("login")) previewStep(params.get("login"), params.get("step"));   // dev/screenshot convenience

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
    document.getElementById("price-pill").textContent = `₹${data.PRICE_PER_HEAD} per game`;
    renderProfile(currentUser());
    renderGames(data);
    renderWallet(data);
    renderRoster(data);
    renderAdmin(data);
  };
  renderAll();
  // organiser mode, payment confirmations etc. touch more than one tab
  bus.addEventListener("change", renderAll);


  // Clear the busy state and play the one arrival moment (squad bars fill).
  // The class is removed afterwards so later re-renders (RSVP taps) don't replay it.
  main.setAttribute("aria-busy", "false");
  main.classList.add("is-arriving");
  setTimeout(() => main.classList.remove("is-arriving"), 1200);
}

document.addEventListener("DOMContentLoaded", init);
