# Pitch & Ledger — FCFC

A mobile-first web app for FCFC: game RSVPs, personal wallet, and group balances,
backed by a small club server so every phone sees the same data.

## Running it

Python 3 standard library only (no pip, no Node). One process serves the app
and the API:

```bash
cd fcfc-app
python3 server.py                 # http://0.0.0.0:8090
PORT=9000 python3 server.py       # another port
FCFC_DB=/tmp/test.db python3 server.py   # a separate database
```

On first run the server creates `server/fcfc.db` (SQLite) and seeds it from
`server/seed.json`. Delete the `.db` file, or use Settings → Demo data → Reset,
to go back to the seed.

## How it fits together

- **`server.py`** is the source of truth. Every rule runs there, inside one lock
  and one SQLite transaction per request: CNF/WL allocation (members ahead of
  guests, then sign-up order; cancellations and drops promote the top of the
  waitlist), the balance ledger, PIN checks, organiser actions.
- **`GET /api/state`** returns a snapshot for the viewer (their bookings marked,
  the league table, month sheets, insights). Every **`POST /api/...`** applies
  one action and returns a fresh snapshot, so the browser never computes rules.
- The browser keeps the latest snapshot in `src/js/api.js` and re-renders from
  it. It re-checks every 15 seconds and whenever the tab regains focus (the
  server answers "unchanged" cheaply), so other phones' changes show up without
  a reload.
- Logins are server sessions (an HttpOnly, SameSite=Strict cookie). PINs are
  salted PBKDF2-SHA256 (200,000 rounds); five wrong tries lock the name for 30s.
- Static files are served with `Cache-Control: no-cache`; only `/`, `/index.html`
  and `/src/...` are served (never the database, server code or `.git`).

### API

| Endpoint | Who | Does |
| --- | --- | --- |
| `GET /api/state[?since=v&me=name]` | anyone | snapshot, or `{unchanged:true}` |
| `POST /api/login {name, pin?}` | anyone | session cookie; `needsPinSetup` for an unclaimed name |
| `POST /api/logout` / `POST /api/pin {pin}` | logged in | end session / set PIN |
| `POST /api/rsvp {fixture, choice}` | logged in | in / out; same choice again undoes |
| `POST /api/guests {fixture, delta}` | logged in | 0-2 guests, queued behind every member |
| `POST /api/payments/claim {amt}` | logged in | "I've paid" (one pending at a time) |
| `POST /api/extras/settle {id}` | logged in | pay your share from your wallet (paired ledger rows, once) |
| `POST /api/admin/fixtures/{create,edit,cancel,restore,duplicate,regulars,played}` | logged in* | host and manage games |
| `POST /api/admin/{drop,undrop,attendance}` | logged in* | queue and attendance |
| `POST /api/admin/players/{kind,removed,adjust,reset-pin}` | logged in* | players |
| `POST /api/admin/payments/confirm {id}` · `/api/admin/extras/mark` | logged in* | money |
| `POST /api/admin/reset-all {confirm:"RESET"}` | logged in* | reseed everything, log everyone out |
| `POST /api/demo/reset-settle` | anyone | DEMO-ONLY: forget Tejas's extras settle |

\* Organiser tools need a login but are **not yet restricted to organisers**:
organiser mode is still a per-device view toggle. Restricting them to named
organisers is the main thing left to do.

POSTs must be `application/json` (a cross-site form can't send that without a
CORS preflight, which the server never approves).

### Database (`server/fcfc.db`)

| Table | Holds |
| --- | --- |
| `people` | everyone who can appear in a booking: sheet members (`in_roster`), guests, `kind` (member/guest, organisers can change it), `removed`, `opening_balance` |
| `fixtures` | games: date, time, turf, capacity, price, `status` (upcoming/played), `charged`, series/repeat, cancellation |
| `bookings` | one row per person per game: `state` (in/out/none), `at` (queue order), `guests` |
| `drops`, `attendance` | organiser drops; who turned up at played games |
| `ledger` | every balance change except game charges: organiser corrections, extras transfers (paired rows; unique per person per item), confirmed top-ups (unique per payment) |
| `payments` | "I've paid" claims, pending or confirmed |
| `extras`, `extras_marks` | shared costs and cash settlements marked by organisers |
| `month_sheets`, `month_rows`, `month_ledger`, `wallet_seed`, `recent_attendance` | seeded history (before the server existed) |
| `pins`, `login_attempts`, `sessions` | auth |
| `meta` | version counter (bumped on every change), price, guest fee, UPI id |

Balance = `opening_balance` + ledger + game charges. Game charges are not stored:
they're derived from attendance at games marked played on this server (price for
each member who came, the guest fee to the host for each guest), so changing
attendance can never double-charge.

## Structure

```
server.py                  the club server (HTTP + API + SQLite)
server/seed.json           starting data (see its _notes for real vs synthesized)
index.html                 shell markup, import map, boot safety net
src/styles/*.css           tokens, layout, components
src/js/api.js              server client: snapshot, actions, sync
src/js/app.js              boot, tabs, login gate
src/js/auth.js / login.js  sessions + PINs (server-checked), login screen
src/js/games.js            Fixtures: cards, CNF/WL chart, RSVP, guests, share
src/js/booking.js          display helpers (labels, WhatsApp lineup text)
src/js/wallet.js           Wallet: balance, chart, history, extras settle
src/js/group.js            League table + monthly sheets
src/js/admin.js            Organiser tab: Games, Insights, Players
src/js/admin-store.js      read model + organiser actions
src/js/payments.js         payment claims and confirmations
src/js/settings.js         profile, theme, organiser mode, demo reset
```

## Real vs synthesized data

`server/seed.json` keeps the app's starting data. Real (from the club sheet):
roster names and balances, September games-played counts, the three SUFC
fixtures and their sign-ups, the UPI id. Synthesized placeholders: Turf B/C and
their games, guest sign-ups, the 24 Sep played game, last-5 attendance, extras,
pending payments, the month ledger, Tejas's wallet history, and the monthly
sheets from July 2025. Everything that happens on the server from now on is
real and accumulates (bookings, payments, games marked played, corrections);
months after September 2026 are computed from it.

## Known gaps

- **Organiser tools aren't restricted** to organisers yet (see above).
- **Payments/UPI are a stub**: "Pay by UPI app" only logs. Members claim a
  payment and an organiser confirms it against the UPI statement.
- **"Played" is manual**: an organiser marks a game played (charges follow);
  there's no automatic close-out by date.
- **Insights cost data** (ground fees, snacks) is seeded; there's no form yet to
  record new snack or ground-fee spend.
- Plain HTTP: run it behind HTTPS before using it beyond a local network.

## After changing any code

`index.html` pins every module to one version with an import map, and the
server sends `no-cache`. After editing any file under `src/`, bump the `?v=`
value (it appears in the import map and on the `app.js` script tag).
