import { inr, esc, isOrganiser } from "./utils.js";
import { addClaim, confirmedPaymentsFor, hasPendingFor } from "./payments.js";
import { adjustmentsFor, transferExtras } from "./admin-store.js";
import { currentUser as me } from "./auth.js";
import { act, reportError } from "./api.js";

// The wallet, extras split and history all come from the server snapshot.
let D = null;
let busy = false;
let extrasOpen = false;
let extrasNote = "";
let noteFor = null;         // the note belongs to whoever triggered it

const fmtDay = iso => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  .toLocaleDateString("en-IN", { day: "numeric", month: "short" });

// One source of truth: the chart and the history list both come from the
// person's dated wallet entries (seed history + confirmed top-ups + ledger).
function paymentsFor(name) {
  const seeded = ((D.walletHistory || {})[name] || []).filter(h => h.kind === "topup")
    .map(h => ({ amt: h.amt, at: h.date }));
  const confirmed = confirmedPaymentsFor(name).filter(p => p.at).map(p => ({ amt: p.amt, at: p.at }));
  return [...seeded, ...confirmed].sort((a, b) => a.at.localeCompare(b.at));
}

function chartHtml(name) {
  const pays = paymentsFor(name).slice(-8);
  if (!pays.length) return "";
  const max = Math.max(...pays.map(p => p.amt));
  const tipLast = new URLSearchParams(location.search).get("tip") === "last";   // dev/screenshot convenience
  return pays.map((p, i) => {
    const tip = `${inr(p.amt)} on ${fmtDay(p.at)}`;
    const last = i === pays.length - 1;
    return `<div class="b${last ? " last" : ""}${last && tipLast ? " tip-on" : ""}" style="height:${Math.max(8, Math.round((p.amt / max) * 100))}%;--i:${i}" tabindex="0" role="img" aria-label="Paid ${tip}" data-tip="${esc(tip)}"></div>`;
  }).join("");
}

function ledgerRow(a) {
  if (a.kind === "game") return { t: "Game", d: a.reason };
  if (a.kind === "guest-fee") return { t: "Guest fee", d: a.reason };
  if (a.kind === "extras-paid") return { t: `Settled: ${a.reason}`, d: `Sent to ${a.counterpart} from your wallet, ${fmtDay(a.at)}` };
  if (a.kind === "extras-received") return { t: `Received: ${a.reason}`, d: `From ${a.counterpart}, ${fmtDay(a.at)}` };
  return { t: "Adjusted by organiser", d: `${a.reason}, ${fmtDay(a.at)}` };
}

