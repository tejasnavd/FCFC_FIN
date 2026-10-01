# Pitch & Ledger — FCFC

A mobile-first web app for FCFC: game RSVPs, personal wallet, and group balances.

## Running it

ES modules require a real HTTP origin (browsers block `import` over `file://`).
No build step, no Node — any static file server works:

```bash
cd fcfc-app
python3 -m http.server 8000
# open http://localhost:8000
```

## Structure

```
index.html                 shell markup, imports styles + app.js
src/styles/tokens.css      color tokens (light + dark, media query + [data-theme])
src/styles/layout.css      app shell, header, tab bar
src/styles/components.css  game cards, wallet cards, roster rows
src/data/seed.js           all current data (games, wallet, roster) — swap this
src/data/history.js        SYNTHESIZED monthly sheets (Jul 2025 on) for the League table's month picker
                            file for a real API/sheet fetch, nothing else changes
src/js/utils.js            formatting + localStorage helpers
src/js/games.js            Games tab: render + RSVP interaction
src/js/wallet.js           Wallet tab: render + top-up/pay interaction
src/js/group.js            Group tab: render + search/sort interaction
src/js/admin-store.js      organiser overlays: hosted/edited/cancelled games, player kind/removal/adjustments
src/js/admin.js            Organiser tab: Games, Insights, Players
src/js/auth.js             simulated single-device login: session, local PINs, current user from roster
src/js/login.js            login screen: name picker, PIN entry, PIN setup
src/js/booking.js          CNF/WL engine: member priority, waitlist cascade, share text
src/js/popover.js          shared dropdown-panel behaviour (settings, turf picker)
src/js/payments.js         "I've paid" claims + organiser confirmations (device-local)
src/js/settings.js         profile & settings panel (me-chip), theme choice
src/js/app.js              wires it all together, tab switching, async data load
```

## Known gaps (next steps)

- `src/data/seed.js` is static — RSVPs and top-ups don't write back anywhere,
  they only affect local UI state (RSVP choice persists per-browser via
  `localStorage`, nothing else does).
- The "Pay by UPI app" button logs to console instead of opening a real UPI
  deep link — needs `upi://pay?...` wiring plus a way to confirm payment.
- No backend yet: real data still lives in the FCFC tabulation spreadsheet.
  Next milestone is an API (or direct sheet read) that `seed.js` calls into.

## After changing any code

The dev server sends no cache headers, so a browser can keep an old copy of a
module and mix it with new ones. `index.html` pins every module to one
version with an import map: after editing any file under `src/`, bump the
`?v=` value (it appears in the import map and on the `app.js` script tag).

If saved data on a device is ever from an incompatible older version, the
app shows a "couldn't start" panel with Reload / Reset instead of hanging,
and Settings has "Reset this device" (clears every `fcfc_` key).
