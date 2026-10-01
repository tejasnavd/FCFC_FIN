// Booking engine: CNF / WL. No DOM in here.
//
// Rules
// - `capacity` is the number of CNF (confirmed) places, full stop.
// - Priority: every member queues ahead of every guest, whatever order they
//   tapped in. Within each group, earlier sign-up first.
// - The first `capacity` people in that order are CNF; everyone after is WL,
//   numbered in queue order.
// - Status is always derived from the one ordered queue, so a cancellation
//   cascades by itself: the top of WL moves straight up to CNF.

export function allocate(queue, capacity) {
  const byAt = (a, b) => a.at - b.at;
  const ordered = [
    ...queue.filter(e => e.kind !== "guest").sort(byAt),
    ...queue.filter(e => e.kind === "guest").sort(byAt),
  ];
  const chart = ordered.map((e, i) =>
    i < capacity ? { ...e, tier: "CNF", pos: i + 1 } : { ...e, tier: "WL", pos: i - capacity + 1 });
  const cnf = chart.filter(e => e.tier === "CNF").length;
  return { chart, capacity, counts: { CNF: cnf, WL: chart.length - cnf } };
}

export const label = e => (e ? `${e.tier} ${e.pos}` : "");

// Who moved up from WL to CNF between two allocations.
export function promotions(before, after) {
  const prev = new Map(before.chart.map(e => [e.name, e]));
  return after.chart
    .filter(e => e.tier === "CNF" && prev.get(e.name) && prev.get(e.name).tier === "WL")
    .map(e => ({ name: e.name, from: "WL", to: "CNF" }));
}

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
