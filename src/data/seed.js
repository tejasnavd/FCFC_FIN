// Seed data pulled from the Sep 2026 tab of the FCFC tabulation sheet.
// Swap the exports in this one file for a real fetch() to a backend/sheet API
// later — nothing else in the app needs to change.
//
// REAL (from the sheet, unchanged): the three SUFC fixtures and their
// sign-up names/order/capacity, upiId, roster.
//
// There's no separate "current user" record: whoever logs in is looked up in
// `roster` (one record per person), so wallet and league table can't disagree.
// SYNTHESIZED (plausible placeholders until the backend exists, marked
// below): Turf B / Turf C and their fixtures, guest sign-ups, the last
// played fixture, recentAttendance, extras, pendingPayments.

// groundFee = what the club pays the turf per game (synthesized).
export const turfs = [
  { id: "sufc",   name: "SUFC",   label: "SUFC turf", groundFee: 3000 },
  { id: "turf-b", name: "Turf B", label: "Turf B",    groundFee: 2500 },   // synthesized
  { id: "turf-c", name: "Turf C", label: "Turf C",    groundFee: 2800 },   // synthesized
];

// Default charge per player per game. Synthesized: matches the wallet's
// "₹750 is enough for about 3 more games".
export const PRICE_PER_HEAD = 250;

// synthesized: this month's money per turf, mirroring the sheet's layout
// (games played, ground fees paid, "FCFC - Snacks", cash collected).
export const monthLedger = {
  month: "September 2026",
  turfs: [
    { turf: "sufc",   gamesPlayed: 9, snacks: 1450, collected: 26250 },
    { turf: "turf-b", gamesPlayed: 2, snacks: 290,  collected: 5500 },
    { turf: "turf-c", gamesPlayed: 1, snacks: 0,    collected: 2250 },
  ],
};

// Guest fee charged to the member who brings them.
export const GUEST_FEE = 250;

// Sign-up queue helpers. `at` is queue order (when they tapped "I'm in").
// Priority (members before guests) is applied by the booking engine, not here.
const members = (names, from = 1) => names.map((name, i) => ({ name, kind: "member", at: from + i }));
const guest = (name, host, at) => ({ name, kind: "guest", host, at });

// Capacity = number of CNF (confirmed) places. Everyone beyond it is WL.
export const fixtures = [
  { id: "2026-09-26-sufc", wd: "SAT", num: 26, mo: "SEP", time: "7:00 AM", turf: "sufc",
    capacity: 18, status: "upcoming",
    signups: members(["Hemant","Rushil","Prasanth","Madhu","Sam","Sehaj","Harji","Shanks","Viraj","Pradhan","Lalit","Sunil","Suri"]) },
  { id: "2026-09-29-sufc", wd: "TUE", num: 29, mo: "SEP", time: "6:30 AM", turf: "sufc",
    capacity: 14, status: "upcoming",
    signups: members(["Saanand"]) },
  // synthesized: an oversubscribed game so both CNF and WL show.
  // Two guests signed up early but still queue behind every member.
  { id: "2026-09-30-turf-b", wd: "WED", num: 30, mo: "SEP", time: "6:30 AM", turf: "turf-b",
    capacity: 10, status: "upcoming",
    signups: [
      ...members(["Arjun","Sam","Lalit"], 1),
      guest("Rahul", "Arjun", 4),
      ...members(["Kushal","Viraj","Sehaj"], 5),
      guest("Nikhil", "Sam", 8),
      ...members(["Hemant","Madhu","Prasanth","Suri","Harji"], 9),
    ] },
  { id: "2026-10-01-sufc", wd: "THU", num: 1, mo: "OCT", time: "6:30 AM", turf: "sufc",
    capacity: 14, status: "upcoming",
    signups: members(["Arjun","Gautam","Gavin"]) },
  // synthesized
  { id: "2026-10-03-turf-c", wd: "SAT", num: 3, mo: "OCT", time: "7:00 AM", turf: "turf-c",
    capacity: 12, status: "upcoming",
    signups: [...members(["Shawn","Johnny","Bhaskar","Sudhir"]), guest("Karan", "Johnny", 5)] },
  // synthesized: the last played game, for the organiser's attendance marking.
  { id: "2026-09-24-turf-b", wd: "THU", num: 24, mo: "SEP", time: "6:30 AM", turf: "turf-b",
    capacity: 12, status: "played",
    signups: members(["Pradhan","Harji","Suri","Prasanth","Madhu","Sehaj","Viraj","Hemant","Sam","Lalit","Sunil","Arjun"]),
    attended: ["Pradhan","Harji","Suri","Prasanth","Madhu","Sehaj","Viraj","Hemant","Sam","Arjun"] },
];

