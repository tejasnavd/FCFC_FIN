// Display helpers for bookings. The rules themselves (capacity = CNF
// places; members ahead of guests, then sign-up order; cancellations and
// drops promote the top of WL) run on the server: see Club.allocate in
// server.py.

export const label = e => (e ? `${e.tier} ${e.pos}` : "");

// Plain-text lineup for pasting into the group chat (WhatsApp keeps the
// *bold* markers).
export function lineupText(fx, turfLabel, alloc, url) {
  const title = `*FCFC ${cap(fx.wd)} ${fx.num} ${cap(fx.mo)}, ${fx.time}*\n${turfLabel}`;
  const nameOf = e => (e.kind === "guest" && !e.anon ? `${e.name} (guest of ${e.host})` : e.name);
  const list = tier => alloc.chart.filter(e => e.tier === tier).map(e => `${e.pos}. ${nameOf(e)}`).join("\n");
  const open = alloc.capacity - alloc.counts.CNF;
  return [
    title,
    `*CNF* ${alloc.counts.CNF}/${alloc.capacity}\n${list("CNF") || "(none yet)"}`,
    alloc.counts.WL ? `*WL* ${alloc.counts.WL}\n${list("WL")}` : null,
    open > 0 ? `Need ${open} more.` : "Full. New sign-ups go on the waitlist.",
    url ? `Book: ${url}` : null,
  ].filter(Boolean).join("\n\n");
}

const cap = s => s.charAt(0) + s.slice(1).toLowerCase();
