import { colorFor, initials, inr, esc, isOrganiser } from "./utils.js";
import { pendingPayments, confirmPayment } from "./payments.js";
import { reportError } from "./api.js";
import { effectiveRoster } from "./admin-store.js";
import { popover } from "./popover.js";


let sortMode = "balance";
let D = null;            // latest server snapshot
let orgNote = "";
let sheets = null;       // monthly sheets, newest first (from the server)
let monthKey = null;     // selected month; defaults to the current one
const openRows = new Set();
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Balances include confirmed top-ups and organiser adjustments; promoted
// guests appear as members.
const withConfirmed = () => effectiveRoster();

// Last 5 fixtures, oldest -> newest. Attendance only: filled = played,
// hollow = didn't. There's no result data, so no W/L/D.
function attendanceStrip(name) {
  const a = (D.recentAttendance && D.recentAttendance[name]) || [0, 0, 0, 0, 0];
  const n = a.filter(Boolean).length;
  return `<div class="att-strip" role="img" aria-label="Played ${n} of the last 5 games">${a.map(v => `<span class="pip${v ? " on" : ""}"></span>`).join("")}</div>`;
}

const fmtCell = iso => {
  const d = new Date(`${iso}T00:00:00`);
  return `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]} ${d.getDate()}`;
};

