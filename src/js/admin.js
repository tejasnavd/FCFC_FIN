// Organiser tab: Games (host / edit / cancel / duplicate / weekly regulars),
// Insights, Players. Only shown while organiser mode is on. Everything here
// writes device-local overlays via admin-store.js.
import { esc, inr, bus, loadJSON, strArrMap } from "./utils.js";
import {
  allFixtures, createFixtures, editFixture, cancelFixture, restoreFixture, duplicateFixture,
  scheduleRegulars, REGULARS, addDays, to12, to24, knownGuests, effectiveRoster, kindOf,
  setKind, isRemoved, setRemoved, addAdjustment, adjustmentsFor,
} from "./admin-store.js";
import { allocFor } from "./games.js";
import { pendingPayments, confirmedTotalFor } from "./payments.js";
import { hasPin, resetPin } from "./auth.js";

let D = null;
let pane = "games";
let editingId = null;        // fixture being edited in the form, or null for "host a game"
let cancelOpenId = null;     // fixture whose cancel-reason form is open
let openPlayer = null;
let formNote = "";
let playerQuery = "";

const turfOf = id => D.turfs.find(t => t.id === id);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const dayLabel = f => `${f.wd.charAt(0)}${f.wd.slice(1).toLowerCase()} ${f.num} ${f.mo.charAt(0)}${f.mo.slice(1).toLowerCase()}`;

/* =============== Games =============== */

// Repeat: one frequency (weekly OR monthly) plus how long it runs.
const COUNTS = { none: [[1, "Just this game"]], week: [[2, "2 weeks"], [4, "4 weeks"], [8, "8 weeks"]], month: [[2, "2 months"], [3, "3 months"], [6, "6 months"]] };
const countOptions = every => (COUNTS[every] || COUNTS.none).map(([n, l]) => `<option value="${n}">${l}</option>`).join("");
const ORD = ["1st", "2nd", "3rd", "4th", "last"];
function repeatHint(every, iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  const wd = d.toLocaleDateString("en-IN", { weekday: "long" });
  if (every === "week") return `Every ${wd}, same turf and time.`;
  if (every === "month") return `The ${ORD[Math.min(4, Math.floor((d.getDate() - 1) / 7))]} ${wd} of each month, same turf and time.`;
  return "";
}

