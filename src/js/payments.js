// "I've paid" claims and organiser confirmations, held by the club server.
// No money moves here: UPI itself is still a stub. A member claims a
// payment, an organiser checks the UPI statement and confirms it, and the
// server credits the member's balance once.
import { state, act } from "./api.js";

const list = () => (state() || { payments: [] }).payments;

export const addClaim = (_name, amt) => act("/api/payments/claim", { amt });
export const confirmPayment = id => act("/api/admin/payments/confirm", { id });

export const pendingPayments = () => list().filter(p => p.status === "pending");
export const confirmedPaymentsFor = name =>
  list().filter(p => p.name === name && p.status === "confirmed").map(p => ({ ...p, at: p.confirmedAt || p.at }));
export const confirmedTotalFor = name => confirmedPaymentsFor(name).reduce((t, p) => t + p.amt, 0);
export const hasPendingFor = name => pendingPayments().some(p => p.name === name);