// synthesized: dated wallet history per member, before this month. The
// wallet chart is drawn from the top-ups in here (one bar per payment), so
// it can't disagree with the history list. Amounts follow how the club pays:
// ~₹250 a game, sometimes ₹300-350 when covering a guest or rounding up.
// Tejas: 8 top-ups (₹2,250) - 6 August games (₹1,500) = ₹750, matching his
// roster balance carried into September.
export const walletHistory = {
  Tejas: [
    { date: "2026-07-06", t: "UPI top-up", amt: 250, kind: "topup" },
    { date: "2026-07-14", t: "UPI top-up", amt: 250, kind: "topup" },
    { date: "2026-07-23", t: "UPI top-up", amt: 300, kind: "topup" },
    { date: "2026-07-30", t: "UPI top-up", amt: 250, kind: "topup" },
    { date: "2026-08-06", t: "UPI top-up", amt: 250, kind: "topup" },
    { date: "2026-08-13", t: "UPI top-up", amt: 350, kind: "topup" },
    { date: "2026-08-20", t: "UPI top-up", amt: 250, kind: "topup" },
    { date: "2026-08-27", t: "UPI top-up", amt: 350, kind: "topup" },
    { date: "2026-08-31", t: "Games in August", d: "6 games at ₹250", amt: -1500, kind: "games" },
  ],
};

export const upiId = "fcfc-club@upi";

// [name, balance, gamesPlayed]
export const roster = [
  ["Deepu",-3440,0],["Rushil",-2000,0],["Dominic",-450,4],["Raj",-1200,0],["Balu",-650,0],
  ["Ajay",-625,0],["Gautam",-550,0],["Gavin",-100,0],["Bopana",0,0],["Peter",0,0],
  ["Saanand",50,3],["Pradhan",225,13],["Harji",275,9],["Ceejo",400,0],["Kodu",500,0],
  ["Ashwin",500,0],["Smaran",550,0],["Suri",630,9],["Akbar",650,0],["Tejas",750,0],
  ["Prasanth",800,9],["Madhu",1100,8],["Bhaskar",1320,3],["Amit",1400,0],["Sunil",1450,6],
  ["Jacob",1450,1],["Sehaj",1550,9],["Shanks",1675,0],["Sudhir",1750,4],["Hemant",2100,8],
  ["Johnny",2450,2],["Kuldeep",2475,0],["Yash",2500,0],["Viraj",2775,9],["Bala",2975,0],
  ["Lalit",3285,6],["Kushal",3400,2],["Sam",3695,6],["Shawn",4900,1],["Arjun",7775,5],
];

// synthesized: attendance at the club's last 5 fixtures, oldest -> newest
// (1 = played, 0 = didn't). Scaled to each player's `played` count this month:
// nobody with 0 games has a 1, regulars (9+) played 4-5 of the last 5.
export const recentAttendance = {
  Deepu: [0,0,0,0,0], Rushil: [0,0,0,0,0], Dominic: [1,0,1,0,0], Raj: [0,0,0,0,0],
  Balu: [0,0,0,0,0], Ajay: [0,0,0,0,0], Gautam: [0,0,0,0,0], Gavin: [0,0,0,0,0],
  Bopana: [0,0,0,0,0], Peter: [0,0,0,0,0], Saanand: [0,0,0,1,1], Pradhan: [1,1,1,1,1],
  Harji: [1,0,1,1,1], Ceejo: [0,0,0,0,0], Kodu: [0,0,0,0,0], Ashwin: [0,0,0,0,0],
  Smaran: [0,0,0,0,0], Suri: [1,0,1,1,1], Akbar: [0,0,0,0,0], Tejas: [0,0,0,0,0],
  Prasanth: [0,1,1,1,1], Madhu: [1,0,0,1,1], Bhaskar: [0,1,0,1,0], Amit: [0,0,0,0,0],
  Sunil: [1,1,0,0,1], Jacob: [0,0,0,1,0], Sehaj: [1,0,1,1,1], Shanks: [0,0,0,0,0],
  Sudhir: [0,0,1,1,0], Hemant: [1,0,1,0,1], Johnny: [0,0,1,0,0], Kuldeep: [0,0,0,0,0],
  Yash: [0,0,0,0,0], Viraj: [1,1,1,1,0], Bala: [0,0,0,0,0], Lalit: [1,1,0,1,0],
  Kushal: [0,0,1,0,0], Sam: [1,1,0,0,1], Shawn: [0,0,0,0,1], Arjun: [0,1,0,0,1],
};

// synthesized: shared post-game spend (the sheet's "FCFC - Snacks" line),
// split equally among everyone who played. Kept separate from wallets.
export const extras = {
  id: "extras-2026-09-24",
  title: "Chai and bananas",
  when: "After Thursday's game, 24 Sep",
  paidBy: "Hemant",
  items: [{ what: "Chai, 10 cups", amt: 200 }, { what: "Bananas", amt: 90 }],
  // Tejas added (unsettled) so the settle-from-wallet transfer can be demoed
  // as him; he isn't in that game's attendance, so this is demo data.
  splitAmong: ["Pradhan","Harji","Suri","Prasanth","Madhu","Sehaj","Viraj","Hemant","Sam","Arjun","Tejas"],
  settled: ["Pradhan","Sam","Viraj"],
};

// synthesized: UPI top-ups members said they've made, awaiting the
// organiser's check against the bank statement.
export const pendingPayments = [
  { id: "pay-deepu-0929", name: "Deepu", amt: 2000, when: "29 Sep, 6:12 AM", at: "2026-09-29T06:12:00" },
  { id: "pay-raj-0928", name: "Raj", amt: 1200, when: "28 Sep, 9:40 PM", at: "2026-09-28T21:40:00" },
];