function renderForm() {
  const el = document.getElementById("game-form");
  const f = editingId ? allFixtures().find(x => x.id === editingId) : null;
  const upcoming = allFixtures().filter(x => x.status === "upcoming");
  const nextDate = upcoming.length ? addDays(upcoming[upcoming.length - 1].date, 1) : "2026-10-06";
  const v = f
    ? { turf: f.turf, date: f.date, time: to24(f.time), capacity: f.capacity, price: f.price }
    : { turf: "sufc", date: nextDate, time: "06:30", capacity: 14, price: D.PRICE_PER_HEAD };
  el.innerHTML = `
    <form class="card-block admin-form" id="fixture-form" novalidate>
      <div class="form-head">
        <h3 class="card-title">${f ? `Edit ${esc(dayLabel(f))}` : "Host a game"}</h3>
        ${f ? `<button type="button" class="link-btn" data-stop-edit>Stop editing</button>` : ""}
      </div>
      <div class="form-grid">
        <label class="field-l">Turf
          <select name="turf">${D.turfs.map(t => `<option value="${t.id}" ${t.id === v.turf ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select>
        </label>
        <label class="field-l">Date<input type="date" name="date" value="${v.date}" required></label>
        <label class="field-l">Kickoff<input type="time" name="time" value="${v.time}" step="300" required></label>
        <label class="field-l">Places<input type="number" name="capacity" value="${v.capacity}" min="2" max="40" inputmode="numeric" required></label>
        <label class="field-l">Price per head (₹)<input type="number" name="price" value="${v.price}" min="0" max="2000" step="10" inputmode="numeric" required></label>
        ${f ? "" : `<label class="field-l">Repeats
          <select name="every">
            <option value="none">Doesn't repeat</option>
            <option value="week">Weekly</option>
            <option value="month">Monthly</option>
          </select>
        </label>
        <label class="field-l">For<select name="count" disabled>${countOptions("none")}</select></label>
        <p class="form-hint repeat-hint" id="repeat-hint">${repeatHint("none", v.date)}</p>`}
      </div>
      ${f ? `<p class="form-hint">Lowering places moves the last people in the queue to the waitlist.</p>` : ""}
      <button type="submit" class="pay-btn">${f ? "Save changes" : "Create game"}</button>
      <p class="fx-note" role="status">${esc(formNote)}</p>
    </form>`;
}

function fixtureRow(f) {
  const turf = turfOf(f.turf);
  const alloc = allocFor(f);
  const badges = [
    f.hosted ? `<span class="tag">Hosted here</span>` : "",
    f.series ? `<span class="tag">${f.repeat === "month" ? "Monthly" : "Weekly"}</span>` : "",
    f.cancelled ? `<span class="tag danger">Cancelled</span>` : "",
  ].join("");
  const cancelForm = cancelOpenId === f.id ? `
    <form class="cancel-form" data-cancel-form="${f.id}">
      <label class="field-l">Reason, shown to everyone who booked
        <select name="reason"><option>Rained out</option><option>Turf unavailable</option><option>Not enough players</option><option value="other">Something else</option></select>
      </label>
      <input type="text" name="detail" placeholder="Details (optional)" maxlength="80" class="text-in">
      <div class="row-actions">
        <button type="submit" class="danger-btn">Cancel this game</button>
        <button type="button" class="link-btn" data-keep="${f.id}">Keep it</button>
      </div>
    </form>` : "";
  return `
    <li class="afx${f.cancelled ? " is-off" : ""}">
      <div class="afx-date"><span class="wd">${f.wd}</span><span class="num">${f.num}</span><span class="mo">${f.mo}</span></div>
      <div class="afx-body">
        <div class="afx-top"><span class="afx-time">${f.time}</span>${badges}</div>
        <div class="afx-sub">${esc(turf.label)}, ${inr(f.price)} each, ${alloc.counts.CNF}/${f.capacity} CNF${alloc.counts.WL ? `, ${alloc.counts.WL} WL` : ""}</div>
        ${f.cancelled ? `<div class="afx-sub danger-t">${esc(f.cancelled.reason)}</div>` : ""}
        <div class="row-actions">
          ${f.cancelled
            ? `<button type="button" class="chip-btn" data-restore="${f.id}">Restore game</button>`
            : `<button type="button" class="chip-btn" data-edit-row="${f.id}">Edit</button>
               <button type="button" class="chip-btn" data-dup="${f.id}">Same next week</button>
               <button type="button" class="chip-btn danger-t" data-cancel="${f.id}" aria-expanded="${cancelOpenId === f.id}">Cancel game</button>`}
        </div>
        ${cancelForm}
      </div>
    </li>`;
}

function renderGameList() {
  const list = allFixtures().filter(f => f.status === "upcoming");
  const regular = REGULARS.map(r => `${["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][r.day]} ${r.time}`).join(", ");
  document.getElementById("admin-fx").innerHTML = `
    <div class="card-block regulars">
      <div><div class="card-title">Regular week</div><div class="afx-sub">${esc(regular)} at SUFC turf</div></div>
      <button type="button" class="chip-btn strong" data-regulars>Add next week</button>
    </div>
    <h2 class="section">Upcoming games <span class="count">${list.length}</span></h2>
    <ul class="afx-list">${list.map(fixtureRow).join("")}</ul>`;
}

function readForm(form) {
  const fd = new FormData(form);
  const v = {
    turf: fd.get("turf"), date: fd.get("date"), time: fd.get("time"),
    capacity: Number(fd.get("capacity")), price: Number(fd.get("price")),
    every: fd.get("every") === "month" ? "month" : "week",
    count: fd.get("every") && fd.get("every") !== "none" ? Number(fd.get("count") || 1) : 1,
  };
  if (!v.date) return { error: "Pick a date." };
  if (!v.time) return { error: "Pick a kickoff time." };
  if (!(v.capacity >= 2 && v.capacity <= 40)) return { error: "Places must be between 2 and 40." };
  if (!(v.price >= 0 && v.price <= 2000)) return { error: "Price per head must be between ₹0 and ₹2,000." };
  return { v: { ...v, time: to12(v.time) } };
}

/* =============== Insights =============== */

function insightsHtml() {
  const roster = effectiveRoster();
  const ledger = D.monthLedger.turfs.map(l => {
    const t = turfOf(l.turf);
    const fees = l.gamesPlayed * t.groundFee;
    return { ...l, label: t.label, fees, cost: fees + l.snacks, net: l.collected - fees - l.snacks };
  });
  const confirmedHere = roster.reduce((s, r) => s + confirmedTotalFor(r[0]), 0);
  const collected = ledger.reduce((s, l) => s + l.collected, 0) + confirmedHere;
  const cost = ledger.reduce((s, l) => s + l.cost, 0);
  const owing = roster.filter(r => r[1] < 0);
  const outstanding = owing.reduce((s, r) => s + Math.abs(r[1]), 0);
  const pending = pendingPayments().reduce((s, p) => s + p.amt, 0);
  const net = collected - cost;

  // cost vs collected, one row per turf, shared scale
  const max = Math.max(1, ...ledger.flatMap(l => [l.collected, l.cost]));
  const bar = (cls, v, what, l) => `
    <div class="bar-line"><span class="bar ${cls}" style="width:${Math.max(2, (v / max) * 100)}%" title="${esc(l.label)}: ${what} ${inr(v)}"></span><span class="bar-v">${inr(v)}</span></div>`;
  const chart = ledger.map(l => `
    <div class="turf-bars">
      <div class="tb-head"><span class="tb-name">${esc(l.label)}</span><span class="tb-net ${l.net >= 0 ? "pos" : "neg"}">${l.net >= 0 ? "+" : "−"}${inr(Math.abs(l.net))} net</span></div>
      ${bar("collected", l.collected, "collected", l)}
      ${bar("cost", l.cost, "cost", l)}
    </div>`).join("");

  // attendance: last played game's no-shows (with organiser marks), regulars
  const played = allFixtures().filter(f => f.status === "played");
  const lastGame = played[played.length - 1];
  let noShow = "";
  if (lastGame) {
    const marks = strArrMap(loadJSON("fcfc_attended", null))[lastGame.id] || lastGame.attended || [];
    const booked = lastGame.signups.map(e => e.name);
    const missed = booked.filter(n => !marks.includes(n));
    const rate = booked.length ? Math.round((missed.length / booked.length) * 100) : 0;
    noShow = `
      <div class="ins-row">
        <div class="stat inline"><div class="v">${rate}%</div><div class="l">no-shows at ${esc(dayLabel(lastGame))}</div></div>
        <p class="ins-text">${missed.length ? `${esc(missed.join(", "))} booked but didn't turn up (${missed.length} of ${booked.length}).` : "Everyone who booked turned up."}</p>
      </div>`;
  }
  const att = n => (D.recentAttendance[n] || [0, 0, 0, 0, 0]);
  const attN = n => att(n).reduce((a, b) => a + b, 0);
  const strip = n => `<span class="att-strip" role="img" aria-label="Played ${attN(n)} of the last 5">${att(n).map(v => `<span class="pip${v ? " on" : ""}"></span>`).join("")}</span>`;
  const members = roster.filter(r => r[3].kind !== "guest");
  const regulars = members.slice().sort((a, b) => attN(b[0]) - attN(a[0]) || b[2] - a[2]).slice(0, 5);
  // new (promoted) members and players already removed from games are left out
  const inactive = members.filter(r => attN(r[0]) === 0 && r[2] === 0 && !r[3].promoted && !r[3].removed).sort((a, b) => a[1] - b[1]);
  const slipping = members.filter(r => r[2] > 0 && attN(r[0]) <= 1).sort((a, b) => attN(a[0]) - attN(b[0]));
  const person = (r, extra) => `<li class="ins-person"><span class="ip-name">${esc(r[0])}</span>${extra}</li>`;

  return `
    <p class="ins-period">${esc(D.monthLedger.month)}</p>
    <div class="stat-strip">
      <div class="stat"><div class="v">${inr(collected)}</div><div class="l">Collected</div></div>
      <div class="stat owe"><div class="v">${inr(outstanding)}</div><div class="l">Outstanding, ${plural(owing.length, "member")}</div></div>
      <div class="stat ${net >= 0 ? "credit" : "owe"}"><div class="v">${net >= 0 ? "" : "−"}${inr(Math.abs(net))}</div><div class="l">After costs</div></div>
    </div>
    ${pending ? `<p class="ins-foot">${inr(pending)} more is waiting for you to confirm in the Table tab.</p>` : ""}

    <h2 class="section">Cost vs collected by turf</h2>
    <div class="card-block">
      <div class="legend"><span><i class="sw collected"></i>Collected</span><span><i class="sw cost"></i>Cost: ground fees and snacks</span></div>
      ${chart}
      <details class="who tbl-view">
        <summary>Show as a table<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
        <table class="ins-table">
          <thead><tr><th>Turf</th><th>Games</th><th>Fees</th><th>Snacks</th><th>Collected</th><th>Net</th></tr></thead>
          <tbody>${ledger.map(l => `<tr><td>${esc(l.label)}</td><td>${l.gamesPlayed}</td><td>${inr(l.fees)}</td><td>${inr(l.snacks)}</td><td>${inr(l.collected)}</td><td>${l.net >= 0 ? "" : "−"}${inr(Math.abs(l.net))}</td></tr>`).join("")}</tbody>
        </table>
      </details>
      ${confirmedHere ? `<p class="ins-foot">Collected also includes ${inr(confirmedHere)} of top-ups confirmed on this device, not split by turf.</p>` : ""}
    </div>

    <h2 class="section">Attendance</h2>
    <div class="card-block">
      ${noShow}
      <div class="ins-cols">
        <div><div class="ins-h">Most regular</div><ul class="ins-list">${regulars.map(r => person(r, strip(r[0]))).join("")}</ul></div>
        <div><div class="ins-h">Slipping</div>
          ${slipping.length ? `<ul class="ins-list">${slipping.map(r => person(r, strip(r[0]))).join("")}</ul>` : `<p class="ins-text">No one.</p>`}
        </div>
      </div>
      <p class="ins-foot">Last 5 fixtures, oldest to newest. Slipping: played this month but at most 1 of the last 5.</p>
    </div>

    <h2 class="section">Inactive <span class="count">${inactive.length}</span></h2>
    <div class="card-block">
      <p class="ins-text">No games this month and none in the last 5 fixtures (about two weeks). Owing money first.</p>
      <ul class="ins-list cols">${inactive.map(r => person(r, `<span class="ip-bal ${r[1] < 0 ? "owe" : ""}">${inr(r[1])}</span>`)).join("")}</ul>
    </div>`;
}

/* =============== Players =============== */

function playerRow(name, meta) {
  const { kind, host, bal } = meta;
  const removed = isRemoved(name);
  const adj = adjustmentsFor(name);
  const isOpen = openPlayer === name;
  const tags = [
    kind === "guest" ? `<span class="tag guest">Guest${host ? ` of ${esc(host)}` : ""}</span>` : "",
    removed ? `<span class="tag danger">Off future games</span>` : "",
    adj.some(x => !x.kind || x.kind === "organiser") ? `<span class="tag">Adjusted</span>` : "",
  ].join("");
  const canBalance = bal !== null;
  return `
    <details class="pl-row" data-player="${esc(name)}"${isOpen ? " open" : ""}>
      <summary>
        <span class="pl-name">${esc(name)}</span>${tags}
        <span class="pl-bal ${bal < 0 ? "owe" : bal > 0 ? "credit" : ""}">${bal === null ? "" : inr(bal)}</span>
        <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </summary>
      <div class="pl-body">
        <div class="pl-action">
          <div><div class="pl-k">${kind === "guest" ? "Guest" : "Member"}</div><div class="pl-help">Members always book ahead of guests.</div></div>
          <button type="button" class="chip-btn" data-kind="${kind === "guest" ? "member" : "guest"}">${kind === "guest" ? "Make member" : "Make guest"}</button>
        </div>
        <div class="pl-action">
          <div><div class="pl-k">${removed ? "Removed from future games" : "Can book games"}</div><div class="pl-help">${removed ? "Their existing bookings are hidden and their spots freed." : "Removing frees their spots in every upcoming game."}</div></div>
          <button type="button" class="chip-btn${removed ? "" : " danger-t"}" data-removed="${removed ? "0" : "1"}">${removed ? "Allow back" : "Remove"}</button>
        </div>
        ${kind !== "guest" ? `
        <div class="pl-action">
          <div><div class="pl-k">${hasPin(name) ? "Login PIN set on this device" : "No login PIN on this device"}</div><div class="pl-help">${hasPin(name) ? "Reset it if they've forgotten it. They'll be offered a new one next login." : "They'll be offered one when they log in."}</div></div>
          ${hasPin(name) ? `<button type="button" class="chip-btn" data-reset-pin>Reset PIN</button>` : ""}
        </div>` : ""}
        ${canBalance ? `
        <form class="adj-form" data-adjust="${esc(name)}">
          <div class="pl-k">Correct balance</div>
          <div class="adj-grid">
            <input type="number" name="amt" placeholder="± amount in ₹" step="1" inputmode="numeric" class="text-in" aria-label="Amount to add, negative to deduct">
            <input type="text" name="reason" placeholder="Reason (shown in their history)" maxlength="80" class="text-in" aria-label="Reason">
          </div>
          <button type="submit" class="chip-btn strong">Apply</button>
          ${adj.length ? `<ul class="adj-log">${adj.slice().reverse().map(a => `<li><span class="${a.amt >= 0 ? "credit" : "owe"}">${a.amt >= 0 ? "+" : ""}${inr(a.amt)}</span> ${esc(a.kind === "extras-paid" ? `Settled ${a.reason} with ${a.counterpart}` : a.kind === "extras-received" ? `Received ${a.reason} from ${a.counterpart}` : a.reason)} <time>${new Date(a.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</time></li>`).join("")}</ul>` : ""}
        </form>` : `<p class="pl-help">Guests pay through the member who brings them. Make them a member to give them a balance.</p>`}
      </div>
    </details>`;
}

function renderPlayers() {
  const q = playerQuery.trim().toLowerCase();
  const roster = effectiveRoster();
  const inRoster = new Set(roster.map(r => r[0]));
  const guests = knownGuests().filter(g => !inRoster.has(g.name));
  const rows = [
    ...guests.map(g => [g.name, { kind: kindOf(g.name, "guest"), host: g.host, bal: null }]),
    ...roster.map(r => [r[0], { kind: r[3].kind, host: null, bal: r[1] }]),
  ].filter(([n]) => n.toLowerCase().includes(q));
  const g = rows.filter(r => r[1].kind === "guest");
  const m = rows.filter(r => r[1].kind !== "guest");
  document.getElementById("admin-player-list").innerHTML = `
    <h3 class="pl-group">Members <span class="count">${m.length}</span></h3>
    ${m.length ? m.map(r => playerRow(...r)).join("") : `<p class="pl-help">No members match.</p>`}
    ${g.length ? `<h3 class="pl-group">Guests <span class="count">${g.length}</span></h3>${g.map(r => playerRow(...r)).join("")}` : ""}`;
}

/* =============== wiring =============== */

export function renderAdmin(data) {
  if (data) D = data;
  if (!D) return;
  document.querySelectorAll(".admin-pane").forEach(p => { p.hidden = p.id !== `admin-${pane}`; });
  if (pane === "games") { if (!document.getElementById("fixture-form")) renderForm(); renderGameList(); }
  if (pane === "insights") document.getElementById("admin-insights").innerHTML = insightsHtml();
  if (pane === "players") renderPlayers();
}

export function initAdmin({ showTab }) {
  document.getElementById("admin-nav").addEventListener("change", e => {
    if (e.target.name !== "admin-pane") return;
    pane = e.target.value;
    renderAdmin();
  });

  // ---- games ----
  const games = document.getElementById("admin-games");
  games.addEventListener("change", e => {
    const form = e.target.closest("#fixture-form");
    if (!form || !form.elements.every) return;
    const every = form.elements.every.value;
    if (e.target.name === "every") {
      form.elements.count.innerHTML = countOptions(every);
      form.elements.count.disabled = every === "none";
    }
    if (e.target.name === "every" || e.target.name === "date") {
      document.getElementById("repeat-hint").textContent = repeatHint(every, form.elements.date.value);
    }
  });
  games.addEventListener("submit", e => {
    e.preventDefault();
    const form = e.target;
    if (form.id === "fixture-form") {
      const { v, error } = readForm(form);
      if (error) { formNote = error; renderForm(); return; }
      if (editingId) {
        editFixture(editingId, { turf: v.turf, date: v.date, time: v.time, capacity: v.capacity, price: v.price });
        formNote = "Saved. Players see the change straight away.";
        editingId = null;
      } else {
        const made = createFixtures(v);
        formNote = made.length
          ? `Created ${plural(made.length, "game")}: ${made.map(dayLabel).join(", ")}.`
          : "Nothing created: there's already a game at that turf and time.";
      }
      renderForm();
      renderGameList();
    } else if (form.dataset.cancelForm) {
      const fd = new FormData(form);
      const reason = fd.get("reason") === "other" ? (fd.get("detail") || "Cancelled by the organiser") : [fd.get("reason"), fd.get("detail")].filter(Boolean).join(". ");
      cancelOpenId = null;
      cancelFixture(form.dataset.cancelForm, reason);
    }
  });
  games.addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.stopEdit !== undefined) { editingId = null; formNote = ""; renderForm(); }
    else if (t.dataset.editRow) startEdit(t.dataset.editRow);
    else if (t.dataset.dup) {
      const made = duplicateFixture(t.dataset.dup);
      formNote = made.length ? `Added ${dayLabel(made[0])}, same turf, time and price.` : "";
      renderForm();
    } else if (t.dataset.cancel) { cancelOpenId = cancelOpenId === t.dataset.cancel ? null : t.dataset.cancel; renderGameList(); }
    else if (t.dataset.keep) { cancelOpenId = null; renderGameList(); }
    else if (t.dataset.restore) restoreFixture(t.dataset.restore);
    else if (t.dataset.regulars !== undefined) {
      const made = scheduleRegulars();
      formNote = made.length ? `Added ${made.map(dayLabel).join(", ")} at SUFC turf.` : "That week is already scheduled.";
      renderForm();
    }
  });

  const startEdit = id => {
    pane = "games";
    const r = document.querySelector('#admin-nav input[value="games"]');
    if (r) r.checked = true;
    editingId = id;
    formNote = "";
    renderAdmin();
    renderForm();
    document.getElementById("game-form").scrollIntoView({ block: "start" });
  };
  bus.addEventListener("edit-fixture", e => { showTab("admin"); startEdit(e.detail); });

  // ---- players ----
  const players = document.getElementById("admin-players");
  document.getElementById("player-search").addEventListener("input", e => { playerQuery = e.target.value; renderPlayers(); });
  players.addEventListener("toggle", e => {
    const d = e.target.closest && e.target.closest(".pl-row");
    if (!d) return;
    if (d.open) openPlayer = d.dataset.player; else if (openPlayer === d.dataset.player) openPlayer = null;
  }, true);
  players.addEventListener("click", e => {
    const t = e.target.closest("button");
    const row = e.target.closest(".pl-row");
    if (!t || !row) return;
    const name = row.dataset.player;
    if (t.dataset.kind) setKind(name, t.dataset.kind);
    else if (t.dataset.removed) setRemoved(name, t.dataset.removed === "1");
    else if (t.dataset.resetPin !== undefined) resetPin(name);
  });
  players.addEventListener("submit", e => {
    e.preventDefault();
    const form = e.target.closest("[data-adjust]");
    if (!form) return;
    const fd = new FormData(form);
    const amt = Number(fd.get("amt"));
    const reason = String(fd.get("reason") || "").trim();
    if (!amt || !reason) {
      form.querySelector(amt ? '[name="reason"]' : '[name="amt"]').focus();
      return;
    }
    addAdjustment(form.dataset.adjust, amt, reason);
  });
}

// dev/screenshot convenience: ?admin=games|insights|players
export function initialPane(p) {
  if (["games", "insights", "players"].includes(p)) {
    pane = p;
    const r = document.querySelector(`#admin-nav input[value="${p}"]`);
    if (r) r.checked = true;
  }
}
export const setOpenPlayer = n => { openPlayer = n; };