// Per-date breakdown: the sheet's ~13 date columns folded into a 7-wide grid.
function monthGrid(sheet, row) {
  if (!row) return `<p class="mg-empty">No games recorded for this month.</p>`;
  const played = new Set(row.games);
  return `<div class="month-grid" role="list">${sheet.dates.map(d => {
    const on = played.has(d);
    return `<span class="mg-cell${on ? " on" : ""}" role="listitem" aria-label="${fmtCell(d)}: ${on ? `played, ${inr(D.PRICE_PER_HEAD)}` : "didn't play"}"><span class="mg-d">${fmtCell(d)}</span><span class="mg-a">${on ? inr(D.PRICE_PER_HEAD) : "·"}</span></span>`;
  }).join("")}</div>`;
}

function memberRowHtml(rank, [name, bal, played, meta = {}], sheet, nextLabel) {
  const row = sheet.rows[name];
  const games = row ? row.games.length : 0;
  const spent = row ? row.spent : 0;
  const notes = sheet.current ? [`${played} this month`] : [`${games} game${games === 1 ? "" : "s"}, ${inr(spent)} spent`];
  if (sheet.current) {
    if (meta.kind === "guest") notes.push("guest");
    if (meta.removed) notes.push("off future games");
    if (meta.adjusted) notes.push("balance adjusted");
  }
  const cls = bal < 0 ? "owe" : bal > 0 ? "credit" : "";
  const mid = sheet.current ? attendanceStrip(name) : `<div class="games-n">${games}</div>`;
  const foot = sheet.current
    ? `Spent ${inr(spent)} on ${plural(row ? games : played, "game")} this month. Balance now ${inr(bal)}.`
    : `Topped up ${inr(row ? row.topups : 0)}. Carried ${inr(bal)} into ${nextLabel}.`;
  return `
    <details class="member-d"${openRows.has(name) ? " open" : ""} data-name="${esc(name)}">
      <summary class="member-row">
        <div class="rank">${rank}</div>
        <div class="m-identity">
          <div class="m-av" style="background:${colorFor(name)}">${initials(name)}</div>
          <div class="m-text"><div class="m-name">${esc(name)}</div><div class="m-sub">${notes.join(", ")}</div></div>
        </div>
        ${mid}
        <div class="bal ${cls}">${inr(bal)}</div>
      </summary>
      <div class="month-detail">
        ${monthGrid(sheet, row)}
        <p class="mg-foot">${foot}</p>
      </div>
    </details>`;
}

function renderPayments() {
  const el = document.getElementById("org-payments");
  if (!isOrganiser()) { el.hidden = true; el.innerHTML = ""; return; }
  const list = pendingPayments();
  el.hidden = false;
  el.innerHTML = `
    <h2 class="section">Payments to confirm</h2>
    <div class="card-block pay-confirm">
      ${list.length ? `<ul class="pc-list">${list.map(p => `
        <li class="pc-row">
          <div class="pc-text"><div class="pc-name">${esc(p.name)}</div><div class="pc-when">${esc(p.when)}</div></div>
          <div class="pc-amt">${inr(p.amt)}</div>
          <button type="button" class="pc-btn" data-confirm="${esc(p.id)}">Received</button>
        </li>`).join("")}</ul>` : `<p class="pc-empty">Nothing waiting. New "I've paid" taps show up here.</p>`}
      <p class="fx-note" role="status">${esc(orgNote)}</p>
      <p class="lg-note">Check each one against the UPI statement first. Confirming credits their balance for everyone.</p>
    </div>`;
}

export function renderRoster(data) {
  if (data) D = data;
  if (!D) return;
  sheets = D.months;
  if (!monthKey || !sheets.some(x => x.key === monthKey)) {
    const want = new URLSearchParams(location.search).get("month");   // dev/screenshot convenience
    monthKey = sheets.some(x => x.key === want) ? want : (sheets.find(x => x.current) || sheets[0]).key;
  }
  renderPayments();
  const idx = sheets.findIndex(x => x.key === monthKey);
  const sheet = sheets[idx];
  const nextLabel = idx > 0 ? sheets[idx - 1].label.split(" ")[0] : "";

  // current month: live balances (confirmed top-ups, corrections, transfers);
  // past months: the members on that month's sheet, at their carry-forward
  const roster = sheet.current
    ? withConfirmed()
    : Object.entries(sheet.rows).map(([name, r]) => [name, r.carried, r.games.length, {}]);

  document.getElementById("month-btn-label").textContent = sheet.label;
  document.getElementById("month-options").innerHTML = sheets.map(x => {
    const total = Object.values(x.rows).reduce((t, r) => t + r.games.length, 0);
    return `<label class="opt"><input type="radio" name="month" value="${x.key}" ${x.key === monthKey ? "checked" : ""}>
      <span class="opt-body"><span class="opt-name">${x.label}${x.current ? " (now)" : ""}</span><span class="opt-sub">${x.dates.length} game days, ${total} spots filled</span></span></label>`;
  }).join("");
  document.getElementById("lh-mid").textContent = sheet.current ? "Last 5" : "Games";
  document.getElementById("lh-bal").textContent = sheet.current ? "Balance" : "Carried";
  document.getElementById("month-note").textContent = sheet.current
    ? "Live balances. Tap a player for this month's games."
    : `How ${sheet.label} ended. Tap a player for their games that month.`;

  const q = document.getElementById("member-search").value.trim().toLowerCase();
  const list = roster.filter(m => m[0].toLowerCase().includes(q));
  list.sort((a, b) => (sortMode === "name" ? a[0].localeCompare(b[0]) : a[1] - b[1]));

  const owe = roster.filter(m => m[1] < 0);
  const credit = roster.filter(m => m[1] > 0);
  document.getElementById("stat-owe-count").textContent = owe.length;
  document.getElementById("stat-total-owed").textContent = inr(owe.reduce((s, m) => s + Math.abs(m[1]), 0));
  const creditTotal = credit.reduce((s, m) => s + m[1], 0);
  document.getElementById("stat-total-credit").textContent = `₹${Math.round(creditTotal / 1000)}k`;

  if (!list.length) {
    document.getElementById("roster-list").innerHTML =
      `<div class="empty-state">No members match &ldquo;${esc(q)}&rdquo;.</div>`;
    return;
  }

  // Zone dividers only read as meaningful when the table is actually ranked
  // by balance — on a name sort they'd sit at an arbitrary row.
  const showZones = sortMode === "balance";
  let html = "";
  let printedRelegation = false;
  let printedCredit = false;

  list.forEach((m, i) => {
    if (showZones && !printedRelegation && m[1] >= 0 && i > 0 && list[i - 1][1] < 0) {
      html += `<div class="zone-line relegation"><span>Owes money</span><div class="bar"></div></div>`;
      printedRelegation = true;
    }
    if (showZones && !printedCredit && m[1] > 0 && (i === 0 || list[i - 1][1] <= 0)) {
      html += `<div class="zone-line credit"><span>In credit</span><div class="bar"></div></div>`;
      printedCredit = true;
    }
    html += memberRowHtml(i + 1, m, sheet, nextLabel);
  });

  document.getElementById("roster-list").innerHTML = html;
}

export function initGroupControls() {
  document.getElementById("member-search").addEventListener("input", () => renderRoster());

  // month picker: same dropdown panel as settings
  const pop = popover(document.getElementById("month-btn"), document.getElementById("month-panel"));
  document.getElementById("month-options").addEventListener("change", e => {
    if (e.target.name !== "month") return;
    monthKey = e.target.value;
    openRows.clear();
    renderRoster();
    pop.close();
  });
  document.getElementById("roster-list").addEventListener("toggle", e => {
    const d = e.target.closest && e.target.closest(".member-d");
    if (!d) return;
    if (d.open) openRows.add(d.dataset.name); else openRows.delete(d.dataset.name);
  }, true);
  const params = new URLSearchParams(location.search);   // dev/screenshot conveniences
  if (params.get("row")) openRows.add(params.get("row"));
  if (params.get("months") === "open") setTimeout(() => pop.open(false), 900);
  document.querySelectorAll(".sort-row button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sort-row button").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-pressed", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
      sortMode = btn.getAttribute("data-sort");
      renderRoster();
    });
  });
  document.getElementById("org-payments").addEventListener("click", async e => {
    const b = e.target.closest("[data-confirm]");
    if (!b) return;
    const p = pendingPayments().find(x => x.id === b.dataset.confirm);
    if (!p) return;
    b.disabled = true;
    try {
      await confirmPayment(p.id);
      const row = withConfirmed().find(r => r[0] === p.name);
      orgNote = `Confirmed ${p.name}'s ${inr(p.amt)}.${row ? ` Balance now ${inr(row[1])}.` : ""}`;
    } catch (err) {
      orgNote = err.message;
      reportError(err);
    }
    renderRoster();
  });
}
