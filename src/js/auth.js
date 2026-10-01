// Identity, checked by the club server.
// - Logging in creates a server session (an HttpOnly cookie).
// - PINs are verified on the server (salted PBKDF2). The first person to
//   pick an unclaimed name logs in freely and is offered a PIN; after that,
//   that name needs its PIN on every device.
// The logged-in person is their roster row on the server: balance, games
// played, etc. all come from the same snapshot as the league table.
import { state, act } from "./api.js";

const S = () => state() || { me: null, roster: [], pins: [], opening: {}, PRICE_PER_HEAD: 250 };

export const sessionName = () => S().me;

export function currentUser() {
  const name = S().me;
  if (!name) return null;
  const row = S().roster.find(r => r[0] === name);
  if (!row) return null;
  const [, balance, played] = row;
  return {
    name,
    balance,                                   // server-computed, includes every ledger entry
    playedThisMonth: played,
    gamesLeft: Math.max(0, Math.floor(balance / S().PRICE_PER_HEAD)),
    openingBalance: S().opening[name] || 0,    // balance when the server was seeded
  };
}

// Resolves to { needsPinSetup } or throws ApiError (wrong PIN, locked...).
export const login = async (name, pin) => {
  const d = await act("/api/login", pin === undefined ? { name } : { name, pin });
  return { needsPinSetup: Boolean(d.needsPinSetup) };
};
export const logout = () => act("/api/logout", {});

export const hasPin = name => S().pins.includes(name);
export const setPin = pin => act("/api/pin", { pin });
export const resetPin = name => act("/api/admin/players/reset-pin", { name });
export const validPin = pin => /^\d{4}$/.test(pin);
