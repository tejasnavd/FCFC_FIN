import { loadJSON, saveJSON, esc, isOrganiser, bus, inr, isObj, asObj, isNum, strArrMap } from "./utils.js";
import { allFixtures, kindOf, isRemoved } from "./admin-store.js";
import { allocate, label, promotions, lineupText } from "./booking.js";
import { currentUser } from "./auth.js";

// Device-local state (moves to the backend along with seed.js later):
//   bookings: { [name]: { [fixtureId]: { state: "in"|"out"|"none", at, guests } } }
//             keyed by whoever was logged in, so switching accounts on one
//             device keeps each person's bookings (and everyone sees them)
//   dropped:  { [fixtureId]: [names] }   organiser marked as dropped out
//   attended: { [fixtureId]: [names] }   organiser attendance overrides
const BOOK_KEY = "fcfc_bookings_by_user";
const DROP_KEY = "fcfc_dropped";
const ATT_KEY = "fcfc_attended";
const MAX_GUESTS = 2;

// normalise saved bookings: keep only well-formed { name: { fixtureId: rec } }
function loadBookings() {
  const out = {};
  Object.entries(asObj(loadJSON(BOOK_KEY, null))).forEach(([name, recs]) => {
    const good = {};
    Object.entries(asObj(recs)).forEach(([id, r]) => {
      if (!isObj(r) || !["in", "out", "none"].includes(r.state)) return;
      if (r.state === "in" && !isNum(r.at)) return;
      good[id] = { ...r, guests: isNum(r.guests) ? Math.max(0, Math.min(2, r.guests)) : 0 };
    });
    out[name] = good;
  });
  return out;
}
let allBookings = loadBookings();
let dropped = strArrMap(loadJSON(DROP_KEY, null));
let attended = strArrMap(loadJSON(ATT_KEY, null));
let D = null;               // { turfs, GUEST_FEE, ... } from seed
let fresh = null;           // fixture id whose stamp should animate
const notes = {};           // transient per-fixture status messages
const openCharts = new Set();

const turfOf = id => D.turfs.find(t => t.id === id);
const me = () => (currentUser() || { name: "" }).name;

// Your booking for a fixture: a local record if you've tapped anything,
// otherwise your sign-up in the seed data (the real sheet) counts as "in".
function bookingOf(fx, name = me()) {
  const rec = (allBookings[name] || {})[fx.id];
  if (rec) return rec.state === "none" ? null : rec;
  const seeded = fx.signups.find(e => e.name === name && e.kind !== "guest");
  return seeded ? { state: "in", at: seeded.at, guests: 0, seeded: true } : null;
}
function saveBooking(fx, rec) {
  (allBookings[me()] = allBookings[me()] || {})[fx.id] = rec;
  saveJSON(BOOK_KEY, allBookings);
}
const moves = list => list.map(p => `${p.name} ${p.from} → ${p.to}`).join(", ");

function queueFor(fx) {
  const gone = new Set(dropped[fx.id] || []);
  // organiser changes: promoted/demoted players change priority; removed
  // players are out of every future game
  const ok = name => !gone.has(name) && !isRemoved(name);
  const hasLocal = name => Boolean((allBookings[name] || {})[fx.id]);
  // seed sign-ups, unless that person has a local booking record overriding it
  const q = fx.signups
    .map(e => ({ ...e, kind: kindOf(e.name, e.kind), you: e.name === me() && e.kind !== "guest" }))
    .filter(e => ok(e.name) && !hasLocal(e.name) && !(e.kind === "guest" && e.host && gone.has(e.host)));
  // everyone who has booked on this device, including the logged-in person
  Object.keys(allBookings).forEach(name => {
    const b = allBookings[name][fx.id];
    if (!b || b.state !== "in" || !ok(name)) return;
    const you = name === me();
    q.push({ name, kind: kindOf(name, "member"), at: b.at, you });
    for (let i = 0; i < (b.guests || 0); i++) {
      q.push({ name: `${name}'s guest${i ? ` ${i + 1}` : ""}`, kind: "guest", host: name, at: b.at + (i + 1) / 10, yours: you, anon: true });
    }
  });
  return q;
}

export const allocFor = fx => allocate(queueFor(fx), fx.capacity);
export const bookingFor = fx => bookingOf(fx);

/* ---------------- rendering ---------------- */

function seatStrip(alloc) {
  const cell = i => {
    const e = alloc.chart.find(x => x.tier === "CNF" && x.pos === i + 1);
    const cls = ["seat"];
    if (e) cls.push("taken");
    if (e && e.kind === "guest") cls.push("guest");
    if (e && (e.you || e.yours)) cls.push("you");
    return `<span class="${cls.join(" ")}"></span>`;
  };
  const aria = `${alloc.counts.CNF} of ${alloc.capacity} places confirmed, ${alloc.counts.WL} on the waitlist`;
  return `<div class="seat-strip" role="img" aria-label="${aria}">${Array.from({ length: alloc.capacity }, (_, i) => cell(i)).join("")}</div>`;
}

