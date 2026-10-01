#!/usr/bin/env python3
"""FCFC club server: the static app + a JSON API + SQLite, standard library only.

Drop-in replacement for `python3 -m http.server 8090`:

    python3 server.py            # serves http://0.0.0.0:8090
    PORT=9000 python3 server.py  # another port
    FCFC_DB=/tmp/x.db python3 server.py

Design
- The server is the single source of truth. Every business rule that used to
  run in each browser (CNF/WL allocation, the balance ledger, PIN checks,
  organiser actions) runs here, inside one lock + one SQLite transaction per
  request, so all devices see the same state.
- GET /api/state returns a viewer-specific snapshot (bookings marked "you",
  your own booking records). Every POST applies one action and returns a
  fresh snapshot, so the browser never computes rules itself.
- First run (or POST /api/admin/reset-all) seeds the database from
  server/seed.json, the data the app shipped with.
- Payments/UPI remain a stub: members *claim* a payment and an organiser
  confirms it. No money moves through this server.
"""
import calendar
import datetime as dt
import hashlib
import hmac
import http.server
import json
import math
import os
import secrets
import sqlite3
import sys
import threading
import time
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("FCFC_DB", os.path.join(ROOT, "server", "fcfc.db"))
SEED_PATH = os.path.join(ROOT, "server", "seed.json")
PORT = int(os.environ.get("PORT", "8090"))
HOST = os.environ.get("HOST", "0.0.0.0")

PIN_ITERATIONS = 200_000
MAX_PIN_TRIES = 5
LOCKOUT_SECONDS = 30
SESSION_COOKIE = "fcfc_session"
SESSION_DAYS = 180
MAX_GUESTS = 2
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
WDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]          # Python weekday()
MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]
# The club's regular week (Mon=0): Tue + Thu 6:30, Sat 7:00 at SUFC.
REGULARS = [(1, "6:30 AM", 14), (3, "6:30 AM", 14), (5, "7:00 AM", 18)]
DEMO_SETTLE_NAME = "Tejas"     # see demo_reset_settle()

LOCK = threading.RLock()


class ApiError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


# ---------------------------------------------------------------- utilities

def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def now_ms():
    return time.time() * 1000


def parse_date(iso):
    try:
        return dt.date.fromisoformat(iso)
    except (TypeError, ValueError):
        raise ApiError(400, "Pick a valid date.")


def parts_from_date(iso):
    d = parse_date(iso)
    return {"wd": WDAYS[d.weekday()], "num": d.day, "mo": MONTHS[d.month - 1]}


def add_days(iso, n):
    return (parse_date(iso) + dt.timedelta(days=n)).isoformat()


def to24(t12):
    try:
        hm, ap = t12.strip().split(" ")
        h, m = hm.split(":")
        h = int(h) % 12 + (12 if ap.upper() == "PM" else 0)
        return f"{h:02d}:{int(m):02d}"
    except Exception:
        return t12


def to12(t24):
    try:
        h, m = (int(x) for x in t24.split(":"))
    except Exception:
        raise ApiError(400, "Pick a kickoff time.")
    if not (0 <= h < 24 and 0 <= m < 60):
        raise ApiError(400, "Pick a kickoff time.")
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def add_months_same_weekday(iso, k):
    """Same weekday and week-of-month, k months later ("2nd Tuesday").
    A 5th weekday missing next month becomes that month's last one."""
    d = parse_date(iso)
    nth = (d.day - 1) // 7
    y, m = d.year, d.month - 1 + k
    y, m = y + m // 12, m % 12 + 1
    first = dt.date(y, m, 1)
    day = 1 + (d.weekday() - first.weekday()) % 7 + 7 * nth
    days_in = calendar.monthrange(y, m)[1]
    while day > days_in:
        day -= 7
    return dt.date(y, m, day).isoformat()


def month_key(iso):
    return iso[:7]


def month_label(key):
    y, m = key.split("-")
    return f"{MONTH_NAMES[int(m) - 1]} {y}"


def next_month(key):
    y, m = (int(x) for x in key.split("-"))
    return f"{y + (m == 12)}-{1 if m == 12 else m + 1:02d}"


def game_dates(key):
    y, m = (int(x) for x in key.split("-"))
    return [dt.date(y, m, d).isoformat() for d in range(1, calendar.monthrange(y, m)[1] + 1)
            if dt.date(y, m, d).weekday() in (1, 3, 5)]


def short_day(iso):
    d = parse_date(iso)
    return f"{WDAYS[d.weekday()].title()} {d.day} {MONTHS[d.month - 1].title()}"


def as_int(v, lo, hi, what):
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise ApiError(400, f"{what} must be a whole number.")
    if not lo <= n <= hi:
        raise ApiError(400, f"{what} must be between {lo} and {hi}.")
    return n


def as_text(v, what, maxlen=80, required=True):
    s = (v if isinstance(v, str) else "").strip()
    if required and not s:
        raise ApiError(400, f"{what} is required.")
    return s[:maxlen]


def hash_pin(pin, salt):
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), salt.encode(), PIN_ITERATIONS).hex()


# ---------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS turfs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, label TEXT NOT NULL, ground_fee INTEGER NOT NULL);
-- Everyone who can appear in a booking. in_roster = on the club sheet;
-- kind can be changed by organisers (promote/demote changes priority).
CREATE TABLE IF NOT EXISTS people (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('member','guest')),
  host TEXT,
  in_roster INTEGER NOT NULL DEFAULT 0,
  opening_balance INTEGER NOT NULL DEFAULT 0,   -- balance when the server was seeded
  removed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS fixtures (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL, time TEXT NOT NULL,
  turf TEXT NOT NULL REFERENCES turfs(id),
  capacity INTEGER NOT NULL, price INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('upcoming','played')),
  charged INTEGER NOT NULL DEFAULT 0,            -- 1 = played on this server: attendance is charged
  series TEXT, repeat TEXT, hosted INTEGER NOT NULL DEFAULT 0,
  cancelled_reason TEXT, cancelled_at TEXT, created_at TEXT);
