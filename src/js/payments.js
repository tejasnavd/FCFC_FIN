// "I've paid" claims and organiser confirmations. Device-local until a
// backend exists: the seed's pendingPayments plus any claims made on this
// device, minus the ones the organiser has confirmed.
import { loadJSON, saveJSON, emit, isObj, asArr, strArr, isStr, isNum } from "./utils.js";

const KEY = "fcfc_payments";
// normalised: anything malformed from an older version is dropped
const state = () => {
  const s = loadJSON(KEY, null);
  return {
    claims: asArr(s && s.claims).filter(c => isObj(c) && isStr(c.id) && isStr(c.name) && isNum(c.amt))
      .map(c => ({ ...c, when: isStr(c.when) ? c.when : "", at: isStr(c.at) ? c.at : undefined })),
    confirmed: strArr(s && s.confirmed),
  };
};

let seedPending = [];
export const setSeedPayments = list => { seedPending = asArr(list); };

export function addClaim(name, amt) {
  const s = state();
  const now = new Date();
  s.claims.push({
    id: `claim-${now.getTime()}`, name, amt, at: now.toISOString(),
    when: `Today, ${now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`,
  });
  saveJSON(KEY, s);
  emit("payments");
}

export function confirmPayment(id) {
  const s = state();
  if (!s.confirmed.includes(id)) s.confirmed.push(id);
  saveJSON(KEY, s);
  emit("payments");
}

const all = () => [...seedPending, ...state().claims];
export const pendingPayments = () => { const c = state().confirmed; return all().filter(p => !c.includes(p.id)); };
export const confirmedTotalFor = name => {
  const c = state().confirmed;
  return all().filter(p => p.name === name && c.includes(p.id)).reduce((t, p) => t + p.amt, 0);
};
// Confirmed top-ups for a person, with dates (for the wallet chart/history).
export const confirmedPaymentsFor = name => {
  const c = state().confirmed;
  return all().filter(p => p.name === name && c.includes(p.id));
};
export const hasPendingFor = name => pendingPayments().some(p => p.name === name);