function availability(alloc) {
  const open = alloc.capacity - alloc.counts.CNF;
  if (open > 0) return `<div class="spots-note open">${open} spot${open === 1 ? "" : "s"} left</div>`;
  return `<div class="spots-note wl">Full. ${alloc.counts.WL} on the waitlist, next booking is WL ${alloc.counts.WL + 1}</div>`;
}

// Plain status line. "Notified" = this status line and stamp update when
// you're promoted; there are no push notifications yet.
function statusBox(fx, alloc) {
  const b = bookingOf(fx);
  const mine = alloc.chart.find(e => e.you);
  if (!b || b.state !== "in" || !mine) return "";
  const wl = mine.tier === "WL";
  return `
    <div class="fx-status tier-${mine.tier.toLowerCase()}">
      <div>Status: <strong>${wl ? label(mine) : "CNF"}</strong></div>
      ${wl ? `<p>You'll be notified here when a spot opens up and you're moved up to CNF automatically.</p>` : ""}
    </div>`;
}

function guestRow(fx) {
  const b = bookingOf(fx);
  if (!b || b.state !== "in") return `<span class="guest-hint">Book in to bring a guest</span>`;
  const n = b.guests || 0;
  return `
    <div class="stepper" role="group" aria-label="Guests you're bringing">
      <button type="button" data-guests="-1" aria-label="One fewer guest" ${n <= 0 ? "disabled" : ""}>−</button>
      <output>${n ? `${n} guest${n > 1 ? "s" : ""}` : "Bring a guest"}</output>
      <button type="button" data-guests="1" aria-label="Add a guest" ${n >= MAX_GUESTS ? "disabled" : ""}>+</button>
    </div>
    <span class="guest-fee">+₹${D.GUEST_FEE}${n > 1 ? " each" : ""}</span>`;
}

function chartRows(fx, alloc) {
  const org = isOrganiser();
  const who = e => {
    let tag = "";
    if (e.you) tag = `<span class="tag you">You</span>`;
    else if (e.kind === "guest") tag = `<span class="tag guest">${e.yours ? "Your guest" : `Guest of ${esc(e.host)}`}</span>`;
    return `<span class="c-name">${esc(e.anon ? "Guest" : e.name)}</span>${tag}`;
  };
  const rows = alloc.chart.map(e => `
    <li class="c-row tier-${e.tier.toLowerCase()}${e.you || e.yours ? " mine" : ""}${e.kind === "guest" ? " is-guest" : ""}">
      <span class="c-status">${e.tier} ${e.pos}</span>
      <span class="c-who">${who(e)}</span>
      ${org && !e.you && !e.yours ? `<button type="button" class="c-drop" data-drop="${esc(e.name)}" aria-label="Mark ${esc(e.name)} as dropped out">Drop</button>` : ""}
    </li>`).join("");
  const gone = dropped[fx.id] || [];
  const undo = org && gone.length
    ? `<p class="c-undo">Dropped: ${gone.map(n => `<button type="button" data-undrop="${esc(n)}">${esc(n)}, undo</button>`).join(" ")}</p>`
    : "";
  return `<ol class="chart-list">${rows || `<li class="c-empty">No one's booked yet.</li>`}</ol>${undo}`;
}

function stampHtml(fx, alloc) {
  const b = bookingOf(fx);
  if (!b) return "";
  const anim = fresh === fx.id ? " fresh" : "";
  if (b.state === "out") return `<div class="stamp out${anim}" aria-hidden="true">OUT</div>`;
  const mine = alloc.chart.find(e => e.you);
  if (!mine) return "";
  const text = mine.tier === "CNF" ? "CNF ✓" : label(mine);
  return `<div class="stamp tier-${mine.tier.toLowerCase()}${anim}" aria-hidden="true">${text}</div>`;
}