-- One row per person per fixture: their RSVP. `at` orders the queue.
CREATE TABLE IF NOT EXISTS bookings (
  fixture_id TEXT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in','out','none')),
  at REAL NOT NULL, guests INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
  PRIMARY KEY (fixture_id, name));
CREATE TABLE IF NOT EXISTS drops (
  fixture_id TEXT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE, name TEXT NOT NULL, at TEXT,
  PRIMARY KEY (fixture_id, name));
CREATE TABLE IF NOT EXISTS attendance (
  fixture_id TEXT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE, name TEXT NOT NULL,
  PRIMARY KEY (fixture_id, name));
-- Every balance change except game charges (which are derived from
-- attendance at charged fixtures, so toggling attendance can't double-charge).
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, amt INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('organiser','extras-paid','extras-received','topup')),
  ref TEXT, counterpart TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_settle_once ON ledger(ref, name) WHERE kind = 'extras-paid';
CREATE UNIQUE INDEX IF NOT EXISTS ledger_topup_once ON ledger(ref) WHERE kind = 'topup';
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, amt INTEGER NOT NULL,
  when_text TEXT, at TEXT, status TEXT NOT NULL CHECK (status IN ('pending','confirmed')),
  confirmed_at TEXT);
CREATE TABLE IF NOT EXISTS extras (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, when_text TEXT, paid_by TEXT NOT NULL,
  items TEXT NOT NULL, split TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS extras_marks (       -- settled by cash, marked by an organiser
  extras_id TEXT NOT NULL REFERENCES extras(id) ON DELETE CASCADE, name TEXT NOT NULL,
  PRIMARY KEY (extras_id, name));
CREATE TABLE IF NOT EXISTS wallet_seed (        -- dated wallet history before the server existed
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, date TEXT NOT NULL,
  t TEXT NOT NULL, d TEXT, amt INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS recent_attendance (name TEXT PRIMARY KEY, pips TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS month_sheets (month TEXT PRIMARY KEY, label TEXT NOT NULL, dates TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS month_rows (
  month TEXT NOT NULL, name TEXT NOT NULL, games TEXT NOT NULL,
  spent INTEGER NOT NULL, topups INTEGER NOT NULL, carried INTEGER NOT NULL,
  PRIMARY KEY (month, name));
CREATE TABLE IF NOT EXISTS month_ledger (
  month TEXT NOT NULL, turf TEXT NOT NULL, games_played INTEGER NOT NULL,
  snacks INTEGER NOT NULL, collected INTEGER NOT NULL, PRIMARY KEY (month, turf));
CREATE TABLE IF NOT EXISTS pins (
  name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, iterations INTEGER NOT NULL, set_at TEXT);
CREATE TABLE IF NOT EXISTS login_attempts (name TEXT PRIMARY KEY, fails INTEGER NOT NULL, locked_until REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT NOT NULL, created_at REAL NOT NULL);
"""
TABLES = ["sessions", "login_attempts", "pins", "month_ledger", "month_rows", "month_sheets",
          "recent_attendance", "wallet_seed", "extras_marks", "extras", "payments", "ledger",
          "attendance", "drops", "bookings", "fixtures", "people", "turfs", "meta"]


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def seed_database(conn):
    """(Re)load server/seed.json. Wipes everything, including PINs and sessions."""
    with open(SEED_PATH, encoding="utf-8") as f:
        S = json.load(f)
    conn.execute("PRAGMA foreign_keys = OFF")      # dropping tables in any order
    conn.execute("BEGIN IMMEDIATE")
    try:
        for t in TABLES:
            conn.execute(f"DROP TABLE IF EXISTS {t}")
        for stmt in SCHEMA.split(";"):
            if stmt.strip():
                conn.execute(stmt)
        x = conn.execute
        seeded_at = now_iso()
        x("INSERT INTO meta VALUES ('version','1'), ('seeded_at',?), ('price',?), ('guest_fee',?), ('upi_id',?)",
          (seeded_at, str(S["PRICE_PER_HEAD"]), str(S["GUEST_FEE"]), S["upiId"]))
        for t in S["turfs"]:
            x("INSERT INTO turfs VALUES (?,?,?,?)", (t["id"], t["name"], t["label"], t["groundFee"]))
        for name, bal, _played in S["roster"]:
            x("INSERT INTO people (name, kind, in_roster, opening_balance) VALUES (?, 'member', 1, ?)", (name, bal))
        for fx in S["fixtures"]:
            date = f"2026-{MONTHS.index(fx['mo']) + 1:02d}-{fx['num']:02d}"
            x("""INSERT INTO fixtures (id, date, time, turf, capacity, price, status, created_at)
                 VALUES (?,?,?,?,?,?,?,?)""",
              (fx["id"], date, fx["time"], fx["turf"], fx["capacity"], S["PRICE_PER_HEAD"], fx["status"], seeded_at))
            for e in fx["signups"]:
                if e["kind"] == "guest":
                    x("INSERT OR IGNORE INTO people (name, kind, host) VALUES (?, 'guest', ?)", (e["name"], e.get("host")))
                x("INSERT INTO bookings (fixture_id, name, state, at, updated_at) VALUES (?,?, 'in', ?, ?)",
                  (fx["id"], e["name"], e["at"], seeded_at))
            for n in fx.get("attended", []):
                x("INSERT INTO attendance VALUES (?,?)", (fx["id"], n))
        e = S["extras"]
        x("INSERT INTO extras VALUES (?,?,?,?,?,?)",
          (e["id"], e["title"], e["when"], e["paidBy"], json.dumps(e["items"]), json.dumps(e["splitAmong"])))
        for n in e.get("settled", []):
            x("INSERT INTO extras_marks VALUES (?,?)", (e["id"], n))
        for p in S["pendingPayments"]:
            x("INSERT INTO payments (id, name, amt, when_text, at, status) VALUES (?,?,?,?,?, 'pending')",
              (p["id"], p["name"], p["amt"], p.get("when"), p.get("at")))
        for name, rows in S["walletHistory"].items():
            for h in rows:
                x("INSERT INTO wallet_seed (name, date, t, d, amt, kind) VALUES (?,?,?,?,?,?)",
                  (name, h["date"], h["t"], h.get("d"), h["amt"], h["kind"]))
        for name, pips in S["recentAttendance"].items():
            x("INSERT INTO recent_attendance VALUES (?,?)", (name, json.dumps(pips)))
        for m in S["months"]:
            x("INSERT INTO month_sheets VALUES (?,?,?)", (m["key"], m["label"], json.dumps(m["dates"])))
            for name, r in m["rows"].items():
                x("INSERT INTO month_rows VALUES (?,?,?,?,?,?)",
                  (m["key"], name, json.dumps(r["games"]), r["spent"], r["topups"], r["carried"]))
        ml = S["monthLedger"]
        mkey = "2026-%02d" % (MONTH_NAMES.index(ml["month"].split()[0]) + 1)
        for t in ml["turfs"]:
            x("INSERT INTO month_ledger VALUES (?,?,?,?,?)", (mkey, t["turf"], t["gamesPlayed"], t["snacks"], t["collected"]))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def ensure_database():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = connect()
    try:
        has = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone()
        if not has:
            seed_database(conn)
            print(f"[fcfc] seeded {DB_PATH} from {SEED_PATH}", file=sys.stderr)
    finally:
        conn.close()


def meta(conn, key):
    r = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return r["value"] if r else None


def bump_version(conn):
    conn.execute("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='version'")


# ---------------------------------------------------------------- domain model

class Club:
    """A read model of the whole database, built once per request."""

    def __init__(self, conn):
        self.conn = conn
        q = lambda sql, *a: conn.execute(sql, a).fetchall()
        self.price = int(meta(conn, "price"))
        self.guest_fee = int(meta(conn, "guest_fee"))
        self.upi_id = meta(conn, "upi_id")
        self.version = int(meta(conn, "version"))
        self.seeded_at = meta(conn, "seeded_at")
        self.turfs = [dict(r) for r in q("SELECT * FROM turfs ORDER BY rowid")]
        self.turf_by_id = {t["id"]: t for t in self.turfs}
        self.people = {r["name"]: dict(r) for r in q("SELECT * FROM people")}
        self.fixtures = [dict(r) for r in q("SELECT * FROM fixtures")]
        self.fixtures.sort(key=lambda f: (f["date"], to24(f["time"])))
        self.fx_by_id = {f["id"]: f for f in self.fixtures}
        self.bookings = {}
        for r in q("SELECT * FROM bookings"):
            self.bookings.setdefault(r["fixture_id"], {})[r["name"]] = dict(r)
        self.drops = {}
        for r in q("SELECT * FROM drops ORDER BY rowid"):
            self.drops.setdefault(r["fixture_id"], []).append(r["name"])
        self.attendance = {}
        for r in q("SELECT * FROM attendance ORDER BY rowid"):
            self.attendance.setdefault(r["fixture_id"], []).append(r["name"])
        self.ledger = [dict(r) for r in q("SELECT * FROM ledger ORDER BY id")]
        self.payments = [dict(r) for r in q("SELECT * FROM payments ORDER BY COALESCE(at, '')")]
        self.extras = [dict(r) for r in q("SELECT * FROM extras")]
        self.marks = {}
        for r in q("SELECT * FROM extras_marks"):
            self.marks.setdefault(r["extras_id"], set()).add(r["name"])
        self.pins = {r["name"] for r in q("SELECT name FROM pins")}

    # ---- people
    def kind_of(self, name):
        p = self.people.get(name)
        return p["kind"] if p else "member"

    def removed(self, name):
        p = self.people.get(name)
        return bool(p and p["removed"])

    def roster_names(self):
        """Members on the sheet plus guests promoted to members, sheet order first."""
        names = [n for n, p in self.people.items() if p["in_roster"]]
        names += sorted(n for n, p in self.people.items() if not p["in_roster"] and p["kind"] == "member")
        return names

    # ---- allocation: a faithful port of booking.js + games.js queueFor
    def queue_for(self, fx):
        gone = set(self.drops.get(fx["id"], []))
        ok = lambda n: n not in gone and not self.removed(n)
        q = []
        for name, b in self.bookings.get(fx["id"], {}).items():
            if b["state"] != "in" or not ok(name):
                continue
            p = self.people.get(name)
            kind, host = self.kind_of(name), (p or {}).get("host")
            if kind == "guest" and host and host in gone:
                continue
            q.append({"name": name, "kind": kind, "host": host if kind == "guest" else None, "at": b["at"], "anon": False})
            if kind != "guest":
                for i in range(int(b["guests"] or 0)):
                    q.append({"name": f"{name}'s guest" + (f" {i + 1}" if i else ""), "kind": "guest",
                              "host": name, "at": b["at"] + (i + 1) / 10, "anon": True})
        return q

    def allocate(self, fx):
        q = self.queue_for(fx)
        ordered = sorted((e for e in q if e["kind"] != "guest"), key=lambda e: e["at"]) + \
            sorted((e for e in q if e["kind"] == "guest"), key=lambda e: e["at"])
        cap = fx["capacity"]
        chart = []
        for i, e in enumerate(ordered):
            tier, pos = ("CNF", i + 1) if i < cap else ("WL", i - cap + 1)
            chart.append({"name": e["name"], "kind": e["kind"], "host": e["host"], "anon": e["anon"],
                          "tier": tier, "pos": pos})
        return chart

    # ---- money
    def game_charges(self):
        """Derived charges for fixtures played on this server: price for each
        attending member, the guest fee to the host for each attending guest."""
        out = []
        for fx in self.fixtures:
            if not fx["charged"] or fx["cancelled_reason"]:
                continue
            chart = {e["name"]: e for e in self.allocate(fx)}
            turf = self.turf_by_id[fx["turf"]]["label"]
            for name in self.attendance.get(fx["id"], []):
                e = chart.get(name)
                kind = e["kind"] if e else self.kind_of(name)
                host = (e or {}).get("host") or (self.people.get(name) or {}).get("host")
                if kind == "guest" and host:
                    out.append({"name": host, "amt": -self.guest_fee, "kind": "guest-fee", "at": fx["date"],
                                "reason": f"{short_day(fx['date'])}, {turf}", "counterpart": name if not (e or {}).get("anon") else "guest",
                                "ref": fx["id"]})
                else:
                    out.append({"name": name, "amt": -fx["price"], "kind": "game", "at": fx["date"],
                                "reason": f"{short_day(fx['date'])}, {turf}", "ref": fx["id"], "counterpart": None})
        return out

    def balances(self):
        bal = {n: p["opening_balance"] for n, p in self.people.items()}
        for a in self.ledger:
            bal[a["name"]] = bal.get(a["name"], 0) + a["amt"]
        for c in self.game_charges():
            bal[c["name"]] = bal.get(c["name"], 0) + c["amt"]
        return bal

    def extras_view(self, ex):
        split = json.loads(ex["split"])
        items = json.loads(ex["items"])
        total = sum(i["amt"] for i in items)
        paid = {a["name"] for a in self.ledger if a["kind"] == "extras-paid" and a["ref"] == ex["id"]}
        marks = self.marks.get(ex["id"], set())
        return {"id": ex["id"], "title": ex["title"], "when": ex["when_text"], "paidBy": ex["paid_by"],
                "items": items, "splitAmong": split, "each": math.ceil(total / len(split)) if split else 0,
                "total": total, "marks": sorted(marks), "viaWallet": sorted(paid), "settled": sorted(marks | paid)}

    # ---- months
    def current_month(self):
        return dt.date.today().isoformat()[:7]

    def month_sheets(self, balances):
        conn = self.conn
        sheets = []
        for r in conn.execute("SELECT * FROM month_sheets ORDER BY month"):
            rows = {x["name"]: {"games": json.loads(x["games"]), "spent": x["spent"], "topups": x["topups"],
                                "carried": x["carried"]}
                    for x in conn.execute("SELECT * FROM month_rows WHERE month=?", (r["month"],))}
            sheets.append({"key": r["month"], "label": r["label"], "dates": json.loads(r["dates"]), "rows": rows,
                           "current": False, "seeded": True})
        cur = self.current_month()
        last = sheets[-1]["key"] if sheets else cur
        # live months: everything after the seeded history, up to now
        charges = self.game_charges()
        topups = [a for a in self.ledger if a["kind"] == "topup"]
        key = next_month(last)
        while key <= cur:
            start, end = f"{key}-01", f"{next_month(key)}-01"
            rows = {}
            for name in self.roster_names():
                mine = [c for c in charges if c["name"] == name and start <= c["at"] < end]
                games = sorted({self.fx_by_id[c["ref"]]["date"] for c in mine if c["kind"] == "game"})
                spent = -sum(c["amt"] for c in mine)
                tops = sum(a["amt"] for a in topups if a["name"] == name and start <= a["at"][:10] < end)
                if key == cur:
                    carried = balances.get(name, 0)
                else:
                    carried = self.people[name]["opening_balance"] + \
                        sum(a["amt"] for a in self.ledger if a["name"] == name and a["at"][:10] < end) + \
                        sum(c["amt"] for c in charges if c["name"] == name and c["at"] < end)
                rows[name] = {"games": games, "spent": spent, "topups": tops, "carried": carried}
            sheets.append({"key": key, "label": month_label(key), "dates": game_dates(key), "rows": rows,
                           "current": False, "seeded": False})
            key = next_month(key)
        for s in sheets:
            s["current"] = s["key"] == cur
        return list(reversed(sheets))

    def month_ledger(self):
        """Money per turf for the latest month with played games: live months
        are computed from charged fixtures; otherwise the seeded month."""
        charges = self.game_charges()
        played = [f for f in self.fixtures if f["charged"] and not f["cancelled_reason"]]
        if played:
            key = max(f["date"] for f in played)[:7]
            turfs = []
            for t in self.turfs:
                fxs = [f for f in played if f["turf"] == t["id"] and f["date"][:7] == key]
                ids = {f["id"] for f in fxs}
                turfs.append({"turf": t["id"], "gamesPlayed": len(fxs), "snacks": 0,
                              "collected": -sum(c["amt"] for c in charges if c["ref"] in ids)})
            return {"month": month_label(key), "live": True, "turfs": turfs}
        rows = self.conn.execute("SELECT * FROM month_ledger ORDER BY rowid").fetchall()
        key = rows[0]["month"] if rows else self.current_month()
        return {"month": month_label(key), "live": False,
                "turfs": [{"turf": r["turf"], "gamesPlayed": r["games_played"], "snacks": r["snacks"],
                           "collected": r["collected"]} for r in rows]}

    def recent_attendance(self):
        pips = {r["name"]: json.loads(r["pips"]) for r in self.conn.execute("SELECT * FROM recent_attendance")}
        for fx in self.fixtures:            # games played on this server extend the strip
            if fx["charged"] and not fx["cancelled_reason"]:
                came = set(self.attendance.get(fx["id"], []))
                for n in self.roster_names():
                    pips[n] = (pips.get(n, [0] * 5) + [1 if n in came else 0])[-5:]
        return pips

    # ---- snapshot for one viewer
    def snapshot(self, viewer):
        bal = self.balances()
        sheets = self.month_sheets(bal)
        cur = next((s for s in sheets if s["current"]), sheets[0])
        roster = []
        for n in self.roster_names():
            p = self.people[n]
            roster.append([n, bal.get(n, 0), len(cur["rows"].get(n, {}).get("games", [])), {
                "kind": p["kind"], "removed": bool(p["removed"]),
                "adjusted": any(a["name"] == n and a["kind"] == "organiser" for a in self.ledger),
                "promoted": not p["in_roster"]}])
        fixtures = []
        for f in self.fixtures:
            fixtures.append({
                "id": f["id"], "date": f["date"], **parts_from_date(f["date"]), "time": f["time"],
                "turf": f["turf"], "capacity": f["capacity"], "price": f["price"], "status": f["status"],
                "charged": bool(f["charged"]), "series": f["series"], "repeat": f["repeat"], "hosted": bool(f["hosted"]),
                "cancelled": {"reason": f["cancelled_reason"], "at": f["cancelled_at"]} if f["cancelled_reason"] else None,
                "signups": [{"name": n, "kind": self.kind_of(n), "host": (self.people.get(n) or {}).get("host")}
                            for n, b in sorted(self.bookings.get(f["id"], {}).items(), key=lambda kv: kv[1]["at"])
                            if b["state"] == "in"],
                "attended": self.attendance.get(f["id"], []),
                "dropped": self.drops.get(f["id"], []),
                "chart": self.allocate(f),
            })
        mine = {}
        if viewer:
            for fid, rows in self.bookings.items():
                b = rows.get(viewer)
                if b and b["state"] in ("in", "out"):
                    mine[fid] = {"state": b["state"], "guests": b["guests"], "at": b["at"]}
        guests = [{"name": n, "host": p["host"], "kind": p["kind"]}
                  for n, p in self.people.items() if not p["in_roster"]]
        ledger = [{k: a[k] for k in ("id", "name", "amt", "reason", "at", "kind", "ref", "counterpart")}
                  for a in self.ledger if a["kind"] != "topup"]
        ledger += [{"id": f"g-{c['ref']}-{c['name']}-{i}", **c} for i, c in enumerate(self.game_charges())]
        wallet = {}
        for r in self.conn.execute("SELECT * FROM wallet_seed ORDER BY date, id"):
            wallet.setdefault(r["name"], []).append({"date": r["date"], "t": r["t"], "d": r["d"], "amt": r["amt"], "kind": r["kind"]})
        return {
            "version": self.version, "serverTime": now_iso(),
            "month": {"key": cur["key"], "label": cur["label"]},
            "seededAt": self.seeded_at, "seededMonth": month_label(self.seeded_at[:7]),
            "PRICE_PER_HEAD": self.price, "GUEST_FEE": self.guest_fee, "upiId": self.upi_id,
            "turfs": [{"id": t["id"], "name": t["name"], "label": t["label"], "groundFee": t["ground_fee"]} for t in self.turfs],
            "me": viewer, "pins": sorted(self.pins),
            "fixtures": fixtures, "myBookings": mine,
            "roster": roster, "guests": guests,
            "people": {n: {"kind": p["kind"], "removed": bool(p["removed"]), "host": p["host"]} for n, p in self.people.items()},
            "opening": {n: p["opening_balance"] for n, p in self.people.items()},
            "recentAttendance": self.recent_attendance(),
            "ledger": ledger,
            "payments": [{"id": p["id"], "name": p["name"], "amt": p["amt"], "when": p["when_text"], "at": p["at"],
                          "status": p["status"], "confirmedAt": p["confirmed_at"]} for p in self.payments],
            "extras": self.extras_view(self.extras[0]) if self.extras else None,
            "walletHistory": wallet,
            "months": sheets,
            "monthLedger": self.month_ledger(),
        }


# ---------------------------------------------------------------- actions

def promotions(before, after):
    prev = {e["name"]: e for e in before}
    return [{"name": e["name"], "from": "WL", "to": "CNF"} for e in after
            if e["tier"] == "CNF" and prev.get(e["name"], {}).get("tier") == "WL"]


def need_fixture(club, fid, bookable=False):
    fx = club.fx_by_id.get(fid if isinstance(fid, str) else "")
    if not fx:
        raise ApiError(404, "That game doesn't exist any more.")
    if bookable and fx["cancelled_reason"]:
        raise ApiError(409, "That game has been cancelled.")
    if bookable and fx["status"] != "upcoming":
        raise ApiError(409, "That game has already been played.")
    return fx


def need_person(club, name, member=False):
    if not isinstance(name, str) or name not in club.people:
        raise ApiError(404, "No one by that name is in the club list.")
    if member and club.kind_of(name) != "member":
        raise ApiError(400, f"{name} is a guest.")
    return club.people[name]


def fixture_exists(club, date, time12, turf, extra=()):
    return any(f["date"] == date and to24(f["time"]) == to24(time12) and f["turf"] == turf
               for f in list(club.fixtures) + list(extra))


def insert_fixtures(conn, club, turf, date, time12, capacity, price, every="week", count=1):
    if turf not in club.turf_by_id:
        raise ApiError(400, "Pick a turf.")
    parse_date(date)
    capacity = as_int(capacity, 2, 40, "Places")
    price = as_int(price, 0, 2000, "Price per head")
    count = as_int(count, 1, 12, "Repeat count")
    every = "month" if every == "month" else "week"
    series = f"series-{secrets.token_hex(4)}" if count > 1 else None
    made = []
    for i in range(count):
        d = add_months_same_weekday(date, i) if every == "month" else add_days(date, 7 * i)
        if fixture_exists(club, d, time12, turf, made):
            continue
        fid = f"hosted-{d}-{turf}-{to24(time12).replace(':', '')}-{secrets.token_hex(3)}"
        conn.execute("""INSERT INTO fixtures (id, date, time, turf, capacity, price, status, series, repeat, hosted, created_at)
                        VALUES (?,?,?,?,?,?, 'upcoming', ?, ?, 1, ?)""",
                     (fid, d, time12, turf, capacity, price, series, every if count > 1 else None, now_iso()))
        made.append({"id": fid, "date": d, "time": time12, "turf": turf, **parts_from_date(d)})
    return made


def demo_reset_settle(conn, club):
    """DEMO-ONLY SCAFFOLDING. Remove once the settle-from-wallet demo is done.
    Forgets Tejas's settle-from-wallet transfer for the extras item (both
    halves of the pair) so the demo can be repeated. Nothing else changes."""
    if not club.extras:
        return False
    ref = club.extras[0]["id"]
    cur = conn.execute("""DELETE FROM ledger WHERE ref=? AND (
                            (kind='extras-paid' AND name=?) OR (kind='extras-received' AND counterpart=?))""",
                       (ref, DEMO_SETTLE_NAME, DEMO_SETTLE_NAME))
    return cur.rowcount > 0


def handle_action(conn, path, body, viewer, session_token):
    """Apply one mutation. Runs inside a transaction; returns (extra_response, set_cookie)."""
    club = Club(conn)
    x = conn.execute
    me = viewer
    out, cookie = {}, None

    def need_login():
        if not me:
            raise ApiError(401, "Log in first.")

    # ------------------------------------------------ auth
    if path == "/api/login":
        name = body.get("name")
        need_person(club, name)
        if club.kind_of(name) != "member":
            raise ApiError(400, "Guests can't log in. They book through the member who brings them.")
        pin_row = x("SELECT * FROM pins WHERE name=?", (name,)).fetchone()
        if pin_row:
            att = x("SELECT * FROM login_attempts WHERE name=?", (name,)).fetchone()
            if att and att["locked_until"] > time.time():
                wait = int(att["locked_until"] - time.time()) + 1
                raise ApiError(423, f"Too many wrong PINs. Try again in {wait} seconds.", retryIn=wait)
            pin = body.get("pin")
            if pin is None or pin == "":
                # asking which step comes next isn't a failed attempt
                raise ApiError(401, "Enter the PIN for this name.", needsPin=True)
            good = isinstance(pin, str) and hmac.compare_digest(hash_pin(pin, pin_row["salt"]), pin_row["hash"])
            if not good:
                fails = (att["fails"] if att else 0) + 1
                locked = time.time() + LOCKOUT_SECONDS if fails >= MAX_PIN_TRIES else 0
                x("INSERT OR REPLACE INTO login_attempts VALUES (?,?,?)", (name, 0 if locked else fails, locked))
                # failed attempts must persist even though the request errors
                conn.execute("COMMIT")
                conn.execute("BEGIN IMMEDIATE")
                if locked:
                    raise ApiError(423, f"Too many wrong PINs. Try again in {LOCKOUT_SECONDS} seconds.", retryIn=LOCKOUT_SECONDS)
                left = MAX_PIN_TRIES - fails
                raise ApiError(401, f"That PIN doesn't match. {left} {'try' if left == 1 else 'tries'} left.", triesLeft=left)
            x("DELETE FROM login_attempts WHERE name=?", (name,))
        token = secrets.token_urlsafe(32)
        x("INSERT INTO sessions VALUES (?,?,?)", (token, name, time.time()))
        cookie = token
        out["needsPinSetup"] = pin_row is None
        return out, cookie, name

    if path == "/api/logout":
        if session_token:
            x("DELETE FROM sessions WHERE token=?", (session_token,))
        return out, "", None

    if path == "/api/pin":
        need_login()
        pin = body.get("pin")
        if not (isinstance(pin, str) and len(pin) == 4 and pin.isdigit()):
            raise ApiError(400, "Use exactly 4 digits.")
        salt = secrets.token_hex(16)
        x("INSERT OR REPLACE INTO pins VALUES (?,?,?,?,?)", (me, salt, hash_pin(pin, salt), PIN_ITERATIONS, now_iso()))
        return out, None, me

    # ------------------------------------------------ bookings
    if path == "/api/rsvp":
        need_login()
        fx = need_fixture(club, body.get("fixture"), bookable=True)
        choice = body.get("choice")
        if choice not in ("in", "out"):
            raise ApiError(400, "Choose in or out.")
        before = club.allocate(fx)
        prev = club.bookings.get(fx["id"], {}).get(me)
        prev_state = prev["state"] if prev and prev["state"] != "none" else None
        if prev_state == choice:
            state, at = "none", (prev["at"] if prev else now_ms())     # tap again to undo
        elif choice == "in":
            state, at = "in", now_ms()
        else:
            state, at = "out", (prev["at"] if prev else now_ms())
        x("""INSERT INTO bookings (fixture_id, name, state, at, guests, updated_at) VALUES (?,?,?,?,0,?)
             ON CONFLICT(fixture_id, name) DO UPDATE SET state=excluded.state, at=excluded.at, guests=0,
             updated_at=excluded.updated_at""", (fx["id"], me, state, at, now_iso()))
        if prev_state == "in" and state != "in":
            out["moved"] = promotions(before, Club(conn).allocate(fx))
        return out, None, me

    if path == "/api/guests":
        need_login()
        fx = need_fixture(club, body.get("fixture"), bookable=True)
        b = club.bookings.get(fx["id"], {}).get(me)
        if not b or b["state"] != "in":
            raise ApiError(409, "Book yourself in to bring a guest.")
        delta = as_int(body.get("delta"), -1, 1, "Change")
        n = max(0, min(MAX_GUESTS, int(b["guests"]) + delta))
        x("UPDATE bookings SET guests=?, updated_at=? WHERE fixture_id=? AND name=?", (n, now_iso(), fx["id"], me))
        return out, None, me

    # ------------------------------------------------ wallet
    if path == "/api/payments/claim":
        need_login()
        amt = as_int(body.get("amt"), 1, 100000, "Amount")
        if any(p["name"] == me and p["status"] == "pending" for p in club.payments):
            raise ApiError(409, "You already have a payment waiting for the organiser.")
        t = dt.datetime.now()
        x("INSERT INTO payments (id, name, amt, when_text, at, status) VALUES (?,?,?,?,?, 'pending')",
          (f"claim-{int(time.time() * 1000)}-{secrets.token_hex(2)}", me, amt,
           f"{t.day} {MONTHS[t.month - 1].title()}, {t.strftime('%I:%M %p').lstrip('0')}", now_iso()))
        return out, None, me

    if path == "/api/extras/settle":
        need_login()
        ex = next((e for e in club.extras if e["id"] == body.get("id")), None)
        if not ex:
            raise ApiError(404, "That shared cost doesn't exist.")
        v = club.extras_view(ex)
        if me not in v["splitAmong"] or me == v["paidBy"]:
            raise ApiError(409, "You don't owe anything for this one.")
        if me in v["settled"]:
            raise ApiError(409, "You've already settled this.")
        at = now_iso()
        try:
            x("INSERT INTO ledger (name, amt, reason, at, kind, ref, counterpart) VALUES (?,?,?,?, 'extras-paid', ?, ?)",
              (me, -v["each"], v["title"], at, ex["id"], v["paidBy"]))
        except sqlite3.IntegrityError:
            raise ApiError(409, "You've already settled this.")
        x("INSERT INTO ledger (name, amt, reason, at, kind, ref, counterpart) VALUES (?,?,?,?, 'extras-received', ?, ?)",
          (v["paidBy"], v["each"], v["title"], at, ex["id"], me))
        out["sent"] = {"amt": v["each"], "to": v["paidBy"]}
        return out, None, me

    if path == "/api/demo/reset-settle":
        out["reset"] = demo_reset_settle(conn, club)
        return out, None, me

    # ------------------------------------------------ organiser
    # Organiser tools need a login but are not restricted to organisers yet
    # (organiser mode is still a per-device view toggle). See README.
    if not path.startswith("/api/admin/"):
        raise ApiError(404, "Unknown action.")
    need_login()
    a = path[len("/api/admin/"):]

    if a == "fixtures/create":
        made = insert_fixtures(conn, club, body.get("turf"), body.get("date"), to12(body.get("time") or ""),
                               body.get("capacity"), body.get("price"), body.get("every"), body.get("count") or 1)
        out["made"] = made
    elif a == "fixtures/edit":
        fx = need_fixture(club, body.get("id"))
        turf, date = body.get("turf"), body.get("date")
        if turf not in club.turf_by_id:
            raise ApiError(400, "Pick a turf.")
        parse_date(date)
        time12 = to12(body.get("time") or "")
        if fixture_exists(club, date, time12, turf, ()) and not (
                fx["date"] == date and to24(fx["time"]) == to24(time12) and fx["turf"] == turf):
            raise ApiError(409, "There's already a game at that turf and time.")
        x("UPDATE fixtures SET turf=?, date=?, time=?, capacity=?, price=? WHERE id=?",
          (turf, date, time12, as_int(body.get("capacity"), 2, 40, "Places"),
           as_int(body.get("price"), 0, 2000, "Price per head"), fx["id"]))
    elif a == "fixtures/cancel":
        fx = need_fixture(club, body.get("id"))
        x("UPDATE fixtures SET cancelled_reason=?, cancelled_at=? WHERE id=?",
          (as_text(body.get("reason"), "A reason") or "Cancelled by the organiser", now_iso(), fx["id"]))
    elif a == "fixtures/restore":
        fx = need_fixture(club, body.get("id"))
        x("UPDATE fixtures SET cancelled_reason=NULL, cancelled_at=NULL WHERE id=?", (fx["id"],))
    elif a == "fixtures/duplicate":
        fx = need_fixture(club, body.get("id"))
        d = add_days(fx["date"], 7)
        while fixture_exists(club, d, fx["time"], fx["turf"]):
            d = add_days(d, 7)
        out["made"] = insert_fixtures(conn, club, fx["turf"], d, fx["time"], fx["capacity"], fx["price"])
    elif a == "fixtures/regulars":
        last = club.fixtures[-1]["date"] if club.fixtures else dt.date.today().isoformat()
        monday = add_days(last, 1)
        while parse_date(monday).weekday() != 0:
            monday = add_days(monday, 1)
        made = []
        for day, time12, cap in REGULARS:
            club = Club(conn)
            made += insert_fixtures(conn, club, "sufc", add_days(monday, day), time12, cap, club.price)
        out["made"] = made
    elif a == "fixtures/played":
        # New with the server: closes a game. Attendance starts as everyone
        # in CNF (organisers can correct it); charges are derived from it.
        fx = need_fixture(club, body.get("id"), bookable=True)
        x("UPDATE fixtures SET status='played', charged=1 WHERE id=?", (fx["id"],))
        x("DELETE FROM attendance WHERE fixture_id=?", (fx["id"],))
        for e in club.allocate(fx):
            if e["tier"] == "CNF":
                x("INSERT OR IGNORE INTO attendance VALUES (?,?)", (fx["id"], e["name"]))
    elif a in ("drop", "undrop"):
        fx = need_fixture(club, body.get("fixture"))
        name = as_text(body.get("name"), "Name")
        if a == "drop":
            before = club.allocate(fx)
            x("INSERT OR IGNORE INTO drops VALUES (?,?,?)", (fx["id"], name, now_iso()))
            out["moved"] = promotions(before, Club(conn).allocate(fx))
        else:
            x("DELETE FROM drops WHERE fixture_id=? AND name=?", (fx["id"], name))
    elif a == "attendance":
        fx = need_fixture(club, body.get("fixture"))
        if fx["status"] != "played":
            raise ApiError(409, "Attendance can only be marked for played games.")
        name = as_text(body.get("name"), "Name")
        if name in club.attendance.get(fx["id"], []):
            x("DELETE FROM attendance WHERE fixture_id=? AND name=?", (fx["id"], name))
        else:
            x("INSERT INTO attendance VALUES (?,?)", (fx["id"], name))
    elif a == "players/kind":
        name = body.get("name")
        need_person(club, name)
        kind = body.get("kind")
        if kind not in ("member", "guest"):
            raise ApiError(400, "Kind must be member or guest.")
        x("UPDATE people SET kind=? WHERE name=?", (kind, name))
    elif a == "players/removed":
        name = body.get("name")
        need_person(club, name)
        x("UPDATE people SET removed=? WHERE name=?", (1 if body.get("removed") else 0, name))
    elif a == "players/adjust":
        name = body.get("name")
        need_person(club, name, member=True)
        amt = as_int(body.get("amt"), -100000, 100000, "Amount")
        if amt == 0:
            raise ApiError(400, "Enter an amount other than zero.")
        x("INSERT INTO ledger (name, amt, reason, at, kind) VALUES (?,?,?,?, 'organiser')",
          (name, amt, as_text(body.get("reason"), "A reason"), now_iso()))
    elif a == "players/reset-pin":
        name = body.get("name")
        need_person(club, name)
        x("DELETE FROM pins WHERE name=?", (name,))
        x("DELETE FROM login_attempts WHERE name=?", (name,))
    elif a == "payments/confirm":
        p = next((p for p in club.payments if p["id"] == body.get("id")), None)
        if not p:
            raise ApiError(404, "That payment doesn't exist.")
        if p["status"] == "confirmed":
            raise ApiError(409, "Already confirmed.")
        at = now_iso()
        x("UPDATE payments SET status='confirmed', confirmed_at=? WHERE id=?", (at, p["id"]))
        x("INSERT INTO ledger (name, amt, reason, at, kind, ref) VALUES (?,?,?,?, 'topup', ?)",
          (p["name"], p["amt"], "UPI top-up confirmed", at, p["id"]))
    elif a == "extras/mark":
        ex = next((e for e in club.extras if e["id"] == body.get("id")), None)
        if not ex:
            raise ApiError(404, "That shared cost doesn't exist.")
        v = club.extras_view(ex)
        name = body.get("name")
        if name not in v["splitAmong"] or name == v["paidBy"]:
            raise ApiError(400, "They're not in this split.")
        if name in v["viaWallet"]:
            raise ApiError(409, "Paid from their wallet; that can't be undone here.")
        if name in v["marks"]:
            x("DELETE FROM extras_marks WHERE extras_id=? AND name=?", (ex["id"], name))
        else:
            x("INSERT INTO extras_marks VALUES (?,?)", (ex["id"], name))
    else:
        raise ApiError(404, "Unknown action.")
    return out, None, me


# ---------------------------------------------------------------- HTTP

STATIC_OK = ("/", "/index.html")


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = "FCFC/1.0"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if os.environ.get("FCFC_QUIET") != "1":
            sys.stderr.write("[fcfc] %s %s\n" % (self.address_string(), fmt % args))

    # ---- static: only the app, never the database, server code or .git
    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/"):
            return self.api("GET", path)
        if path in STATIC_OK or path.startswith("/src/"):
            if ".." in path:
                return self.send_error(404)
            return super().do_GET()
        return self.send_error(404, "Not found")

    def do_HEAD(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in STATIC_OK or path.startswith("/src/"):
            return super().do_HEAD()
        return self.send_error(404, "Not found")

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if not path.startswith("/api/"):
            return self.send_error(405)
        return self.api("POST", path)

    # ---- API
    def session_token(self):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == SESSION_COOKIE and v:
                return v
        return None

    def viewer(self, conn, token):
        if not token:
            return None
        r = conn.execute("SELECT name, created_at FROM sessions WHERE token=?", (token,)).fetchone()
        if not r or r["created_at"] < time.time() - SESSION_DAYS * 86400:
            return None
        p = conn.execute("SELECT kind, in_roster FROM people WHERE name=?", (r["name"],)).fetchone()
        return r["name"] if p and p["kind"] == "member" else None

    def send_json(self, status, payload, cookie=None):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if cookie is not None:
            if cookie:
                self.send_header("Set-Cookie", f"{SESSION_COOKIE}={cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_DAYS * 86400}")
            else:
                self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
        self.end_headers()
        self.wfile.write(body)

    def api(self, method, path):
        token = self.session_token()
        try:
            if method == "POST":
                # JSON-only POSTs: a cross-site form can't send this without a
                # CORS preflight, which this server never approves.
                if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                    raise ApiError(415, "Send JSON.")
                n = int(self.headers.get("Content-Length") or 0)
                if n > 64 * 1024:
                    raise ApiError(413, "Request too large.")
                try:
                    body = json.loads(self.rfile.read(n) or b"{}")
                except json.JSONDecodeError:
                    raise ApiError(400, "Bad JSON.")
                if not isinstance(body, dict):
                    raise ApiError(400, "Bad JSON.")
            with LOCK:
                conn = connect()
                try:
                    me = self.viewer(conn, token)
                    if method == "GET":
                        if path != "/api/state":
                            raise ApiError(404, "Unknown endpoint.")
                        q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                        since = q.get("since", [None])[0]
                        if since is not None and since == meta(conn, "version") and q.get("me", [""])[0] == (me or ""):
                            return self.send_json(200, {"unchanged": True, "version": int(since)})
                        return self.send_json(200, {"state": Club(conn).snapshot(me)})
                    if path == "/api/admin/reset-all":
                        if not me:
                            raise ApiError(401, "Log in first.")
                        if body.get("confirm") != "RESET":
                            raise ApiError(400, "Confirm the reset.")
                        seed_database(conn)
                        return self.send_json(200, {"ok": True, "state": Club(conn).snapshot(None)}, cookie="")
                    conn.execute("BEGIN IMMEDIATE")
                    try:
                        extra, cookie, viewer = handle_action(conn, path, body, me, token)
                        bump_version(conn)
                        conn.execute("COMMIT")
                    except Exception:
                        conn.execute("ROLLBACK")
                        raise
                    return self.send_json(200, {"ok": True, **extra, "state": Club(conn).snapshot(viewer)}, cookie=cookie)
                finally:
                    conn.close()
        except ApiError as e:
            return self.send_json(e.status, {"error": e.message, **e.extra})
        except Exception as e:      # never leak a traceback to the client
            import traceback
            traceback.print_exc()
            return self.send_json(500, {"error": "Something went wrong on the server."})


def main():
    ensure_database()
    srv = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print(f"[fcfc] serving {ROOT} on http://{HOST}:{PORT} (db: {DB_PATH})", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
