// Profile & settings panel, opened from the header me-chip. Sections:
// profile, Appearance (theme), Organiser mode.
// Theme: "system" (no data-theme; CSS follows prefers-color-scheme) or an
// explicit "light"/"dark" stamped on <html data-theme> and saved. The inline
// script in index.html applies the saved choice before first paint.
import { initials, inr, emit, resetDevice } from "./utils.js";
import { popover } from "./popover.js";
import { logout } from "./auth.js";

const THEME_KEY = "fcfc_theme";
const ROLE_KEY = "fcfc_role";
const root = document.documentElement;
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

// What the radio should show: a ?theme= preview counts as the current choice.
function currentChoice() {
  return root.dataset.theme || "system";
}

function applyTheme(choice) {
  const set = () => {
    if (choice === "system") delete root.dataset.theme;
    else root.dataset.theme = choice;
  };
  if (document.startViewTransition && !reduceMotion.matches) document.startViewTransition(set);
  else set();
  try {
    // saved explicitly, including "system": no saved value means Light
    localStorage.setItem(THEME_KEY, choice);
  } catch (e) { /* private mode — the choice still applies for this visit */ }
  updateNote();
}

function updateNote() {
  const note = document.getElementById("theme-note");
  const choice = currentChoice();
  note.textContent = choice === "system"
    ? `Following your device, currently ${systemDark.matches ? "dark" : "light"}.`
    : `Always ${choice}, whatever your device is set to.`;
}

// Restore organiser mode before first render. ?role=organiser previews it.
export function restoreRole() {
  let role = new URLSearchParams(location.search).get("role");
  if (!role) { try { role = localStorage.getItem(ROLE_KEY); } catch (e) {} }
  if (role === "organiser") root.dataset.role = "organiser";
}

export function initSettings() {
  const chip = document.getElementById("me-chip");
  const panel = document.getElementById("settings");
  const radios = panel.querySelectorAll('input[name="theme"]');

  const choice = currentChoice();
  radios.forEach(r => {
    r.checked = r.value === choice;
    r.addEventListener("change", () => { if (r.checked) applyTheme(r.value); });
  });
  updateNote();
  systemDark.addEventListener("change", updateNote);

  const pop = popover(chip, panel);
  // Reset this device: a deliberate two-step action
  const resetOpen = document.getElementById("reset-open");
  const resetBox = document.getElementById("reset-confirm");
  const toggleReset = show => {
    resetBox.hidden = !show;
    resetOpen.hidden = show;
    resetOpen.setAttribute("aria-expanded", String(show));
    (show ? document.getElementById("reset-cancel") : resetOpen).focus();
  };
  resetOpen.addEventListener("click", () => toggleReset(true));
  document.getElementById("reset-cancel").addEventListener("click", () => toggleReset(false));
  document.getElementById("reset-go").addEventListener("click", resetDevice);

  document.getElementById("logout-btn").addEventListener("click", () => {
    pop.close(false);
    logout();   // PINs stay; only this device's session ends
  });

  // Organiser mode: device-local, shows organiser tools. Not a permission.
  const org = document.getElementById("org-toggle");
  org.checked = root.dataset.role === "organiser";
  org.addEventListener("change", () => {
    if (org.checked) root.dataset.role = "organiser"; else delete root.dataset.role;
    try { localStorage.setItem(ROLE_KEY, org.checked ? "organiser" : "player"); } catch (e) {}
    emit("role");
  });

  // Dev/screenshot convenience: ?settings=open shows the panel on load.
  if (new URLSearchParams(location.search).get("settings") === "open") pop.open(false);
}

export function renderProfile(user) {
  if (!user) return;
  const ini = initials(user.name);
  document.getElementById("me-name").textContent = user.name;
  document.getElementById("me-avatar").textContent = ini;
  document.getElementById("settings-name").textContent = user.name;
  document.getElementById("settings-avatar").textContent = ini;
  document.getElementById("settings-sub").textContent =
    `${inr(user.balance)} in your wallet${root.dataset.role === "organiser" ? ". Organiser tools on." : ""}`;
}