// A cancelled game stays on the list so anyone who booked sees why.
function cancelledCardHtml(fx) {
  const turf = turfOf(fx.turf);
  const b = bookingOf(fx);
  const mine = b && b.state === "in" ? allocFor(fx).chart.find(e => e.you) : null;
  return `
    <article class="fixture is-cancelled" data-id="${fx.id}" aria-label="Cancelled: ${fx.wd} ${fx.num} ${fx.mo}, ${fx.time}, ${esc(turf.label)}">
      <div class="fx-date">
        <div class="stamp cancelled" aria-hidden="true">OFF</div>
        <div class="wd">${fx.wd}</div>
        <div class="num">${fx.num}</div>
        <div class="mo">${fx.mo}</div>
      </div>
      <div class="fx-body">
        <div class="fx-row">
          <div>
            <div class="fx-time"><s>${fx.time}</s></div>
            <div class="fx-venue">${esc(turf.label)}</div>
          </div>
        </div>
        <p class="cx-reason"><strong>Cancelled:</strong> ${esc(fx.cancelled.reason)}</p>
        ${mine ? `<p class="cx-you">You were booked (${label(mine)}). You won't be charged.</p>` : ""}
      </div>
      <div class="notch-bottom"></div>
    </article>`;
}

function cardHtml(fx) {
  if (fx.cancelled) return cancelledCardHtml(fx);
  const alloc = allocFor(fx);
  const b = bookingOf(fx);
  const state = b ? b.state : null;
  const turf = turfOf(fx.turf);
  const note = notes[fx.id];
  return `
    <article class="fixture" data-id="${fx.id}" aria-label="${fx.wd} ${fx.num} ${fx.mo}, ${fx.time}, ${esc(turf.label)}">
      <div class="fx-date">
        ${stampHtml(fx, alloc)}
        <div class="wd">${fx.wd}</div>
        <div class="num">${fx.num}</div>
        <div class="mo">${fx.mo}</div>
      </div>
      <div class="fx-body">
        <div class="fx-row">
          <div>
            <div class="fx-time">${fx.time}</div>
            <div class="fx-venue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.4"/></svg>${esc(turf.label)}<span class="fx-price">${inr(fx.price)}</span></div>
            ${isOrganiser() ? `<button type="button" class="fx-edit" data-edit="${fx.id}">Edit game</button>` : ""}
          </div>
          <div class="fx-tally"><div class="score">${alloc.counts.CNF}/${alloc.capacity}</div><div class="lbl">CNF</div></div>
        </div>
        ${seatStrip(alloc)}
        ${availability(alloc)}
        <div class="rsvp-row">
          <button type="button" class="${state === "in" ? "chosen in" : ""}" data-choice="in" aria-pressed="${state === "in"}">I'm in</button>
          <button type="button" class="${state === "out" ? "chosen out" : ""}" data-choice="out" aria-pressed="${state === "out"}">Can't make it</button>
        </div>
        ${statusBox(fx, alloc)}
        <div class="fx-actions">
          <div class="guests">${guestRow(fx)}</div>
          <button type="button" class="share-btn" data-share aria-label="Share lineup to WhatsApp or copy it">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/></svg>
            Share
          </button>
        </div>
        <p class="fx-note" role="status">${note ? esc(note) : ""}</p>
        <details class="who"${openCharts.has(fx.id) ? " open" : ""}>
          <summary>Booking chart <span class="who-count">${alloc.counts.CNF} CNF, ${alloc.counts.WL} WL</span><svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
          ${chartRows(fx, alloc)}
        </details>
      </div>
      <div class="notch-bottom"></div>
    </article>`;
}

function lastGameHtml(fx) {
  const turf = turfOf(fx.turf);
  const present = new Set(attended[fx.id] || fx.attended || []);
  const org = isOrganiser();
  const names = fx.signups.map(e => e.name);
  const chips = names.map(n => {
    const on = present.has(n);
    return org
      ? `<button type="button" class="att-chip${on ? " on" : ""}" data-att="${esc(n)}" aria-pressed="${on}">${esc(n)}</button>`
      : `<span class="att-chip${on ? " on" : ""}">${esc(n)}${on ? "" : `<span class="sr"> (didn't turn up)</span>`}</span>`;
  }).join("");
  return `
    <div class="card-block last-game">
      <div class="lg-head">
        <div><div class="lg-title">${fx.wd} ${fx.num} ${fx.mo}, ${fx.time}</div><div class="lg-sub">${esc(turf.label)}</div></div>
        <div class="lg-count"><span>${present.size}/${names.length}</span> turned up</div>
      </div>
      <div class="att-chips">${chips}</div>
      <p class="lg-note">${org
        ? "Tap a name to mark them present or absent. Saved on this device only."
        : "Faded names booked but didn't turn up."}</p>
    </div>`;
}

export function renderGames(data) {
  if (data && !D && new URLSearchParams(location.search).get("charts") === "open") {
    allFixtures().forEach(f => openCharts.add(f.id));   // dev/screenshot convenience
  }
  if (data) D = data;
  if (!D) return;

  const fixtures = allFixtures();
  const upcoming = fixtures.filter(f => f.status === "upcoming");
  const el = document.getElementById("games-list");
  el.innerHTML = upcoming.length
    ? upcoming.map(cardHtml).join("")
    : `<div class="empty-state">No games scheduled yet. Check back soon.</div>`;

  const past = fixtures.filter(f => f.status === "played");
  document.getElementById("last-game-wrap").hidden = !past.length;
  document.getElementById("last-game").innerHTML = past.length ? lastGameHtml(past[past.length - 1]) : "";

  fresh = null;
}

/* ---------------- interaction ---------------- */

function setBooking(fx, choice) {
  const before = allocFor(fx);
  const prev = bookingOf(fx);
  let next;
  if (prev && prev.state === choice) {
    next = { state: "none" };                      // tap the same button again to undo
  } else if (choice === "in") {
    // someone already on the sheet keeps their original queue position
    next = { state: "in", at: prev && prev.seeded ? prev.at : Date.now(), guests: 0 };
  } else {
    next = { state: "out" };
  }
  saveBooking(fx, next);
  notes[fx.id] = "";
  const wasIn = prev && prev.state === "in";
  const nowIn = next.state === "in";
  if (wasIn && !nowIn) {
    const moved = promotions(before, allocFor(fx));
    if (moved.length) notes[fx.id] = `Your seat moved people up: ${moves(moved)}.`;
  }
  fresh = fx.id;
}

async function shareLineup(fx) {
  const text = lineupText(fx, turfOf(fx.turf).label, allocFor(fx), location.origin + location.pathname);
  const say = msg => { notes[fx.id] = msg; renderGames(); };
  if (navigator.share) {
    try {
      await navigator.share({ text });
      say("Lineup shared.");
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;     // share sheet dismissed: say nothing
      // any other failure falls through to copying
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    say("Lineup copied. Paste it into the group chat.");
  } catch (e) {
    say("This browser blocked sharing and copying. Open the booking chart to see the lineup.");
  }
}

export function initGamesControls() {
  const list = document.getElementById("games-list");
  const fxById = id => D && allFixtures().find(f => f.id === id);

  list.addEventListener("click", e => {
    const card = e.target.closest(".fixture");
    if (!card) return;
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) { bus.dispatchEvent(new CustomEvent("edit-fixture", { detail: editBtn.dataset.edit })); return; }
    const fx = fxById(card.dataset.id);
    const choiceBtn = e.target.closest("[data-choice]");
    const guestBtn = e.target.closest("[data-guests]");
    const dropBtn = e.target.closest("[data-drop]");
    const undropBtn = e.target.closest("[data-undrop]");

    if (choiceBtn) {
      setBooking(fx, choiceBtn.dataset.choice);
    } else if (guestBtn) {
      const cur = bookingOf(fx);
      const b = { ...cur, seeded: undefined };
      b.guests = Math.max(0, Math.min(MAX_GUESTS, (b.guests || 0) + Number(guestBtn.dataset.guests)));
      saveBooking(fx, b);
      const g = allocFor(fx).chart.filter(x => x.yours);
      notes[fx.id] = g.length
        ? `Guests queue behind every member: ${g.map(label).join(", ")}. ₹${D.GUEST_FEE} each comes out of your wallet after the game.`
        : "";
    } else if (e.target.closest("[data-share]")) {
      shareLineup(fx);
      return;
    } else if (dropBtn) {
      const before = allocFor(fx);
      (dropped[fx.id] = dropped[fx.id] || []).push(dropBtn.dataset.drop);
      const moved = promotions(before, allocFor(fx));
      notes[fx.id] = `${dropBtn.dataset.drop} dropped out.${moved.length ? ` Moved up: ${moves(moved)}.` : ""}`;
      saveJSON(DROP_KEY, dropped);
    } else if (undropBtn) {
      dropped[fx.id] = (dropped[fx.id] || []).filter(n => n !== undropBtn.dataset.undrop);
      notes[fx.id] = "";
      saveJSON(DROP_KEY, dropped);
    } else {
      return;
    }
    const focusSel = choiceBtn ? `[data-choice="${choiceBtn.dataset.choice}"]`
      : guestBtn ? `[data-guests="${guestBtn.dataset.guests}"]` : "summary";
    renderGames();
    const again = list.querySelector(`.fixture[data-id="${fx.id}"] ${focusSel}`);
    if (again && !again.disabled) again.focus({ preventScroll: true });
  });

  // remember which booking charts are open across re-renders
  list.addEventListener("toggle", e => {
    const card = e.target.closest && e.target.closest(".fixture");
    if (!card) return;
    if (e.target.open) openCharts.add(card.dataset.id); else openCharts.delete(card.dataset.id);
  }, true);

  document.getElementById("last-game").addEventListener("click", e => {
    const chip = e.target.closest("[data-att]");
    if (!chip || !isOrganiser()) return;
    const fx = allFixtures().filter(f => f.status === "played").pop();
    const set = new Set(attended[fx.id] || fx.attended || []);
    const n = chip.dataset.att;
    if (set.has(n)) set.delete(n); else set.add(n);
    attended[fx.id] = [...set];
    saveJSON(ATT_KEY, attended);
    renderGames();
    const again = document.querySelector(`#last-game [data-att="${CSS.escape(n)}"]`);
    if (again) again.focus({ preventScroll: true });
  });

}