export function renderWallet(data) {
  if (data) D = data;
  if (!D) return;
  const u = me();
  if (!u) return;
  // balance already includes confirmed top-ups, organiser corrections and
  // extras transfers (see admin-store effectiveRoster)
  document.getElementById("wallet-amount").textContent = inr(u.balance);
  document.getElementById("wallet-sub").textContent = u.gamesLeft > 0
    ? `Enough for about ${u.gamesLeft} more game${u.gamesLeft === 1 ? "" : "s"}. Played ${u.playedThisMonth} this month.`
    : u.balance > 0
      ? `Not quite enough for a game (₹${D.PRICE_PER_HEAD}). Played ${u.playedThisMonth} this month.`
      : `Top up to keep booking. Played ${u.playedThisMonth} this month.`;
  document.getElementById("upi-id").textContent = D.upiId;

  const chart = chartHtml(u.name);
  document.getElementById("bar-spark").innerHTML = chart;
  document.getElementById("bar-spark").hidden = !chart;
  document.getElementById("spark-cap").hidden = !chart;

  // newest first: this month's ledger and confirmed top-ups, the balance
  // carried into the month, then older dated history
  const live = [
    ...adjustmentsFor(u.name).map(a => ({ ...ledgerRow(a), amt: a.amt, at: a.at })),
    ...confirmedPaymentsFor(u.name).map(p => ({ t: "Top-up confirmed", d: `Checked by the organiser${p.at ? `, ${fmtDay(p.at)}` : ""}`, amt: p.amt, at: p.at || "" })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const older = ((D.walletHistory || {})[u.name] || []).slice().reverse()
    .map(h => ({ t: h.t, d: h.d ? `${h.d}, ${fmtDay(h.date)}` : fmtDay(h.date), amt: h.amt }));
  const history = [
    ...live,
    { t: "Opening balance", d: `When the club server started, ${fmtDay(D.seededAt)}`, amt: u.openingBalance, carried: true },
    ...older,
  ];
  document.getElementById("hist-list").innerHTML = history.map(h => {
    const type = h.carried ? "carried" : h.amt >= 0 ? "credit" : "debit";
    return `
    <div class="hist-row${h.carried ? " is-carried" : ""}">
      <div class="hist-tab ${type}"></div>
      <div class="hist-text"><div class="t">${esc(h.t)}</div><div class="d">${esc(h.d)}</div></div>
      <div class="hist-amt ${type}">${!h.carried && h.amt > 0 ? "+" : ""}${inr(h.amt)}</div>
    </div>`;
  }).join("");

  const paid = document.getElementById("paid-btn");
  const waiting = hasPendingFor(u.name);
  paid.disabled = waiting || busy;
  paid.textContent = waiting ? "Waiting for the organiser to confirm" : "I've paid. Tell the organiser";

  renderExtras();
}

// Shared extras: split equally among everyone who played, rounded up to the
// rupee. Members settle their share with a wallet-to-wallet transfer to the
// payer; organisers can still mark cash settlements by hand.
function extrasState() {
  const x = D.extras;
  const viaWallet = new Set(x.viaWallet);
  const settled = new Set(x.settled);
  const total = x.total;
  const each = x.each;                 // the server's split, rounded up to the rupee
  const owers = x.splitAmong.filter(n => n !== x.paidBy);
  return { x, viaWallet, settled, total, each, owers, done: owers.filter(n => settled.has(n)).length };
}

function renderExtras() {
  const el = document.getElementById("extras");
  if (!D.extras) { el.innerHTML = ""; return; }
  const { x, viaWallet, settled, total, each, owers, done } = extrasState();
  const org = isOrganiser();
  const u = me();
  const you = u.name;
  if (noteFor !== you) extrasNote = "";

  let yourBlock;
  if (x.paidBy === you) {
    yourBlock = `<p class="x-you">You paid. ${owers.length - done} ${owers.length - done === 1 ? "person still owes" : "people still owe"} you ${inr(each)} each.</p>`;
  } else if (!x.splitAmong.includes(you)) {
    yourBlock = `<p class="x-you">You weren't at this game, so there's nothing for you to pay.</p>`;
  } else if (settled.has(you)) {
    yourBlock = `<p class="x-you">You've settled your ${inr(each)}${viaWallet.has(you) ? " from your wallet" : ""}.</p>`;
  } else {
    const after = u.balance - each;
    yourBlock = `
      <div class="x-you owes">
        <p>You owe ${esc(x.paidBy)} ${inr(each)}.</p>
        <button type="button" class="pay-btn x-settle" data-settle-wallet ${busy ? "disabled" : ""}>${busy ? "Sending…" : `Settle ${inr(each)} from your wallet`}</button>
        <p class="x-after${after < 0 ? " neg" : ""}">${after < 0
          ? `This takes your balance to ${inr(after)}. That's fine: top up when you can, like any other game you owe for.`
          : `Your balance after: ${inr(after)}. ${esc(x.paidBy)} gets ${inr(each)} in their wallet.`}</p>
      </div>`;
  }

  const rows = [x.paidBy, ...owers].map(n => {
    const isPayer = n === x.paidBy;
    const ok = isPayer || settled.has(n);
    const status = isPayer ? `Paid ${inr(total)}` : viaWallet.has(n) ? "Paid from wallet" : ok ? "Settled" : `Owes ${inr(each)}`;
    // organisers can mark cash settlements; wallet transfers are final
    const cell = org && !isPayer && !viaWallet.has(n)
      ? `<button type="button" class="x-status${ok ? " ok" : ""}" data-settle="${esc(n)}" aria-pressed="${ok}">${status}</button>`
      : `<span class="x-status${ok ? " ok" : ""}${isPayer ? " payer" : ""}">${status}</span>`;
    return `<li class="x-row"><span class="x-name">${esc(n)}${n === you ? ` <span class="tag you">You</span>` : ""}</span>${cell}</li>`;
  }).join("");

  el.innerHTML = `
    <div class="x-head">
      <div><div class="x-title">${esc(x.title)}</div><div class="x-sub">${esc(x.when)}. ${esc(x.paidBy)} paid.</div></div>
      <div class="x-total">${inr(total)}</div>
    </div>
    <ul class="x-items">${x.items.map(i => `<li><span>${esc(i.what)}</span><span>${inr(i.amt)}</span></li>`).join("")}</ul>
    <div class="x-split">
      <div><span class="x-each">${inr(each)}</span> each, split ${x.splitAmong.length} ways</div>
      <div class="x-progress" role="img" aria-label="${done} of ${owers.length} settled"><span style="width:${owers.length ? Math.round((done / owers.length) * 100) : 100}%"></span></div>
      <div class="x-progress-l">${done} of ${owers.length} settled</div>
    </div>
    ${yourBlock}
    <p class="fx-note" role="status">${esc(extrasNote)}</p>
    <details class="who x-who"${extrasOpen ? " open" : ""}>
      <summary>Who owes what<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
      <ul class="x-list">${rows}</ul>
      ${org ? `<p class="lg-note">Tap a status to mark a cash settlement. Wallet payments can't be undone here.</p>` : ""}
    </details>`;
}

export function initWalletControls() {
  const chipRow = document.getElementById("chip-row");
  const customAmt = document.getElementById("custom-amt");
  const amount = () => {
    const active = chipRow.querySelector(".chip.active");
    return Number(customAmt.value) || (active ? Number(active.getAttribute("data-amt")) : 0);
  };

  chipRow.addEventListener("click", e => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    chipRow.querySelectorAll(".chip").forEach(c => { c.classList.remove("active"); c.setAttribute("aria-pressed", "false"); });
    chip.classList.add("active");
    chip.setAttribute("aria-pressed", "true");
    customAmt.value = "";
  });

  customAmt.addEventListener("input", () => {
    if (customAmt.value) chipRow.querySelectorAll(".chip").forEach(c => { c.classList.remove("active"); c.setAttribute("aria-pressed", "false"); });
  });

  document.getElementById("paid-btn").addEventListener("click", async () => {
    const u = me();
    if (!D || !u || !amount() || busy) return;
    busy = true;
    try { await addClaim(u.name, amount()); } catch (e) { reportError(e); } finally { busy = false; renderWallet(); }
  });

  document.getElementById("pay-btn").addEventListener("click", () => {
    const u = me();
    const amt = amount();
    if (!D || !u || !amt) return;
    const params = new URLSearchParams({
      pa: D.upiId,
      pn: "FCFC",
      am: String(amt),
      cu: "INR",
      tn: `FCFC topup ${u.name}`,
    });
    const generic = `upi://pay?${params.toString()}`;
    // Android: force the chooser straight to Google Pay's package instead of
    // showing every UPI app. iOS: Google Pay's own documented custom scheme.
    // Either way, if GPay isn't installed the link silently fails to open,
    // so fall back to the generic upi:// link (whatever app is there) after
    // a beat — cancelled if the page actually backgrounds, which means GPay
    // did open. There's still no success callback either way: "I've paid" +
    // organiser confirm (below) is still how the wallet actually credits.
    const isAndroid = /Android/i.test(navigator.userAgent);
    const gpay = isAndroid
      ? `intent://pay?${params.toString()}#Intent;scheme=upi;package=com.google.android.apps.nbu.paisa.user;end`
      : `gpay://upi/pay?${params.toString()}`;
    const fallback = setTimeout(() => { location.href = generic; }, 1500);
    const cancel = () => clearTimeout(fallback);
    document.addEventListener("visibilitychange", cancel, { once: true });
    window.addEventListener("pagehide", cancel, { once: true });
    location.href = gpay;
  });

  const extras = document.getElementById("extras");
  extras.addEventListener("toggle", e => { extrasOpen = e.target.open; }, true);
  extras.addEventListener("click", async e => {
    if (busy) return;
    if (e.target.closest("[data-settle-wallet]")) {
      const u = me();
      const { x } = extrasState();
      if (!u) return;
      busy = true; noteFor = u.name; extrasNote = ""; renderExtras();
      try {
        const d = await transferExtras({ ref: x.id });
        extrasNote = `Sent ${inr(d.sent.amt)} to ${d.sent.to}. It's in both your wallet histories.`;
      } catch (err) {
        extrasNote = err.message;
      } finally {
        busy = false; renderWallet();
      }
      return;
    }
    const b = e.target.closest("[data-settle]");
    if (!b || !isOrganiser()) return;
    const n = b.dataset.settle;
    busy = true;
    try { await act("/api/admin/extras/mark", { id: D.extras.id, name: n }); } catch (err) { reportError(err); } finally { busy = false; }
    renderExtras();
    const again = document.querySelector(`#extras [data-settle="${CSS.escape(n)}"]`);
    if (again) again.focus({ preventScroll: true });
  });
}
