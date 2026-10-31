// Bill workflow tracker: zero-dependency Node.js (22+) server with built-in SQLite.
// Run: node server.js   then open http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'shop.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// ---------- schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'startend',      -- 'startend' or 'single'
  stage_order INTEGER                          -- position in the bill workflow, NULL = not a bill stage
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  tasks TEXT NOT NULL DEFAULT '',             -- comma separated task codes this user can do
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_no TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER REFERENCES bills(id) ON DELETE CASCADE,  -- NULL for general (non-bill) work
  task_code TEXT NOT NULL REFERENCES tasks(code),
  start_at TEXT, start_by INTEGER REFERENCES users(id),
  end_at TEXT,   end_by INTEGER REFERENCES users(id),
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_entry_per_bill_stage ON entries(bill_id, task_code) WHERE bill_id IS NOT NULL;
`);

// ---------- seed ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

if (!db.prepare('SELECT 1 FROM tasks LIMIT 1').get()) {
  const tasks = [
    ['A', '1st Floor'], ['B', '3rd Floor'], ['C', 'Basement Cleaning'], ['D', 'Basement Setting'],
    ['E', 'Bill Distribution'], ['F', 'Expiry Preparations'], ['G', 'Floor Maintenance'],
    ['H', 'Local Poly Distribution'], ['I', 'Polythene Packing'], ['J', 'Purchased Goods Setting'],
    ['K', 'Rack Checking'], ['L', 'Rack Setting'], ['M', 'Sale Goods Check'], ['N', 'Sorting Short Items'],
    ['O', 'Syrup Cases'], ['P', 'Transport Check'], ['Q', 'Tube Rack Setting'],
    ['R', 'Preparing Sale Items'], ['S', 'Checking Sale Items'], ['FR', 'Final Ready'],
  ];
  const stage = { R: [1, 'startend'], S: [2, 'startend'], I: [3, 'single'], FR: [4, 'single'] };
  const ins = db.prepare('INSERT INTO tasks (code, name, kind, stage_order) VALUES (?, ?, ?, ?)');
  for (const [code, name] of tasks) {
    const [order, kind] = stage[code] || [null, 'startend'];
    ins.run(code, name, kind, order);
  }
}
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO users (username, name, pass_hash, is_admin, tasks) VALUES (?, ?, ?, ?, ?)');
  ins.run('admin', 'Owner', hashPassword('admin123'), 1, '');
  ins.run('adnan', 'Adnan', hashPassword('1234'), 0, 'R');
  ins.run('junaid', 'Junaid', hashPassword('1234'), 0, 'S');
  ins.run('faraz', 'Faraz', hashPassword('1234'), 0, 'S');
  ins.run('irfan', 'Irfan', hashPassword('1234'), 0, 'I');
  ins.run('operator', 'Computer Operator', hashPassword('1234'), 0, 'FR');
}

// ---------- one-time data changes (each runs once per database) ----------
db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
function migrate(name, fn) {
  if (db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) return;
  db.exec('BEGIN');
  try { fn(); db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString()); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Replace the starter staff with the shop's real staff list (password 1234). Owner logins are untouched.
migrate('2026-10-24-staff-list', () => {
  const staff = ['AFZAL', 'BHAKTI', 'DIYA', 'MANSI', 'NEHA', 'POOJA', 'RIYA', 'RIZWAN', 'SIYA', 'SHEBI', 'SUMAN', 'YASH',
    'ARUN', 'ANAS', 'AZEEM', 'ABHAY', 'FARAZ', 'HAMZA', 'JUNAID', 'REHAN', 'SAFFAN', 'SUFIYAN', 'ZUHAIB', 'OWAIS', 'NAVED',
    'ADNAN', 'RAJ', 'SAIF', 'FARHAN', 'HAYYUL', 'MUKUL', 'SONU', 'DORI', 'HIMANSHU', 'IRFAN', 'ROCKY', 'TALHA', 'VICKY'];
  const stageFor = { ADNAN: 'R', JUNAID: 'S', FARAZ: 'S', IRFAN: 'I' };
  const keep = new Set(staff.map((s) => s.toLowerCase()));
  const used = db.prepare(`SELECT 1 FROM bills WHERE created_by = ?1 UNION SELECT 1 FROM entries WHERE start_by = ?1 OR end_by = ?1`);
  for (const u of db.prepare('SELECT * FROM users WHERE is_admin = 0').all()) {
    if (keep.has(u.username)) continue;
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    // Users with recorded work stay in history but can no longer log in.
    if (used.get(u.id)) db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(u.id);
    else db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  }
  for (const name of staff) {
    const username = name.toLowerCase();
    const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existing) {
      db.prepare('UPDATE users SET name = ?, pass_hash = ?, active = 1 WHERE id = ?').run(name, hashPassword('1234'), existing.id);
    } else {
      db.prepare('INSERT INTO users (username, name, pass_hash, is_admin, tasks) VALUES (?, ?, ?, 0, ?)')
        .run(username, name, hashPassword('1234'), stageFor[name] || '');
    }
  }
});
// Computer operators get the Final Ready (FR) button.
migrate('2026-10-24-computer-operators', () => {
  const operators = ['afzal', 'bhakti', 'diya', 'mansi', 'neha', 'pooja', 'riya', 'rizwan', 'siya', 'shebi', 'suman', 'yash'];
  for (const username of operators) {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!u) continue;
    const tasks = u.tasks.split(',').map((s) => s.trim()).filter(Boolean);
    if (!tasks.includes('FR')) db.prepare('UPDATE users SET tasks = ? WHERE id = ?').run([...tasks, 'FR'].join(','), u.id);
  }
});
// New work-task list A-T. R, S and I now mean general work, so the bill steps move to their own codes:
// R Preparing Sale Items -> PR, S Checking Sale Items -> CH, I Polythene Packing (bill step) -> PK.
migrate('2026-10-24-work-codes-a-t', () => {
  const moves = { R: 'PR', S: 'CH', I: 'PK' };
  for (const [from, to] of Object.entries(moves)) {
    const t = db.prepare('SELECT * FROM tasks WHERE code = ?').get(from);
    if (!t || t.stage_order == null) continue;
    db.prepare('INSERT INTO tasks (code, name, kind, stage_order) VALUES (?, ?, ?, ?)').run(to, t.name, t.kind, t.stage_order);
    db.prepare('UPDATE tasks SET stage_order = NULL, kind = ? WHERE code = ?').run('startend', from);
    db.prepare('UPDATE entries SET task_code = ? WHERE task_code = ? AND bill_id IS NOT NULL').run(to, from);
    for (const u of db.prepare('SELECT id, tasks FROM users').all()) {
      const list = u.tasks.split(',').map((x) => x.trim()).filter(Boolean);
      if (list.includes(from)) db.prepare('UPDATE users SET tasks = ? WHERE id = ?').run(list.map((x) => (x === from ? to : x)).join(','), u.id);
    }
  }
  const work = [['A', '1st Floor'], ['B', '3rd Floor'], ['C', 'Basement Cleaning'], ['D', 'Basement Setting'],
    ['E', 'Bill Distribution'], ['F', 'Expiry Preparations'], ['G', 'Floor Maintenance'], ['H', 'Local Poly Distribution'],
    ['I', 'Polythene Packing'], ['J', 'Purchased Goods Setting'], ['K', 'Rack Checking'], ['L', 'Rack Setting'],
    ['M', 'Sale Goods Check'], ['N', 'Sorting Short Items'], ['O', 'Syrup Cases'], ['P', 'Transport Check'],
    ['Q', 'Tube Rack Setting'], ['R', 'Sitting Idle'], ['S', 'Ground Floor Cleaning'], ['T', 'Break']];
  for (const [code, name] of work) {
    db.prepare(`INSERT INTO tasks (code, name, kind) VALUES (?, ?, 'startend')
      ON CONFLICT(code) DO UPDATE SET name = excluded.name`).run(code, name);
  }
});
// Managers review everyone's punches and can ask a person to fix one.
migrate('2026-10-24-managers-and-fix-requests', () => {
  db.exec(`ALTER TABLE users ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE fix_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
    what TEXT NOT NULL,                       -- e.g. "Bill T050810 · CH Checking Sale Items"
    employee_id INTEGER NOT NULL REFERENCES users(id),
    message TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
    reply TEXT, resolved_by INTEGER REFERENCES users(id), resolved_at TEXT
  );`);
  db.prepare("UPDATE users SET is_manager = 1 WHERE username = 'arun'").run();
});
// Everyone except computer operators, HIMANSHU, ROCKY, IRFAN and TALHA can prepare and check bills.
migrate('2026-10-24-pr-ch-for-all-staff', () => {
  const skip = new Set(['afzal', 'bhakti', 'diya', 'mansi', 'neha', 'pooja', 'riya', 'rizwan', 'siya', 'shebi', 'suman', 'yash',
    'himanshu', 'rocky', 'irfan', 'talha']);
  for (const u of db.prepare('SELECT id, username, tasks FROM users WHERE is_admin = 0 AND active = 1').all()) {
    if (skip.has(u.username)) continue;
    const list = u.tasks.split(',').map((x) => x.trim()).filter(Boolean);
    for (const code of ['PR', 'CH']) if (!list.includes(code)) list.push(code);
    db.prepare('UPDATE users SET tasks = ? WHERE id = ?').run(list.join(','), u.id);
  }
});
migrate('2026-10-24-add-rayyan', () => {
  if (!db.prepare("SELECT 1 FROM users WHERE username = 'rayyan'").get()) {
    db.prepare("INSERT INTO users (username, name, pass_hash, is_admin, tasks) VALUES ('rayyan', 'RAYYAN', ?, 0, 'PR,CH')").run(hashPassword('1234'));
  }
});
// Second owner login. Only the password hash is stored here; the password was shared privately.
migrate('2026-10-24-add-admin-ajanta', () => {
  if (!db.prepare("SELECT 1 FROM users WHERE username = 'ajanta'").get()) {
    db.prepare("INSERT INTO users (username, name, pass_hash, is_admin, tasks) VALUES ('ajanta', 'AJANTA', ?, 1, '')")
      .run('9f6672ea70906e7c44ed25adbcb85981:b0c3ef5d65b1cff8bbcc6e45133d55bf70055d9ee53c3ae8e60fb6ccaaa3115927addeb9e0208b4dcea8db16761aa0176bc96c3899287c319bf9fe53c263a6f4');
  }
});
// Some work tasks record a count when they end (L racks, O syrup cases); managers verify those.
migrate('2026-10-24-task-counts-and-verify', () => {
  db.exec(`ALTER TABLE tasks ADD COLUMN count_label TEXT;
    ALTER TABLE entries ADD COLUMN qty INTEGER;
    ALTER TABLE entries ADD COLUMN verified_by INTEGER REFERENCES users(id);
    ALTER TABLE entries ADD COLUMN verified_at TEXT;`);
  db.prepare("UPDATE tasks SET count_label = 'racks' WHERE code = 'L'").run();
  db.prepare("UPDATE tasks SET count_label = 'syrup cases' WHERE code = 'O'").run();
});
// Remember when each person last opened the app, for the Staff Status page.
migrate('2026-10-25-last-seen', () => {
  db.exec('ALTER TABLE users ADD COLUMN last_seen TEXT');
});
migrate('2026-10-24-work-code-u-supply', () => {
  db.prepare(`INSERT INTO tasks (code, name, kind) VALUES ('U', 'Supply', 'startend') ON CONFLICT(code) DO UPDATE SET name = excluded.name`).run();
});
migrate('2026-10-25-basement-setting-racks', () => {
  db.prepare("UPDATE tasks SET count_label = 'racks' WHERE code = 'D'").run();
});
// users.blocked: work-task codes a person may not start (e.g. OWAIS cannot do I Polythene Packing, which also keeps him off the packing list).
migrate('2026-10-25-owais-no-checking-packing', () => {
  db.exec("ALTER TABLE users ADD COLUMN blocked TEXT NOT NULL DEFAULT ''");
  const o = db.prepare("SELECT id, tasks FROM users WHERE username = 'owais'").get();
  if (o) db.prepare("UPDATE users SET tasks = ?, blocked = 'I' WHERE id = ?").run(o.tasks.split(',').filter((c) => c && c !== 'CH' && c !== 'PK').join(','), o.id);
});
// Number of items on each bill, typed with the bill no. when Preparing starts.
migrate('2026-10-25-bill-items', () => {
  db.exec('ALTER TABLE bills ADD COLUMN items INTEGER');
});
// Owners, MANSI and AFZAL can enter work for an employee who forgot their phone; entries.entered_by records who pressed it.
migrate('2026-10-25-enter-for-staff', () => {
  db.exec('ALTER TABLE users ADD COLUMN can_proxy INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE entries ADD COLUMN entered_by INTEGER REFERENCES users(id)');
  db.prepare("UPDATE users SET can_proxy = 1 WHERE is_admin = 1 OR username IN ('mansi', 'afzal')").run();
});
// The owner tapped work tiles on their own Work screen by mistake; remove those (user asked 2026-10-25).
migrate('2026-10-25-remove-owner-work-tasks', () => {
  db.prepare("DELETE FROM entries WHERE bill_id IS NULL AND start_by = (SELECT id FROM users WHERE username = 'admin')").run();
});
// Two people often check a bill together: the second checker joins the running check (entries.partner_by).
migrate('2026-10-25-check-partner', () => {
  db.exec('ALTER TABLE entries ADD COLUMN partner_by INTEGER REFERENCES users(id)');
});
migrate('2026-10-25-neha-like-mansi', () => {
  db.prepare("UPDATE users SET can_proxy = 1 WHERE username = 'neha'").run();
});
migrate('2026-10-25-riya-like-mansi', () => {
  db.prepare("UPDATE users SET can_proxy = 1, tasks = (SELECT tasks FROM users WHERE username = 'mansi') WHERE username = 'riya'").run();
});
// "All done" button: finishes every remaining step of a bill at once (owners, VICKY, AFZAL, MANSI, NEHA).
migrate('2026-10-25-all-done', () => {
  db.exec('ALTER TABLE users ADD COLUMN can_alldone INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE users SET can_alldone = 1 WHERE is_admin = 1 OR username IN ('vicky', 'afzal', 'mansi', 'neha')").run();
});
// Only some jobs need verifying (D, H, L, O, Q); VICKY may verify H Local Poly Distribution (users.verify_codes).
migrate('2026-10-26-verify-only-some-jobs', () => {
  db.exec('ALTER TABLE tasks ADD COLUMN needs_verify INTEGER NOT NULL DEFAULT 0');
  db.exec("ALTER TABLE users ADD COLUMN verify_codes TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE tasks SET needs_verify = 1 WHERE code IN ('D', 'H', 'L', 'O', 'Q')").run();
  db.prepare("UPDATE users SET verify_codes = 'H' WHERE username = 'vicky'").run();
});
// YASH also checks sale items (CH), besides Final Ready.
migrate('2026-10-26-yash-checking', () => {
  const y = db.prepare("SELECT id, tasks FROM users WHERE username = 'yash'").get();
  if (y && !y.tasks.split(',').includes('CH')) db.prepare('UPDATE users SET tasks = ? WHERE id = ?').run([...y.tasks.split(',').filter(Boolean), 'CH'].join(','), y.id);
});

// Owner, 2026-10-28: every employee may do Checking (sale goods check).
migrate('2026-10-28-everyone-checking', () => {
  for (const u of db.prepare('SELECT id, tasks FROM users WHERE is_admin = 0').all()) {
    const t = (u.tasks || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!t.includes('CH')) db.prepare('UPDATE users SET tasks = ? WHERE id = ?').run([...t, 'CH'].join(','), u.id);
  }
});

// Owner, 2026-10-28: SUMAN, SIYA and new login PRIYANSHI SHARMA get the same rights as RIYA.
migrate('2026-10-28-like-riya', () => {
  if (!db.prepare("SELECT 1 FROM users WHERE username LIKE 'priyanshi%' OR upper(name) LIKE 'PRIYANSHI%'").get())
    db.prepare("INSERT INTO users (username, name, pass_hash, is_admin, tasks) VALUES ('priyanshi', 'PRIYANSHI SHARMA', ?, 0, '')").run(hashPassword('1234'));
  db.prepare(`UPDATE users SET (tasks, can_proxy, can_alldone, is_manager, blocked, verify_codes) =
    (SELECT tasks, can_proxy, can_alldone, is_manager, blocked, verify_codes FROM users WHERE username = 'riya'), active = 1
    WHERE username IN ('suman', 'siya') OR username LIKE 'priyanshi%' OR upper(name) LIKE 'PRIYANSHI%'`).run();
});

// Owner, 2026-10-28: OWAIS has left. Login switched off and removed from every list; his past work stays in the records.
migrate('2026-10-28-owais-left', () => {
  const o = db.prepare("SELECT id FROM users WHERE username = 'owais'").get();
  if (!o) return;
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(o.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(o.id);
});

// Owner, 2026-10-28: checkers give each bill 1-20 points in Checking.
migrate('2026-10-28-check-points', () => { db.exec('ALTER TABLE entries ADD COLUMN points INTEGER'); });

// Owner, 2026-10-30: FARAZ gets the simple mobile Preparing Entry (start/end Preparing for the sale items team), nothing else.
migrate('2026-10-30-faraz-prep-entry', () => {
  db.exec('ALTER TABLE users ADD COLUMN can_prep INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE users SET can_prep = 1 WHERE username = 'faraz'").run();
});

// Owner, 2026-10-30: IRFAN gets the same simple Preparing Entry as FARAZ.
migrate('2026-10-30-irfan-prep-entry', () => { db.prepare("UPDATE users SET can_prep = 1 WHERE username = 'irfan'").run(); });

// Debtors section (owners): one snapshot of the debtors list per day, uploaded from the owner's Debtors.xls (one sheet per day).
migrate('2026-10-30-debtors', () => {
  db.exec(`CREATE TABLE debtor_days (date TEXT PRIMARY KEY, total REAL NOT NULL, accounts INTEGER NOT NULL, due INTEGER NOT NULL DEFAULT 0,
      file_name TEXT, uploaded_at TEXT NOT NULL, uploaded_by INTEGER REFERENCES users(id));
    CREATE TABLE debtor_rows (date TEXT NOT NULL, party TEXT NOT NULL, area TEXT NOT NULL DEFAULT '', grp TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL, due INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX debtor_rows_date ON debtor_rows(date, amount);`);
});

// Daily incentive email: which days were already mailed.
migrate('2026-10-30-incentive-mail', () => { db.exec('CREATE TABLE incentive_mail (date TEXT PRIMARY KEY, sent_at TEXT NOT NULL, recipients TEXT)'); });

// Departments (owner's list, 2026-10-30), used to filter the Daily Report.
migrate('2026-10-30-departments', () => {
  db.exec("ALTER TABLE users ADD COLUMN dept TEXT NOT NULL DEFAULT ''");
  const set = db.prepare('UPDATE users SET dept = ? WHERE upper(name) = ? OR upper(name) LIKE ?');
  const list = { Computer: ['AFZAL', 'BHAKTI', 'DIYA', 'MANSI', 'NEHA', 'POOJA', 'RIYA', 'RIZWAN', 'SIYA', 'SHEBI', 'SUMAN', 'YASH', 'PRIYANSHI'],
    Manager: ['ARUN', 'VICKY'], Operations: ['ANAS', 'AZEEM', 'ABHAY', 'FARAZ', 'HAMZA', 'JUNAID', 'REHAN', 'SAFFAN', 'SUFIYAN', 'ZUHAIB', 'NAVED', 'ADNAN', 'RAJ'],
    Setting: ['SAIF', 'FARHAN', 'HAYYUL', 'MUKUL', 'SONU'], Supply: ['DORI', 'HIMANSHU', 'IRFAN', 'ROCKY', 'TALHA'] };
  for (const [d, names] of Object.entries(list)) for (const n of names) set.run(d, n, n + ' %');
});

migrate('2026-10-30-rayyan-operations', () => { db.prepare("UPDATE users SET dept = 'Operations' WHERE username = 'rayyan'").run(); });

// Syrup cases (O): the person types each case name and the rack it went on (owner, 2026-10-30).
migrate('2026-10-30-syrup-cases', () => {
  db.exec(`CREATE TABLE syrup_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    case_name TEXT NOT NULL, rack_no TEXT NOT NULL, at TEXT NOT NULL, by INTEGER REFERENCES users(id));
    CREATE INDEX syrup_cases_entry ON syrup_cases(entry_id);`);
});

// Rack Setting (L): the person types each rack number they set (owner, 2026-10-30).
migrate('2026-10-30-rack-numbers', () => {
  db.exec(`CREATE TABLE rack_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    rack_no TEXT NOT NULL, at TEXT NOT NULL, by INTEGER REFERENCES users(id));
    CREATE INDEX rack_sets_entry ON rack_sets(entry_id);`);
});

// Arun / owners verify each rack, tube rack and syrup case one by one (owner, 2026-10-30).
migrate('2026-10-30-item-verify', () => {
  db.exec(`ALTER TABLE rack_sets ADD COLUMN verified_by INTEGER REFERENCES users(id); ALTER TABLE rack_sets ADD COLUMN verified_at TEXT;
    ALTER TABLE syrup_cases ADD COLUMN verified_by INTEGER REFERENCES users(id); ALTER TABLE syrup_cases ADD COLUMN verified_at TEXT;`);
});

// Attendance (owner, 2026-10-30): PagarBook punches uploaded by owners or MANSI, one row per day, plus leave approvals.
// Approvals belong to one revision of a day: uploading that day again needs fresh approval.
migrate('2026-10-30-attendance', () => {
  db.exec(`CREATE TABLE attendance_days (date TEXT PRIMARY KEY, rows TEXT NOT NULL, source TEXT, revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id));
    CREATE TABLE attendance_approvals (date TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, day_revision INTEGER NOT NULL,
      at TEXT NOT NULL, by INTEGER REFERENCES users(id), PRIMARY KEY (date, name));`);
});

// Approved lates (owner, 2026-10-30): an approved late is not counted anywhere (no late, no fine, no late half day).
migrate('2026-10-30-attendance-late-ok', () => {
  db.exec(`CREATE TABLE attendance_late_ok (date TEXT NOT NULL, name TEXT NOT NULL, at TEXT NOT NULL, by INTEGER REFERENCES users(id), PRIMARY KEY (date, name));`);
});

// Late decisions: approved (not counted) or rejected (Not approved: counted as normal, but marked as checked).
migrate('2026-10-30-attendance-late-status', () => {
  db.exec("ALTER TABLE attendance_late_ok ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
});

// Half day decisions (owner, 2026-10-30): approved (not counted as a half day) or rejected (Not approved: counted as normal).
migrate('2026-10-30-attendance-half-ok', () => {
  db.exec(`CREATE TABLE attendance_half_ok (date TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, by INTEGER REFERENCES users(id), PRIMARY KEY (date, name));`);
});

// Shop Open/Close (owner, 2026-10-30; moved from the ChatGPT Speed Desk): two names open the shop and two close it each day.
// data = { opening: { names: [a, b], at, by }, closing: {...} }. Days 1-11 Oct 2026 come from the owner's old "Opening Closing.xlsx".
migrate('2026-10-30-shop-open-close', () => {
  db.exec(`CREATE TABLE shop_open_close (date TEXT PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL, updated_by INTEGER REFERENCES users(id));`);
  const old = [['2026-10-01', 'SUFIYAN', 'AZEEM', 'HAYYUL', 'SONU'], ['2026-10-02', 'ANAS', 'SUFIYAN', 'JUNAID', 'SONU'], ['2026-10-03', 'SUFIYAN', 'AZEEM', 'HAYYUL', 'SONU'],
    ['2026-10-04', 'YASH', 'AZEEM', '', ''], ['2026-10-05', 'HAMZA', 'YASH', '', ''], ['2026-10-07', 'ABHAY', 'ZUHAIB', 'SONU', 'MUKUL'], ['2026-10-08', 'SAFFAN', 'ABHAY', 'MUKUL', 'SONU'],
    ['2026-10-09', 'ABHAY', 'HAMZA', 'FARHAN', 'SONU'], ['2026-10-10', 'HAMZA', 'SAFFAN', 'RIZWAN', 'SONU'], ['2026-10-11', 'SAFFAN', 'SAIF', '', '']];
  const t = new Date().toISOString(), ins = db.prepare('INSERT INTO shop_open_close (date, data, revision, updated_at) VALUES (?, ?, 1, ?)');
  for (const [d, o1, o2, c1, c2] of old) {
    const data = { opening: { names: [o1, o2], at: null, by: 'Old Excel sheet' } };
    if (c1) data.closing = { names: [c1, c2], at: null, by: 'Old Excel sheet' };
    ins.run(d, JSON.stringify(data), t);
  }
});
const SHOP_START = '2026-10-01';
// Not part of shop opening/closing (owner, 2026-10-31): managers, the girls and the supply team. They get no push buttons,
// cannot be entered as names, and are not counted for the Rs 500 penalty. (PRIYANSHI SHARMA is the same person as SIYA.)
const SHOP_EXCLUDE = ['ARUN', 'VICKY', 'BHAKTI', 'DIYA', 'MANSI', 'NEHA', 'POOJA', 'RIYA', 'SHEBI', 'SIYA', 'SUMAN', 'PRIYANSHI', 'PRIYANSHI SHARMA',
  'DORI', 'HIMANSHU', 'IRFAN', 'ROCKY', 'TALHA'];
// How many times this person opened or closed this month: saved names plus their own pushes still waiting for Verify.
const SHOP_MIN = 5;
function shopMonthCount(u, today) {
  const me = String(u.name || '').trim().replace(/\s+/g, ' ').toUpperCase(), month = today.slice(0, 7);
  let n = 0;
  for (const r of db.prepare('SELECT data FROM shop_open_close WHERE date LIKE ?').all(month + '-%')) {
    const d = JSON.parse(r.data);
    for (const ph of ['opening', 'closing']) n += ((d[ph] || {}).names || []).filter((x) => x === me).length;
  }
  return n + db.prepare('SELECT COUNT(*) AS c FROM shop_punch WHERE user_id = ? AND date LIKE ? AND verified_at IS NULL').get(u.id, month + '-%').c;
}
const shopExcluded = (name) => SHOP_EXCLUDE.includes(String(name || '').trim().replace(/\s+/g, ' ').toUpperCase());
// Staff push "I opened / I closed the shop" from their own login (owner, 2026-10-31). At most 2 per phase per day.
// A push only counts after the owner or MANSI presses Verify: the names are then saved in shop_open_close.
migrate('2026-10-31-shop-punch', () => {
  db.exec(`CREATE TABLE shop_punch (date TEXT NOT NULL, phase TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL,
    at TEXT NOT NULL, verified_at TEXT, verified_by INTEGER REFERENCES users(id), PRIMARY KEY (date, phase, user_id));`);
});
const SHOP_PHASE = { opening: 'Opening', closing: 'Closing' };
const shopPunches = (where, ...args) => db.prepare(`SELECT p.date, p.phase, p.user_id, p.name, p.at, p.verified_at, v.name AS verified_by FROM shop_punch p
  LEFT JOIN users v ON v.id = p.verified_by WHERE ${where} ORDER BY p.date, p.phase, p.at`).all(...args);
// Saves the names of one phase for one day (manual entry or Verify), and marks that phase's pushes as verified.
function saveShopPhase(date, phase, names, u, extra = {}) {
  const old = db.prepare('SELECT * FROM shop_open_close WHERE date = ?').get(date), t = now(), data = old ? JSON.parse(old.data) : {};
  data[phase] = { names, at: t, by: u.name, ...extra };
  if (old) db.prepare('UPDATE shop_open_close SET data = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE date = ?').run(JSON.stringify(data), t, u.id, date);
  else db.prepare('INSERT INTO shop_open_close (date, data, revision, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)').run(date, JSON.stringify(data), t, u.id);
  db.prepare('UPDATE shop_punch SET verified_at = ?, verified_by = ? WHERE date = ? AND phase = ? AND verified_at IS NULL').run(t, u.id, date, phase);
}

// Owner, 2026-10-31: PRIYANSHI SHARMA and SIYA are the same person; she uses SIYA on this site (Priyanshi Sharma only in PagarBook).
// Everything recorded under the PRIYANSHI SHARMA login moves to SIYA, and that login is switched off.
migrate('2026-10-31-priyanshi-is-siya', () => {
  const from = db.prepare("SELECT id FROM users WHERE username LIKE 'priyanshi%' OR upper(name) LIKE 'PRIYANSHI%'").get();
  const to = db.prepare("SELECT id FROM users WHERE username = 'siya'").get();
  if (!from || !to || from.id === to.id) return;
  for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('users', 'sessions')").all()) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
      if (fk.table !== 'users') continue;
      db.prepare(`UPDATE OR IGNORE ${table} SET ${fk.from} = ? WHERE ${fk.from} = ?`).run(to.id, from.id);
      db.prepare(`DELETE FROM ${table} WHERE ${fk.from} = ?`).run(from.id); // only rows that would have been duplicates
    }
  }
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(from.id);
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(from.id);
});

// ---------- attendance ----------
// Same roster and PagarBook name matching as the Attendance tab (public/index.html, ATT_*). Rules start 20 Oct 2026.
const ATT_START = '2026-10-20';
const ATT_ALIASES = { 'NEHA SHARMA': 'NEHA', 'MANSI SHARMA': 'MANSI', 'PRIYANSHI': 'DIYA', 'PRIYANSHI SHARMA': 'SIYA', 'HIMANSHU SHARMA': 'HIMANSHU',
  'MUKUL KUMAR': 'MUKUL', 'REHAN ALI': 'REHAN', 'RIZWAN MALIK': 'RIZWAN' };
const ATT_NAMES = ['AZEEM', 'ABHAY', 'HAMZA', 'SAFFAN', 'SUFIYAN', 'OWAIS', 'NAVED', 'ADNAN', 'RAJ', 'ANAS', 'FARAZ', 'JUNAID', 'REHAN', 'ZUHAIB', 'SAIF',
  'ARUN', 'FARHAN', 'HAYYUL', 'MUKUL', 'SONU', 'VICKY', 'BHAKTI', 'DIYA', 'MANSI', 'NEHA', 'POOJA', 'RIYA', 'SIYA', 'SHEBI', 'SUMAN', 'AFZAL', 'RIZWAN', 'YASH',
  'HIMANSHU', 'IRFAN', 'ROCKY', 'TALHA'];
const ATT_FROM = { ADNAN: '2026-10-24', RAJ: '2026-10-24' };
const ATT_LEFT = { OWAIS: '2026-10-20' }; // left: never marked on leave, counted only on days he punched
const attName = (v) => { const n = String(v || '').trim().replace(/\s+/g, ' ').toUpperCase(); return ATT_ALIASES[n] || n; };
const attHasPunch = (s) => String(s || '').split(';').some((t) => /^([01]?\d|2[0-3]):[0-5]\d/.test(t.trim()));
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const canAttendance = (u) => !!(u.is_admin || u.username === 'mansi');
function attendanceData() {
  const days = db.prepare('SELECT d.*, x.name AS by_name FROM attendance_days d LEFT JOIN users x ON x.id = d.updated_by ORDER BY date').all();
  const out = { dates: {}, revisions: {}, uploads: [], approvals: [], today: istToday() };
  for (const d of days) {
    out.dates[d.date] = JSON.parse(d.rows); out.revisions[d.date] = d.revision;
    out.uploads.push({ date: d.date, source: d.source, revision: d.revision, updatedAt: d.updated_at, updatedBy: d.by_name || '' });
  }
  out.approvals = db.prepare('SELECT a.date, a.name, a.status, a.day_revision AS dayRevision, a.at, x.name AS by FROM attendance_approvals a LEFT JOIN users x ON x.id = a.by').all();
  out.lateOk = db.prepare('SELECT l.date, l.name, l.status, l.at, x.name AS by FROM attendance_late_ok l LEFT JOIN users x ON x.id = l.by').all();
  out.halfOk = db.prepare('SELECT l.date, l.name, l.status, l.at, x.name AS by FROM attendance_half_ok l LEFT JOIN users x ON x.id = l.by').all();
  return out;
}

// Saves (or with no status, removes) an approved / not approved choice for one person's late or half day on one day.
async function attDecision(req, res, u, table) {
  if (!canAttendance(u)) fail(403, 'Attendance is only for the owner and Mansi');
  const { date, name, status } = await readBody(req);
  if (status && !['approved', 'rejected'].includes(status)) fail(400, 'Choose approved or not approved');
  const day = db.prepare('SELECT * FROM attendance_days WHERE date = ?').get(String(date || ''));
  if (!day) fail(404, 'No attendance saved for this day');
  const n = attName(name);
  if (!ATT_NAMES.includes(n) || !JSON.parse(day.rows).some((r) => attName(r.name) === n && attHasPunch(r.stamps))) fail(400, `${n} has no punch that day`);
  if (status) db.prepare(`INSERT OR REPLACE INTO ${table} (date, name, status, at, by) VALUES (?, ?, ?, ?, ?)`).run(day.date, n, status, now(), u.id);
  else db.prepare(`DELETE FROM ${table} WHERE date = ? AND name = ?`).run(day.date, n);
  send(res, 200, { ok: true });
}

// SONU verifies racks, tube racks and syrup cases like ARUN (owner, 2026-10-31).
migrate('2026-10-31-sonu-verify-items', () => {
  db.exec('ALTER TABLE users ADD COLUMN can_verify_items INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE users SET can_verify_items = 1 WHERE username IN ('sonu', 'arun')").run();
});

// ---------- helpers ----------
// Adds .cases (syrup case name + rack) to work rows of the Syrup cases task.
function withCases(rows) {
  withRacks(rows);
  const ids = rows.filter((r) => r.task_code === 'O').map((r) => r.id);
  if (!ids.length) return rows;
  const by = {};
  for (const c of db.prepare(`SELECT c.id, c.entry_id, c.case_name, c.rack_no, c.at, c.verified_at, v.name AS verified_by_name FROM syrup_cases c LEFT JOIN users v ON v.id = c.verified_by WHERE c.entry_id IN (${ids.map(() => '?').join(',')}) ORDER BY CAST(c.rack_no AS INTEGER), c.rack_no, c.id`).all(...ids)) (by[c.entry_id] ||= []).push(c);
  for (const r of rows) if (r.task_code === 'O') r.cases = by[r.id] || [];
  return rows;
}
// Adds .racks (rack numbers, lowest first) to work rows of the Rack Setting task.
const RACK_TASKS = ['L', 'Q']; // Rack Setting, Tube rack setting
const rackList = (entryId) => db.prepare('SELECT r.id, r.rack_no, r.verified_at, v.name AS verified_by_name FROM rack_sets r LEFT JOIN users v ON v.id = r.verified_by WHERE r.entry_id = ? ORDER BY CAST(r.rack_no AS INTEGER), r.rack_no').all(entryId);
function withRacks(rows) {
  for (const r of rows) if (RACK_TASKS.includes(r.task_code)) r.racks = rackList(r.id);
  return rows;
}
// Incentive per IST day between from and to (see GET /api/incentive for the rules).
function incentiveDays(from, to) {
  const [pr, ch] = [stages()[0].code, stages()[1].code];
  const istDay = (iso) => new Date(Date.parse(iso) + 330 * 60000).toISOString().slice(0, 10);
  const prep = db.prepare(`SELECT us.name, e.start_at, e.end_at, b.bill_no, b.items, c.points FROM entries e JOIN bills b ON b.id = e.bill_id JOIN users us ON us.id = e.start_by
    LEFT JOIN entries c ON c.bill_id = e.bill_id AND c.task_code = ?
    WHERE e.task_code = ? AND e.start_at IS NOT NULL AND e.end_at IS NOT NULL AND (e.note IS NULL OR e.note != 'All done') AND e.start_at >= ? AND e.start_at < ?
    ORDER BY us.name, e.start_at`).all(ch, pr, from, to);
  const checks = db.prepare(`SELECT su.name, pu.name AS partner, e.start_at, b.items FROM entries e JOIN bills b ON b.id = e.bill_id JOIN users su ON su.id = e.start_by
    LEFT JOIN users pu ON pu.id = e.partner_by
    WHERE e.task_code = ? AND e.start_at IS NOT NULL AND e.end_at IS NOT NULL AND (e.note IS NULL OR e.note != 'All done') AND e.start_at >= ? AND e.start_at < ?`).all(ch, from, to);
  const days = {};
  const day = (d) => (days[d] ||= { date: d, preppers: {}, checkers: {}, checked: 0 });
  for (const r of prep) {
    const p = (day(istDay(r.start_at)).preppers[r.name] ||= { name: r.name, items: 0, points: 0, bills: [], batches: [] });
    p.items += r.items || 0; p.points += r.points || 0;
    const bill = { bill_no: r.bill_no, items: r.items || 0, start_at: r.start_at, end_at: r.end_at };
    p.bills.push(bill);
    const last = p.batches[p.batches.length - 1];
    if (last && r.start_at <= last.end_at) { last.bills.push(bill); last.items += bill.items; if (r.end_at > last.end_at) last.end_at = r.end_at; }
    else p.batches.push({ start_at: r.start_at, end_at: r.end_at, items: bill.items, bills: [bill] });
  }
  for (const r of checks) {
    const d = day(istDay(r.start_at)), items = r.items || 0;
    d.checked += items;
    for (const n of r.partner ? [r.name, r.partner] : [r.name]) {
      const c = (d.checkers[n] ||= { name: n, items: 0, bills: 0 });
      c.items += r.partner ? items / 2 : items; c.bills++;
    }
  }
  const out = Object.values(days).sort((a, b) => b.date.localeCompare(a.date)).map((d) => {
    const preppers = Object.values(d.preppers).map((p) => {
      let minutes = 0;
      for (const b of p.batches) { const min = Math.max(1, (Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000); minutes += min; for (const x of b.bills) x.speed = +(b.items / min).toFixed(2); }
      const adjusted = p.items - 10 * p.points;
      const dayReward = adjusted > 1100 ? 100 : adjusted > 700 ? 50 : 0;
      const speedBills = p.bills.filter((b) => b.items >= 50).map((b) => ({ bill_no: b.bill_no, items: b.items, speed: b.speed, reward: b.speed > 4.5 ? 20 : b.speed > 3.25 ? 10 : 0 }));
      const speedReward = speedBills.reduce((n, b) => n + b.reward, 0);
      return { name: p.name, items: p.items, points: p.points, adjusted, bills: p.bills.length, minutes: Math.round(minutes), speed: +(p.items / minutes).toFixed(2), dayReward, speedBills, speedReward, total: dayReward + speedReward };
    }).sort((a, b) => b.total - a.total || b.adjusted - a.adjusted);
    const checkers = Object.values(d.checkers).map((c) => {
      const pct = d.checked ? (c.items / d.checked) * 100 : 0;
      return { name: c.name, items: +c.items.toFixed(1), bills: c.bills, pct: +pct.toFixed(1), reward: pct > 45 ? 150 : pct > 30 ? 100 : 0 };
    }).sort((a, b) => b.pct - a.pct);
    return { date: d.date, checked: d.checked, preppers, checkers };
  });
  return out;
}
// Daily report for one IST day (owner, 2026-10-30): per person Preparing items, share, points, speed, Checking items and share,
// racks set (L), syrup cases set (O), bills polythene packed (PK), transport checks (P), break time (T),
// and time not punched = gaps between their first punch and last punch that no bill step or work task covers.
function dailyReport(date) {
  const from = new Date(date + 'T00:00:00+05:30').toISOString(), to = new Date(Date.parse(from) + 86400e3).toISOString();
  const inc = incentiveDays(from, to)[0] || { preppers: [], checkers: [], checked: 0 };
  const people = {};
  const depts = Object.fromEntries(db.prepare('SELECT name, dept FROM users').all().map((x) => [x.name, x.dept || 'Other']));
  const get = (n) => (people[n] ||= { name: n, dept: depts[n] || 'Other', items: 0, itemsPct: 0, points: 0, speed: 0, checked: 0, checkedPct: 0, racks: 0, tubes: 0, syrup: 0, packed: 0, transport: 0, transportMin: 0, breakMin: 0, idleMin: 0, workMin: 0, first: null, last: null });
  const totalPrep = inc.preppers.reduce((n, p) => n + p.items, 0);
  for (const p of inc.preppers) Object.assign(get(p.name), { items: p.items, itemsPct: totalPrep ? +(p.items / totalPrep * 100).toFixed(1) : 0, points: p.points, speed: p.speed });
  for (const c of inc.checkers) Object.assign(get(c.name), { checked: c.items, checkedPct: c.pct });
  const nowIso = new Date().toISOString();
  const rows = db.prepare(`SELECT x.name, e.task_code, e.start_at, e.end_at, e.qty, e.bill_id, e.note FROM entries e JOIN users x ON x.id IN (e.start_by, e.partner_by)
    WHERE e.start_at IS NOT NULL AND e.start_at >= ? AND e.start_at < ? AND x.is_admin = 0 ORDER BY x.name, e.start_at`).all(from, to);
  const spans = {};
  for (const r of rows) {
    if (r.note === 'All done') continue;
    const p = get(r.name), end = r.end_at || (nowIso < to ? nowIso : to);
    const min = Math.max(0, (Date.parse(end) - Date.parse(r.start_at)) / 60000);
    if (!r.bill_id && r.task_code === 'L') p.racks += r.qty || 0;
    if (!r.bill_id && r.task_code === 'O') p.syrup += r.qty || 0;
    if (!r.bill_id && r.task_code === 'Q') p.tubes += r.qty || 0;
    if (!r.bill_id && r.task_code === 'P') { p.transport++; p.transportMin += min; }
    if (!r.bill_id && r.task_code === 'T') p.breakMin += min;
    (spans[r.name] ||= []).push([Date.parse(r.start_at), Date.parse(end)]);
  }
  // Polythene packing: the single "Packed now" tap on a bill (PK), counted by who pressed it.
  for (const r of db.prepare(`SELECT x.name, COUNT(*) AS n FROM entries e JOIN users x ON x.id = e.end_by
    WHERE e.task_code = 'PK' AND e.end_at >= ? AND e.end_at < ? AND (e.note IS NULL OR e.note != 'All done') AND x.is_admin = 0 GROUP BY x.name`).all(from, to)) get(r.name).packed = r.n;
  for (const [name, list] of Object.entries(spans)) {
    list.sort((a, b) => a[0] - b[0]);
    let covered = 0, curS = null, curE = null;
    for (const [s0, e0] of list) { if (curE === null || s0 > curE) { if (curE !== null) covered += curE - curS; curS = s0; curE = e0; } else if (e0 > curE) curE = e0; }
    if (curE !== null) covered += curE - curS;
    const p = get(name), first = list[0][0], last = Math.max(...list.map((x) => x[1]));
    Object.assign(p, { first: new Date(first).toISOString(), last: new Date(last).toISOString(), workMin: Math.round((last - first) / 60000), idleMin: Math.round((last - first - covered) / 60000) });
  }
  for (const p of Object.values(people)) { p.breakMin = Math.round(p.breakMin); p.transportMin = Math.round(p.transportMin); p.checked = Math.round(p.checked); }
  // Every syrup case and rack number entered that day, with who entered it.
  const syrup = db.prepare(`SELECT c.case_name, c.rack_no, c.at, c.verified_at, v.name AS verified_by_name, x.name FROM syrup_cases c JOIN entries e ON e.id = c.entry_id JOIN users x ON x.id = e.start_by LEFT JOIN users v ON v.id = c.verified_by
    WHERE c.at >= ? AND c.at < ? ORDER BY x.name, CAST(c.rack_no AS INTEGER), c.rack_no`).all(from, to);
  const racks = db.prepare(`SELECT x.name, e.task_code, r.rack_no, r.verified_at, v.name AS verified_by_name FROM rack_sets r JOIN entries e ON e.id = r.entry_id JOIN users x ON x.id = e.start_by LEFT JOIN users v ON v.id = r.verified_by
    WHERE r.at >= ? AND r.at < ? ORDER BY x.name, e.task_code, CAST(r.rack_no AS INTEGER), r.rack_no`).all(from, to);
  return { date, syrup, racks, totalPrep, totalChecked: inc.checked, people: Object.values(people).sort((a, b) => b.items - a.items || b.checked - a.checked || a.name.localeCompare(b.name)) };
}
// Who earned money on one day: [{ name, items, speed, check, total }], biggest first.
function incentiveEarners(d) {
  const by = {};
  for (const p of d ? d.preppers : []) if (p.total) Object.assign((by[p.name] ||= { name: p.name, items: 0, speed: 0, check: 0 }), { items: p.dayReward, speed: p.speedReward });
  for (const c of d ? d.checkers : []) if (c.reward) (by[c.name] ||= { name: c.name, items: 0, speed: 0, check: 0 }).check = c.reward;
  return Object.values(by).map((r) => ({ ...r, total: r.items + r.speed + r.check })).sort((a, b) => b.total - a.total);
}


const now = () => new Date().toISOString();
const stages = () => db.prepare('SELECT * FROM tasks WHERE stage_order IS NOT NULL ORDER BY stage_order').all();
const userTasks = (u) => u.tasks.split(',').map((s) => s.trim()).filter(Boolean);
const canDo = (u, code) => u.is_admin || userTasks(u).includes(code);
// Running one of these work tasks unlocks the matching bill step: anyone on I Polythene Packing can mark bills packed (PK).
const UNLOCKS = { I: 'PK' };
const runningWork = (u) => (db.prepare('SELECT task_code FROM entries WHERE bill_id IS NULL AND start_by = ? AND end_at IS NULL').get(u.id) || {}).task_code;
const canDoStage = (u, code) => canDo(u, code) || UNLOCKS[runningWork(u)] === code;
const canReview = (u) => !!(u.is_admin || u.is_manager);

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, 'Bad JSON')); } });
    req.on('error', reject);
  });
}
function currentUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const u = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1`).get(m[1]) || null;
  if (u && (!u.last_seen || Date.now() - Date.parse(u.last_seen) > 60000)) db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), u.id);
  return u;
}
// The bill this person has started (preparing or checking) but not finished yet, if any.
// Bills this person has started but not finished (several are allowed while preparing).
const busyBills = (u) => db.prepare(`SELECT b.id AS bill_id, b.bill_no, b.items, e.task_code, e.start_at, e.points, t.name AS task_name,
  (SELECT name FROM users WHERE id = CASE WHEN e.start_by = ?1 THEN e.partner_by ELSE e.start_by END) AS with_name FROM entries e
  JOIN bills b ON b.id = e.bill_id JOIN tasks t ON t.code = e.task_code
  WHERE (e.start_by = ?1 OR e.partner_by = ?1) AND e.start_at IS NOT NULL AND e.end_at IS NULL ORDER BY e.id`).all(u.id);
const busyBill = (u) => busyBills(u)[0] || null;
// Ends the person's running work task. Tasks with a count (racks, syrup cases) need it first.
function endOpenWork(u, qty, id) {
  const e = db.prepare(`SELECT e.id, t.count_label FROM entries e JOIN tasks t ON t.code = e.task_code
    WHERE e.bill_id IS NULL AND e.start_by = ? AND e.end_at IS NULL ${id ? 'AND e.id = ?' : ''}`).get(...(id ? [u.id, id] : [u.id]));
  if (!e) return false;
  // The count (racks, syrup cases) is optional: saved when given, left empty otherwise.
  const n = e.count_label && qty !== undefined && qty !== null && qty !== '' && Number.isInteger(Number(qty)) && Number(qty) >= 0 ? Number(qty) : null;
  // Syrup cases ended without a number: the cases typed in are the count.
  const cases = n === null ? db.prepare('SELECT (SELECT COUNT(*) FROM syrup_cases WHERE entry_id = ?1) + (SELECT COUNT(*) FROM rack_sets WHERE entry_id = ?1) AS c').get(e.id).c : 0;
  db.prepare('UPDATE entries SET end_at = ?, end_by = ?, qty = ?, entered_by = COALESCE(?, entered_by) WHERE id = ?').run(now(), u.id, n ?? (cases || null), u.entered_by ?? null, e.id);
  return true;
}
function startingBill(u, prevQty, code) {
  // Preparers may prepare several bills at once; any other bill step needs everything else finished first.
  const first = stages()[0].code;
  const busy = busyBills(u).find((b) => !(code === first && b.task_code === first));
  if (busy) fail(400, `Finish bill ${busy.bill_no} first`);
  // Starting a bill ends any work task the person had running, except ones that are only ended by hand (M Sale Goods Check).
  if (!MANUAL_END.includes(runningWork(u))) endOpenWork(u, prevQty);
}
// Work tasks that keep running until the person presses End themselves.
const MANUAL_END = ['M'];
// Bill: T or R + 6 digits (T050810). Challan: 2 letters + 6 digits (CA007536).
const BILL_NO = /^([TR]\d{6}|[A-Z]{2}\d{6})$/;
// Staff may skip leading zeros: CA7536 -> CA007536, T50810 -> T050810. Digits only: below 15000 is a challan (7656 -> CA007656),
// otherwise 5 digits: below 50000 an R bill (15345 -> R015345), 50000 and up a T bill (50810 -> T050810).
const padBillNo = (no) => no.replace(/^\d{1,5}$/, (d) => (Number(d) < 1 ? d : Number(d) < 15000 ? 'CA' + d.padStart(6, '0') : d.length === 5 ? (Number(d) < 50000 ? 'R0' : 'T0') + d : d)).replace(/^([A-Z]{1,2})(\d{1,6})$/, (m, p, d) => p + d.padStart(6, '0'));
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, is_admin: !!u.is_admin, is_manager: !!u.is_manager, tasks: userTasks(u), blocked: (u.blocked || '').split(',').filter(Boolean), can_proxy: !!u.can_proxy, can_prep: !!u.can_prep, can_verify_items: !!u.can_verify_items, can_alldone: !!u.can_alldone, can_shop: !u.is_admin && !shopExcluded(u.name), verify_codes: (u.verify_codes || '').split(',').filter(Boolean), active: !!u.active });

// Full status of bills: one row per bill with its stage entries attached.
function billRows(where = '', params = []) {
  const bills = db.prepare(`SELECT b.*, u.name AS created_by_name FROM bills b LEFT JOIN users u ON u.id = b.created_by ${where} ORDER BY b.id DESC`).all(...params);
  if (!bills.length) return [];
  const ids = bills.map((b) => b.id);
  const entries = db.prepare(`
    SELECT e.*, su.name AS start_by_name, eu.name AS end_by_name, vu.name AS verified_by_name, pu.name AS entered_by_name, pa.name AS partner_name FROM entries e
    LEFT JOIN users su ON su.id = e.start_by LEFT JOIN users eu ON eu.id = e.end_by LEFT JOIN users vu ON vu.id = e.verified_by LEFT JOIN users pu ON pu.id = e.entered_by
    LEFT JOIN users pa ON pa.id = e.partner_by
    WHERE e.bill_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const byBill = {};
  for (const e of entries) (byBill[e.bill_id] ||= {})[e.task_code] = e;
  const st = stages();
  return bills.map((b) => {
    const s = byBill[b.id] || {};
    const next = st.find((t) => !(s[t.code] && s[t.code].end_at));
    return { ...b, stages: s, current: next ? next.code : 'DONE' };
  });
}

// Employees who prepare sale items (owner's list, 2026-10-28), for the Preparing Entry side list.
const PREP_TEAM = ['ANAS', 'AZEEM', 'ABHAY', 'FARAZ', 'HAMZA', 'JUNAID', 'REHAN', 'SAFFAN', 'SUFIYAN', 'ZUHAIB', 'NAVED', 'ADNAN', 'RAJ', 'SAIF', 'FARHAN', 'HAYYUL'];

// Who is on each work task and bill step right now (names for the tiles).
function liveOnTask() {
  const onTask = {};
  for (const r of db.prepare(`SELECT e.task_code, u.name FROM entries e JOIN users u ON u.id = e.start_by
    WHERE e.bill_id IS NULL AND e.end_at IS NULL AND e.start_at IS NOT NULL ORDER BY u.name`).all()) (onTask[r.task_code] ||= []).push(r.name);
  // Bill steps too (Preparing, Checking): the person who started and the second checker.
  for (const r of db.prepare(`SELECT DISTINCT e.task_code, x.name FROM entries e JOIN users x ON x.id IN (e.start_by, e.partner_by)
    WHERE e.bill_id IS NOT NULL AND e.end_at IS NULL AND e.start_at IS NOT NULL ORDER BY x.name`).all()) {
    const list = (onTask[r.task_code] ||= []); if (!list.includes(r.name)) list.push(r.name);
  }
  return onTask;
}
// Everyone who is not on any bill step or work task right now.
const idleNames = () => db.prepare(`SELECT name FROM users WHERE active = 1 AND is_admin = 0 AND id NOT IN (
  SELECT start_by FROM entries WHERE end_at IS NULL AND start_at IS NOT NULL AND start_by IS NOT NULL
  UNION SELECT partner_by FROM entries WHERE end_at IS NULL AND start_at IS NOT NULL AND partner_by IS NOT NULL) ORDER BY name`).all().map((x) => x.name);

// All done for one bill: the running step ends under the person doing it; missing steps are saved under u, marked "All done".
function finishBill(bill, u, t) {
  for (const st of stages()) {
    const e = bill.stages[st.code];
    if (e && e.end_at) continue;
    if (e) db.prepare("UPDATE entries SET end_at = ?, end_by = ?, entered_by = ?, note = 'All done' WHERE id = ?").run(t, e.start_by || u.id, u.id, e.id);
    else db.prepare("INSERT INTO entries (bill_id, task_code, start_at, start_by, end_at, end_by, entered_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, 'All done')")
      .run(bill.id, st.code, st.kind === 'startend' ? t : null, st.kind === 'startend' ? u.id : null, t, u.id, u.id);
  }
}

// ---------- API ----------
const routes = {
  'POST /api/login': async (req, res) => {
    const { username, password } = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').toLowerCase().trim());
    if (!u || !checkPassword(String(password || ''), u.pass_hash)) fail(401, 'Wrong username or password');
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, u.id, now());
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), u.id);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    send(res, 200, publicUser(u), { 'Set-Cookie': `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${secure}` });
  },
  'POST /api/logout': async (req, res) => {
    const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
    if (m) db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
    send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
  },
  'GET /api/me': async (req, res, u) => {
    send(res, 200, { user: publicUser(u), tasks: db.prepare('SELECT * FROM tasks ORDER BY stage_order IS NULL, stage_order, code').all() });
  },
  'POST /api/password': async (req, res, u) => {
    const { oldPassword, newPassword } = await readBody(req);
    if (!checkPassword(String(oldPassword || ''), u.pass_hash)) fail(400, 'Old password is wrong');
    if (String(newPassword || '').length < 4) fail(400, 'New password must be at least 4 characters');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(newPassword), u.id);
    send(res, 200, { ok: true });
  },

  // Work queue for each bill stage this user can do.
  'GET /api/queue': async (req, res, u) => {
    const st = stages();
    const last = st[st.length - 1].code;
    const open = billRows('WHERE b.id NOT IN (SELECT bill_id FROM entries WHERE task_code = ? AND end_at IS NOT NULL AND bill_id IS NOT NULL)', [last])
      .filter((b) => b.current !== 'DONE');
    const out = [];
    for (const t of st) {
      if (!canDoStage(u, t.code)) continue;
      const prev = st[st.indexOf(t) - 1];
      // Bills still at the previous step, shown greyed so people know what's coming.
      const coming = prev ? open.filter((b) => b.current === prev.code).reverse()
        .map((b) => ({ id: b.id, bill_no: b.bill_no, items: b.items, current: b.current, by: (b.stages[prev.code] || {}).start_by_name || null, since: (b.stages[prev.code] || {}).start_at || null })) : [];
      // For the first step: bills this person finished in the last 12 hours, with where they are now.
      const done = prev ? [] : billRows(`WHERE b.id IN (SELECT bill_id FROM entries WHERE task_code = ? AND end_by = ? AND end_at >= ?)`,
        [t.code, u.id, new Date(Date.now() - 12 * 3600e3).toISOString()]).slice(0, 40).map((b) => ({ bill_no: b.bill_no, current: b.current, end_at: b.stages[t.code].end_at }));
      // Preparing: staff see only the bills they started themselves; owners see all.
      const mine = (b) => prev || u.is_admin || (b.stages[t.code] && b.stages[t.code].start_by === u.id);
      // Checking: people who can be picked as the second checker.
      const partners = prev && t.kind === 'startend' ? db.prepare('SELECT id, name, tasks FROM users WHERE active = 1 AND id != ? ORDER BY name').all(u.id)
        .filter((x) => userTasks(x).includes(t.code)).map(({ id, name }) => ({ id, name })) : [];
      out.push({ task: t, bills: open.filter((b) => b.current === t.code && mine(b)).reverse(), coming, done, partners });
    }
    send(res, 200, out);
  },
  // Final verification tab: bills with every step but the last done, plus ones finished in the last 24 hours.
  'GET /api/final': async (req, res, u) => {
    const st = stages(), last = st[st.length - 1];
    if (!canDo(u, last.code)) fail(403, 'Final verification is not in your login');
    const waiting = billRows('WHERE b.id NOT IN (SELECT bill_id FROM entries WHERE task_code = ? AND bill_id IS NOT NULL AND end_at IS NOT NULL)', [last.code])
      .filter((b) => b.current === last.code).reverse();
    const done = billRows('WHERE b.id IN (SELECT bill_id FROM entries WHERE task_code = ? AND end_at >= ?)', [last.code, new Date(Date.now() - 24 * 3600e3).toISOString()])
      .sort((a, b) => (b.stages[last.code].end_at > a.stages[last.code].end_at ? 1 : -1)).slice(0, 100);
    send(res, 200, { stages: st, waiting, done });
  },
  // First stage: enter a bill number and press Start.
  'POST /api/bills': async (req, res, u) => {
    const first = stages()[0];
    if (!canDo(u, first.code)) fail(403, 'Not allowed');
    const body = await readBody(req);
    const billNo = padBillNo(String(body.bill_no || '').trim().toUpperCase());
    if (!BILL_NO.test(billNo)) fail(400, 'Type the digits (50810, or 7656 for challan CA007656), a full bill no. like T050810, or a challan no. like CA007536');
    if (db.prepare('SELECT 1 FROM bills WHERE bill_no = ?').get(billNo)) fail(400, `Bill ${billNo} already exists`);
    const items = Number(body.items);
    if (!Number.isInteger(items) || items < 1 || items > 9999) fail(400, 'Type the number of items');
    startingBill(u, body.prev_qty, first.code);
    const t = now();
    const { lastInsertRowid } = db.prepare('INSERT INTO bills (bill_no, items, created_at, created_by) VALUES (?, ?, ?, ?)').run(billNo, items, t, u.id);
    db.prepare('INSERT INTO entries (bill_id, task_code, start_at, start_by, entered_by) VALUES (?, ?, ?, ?, ?)').run(lastInsertRowid, first.code, t, u.id, u.entered_by ?? null);
    send(res, 200, { ok: true });
  },
  // Fix a wrongly typed bill no. or item count: the person who started Preparing (until Checking starts), or an owner/manager any time.
  // Checking points (1-20) for a bill: the checker, their partner, or desk staff / manager / owners.
  'POST /api/points': async (req, res, u) => {
    const { bill_id, points } = await readBody(req);
    const code = stages()[1].code;
    const e = db.prepare('SELECT id, start_by, partner_by FROM entries WHERE bill_id = ? AND task_code = ?').get(bill_id, code);
    if (!e) fail(404, 'Checking has not started on this bill');
    if (!u.is_admin && !u.is_manager && !u.can_proxy && e.start_by !== u.id && e.partner_by !== u.id) fail(403, 'Only the checker can give points');
    const p = points === '' || points == null ? null : Number(points);
    if (p !== null && !(Number.isInteger(p) && p >= 1 && p <= 20)) fail(400, 'Points must be 1 to 20');
    db.prepare('UPDATE entries SET points = ? WHERE id = ?').run(p, e.id);
    send(res, 200, { ok: true, points: p });
  },
  // Debtors: upload replaces every day found in the file; the rest of the history stays.
  'POST /api/debtors/upload': async (req, res, u) => {
    if (!u.is_admin) fail(403, 'Owner only');
    const { file_name, days } = await readBody(req, 30e6);
    if (!Array.isArray(days) || !days.length) fail(400, 'No days found in the file');
    const t = now();
    db.exec('BEGIN');
    try {
      for (const d of days) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !Array.isArray(d.rows)) fail(400, 'Bad day in file');
        const rows = d.rows.filter((r) => r && r.party && Number.isFinite(Number(r.amount)));
        db.prepare('DELETE FROM debtor_rows WHERE date = ?').run(d.date);
        const ins = db.prepare('INSERT INTO debtor_rows (date, party, area, grp, amount, due) VALUES (?, ?, ?, ?, ?, ?)');
        for (const r of rows) ins.run(d.date, String(r.party).slice(0, 120), String(r.area || '').slice(0, 120), String(r.grp || '').slice(0, 120), Number(r.amount), r.due ? 1 : 0);
        db.prepare('INSERT OR REPLACE INTO debtor_days (date, total, accounts, due, file_name, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(d.date, rows.reduce((n, r) => n + Number(r.amount), 0), rows.length, rows.filter((r) => r.due).length, String(file_name || '').slice(0, 200), t, u.id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    send(res, 200, { ok: true, days: days.length });
  },
  // Day-wise totals, and the top 100 debtors of one day (newest by default) with the change since the day before.
  'GET /api/debtors': async (req, res, u, q) => {
    if (!u.is_admin) fail(403, 'Owner only');
    const days = db.prepare('SELECT d.*, x.name AS uploaded_by_name FROM debtor_days d LEFT JOIN users x ON x.id = d.uploaded_by ORDER BY date DESC').all();
    const date = days.some((d) => d.date === q.get('date')) ? q.get('date') : days[0] && days[0].date;
    const prev = days.find((d) => d.date < date);
    const top = date ? db.prepare(`SELECT r.party, r.area, r.grp, r.amount, r.due, p.amount AS prev_amount FROM debtor_rows r
      LEFT JOIN (SELECT party, area, SUM(amount) AS amount FROM debtor_rows WHERE date = ? GROUP BY party, area) p ON p.party = r.party AND p.area = r.area
      WHERE r.date = ? ORDER BY r.amount DESC LIMIT 100`).all(prev ? prev.date : '', date) : [];
    send(res, 200, { days, date, prev: prev ? prev.date : null, top });
  },
  // Attendance (owners and MANSI): every uploaded day, its revision, and the leave approvals.
  'GET /api/attendance': async (req, res, u) => {
    if (!canAttendance(u)) fail(403, 'Attendance is only for the owner and Mansi');
    send(res, 200, attendanceData(), { 'Cache-Control': 'no-store' });
  },
  // Upload: each day in the file replaces that whole day (new revision). All days are checked before anything is saved.
  'POST /api/attendance/upload': async (req, res, u) => {
    if (!canAttendance(u)) fail(403, 'Attendance is only for the owner and Mansi');
    const { days } = await readBody(req, 5e6);
    if (!Array.isArray(days) || !days.length || days.length > 62) fail(400, 'No days with punches found in the file');
    const today = istToday(), seen = new Set();
    for (const d of days) {
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.date < ATT_START || d.date > today) fail(400, `Day ${d && d.date} is outside ${ATT_START} to today`);
      if (seen.has(d.date)) fail(400, `Two sheets or columns have ${d.date}. Choose one source per date.`);
      seen.add(d.date);
      if (!Array.isArray(d.rows) || !d.rows.length || d.rows.length > 350) fail(400, `Bad rows for ${d.date}`);
      for (const r of d.rows) {
        if (!r || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 100 || typeof r.stamps !== 'string' || r.stamps.length > 1000) fail(400, `Bad row on ${d.date}`);
      }
      if (!d.rows.some((r) => attHasPunch(r.stamps))) fail(400, `No punches on ${d.date}`);
    }
    const t = now();
    db.exec('BEGIN');
    try {
      for (const d of days) {
        const rows = JSON.stringify(d.rows.map((r) => ({ name: r.name.trim(), stamps: r.stamps.trim() })));
        const old = db.prepare('SELECT revision, rows FROM attendance_days WHERE date = ?').get(d.date);
        if (old && old.rows === rows) continue; // same punches again: keep the revision and its approvals
        db.prepare(`INSERT INTO attendance_days (date, rows, source, revision, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(date) DO UPDATE SET rows = excluded.rows, source = excluded.source, revision = revision + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
          .run(d.date, rows, String(d.source || '').slice(0, 200), t, u.id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    send(res, 200, { ok: true, saved: days.map((d) => d.date) });
  },
  // Leave approval for one person on one day: approved (informed, no fine), uninformed (Rs 200) or pending (Rs 200 for now).
  'POST /api/attendance/approve': async (req, res, u) => {
    if (!canAttendance(u)) fail(403, 'Attendance is only for the owner and Mansi');
    const { date, name, status, revision } = await readBody(req);
    if (!['approved', 'uninformed', 'pending'].includes(status)) fail(400, 'Choose approve, uninformed or pending');
    const day = db.prepare('SELECT * FROM attendance_days WHERE date = ?').get(String(date || ''));
    if (!day) fail(404, 'No attendance saved for this day');
    if (day.revision !== Number(revision)) fail(409, 'This day was uploaded again. Press Refresh and choose again.');
    const n = attName(name), rows = JSON.parse(day.rows);
    const absent = ATT_NAMES.includes(n) && !(ATT_FROM[n] && day.date < ATT_FROM[n]) && !(ATT_LEFT[n] && day.date >= ATT_LEFT[n])
      && !rows.some((r) => attName(r.name) === n && attHasPunch(r.stamps));
    if (!absent) fail(400, `${n} is not on leave that day`);
    db.prepare('INSERT OR REPLACE INTO attendance_approvals (date, name, status, day_revision, at, by) VALUES (?, ?, ?, ?, ?, ?)').run(day.date, n, status, day.revision, now(), u.id);
    send(res, 200, { ok: true });
  },
  // One person's late on one day: status 'approved' (not counted), 'rejected' (Not approved, counted), or none (undo).
  // Kept even if the day's file is uploaded again.
  'POST /api/attendance/late': async (req, res, u) => attDecision(req, res, u, 'attendance_late_ok'),
  // Same for a half day: 'approved' (not counted as a half day), 'rejected' (Not approved, counted), or none (undo).
  'POST /api/attendance/half': async (req, res, u) => attDecision(req, res, u, 'attendance_half_ok'),
  // Shop Open/Close: owners see and correct any day from 1 Oct 2026; MANSI sees and saves today only.
  'GET /api/shop-open': async (req, res, u, q) => {
    if (!canAttendance(u)) fail(403, 'Shop Open/Close is only for the owner and Mansi');
    const today = istToday(), month = q.get('month'), date = q.get('date') || today;
    if (!u.is_admin && (month || date !== today)) fail(403, 'Mansi can see and enter today only');
    if (month ? !/^\d{4}-\d{2}$/.test(month) : !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'Choose a valid date or month');
    const rows = db.prepare(`SELECT s.date, s.data, s.revision, s.updated_at, x.name AS updated_by FROM shop_open_close s LEFT JOIN users x ON x.id = s.updated_by
      WHERE ${month ? 's.date LIKE ?' : 's.date = ?'} ORDER BY s.date`).all(month ? month + '-%' : date).map((r) => ({ ...r, data: JSON.parse(r.data) }));
    const names = db.prepare('SELECT name FROM users WHERE active = 1 AND is_admin = 0 ORDER BY name').all().map((x) => x.name.toUpperCase()).filter((n) => !shopExcluded(n));
    const punches = month ? shopPunches('p.date LIKE ?', month + '-%') : shopPunches('p.date = ?', date);
    // Pushes not verified yet, any day (owners see every day; MANSI today only).
    const waiting = u.is_admin ? shopPunches('p.verified_at IS NULL') : shopPunches('p.verified_at IS NULL AND p.date = ?', today);
    send(res, 200, { rows, names, today, start: SHOP_START, punches, waiting }, { 'Cache-Control': 'no-store' });
  },
  // Save the opening or the closing pair for one day. revision must match the day as loaded (stops two people overwriting each other).
  'POST /api/shop-open': async (req, res, u) => {
    if (!canAttendance(u)) fail(403, 'Shop Open/Close is only for the owner and Mansi');
    const { date, phase, names, revision } = await readBody(req, 4096), today = istToday();
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date || date < SHOP_START || date > today)
      fail(400, 'Choose a day from 1 October 2026 to today');
    if (!u.is_admin && date !== today) fail(403, 'Mansi can enter today only');
    if (!['opening', 'closing'].includes(phase)) fail(400, 'Choose opening or closing');
    const list = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim().replace(/\s+/g, ' ').toUpperCase());
    if (list.length !== 2 || list.some((n) => !n || n.length > 60)) fail(400, 'Type both names');
    if (list[0] === list[1]) fail(400, 'Choose two different people');
    const out = list.filter(shopExcluded);
    if (out.length) fail(400, `${out.join(' and ')} ${out.length > 1 ? 'are' : 'is'} not part of shop opening and closing`);
    const old = db.prepare('SELECT * FROM shop_open_close WHERE date = ?').get(date);
    if ((old ? old.revision : 0) !== Number(revision)) fail(409, 'Someone saved this day just now. Press Refresh and save again.');
    saveShopPhase(date, phase, list, u);
    send(res, 200, { ok: true });
  },
  // Staff: "I opened the shop" / "I closed the shop" for today. Only 2 people per phase; after that, or once verified, it is done for the day.
  'GET /api/shop-punch': async (req, res, u) => {
    const today = istToday(), row = db.prepare('SELECT data FROM shop_open_close WHERE date = ?').get(today), data = row ? JSON.parse(row.data) : {};
    const out = { today, myCount: shopMonthCount(u, today), min: SHOP_MIN };
    for (const ph of Object.keys(SHOP_PHASE)) {
      const list = shopPunches('p.date = ? AND p.phase = ?', today, ph);
      out[ph] = { punches: list.map((p) => ({ name: p.name, at: p.at, mine: p.user_id === u.id, verified: !!p.verified_at })), saved: data[ph] ? data[ph].names : null };
    }
    send(res, 200, out, { 'Cache-Control': 'no-store' });
  },
  'POST /api/shop-punch': async (req, res, u) => {
    if (u.is_admin) fail(403, 'Owners verify; staff press these buttons');
    if (shopExcluded(u.name)) fail(403, 'You are not part of shop opening and closing');
    const { phase } = await readBody(req), today = istToday();
    if (!SHOP_PHASE[phase]) fail(400, 'Choose opening or closing');
    const row = db.prepare('SELECT data FROM shop_open_close WHERE date = ?').get(today), saved = row && JSON.parse(row.data)[phase];
    const list = shopPunches('p.date = ? AND p.phase = ?', today, phase);
    if (list.some((p) => p.user_id === u.id)) fail(400, `You already pressed ${SHOP_PHASE[phase].toLowerCase()} today`);
    if (saved && saved.names.length >= 2) fail(400, `${SHOP_PHASE[phase]} is done for the day (${saved.names.join(' and ')})`);
    if (list.length >= 2) fail(400, `${SHOP_PHASE[phase]} is done for the day (${list.map((p) => p.name).join(' and ')})`);
    db.prepare('INSERT INTO shop_punch (date, phase, user_id, name, at) VALUES (?, ?, ?, ?, ?)').run(today, phase, u.id, u.name.toUpperCase(), now());
    send(res, 200, { ok: true });
  },
  // Owner / MANSI: Verify saves the pushed names for that day and phase; Remove deletes a wrong push (frees the slot).
  'POST /api/shop-punch/verify': async (req, res, u) => {
    if (!canAttendance(u)) fail(403, 'Only the owner and Mansi can verify');
    const { date, phase } = await readBody(req);
    if (!u.is_admin && date !== istToday()) fail(403, 'Mansi can verify today only');
    if (!SHOP_PHASE[phase]) fail(400, 'Choose opening or closing');
    const list = shopPunches('p.date = ? AND p.phase = ? AND p.verified_at IS NULL', String(date || ''), phase);
    if (!list.length) fail(400, 'Nothing waiting to verify');
    const all = shopPunches('p.date = ? AND p.phase = ?', date, phase);
    db.exec('BEGIN');
    try { saveShopPhase(date, phase, all.map((p) => p.name), u, { pushed: all.map((p) => ({ name: p.name, at: p.at })) }); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    send(res, 200, { ok: true });
  },
  'POST /api/shop-punch/remove': async (req, res, u) => {
    if (!canAttendance(u)) fail(403, 'Only the owner and Mansi can remove');
    const { date, phase, name } = await readBody(req);
    if (!u.is_admin && date !== istToday()) fail(403, 'Mansi can change today only');
    const r = db.prepare('DELETE FROM shop_punch WHERE date = ? AND phase = ? AND name = ? AND verified_at IS NULL').run(String(date || ''), String(phase || ''), String(name || ''));
    if (!r.changes) fail(404, 'Push not found (already verified?)');
    send(res, 200, { ok: true });
  },
  'POST /api/bills/edit': async (req, res, u) => {
    const body = await readBody(req);
    const [bill] = billRows('WHERE b.id = ?', [body.bill_id]);
    if (!bill) fail(404, 'Bill not found');
    const st = stages(), pr = bill.stages[st[0].code];
    if (!u.is_admin && !u.is_manager && !u.can_proxy) {
      if (!pr || pr.start_by !== u.id) fail(403, 'Only the person who started this bill can change it');
      if (bill.stages[st[1].code]) fail(400, 'Checking has started. Ask the manager to change it.');
    }
    const billNo = padBillNo(String(body.bill_no || '').trim().toUpperCase());
    if (!BILL_NO.test(billNo)) fail(400, 'Type the digits (50810, or 7656 for challan CA007656), a full bill no. like T050810, or a challan no. like CA007536');
    if (db.prepare('SELECT 1 FROM bills WHERE bill_no = ? AND id != ?').get(billNo, bill.id)) fail(400, `Bill ${billNo} already exists`);
    const items = Number(body.items);
    if (!Number.isInteger(items) || items < 1 || items > 9999) fail(400, 'Type the number of items');
    db.prepare('UPDATE bills SET bill_no = ?, items = ? WHERE id = ?').run(billNo, items, bill.id);
    send(res, 200, { ok: true, bill_no: billNo });
  },
  // Employees that can be picked under "Enter for staff".
  'GET /api/proxy-staff': async (req, res, u) => {
    if (!u.can_proxy) fail(403, 'Not allowed');
    send(res, 200, db.prepare('SELECT id, name FROM users WHERE active = 1 AND is_admin = 0 ORDER BY name').all());
  },
  // Preparing Entry tab (owners, MANSI, AFZAL, NEHA, RIYA): everyone who can prepare, and every bill being prepared now.
  'GET /api/preparing': async (req, res, u) => {
    if (!u.can_proxy && !u.can_prep) fail(403, 'Not allowed');
    const first = stages()[0];
    const staff = db.prepare('SELECT id, name, tasks FROM users WHERE active = 1 AND is_admin = 0 ORDER BY name').all()
      .filter((x) => userTasks(x).includes(first.code)).map(({ id, name }) => ({ id, name }));
    const bills = billRows().filter((b) => b.current === first.code && b.stages[first.code] && b.stages[first.code].start_at);
    // Right side: the owner's sale-items team who have no bill in Preparing now, with what they are doing instead.
    const busy = new Set(bills.map((b) => b.stages[first.code].start_by_name)), doing = {}, names = Object.fromEntries(db.prepare('SELECT code, name FROM tasks').all().map((t) => [t.code, t.name]));
    for (const [code, list] of Object.entries(liveOnTask())) for (const n of list) (doing[n] ||= []).push(names[code] || code);
    const free = PREP_TEAM.filter((n) => !busy.has(n)).map((n) => ({ name: n, doing: (doing[n] || []).join(', ') }));
    send(res, 200, { staff, bills, free, team: PREP_TEAM });
  },
  // All done: end the running step and record every step still missing, so the bill is Final Ready now.
  // Running steps end under the person doing them; missing steps are saved under whoever pressed, marked "All done".
  'POST /api/bills/alldone': async (req, res, u) => {
    if (!u.can_alldone) fail(403, 'Not allowed');
    const { bill_id } = await readBody(req);
    const [bill] = billRows('WHERE b.id = ?', [bill_id]);
    if (!bill) fail(404, 'Bill not found');
    if (bill.current === 'DONE') fail(400, `Bill ${bill.bill_no} is already final ready`);
    finishBill(bill, u, now());
    send(res, 200, { ok: true, bill_no: bill.bill_no });
  },
  // Owners: every pending bill becomes Final Ready at once.
  'POST /api/bills/alldone-all': async (req, res, u) => {
    if (!u.is_admin) fail(403, 'Owner only');
    const t = now(), open = billRows().filter((b) => b.current !== 'DONE');
    db.exec('BEGIN');
    try { for (const b of open) finishBill(b, u, t); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    send(res, 200, { ok: true, count: open.length });
  },
  // Live Board for the manager (ARUN): the owners' view of every bill step and work task, read-only plus End.
  'GET /api/board': async (req, res, u) => {
    if (!u.is_admin && !u.is_manager) fail(403, 'Not allowed');
    const open = billRows().filter((b) => b.current !== 'DONE');
    send(res, 200, { stages: stages().map((t) => ({ task: t, bills: open.filter((b) => b.current === t.code).reverse() })), onTask: liveOnTask(), idle: idleNames() });
  },
  // Preparing speed: finished Preparing bills per employee, grouped into batches (bills whose times overlap),
  // items per minute = items / minutes from the first start to the last end of the batch.
  'GET /api/prep-speed': async (req, res, u, q) => {
    if (!u.can_proxy && !u.is_admin && !u.is_manager) fail(403, 'Not allowed');
    const from = q.get('from') || new Date(Date.now() - 86400e3).toISOString(), to = q.get('to') || '9999';
    const rows = db.prepare(`SELECT e.start_by, us.name, e.start_at, e.end_at, b.bill_no, b.items FROM entries e JOIN bills b ON b.id = e.bill_id JOIN users us ON us.id = e.start_by
      WHERE e.task_code = ? AND e.start_at IS NOT NULL AND e.end_at IS NOT NULL AND (e.note IS NULL OR e.note != 'All done') AND e.start_at >= ? AND e.start_at < ?
      ORDER BY us.name, e.start_at`).all(stages()[0].code, from, to);
    const people = {};
    for (const r of rows) {
      const p = (people[r.name] ||= { name: r.name, batches: [] });
      const last = p.batches[p.batches.length - 1];
      if (last && r.start_at <= last.end_at) { last.bills.push(r.bill_no); last.items += r.items || 0; if (r.end_at > last.end_at) last.end_at = r.end_at; }
      else p.batches.push({ start_at: r.start_at, end_at: r.end_at, bills: [r.bill_no], items: r.items || 0 });
    }
    const out = Object.values(people).map((p) => {
      for (const b of p.batches) { b.minutes = Math.max(1, Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000)); b.per_min = +(b.items / b.minutes).toFixed(2); }
      const items = p.batches.reduce((n, b) => n + b.items, 0), minutes = p.batches.reduce((n, b) => n + b.minutes, 0);
      return { name: p.name, bills: p.batches.reduce((n, b) => n + b.bills.length, 0), items, minutes, per_min: +(items / minutes).toFixed(2), batches: p.batches.reverse() };
    }).sort((a, b) => b.per_min - a.per_min);
    send(res, 200, out);
  },
  // Daily incentive (owner's VMA Incentive Rules, 2026-10-30), worked out per IST day between from and to.
  // Preppers: Preparing items that day minus 10 per checking point on their bills; over 700 = Rs 50, over 1100 = Rs 100.
  //   Speed bonus per bill of 50+ items: over 3.25 items/min = Rs 10, over 4.5 = Rs 20 (bills prepared together share the batch speed).
  // Checkers: share of the day's checked items (split in half when two check together); over 30% = Rs 100, over 45% = Rs 150.
  'GET /api/incentive': async (req, res, u, q) => {
    if (!u.is_admin && !u.is_manager) fail(403, 'Not allowed');
    send(res, 200, incentiveDays(q.get('from') || new Date(Date.now() - 86400e3).toISOString(), q.get('to') || '9999'));
  },
  'GET /api/daily-report': async (req, res, u, q) => {
    if (!u.is_admin && !u.is_manager) fail(403, 'Not allowed');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    send(res, 200, dailyReport(date));
  },
  // Owners: email one day's incentive sheet now (same as the 11 AM daily mail).
  'POST /api/incentive/email': async (req, res, u) => {
    if (!u.is_admin) fail(403, 'Owner only');
    const { date } = await readBody(req);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail(400, 'Pick a day');
    try { send(res, 200, await mailIncentive(date)); } catch (e) { fail(400, e.message); }
  },
  // Bill search for owners, MANSI and AFZAL: any open bill, at any step.
  'GET /api/find-bills': async (req, res, u, q) => {
    if (!u.can_proxy && !u.can_alldone && !u.is_manager) fail(403, 'Not allowed');
    const term = String(q.get('q') || '').trim().toUpperCase();
    if (term.length < 2) return send(res, 200, { bills: [], work: [] });
    const st = stages();
    // Matches a bill no., or an employee name: their open bill steps and running work task.
    const people = `SELECT id FROM users WHERE UPPER(name) LIKE ?3 AND active = 1`;
    const rows = billRows(`WHERE b.bill_no LIKE ?1 OR b.bill_no = ?2 OR b.id IN (SELECT bill_id FROM entries WHERE bill_id IS NOT NULL AND end_at IS NULL
      AND (start_by IN (${people}) OR partner_by IN (${people})))`, ['%' + term + '%', padBillNo(term), term + '%']).filter((b) => b.current !== 'DONE').slice(0, 15);
    const work = db.prepare(`SELECT e.id, e.task_code, e.start_at, t.name AS task_name, t.count_label, u.id AS user_id, u.name FROM entries e
      JOIN tasks t ON t.code = e.task_code JOIN users u ON u.id = e.start_by
      WHERE e.bill_id IS NULL AND e.end_at IS NULL AND UPPER(u.name) LIKE ? ORDER BY u.name`).all(term + '%');
    send(res, 200, { bills: rows.map((b) => ({ ...b, task: st.find((t) => t.code === b.current) })), work });
  },
  // Press a button on a bill: action = start | end | done (single timestamp).
  'POST /api/stage': async (req, res, u) => {
    const { bill_id, task_code, action, prev_qty, partner_id } = await readBody(req);
    const task = db.prepare('SELECT * FROM tasks WHERE code = ? AND stage_order IS NOT NULL').get(task_code);
    if (!task) fail(400, 'Unknown stage');
    const prepDesk = u.can_prep && !u.entered_by && task_code === stages()[0].code;
    const proxyEnd = action === 'end' && (u.can_proxy || u.is_manager || prepDesk) && !u.entered_by;
    if (!canDoStage(u, task.code) && !proxyEnd) fail(403, 'This stage is not in your login');
    const [bill] = billRows('WHERE b.id = ?', [bill_id]);
    if (!bill) fail(404, 'Bill not found');
    if (bill.current !== task.code) fail(400, `Bill ${bill.bill_no} is not waiting for ${task.name}`);
    const e = bill.stages[task.code];
    const t = now();
    if (action === 'start') {
      if (task.kind !== 'startend') fail(400, 'This stage has one button only');
      if (e && e.start_at) fail(400, `Already started by ${e.start_by_name}`);
      // Optional second checker picked from the list.
      let partner = null;
      if (partner_id && task.code !== stages()[0].code) {
        partner = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(partner_id);
        if (!partner || partner.id === u.id || !userTasks(partner).includes(task.code)) fail(400, 'Choose who you are checking with');
        const pb = busyBills(partner)[0];
        if (pb) fail(400, `${partner.name} is busy with bill ${pb.bill_no}`);
              }
      startingBill(u, prev_qty, task.code);
      if (partner && !MANUAL_END.includes(runningWork(partner))) endOpenWork(partner);
      db.prepare('INSERT INTO entries (bill_id, task_code, start_at, start_by, entered_by, partner_by) VALUES (?, ?, ?, ?, ?, ?)').run(bill.id, task.code, t, u.id, u.entered_by ?? null, partner ? partner.id : null);
    } else if (action === 'join') {
      if (task.kind !== 'startend' || task.code === stages()[0].code) fail(400, 'Only checking can be shared');
      if (!e || !e.start_at || e.end_at) fail(400, 'Checking has not started');
      if (e.start_by === u.id || e.partner_by === u.id) fail(400, 'You are already on this bill');
      if (e.partner_by) fail(400, `${e.start_by_name} and ${e.partner_name} are already checking it`);
      startingBill(u, prev_qty, task.code);
      db.prepare('UPDATE entries SET partner_by = ? WHERE id = ?').run(u.id, e.id);
    } else if (action === 'end') {
      if (task.kind !== 'startend') fail(400, 'This stage has one button only');
      if (!e || !e.start_at) fail(400, 'Press Start first');
      if (task.code === stages()[0].code && e.start_by !== u.id && !u.is_admin && !u.can_proxy && !u.is_manager && !prepDesk) fail(403, `Only ${e.start_by_name} can end this bill`);
      // Ended by MANSI/AFZAL/owner for someone else: saved as the starter's end, entered by them.
      const forOther = (u.can_proxy || u.is_manager || prepDesk) && !u.entered_by && e.start_by !== u.id && e.partner_by !== u.id;
      db.prepare('UPDATE entries SET end_at = ?, end_by = ?, entered_by = COALESCE(?, entered_by) WHERE id = ?').run(t, forOther ? e.start_by : u.id, forOther ? u.id : u.entered_by ?? null, e.id);
    } else if (action === 'done') {
      if (task.kind !== 'single') fail(400, 'This stage needs Start and End');
      db.prepare('INSERT INTO entries (bill_id, task_code, end_at, end_by, entered_by) VALUES (?, ?, ?, ?, ?)').run(bill.id, task.code, t, u.id, u.entered_by ?? null);
    } else fail(400, 'Unknown action');
    send(res, 200, { ok: true });
  },

  // General (non-bill) work, e.g. "C Basement Cleaning": start/end with optional note.
  'GET /api/work': async (req, res, u) => {
    const rows = db.prepare(`SELECT e.*, t.name AS task_name, t.count_label FROM entries e JOIN tasks t ON t.code = e.task_code
      WHERE e.bill_id IS NULL AND e.start_by = ? ORDER BY e.id DESC LIMIT 30`).all(u.id);
    withCases(rows);
    // Only the owners (admin, ajanta) see who is not on any work.
    const idle = u.is_admin && !u.entered_by ? idleNames() : null;
    // Who is on which task: only the owners, SONU, VICKY and ARUN see the names (owner, 2026-10-31). Others see the work buttons only.
    const viewer = u.entered_by ? db.prepare('SELECT * FROM users WHERE id = ?').get(u.entered_by) || u : u;
    const seeWho = !!viewer.is_admin || ['sonu', 'vicky', 'arun'].includes(viewer.username);
    send(res, 200, { rows, busy: busyBill(u), busyAll: busyBills(u), onTask: seeWho ? liveOnTask() : {}, idle });
  },
  // Syrup cases: add or remove one case (name + rack no.) on a running Syrup cases task.
  'POST /api/syrup': async (req, res, u) => {
    const { entry_id, case_name, rack_no, remove } = await readBody(req);
    const e = db.prepare("SELECT * FROM entries WHERE id = ? AND task_code = 'O' AND bill_id IS NULL").get(entry_id);
    if (!e) fail(404, 'Syrup cases task not found');
    if (e.start_by !== u.id && !u.is_admin && !u.is_manager && !u.can_proxy) fail(403, 'Only the person doing this task can add cases');
    if (remove) { db.prepare('DELETE FROM syrup_cases WHERE id = ? AND entry_id = ?').run(remove, e.id); return send(res, 200, { ok: true }); }
    const name = String(case_name || '').trim().toUpperCase().slice(0, 80), rack = String(rack_no || '').trim().toUpperCase().slice(0, 20);
    if (!name) fail(400, 'Type the case name');
    if (!rack) fail(400, 'Type the rack no.');
    db.prepare('INSERT INTO syrup_cases (entry_id, case_name, rack_no, at, by) VALUES (?, ?, ?, ?, ?)').run(e.id, name, rack, now(), u.entered_by || u.id);
    send(res, 200, { ok: true });
  },
  // Rack Setting: add rack numbers (one or many: "1, 5, 615") or remove one; returns the task's whole list.
  'POST /api/racks': async (req, res, u) => {
    const { entry_id, racks, remove } = await readBody(req);
    const e = db.prepare(`SELECT * FROM entries WHERE id = ? AND task_code IN ('L', 'Q') AND bill_id IS NULL`).get(entry_id);
    if (!e) fail(404, 'Rack task not found');
    if (e.start_by !== u.id && !u.is_admin && !u.is_manager && !u.can_proxy) fail(403, 'Only the person doing this task can add racks');
    if (remove) db.prepare('DELETE FROM rack_sets WHERE id = ? AND entry_id = ?').run(remove, e.id);
    const have = new Set(rackList(e.id).map((r) => r.rack_no));
    const add = String(racks || '').toUpperCase().split(/[\s,;/]+/).map((x) => x.trim().slice(0, 20)).filter(Boolean);
    const dup = add.filter((x) => have.has(x));
    for (const x of add) if (!have.has(x)) { db.prepare('INSERT INTO rack_sets (entry_id, rack_no, at, by) VALUES (?, ?, ?, ?)').run(e.id, x, now(), u.entered_by || u.id); have.add(x); }
    send(res, 200, { racks: rackList(e.id), dup });
  },
  'POST /api/work': async (req, res, u) => {
    const { action, task_code, id, note, qty, prev_qty } = await readBody(req);
    if (action === 'start') {
      if (!db.prepare('SELECT 1 FROM tasks WHERE code = ? AND stage_order IS NULL').get(task_code)) fail(400, 'Unknown task');
      if ((u.blocked || '').split(',').includes(task_code)) fail(403, 'This task is not in your login');
      if (u.is_admin) fail(403, 'Owners do not log work tasks. Use Enter for Staff to log work for an employee.');
      const busy = busyBill(u);
      if (busy) fail(400, `Finish bill ${busy.bill_no} first`);
      const cur = runningWork(u);
      if (MANUAL_END.includes(cur)) fail(400, `Press End on ${cur} ${db.prepare('SELECT name FROM tasks WHERE code = ?').get(cur).name} first`);
      // Starting a new task ends whatever this person was doing before.
      endOpenWork(u, prev_qty);
      db.prepare('INSERT INTO entries (task_code, start_at, start_by, note, entered_by) VALUES (?, ?, ?, ?, ?)').run(task_code, now(), u.id, String(note || ''), u.entered_by ?? null);
    } else if (action === 'end') {
      if (!endOpenWork(u, qty, id)) fail(400, 'Nothing to end');
    } else fail(400, 'Unknown action');
    send(res, 200, { ok: true });
  },

  // The person's own jobs (bill steps and work tasks) for a day, with verification status.
  'GET /api/my-jobs': async (req, res, u, q) => {
    const from = q.get('from') || '0000', to = q.get('to') || '9999';
    send(res, 200, db.prepare(`SELECT e.id, e.task_code, e.start_at, e.end_at, e.qty, e.verified_at, t.name AS task_name, t.count_label, t.needs_verify,
        b.bill_no, vu.name AS verified_by_name FROM entries e JOIN tasks t ON t.code = e.task_code
      LEFT JOIN bills b ON b.id = e.bill_id LEFT JOIN users vu ON vu.id = e.verified_by
      WHERE ((e.start_by = ?1 OR e.partner_by = ?1) AND e.start_at >= ?2 AND e.start_at < ?3) OR (e.start_by IS NULL AND e.end_by = ?1 AND e.end_at >= ?2 AND e.end_at < ?3)
      ORDER BY COALESCE(e.start_at, e.end_at) DESC`).all(u.id, from, to));
  },
  // Manager/owner confirms a finished job (work task or bill step) was punched correctly. undo: true clears it.
  'POST /api/verify': async (req, res, u) => {
    const { id, undo } = await readBody(req);
    const job = db.prepare('SELECT e.task_code, t.needs_verify FROM entries e JOIN tasks t ON t.code = e.task_code WHERE e.id = ?').get(id);
    if (!job) fail(404, 'Job not found');
    if (!canReview(u) && !(u.verify_codes || '').split(',').includes(job.task_code)) fail(403, 'Not allowed to verify this job');
    if (!job.needs_verify && !undo) fail(400, 'This job does not need verification');
    const r = db.prepare('UPDATE entries SET verified_by = ?, verified_at = ? WHERE id = ? AND end_at IS NOT NULL').run(undo ? null : u.id, undo ? null : now(), id);
    if (!r.changes) fail(400, 'Nothing to verify');
    send(res, 200, { ok: true });
  },

  // Verify Items (Arun, owners): Rack Setting, Tube rack setting and Syrup cases jobs of the last 3 days with every rack / case.
  'GET /api/item-verify': async (req, res, u) => {
    if (!canReview(u) && !u.can_verify_items) fail(403, 'Not allowed');
    const jobs = db.prepare(`SELECT e.id, e.task_code, e.start_at, e.end_at, e.verified_at, t.name AS task_name, su.name AS start_by_name, vu.name AS verified_by_name FROM entries e
      JOIN tasks t ON t.code = e.task_code LEFT JOIN users su ON su.id = e.start_by LEFT JOIN users vu ON vu.id = e.verified_by
      WHERE e.bill_id IS NULL AND e.task_code IN ('L', 'Q', 'O') AND e.start_at >= ? ORDER BY e.start_at DESC`).all(new Date(Date.now() - 3 * 86400e3).toISOString());
    withCases(jobs);
    send(res, 200, jobs.filter((j) => (j.racks || j.cases || []).length));
  },
  // Verify (or undo) one rack / case, or every item of a job. When all items of a finished job are verified, the job is verified too.
  'POST /api/item-verify': async (req, res, u) => {
    if (!canReview(u) && !u.can_verify_items) fail(403, 'Not allowed');
    const { kind, id, entry_id, undo } = await readBody(req);
    const t = undo ? null : now(), by = undo ? null : u.id;
    let entry = entry_id;
    if (kind === 'rack' || kind === 'case') {
      const table = kind === 'rack' ? 'rack_sets' : 'syrup_cases';
      const row = db.prepare(`SELECT entry_id FROM ${table} WHERE id = ?`).get(id);
      if (!row) fail(404, 'Not found');
      db.prepare(`UPDATE ${table} SET verified_by = ?, verified_at = ? WHERE id = ?`).run(by, t, id);
      entry = row.entry_id;
    } else {
      db.prepare('UPDATE rack_sets SET verified_by = ?, verified_at = ? WHERE entry_id = ? AND (verified_at IS NULL OR ?)').run(by, t, entry, undo ? 1 : 0);
      db.prepare('UPDATE syrup_cases SET verified_by = ?, verified_at = ? WHERE entry_id = ? AND (verified_at IS NULL OR ?)').run(by, t, entry, undo ? 1 : 0);
    }
    const left = db.prepare('SELECT (SELECT COUNT(*) FROM rack_sets WHERE entry_id = ?1 AND verified_at IS NULL) + (SELECT COUNT(*) FROM syrup_cases WHERE entry_id = ?1 AND verified_at IS NULL) AS n').get(entry).n;
    if (!left) db.prepare('UPDATE entries SET verified_by = ?, verified_at = ? WHERE id = ? AND end_at IS NOT NULL AND verified_at IS NULL').run(u.id, now(), entry);
    else db.prepare('UPDATE entries SET verified_by = NULL, verified_at = NULL WHERE id = ?').run(entry);
    send(res, 200, { ok: true, left });
  },
  // Jobs this person may verify (e.g. VICKY: H), last 7 days, waiting ones first.
  'GET /api/verify-list': async (req, res, u) => {
    const codes = (u.verify_codes || '').split(',').filter(Boolean);
    if (!codes.length) fail(403, 'Not allowed');
    send(res, 200, db.prepare(`SELECT e.id, e.task_code, e.start_at, e.end_at, e.qty, e.verified_at, t.name AS task_name, t.count_label, su.name AS start_by_name, vu.name AS verified_by_name
      FROM entries e JOIN tasks t ON t.code = e.task_code LEFT JOIN users su ON su.id = e.start_by LEFT JOIN users vu ON vu.id = e.verified_by
      WHERE e.task_code IN (${codes.map(() => '?').join(',')}) AND e.end_at IS NOT NULL AND e.end_at >= ? ORDER BY e.verified_at IS NOT NULL, e.end_at DESC LIMIT 200`)
      .all(...codes, new Date(Date.now() - 7 * 86400e3).toISOString()));
  },

  // ---------- fix requests (manager asks a person to correct a punch) ----------
  'GET /api/fixes': async (req, res, u) => {
    const sql = `SELECT f.*, eu.name AS employee_name, cu.name AS created_by_name, ru.name AS resolved_by_name FROM fix_requests f
      JOIN users eu ON eu.id = f.employee_id JOIN users cu ON cu.id = f.created_by LEFT JOIN users ru ON ru.id = f.resolved_by`;
    const rows = canReview(u)
      ? db.prepare(`${sql} ORDER BY f.resolved_at IS NOT NULL, f.id DESC LIMIT 200`).all()
      : db.prepare(`${sql} WHERE f.employee_id = ? AND (f.resolved_at IS NULL OR f.resolved_at > datetime('now', '-2 days')) ORDER BY f.id DESC`).all(u.id);
    send(res, 200, rows);
  },
  'POST /api/fixes': async (req, res, u) => {
    if (!canReview(u)) fail(403, 'Managers only');
    const { entry_id, message } = await readBody(req);
    if (!String(message || '').trim()) fail(400, 'Write what needs fixing');
    const e = db.prepare(`SELECT e.*, t.name AS task_name, b.bill_no FROM entries e JOIN tasks t ON t.code = e.task_code
      LEFT JOIN bills b ON b.id = e.bill_id WHERE e.id = ?`).get(entry_id);
    if (!e) fail(404, 'Entry not found');
    const what = (e.bill_no ? `Bill ${e.bill_no} · ` : '') + `${e.task_code} ${e.task_name}`;
    db.prepare('INSERT INTO fix_requests (entry_id, what, employee_id, message, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.id, what, e.start_by || e.end_by, String(message).trim(), u.id, now());
    send(res, 200, { ok: true });
  },
  'POST /api/fixes/done': async (req, res, u) => {
    const { id, reply } = await readBody(req);
    const f = db.prepare('SELECT * FROM fix_requests WHERE id = ? AND resolved_at IS NULL').get(id);
    if (!f) fail(404, 'Request not found');
    if (f.employee_id !== u.id && !canReview(u)) fail(403, 'Not your request');
    db.prepare('UPDATE fix_requests SET reply = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').run(String(reply || '').trim() || null, u.id, now(), id);
    send(res, 200, { ok: true });
  },

  // ---------- owner / admin ----------
  'GET /api/admin/bills': async (req, res, u, q) => {
    const where = []; const params = [];
    if (q.get('from')) { where.push('b.created_at >= ?'); params.push(q.get('from')); }
    if (q.get('to')) { where.push('b.created_at < ?'); params.push(q.get('to')); }
    if (q.get('search')) { where.push('b.bill_no LIKE ?'); params.push('%' + q.get('search') + '%'); }
    send(res, 200, { stages: stages(), bills: billRows(where.length ? 'WHERE ' + where.join(' AND ') : '', params) });
  },
  'GET /api/admin/work': async (req, res, u, q) => {
    const where = ['e.bill_id IS NULL']; const params = [];
    if (q.get('from')) { where.push('e.start_at >= ?'); params.push(q.get('from')); }
    if (q.get('to')) { where.push('e.start_at < ?'); params.push(q.get('to')); }
    if (q.get('verify')) where.push('e.end_at IS NOT NULL AND e.verified_at IS NULL AND t.needs_verify = 1');
    send(res, 200, withCases(db.prepare(`SELECT e.*, t.name AS task_name, t.count_label, t.needs_verify, su.name AS start_by_name, vu.name AS verified_by_name, pu.name AS entered_by_name FROM entries e
      JOIN tasks t ON t.code = e.task_code LEFT JOIN users su ON su.id = e.start_by LEFT JOIN users vu ON vu.id = e.verified_by LEFT JOIN users pu ON pu.id = e.entered_by
      WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT 500`).all(...params)));
  },
  // Who has (and hasn't) logged any job in the chosen period. Owners/managers only.
  'GET /api/admin/staff-status': async (req, res, u, q) => {
    const from = q.get('from') || '0000', to = q.get('to') || '9999';
    const users = db.prepare('SELECT id, username, name, tasks, last_seen FROM users WHERE active = 1 AND is_admin = 0 ORDER BY name').all();
    const jobs = db.prepare(`SELECT COUNT(*) AS n, MAX(COALESCE(end_at, start_at)) AS last FROM entries
      WHERE ((start_by = ?1 OR partner_by = ?1) AND start_at >= ?2 AND start_at < ?3) OR (end_by = ?1 AND end_at >= ?2 AND end_at < ?3)`);
    const running = db.prepare(`SELECT e.task_code, e.start_at, t.name AS task_name, b.bill_no FROM entries e JOIN tasks t ON t.code = e.task_code
      LEFT JOIN bills b ON b.id = e.bill_id WHERE (e.start_by = ?1 OR e.partner_by = ?1) AND e.start_at IS NOT NULL AND e.end_at IS NULL ORDER BY e.id DESC LIMIT 1`);
    const lastEntry = db.prepare(`SELECT e.task_code, e.start_at, e.end_at, t.name AS task_name, b.bill_no FROM entries e JOIN tasks t ON t.code = e.task_code
      LEFT JOIN bills b ON b.id = e.bill_id WHERE e.start_by = ?1 OR e.end_by = ?1 ORDER BY COALESCE(e.end_at, e.start_at) DESC LIMIT 1`);
    send(res, 200, users.map((x) => {
      const j = jobs.get(x.id, from, to);
      return { id: x.id, name: x.name, username: x.username, tasks: userTasks(x), last_seen: x.last_seen, jobs: j.n, last_job: j.last, running: running.get(x.id) || null, last_entry: lastEntry.get(x.id) || null };
    }));
  },
  // Owner deletes a wrong work-task entry from the Task Log (bill steps use reset-stage instead).
  'POST /api/admin/delete-entry': async (req, res) => {
    const { id } = await readBody(req);
    const r = db.prepare('DELETE FROM entries WHERE id = ? AND bill_id IS NULL').run(id);
    if (!r.changes) fail(404, 'Task not found');
    send(res, 200, { ok: true });
  },
  // Undo a stage on a bill (for mistakes). Also clears every later stage.
  'POST /api/admin/reset-stage': async (req, res) => {
    const { bill_id, task_code } = await readBody(req);
    const st = stages(); const idx = st.findIndex((t) => t.code === task_code);
    if (idx < 0) fail(400, 'Unknown stage');
    const codes = st.slice(idx).map((t) => t.code);
    db.prepare(`DELETE FROM entries WHERE bill_id = ? AND task_code IN (${codes.map(() => '?').join(',')})`).run(bill_id, ...codes);
    if (idx === 0) db.prepare('DELETE FROM bills WHERE id = ?').run(bill_id);
    send(res, 200, { ok: true });
  },
  'GET /api/admin/users': async (req, res) => {
    send(res, 200, db.prepare('SELECT * FROM users ORDER BY is_admin DESC, name').all().map(publicUser));
  },
  'POST /api/admin/users': async (req, res, u) => {
    const b = await readBody(req);
    const tasks = (b.tasks || []).join(',');
    if (b.id) {
      if (b.id === u.id && !b.is_admin) fail(400, 'You cannot remove your own owner access');
      db.prepare('UPDATE users SET name = ?, tasks = ?, is_admin = ?, is_manager = ?, active = ? WHERE id = ?').run(b.name, tasks, b.is_admin ? 1 : 0, b.is_manager ? 1 : 0, b.active ? 1 : 0, b.id);
      if (b.password) db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.password), b.id);
      if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(b.id);
    } else {
      const username = String(b.username || '').toLowerCase().trim();
      if (!/^[a-z0-9_.]+$/.test(username)) fail(400, 'Username: letters and numbers only');
      if (!b.password) fail(400, 'Set a password');
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(400, 'Username already taken');
      db.prepare('INSERT INTO users (username, name, pass_hash, is_admin, is_manager, tasks) VALUES (?, ?, ?, ?, ?, ?)').run(username, b.name || username, hashPassword(b.password), b.is_admin ? 1 : 0, b.is_manager ? 1 : 0, tasks);
    }
    send(res, 200, { ok: true });
  },
  'POST /api/admin/tasks': async (req, res) => {
    const { code, name, kind } = await readBody(req);
    const c = String(code || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{1,4}$/.test(c) || !name) fail(400, 'Give a short code (1-4 letters) and a name');
    db.prepare(`INSERT INTO tasks (code, name, kind) VALUES (?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET name = excluded.name`).run(c, String(name).trim(), kind === 'single' ? 'single' : 'startend');
    send(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname.startsWith('/api/')) {
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) fail(404, 'Not found');
      const u = currentUser(req);
      if (url.pathname !== '/api/login' && url.pathname !== '/api/logout') {
        if (!u) fail(401, 'Please log in');
        const reviewPaths = ['/api/admin/bills', '/api/admin/work', '/api/admin/staff-status'];
        const canSee = (u.is_manager && reviewPaths.includes(url.pathname)) || (u.can_proxy && url.pathname === '/api/admin/bills');
        if (url.pathname.startsWith('/api/admin/') && !u.is_admin && !(req.method === 'GET' && canSee)) fail(403, 'Owner only');
      }
      // "Enter for staff": work buttons pressed on someone else's behalf.
      const forId = Number(req.headers['x-for-user'] || 0);
      const proxyPaths = ['/api/me', '/api/queue', '/api/bills', '/api/stage', '/api/work', '/api/bills/edit', '/api/points', '/api/syrup', '/api/racks'];
      if (forId && u && proxyPaths.includes(url.pathname)) {
        // FARAZ (can_prep) may only start Preparing bills for others.
        if (!u.can_proxy && !(u.can_prep && req.method === 'POST' && url.pathname === '/api/bills')) fail(403, 'Not allowed to enter work for others');
        const t = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(forId);
        if (!t) fail(404, 'Employee not found');
        return await handler(req, res, { ...t, entered_by: u.id }, url.searchParams);
      }
      return await handler(req, res, u, url.searchParams);
    }
    if (url.pathname === '/sw.js') return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'sw.js')), { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    const types = { '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    const file = path.join(__dirname, 'public', path.normalize(url.pathname).replace(/^([/\\])+/, ''));
    const ext = path.extname(file);
    if (types[ext] && file.startsWith(path.join(__dirname, 'public')) && fs.existsSync(file)) {
      return send(res, 200, fs.readFileSync(file), { 'Content-Type': types[ext], 'Cache-Control': 'public, max-age=86400' });
    }
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (String(err.message).includes('UNIQUE')) return send(res, 400, { error: 'Already recorded' });
    console.error(err);
    send(res, 500, { error: 'Server error' });
  }
});
// ---------- daily incentive email ----------
// Settings come from the host's environment: SMTP_USER + SMTP_PASS (a Gmail app password), INCENTIVE_EMAIL_TO, INCENTIVE_EMAIL_CC
// (comma separated), optional SMTP_HOST (default smtp.gmail.com, port 465). Every day at 11:00 IST the previous day's sheet is sent once.
const MAIL = { host: process.env.SMTP_HOST || 'smtp.gmail.com', user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
  to: (process.env.INCENTIVE_EMAIL_TO || '').split(',').map((x) => x.trim()).filter(Boolean), cc: (process.env.INCENTIVE_EMAIL_CC || '').split(',').map((x) => x.trim()).filter(Boolean) };

// Minimal SMTP over TLS (port 465) with AUTH LOGIN; enough for Gmail.
function smtpSend({ to, cc, subject, html }) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(465, MAIL.host, { servername: MAIL.host });
    let buf = '', waiting = null;
    const fail = (e) => { sock.destroy(); reject(e instanceof Error ? e : new Error(String(e))); };
    sock.setTimeout(30000, () => fail('Email server timed out'));
    sock.on('error', fail);
    sock.on('data', (c) => {
      buf += c;
      const lines = buf.split('\r\n'); const done = lines.slice(0, -1).find((l) => /^\d{3} /.test(l));
      if (done && waiting) { const w = waiting; waiting = null; const reply = buf; buf = ''; w(reply); }
    });
    const expect = (code) => new Promise((ok) => { waiting = (r) => (r.startsWith(String(code)) ? ok(r) : fail(`Email server said: ${r.trim().split('\r\n').pop()}`)); });
    const cmd = (line, code) => { const p = expect(code); sock.write(line + '\r\n'); return p; };
    const b64 = (x) => Buffer.from(x).toString('base64');
    const msg = [`From: Vrinda Medical Agencies <${MAIL.user}>`, `To: ${to.join(', ')}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
      `Subject: =?UTF-8?B?${b64(subject)}?=`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@vrinda>`, 'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html).replace(/.{76}/g, '$&\r\n')].join('\r\n');
    (async () => {
      await expect(220);
      await cmd('EHLO vrinda.local', 250);
      await cmd('AUTH LOGIN', 334); await cmd(b64(MAIL.user), 334); await cmd(b64(MAIL.pass), 235);
      await cmd(`MAIL FROM:<${MAIL.user}>`, 250);
      for (const r of [...to, ...cc]) await cmd(`RCPT TO:<${r}>`, 250);
      await cmd('DATA', 354); await cmd(msg + '\r\n.', 250);
      sock.write('QUIT\r\n'); sock.end(); resolve();
    })().catch(fail);
  });
}
function incentiveSheetHtml(date) {
  const from = new Date(date + 'T00:00:00+05:30').toISOString(), to = new Date(Date.parse(from) + 86400e3).toISOString();
  const earners = incentiveEarners(incentiveDays(from, to)[0]);
  const long = new Date(date + 'T00:00:00+05:30').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const rs = (n) => (n ? '&#8377;' + n : '—'), total = earners.reduce((n, r) => n + r.total, 0);
  const td = 'style="border:1px solid #999;padding:6px 10px"', tdr = 'style="border:1px solid #999;padding:6px 10px;text-align:right"';
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const html = `<div style="font:14px Arial,sans-serif;color:#111"><h2 style="margin:0">Vrinda Medical Agencies</h2><p style="margin:4px 0 14px">Daily incentive · <b>${long}</b></p>
    ${earners.length ? `<table style="border-collapse:collapse"><tr style="background:#eee"><th ${td}>#</th><th ${td}>Employee</th><th ${tdr}>Items reward</th><th ${tdr}>Speed bonus</th><th ${tdr}>Checking reward</th><th ${tdr}>Total</th></tr>
    ${earners.map((r, i) => `<tr><td ${td}>${i + 1}</td><td ${td}><b>${esc(r.name)}</b></td><td ${tdr}>${rs(r.items)}</td><td ${tdr}>${rs(r.speed)}</td><td ${tdr}>${rs(r.check)}</td><td ${tdr}><b>${rs(r.total)}</b></td></tr>`).join('')}
    <tr style="font-weight:bold"><td ${td} colspan="5">Total · ${earners.length} employee${earners.length > 1 ? 's' : ''}</td><td ${tdr}>&#8377;${total}</td></tr></table>`
      : '<p>Nobody earned an incentive on this day.</p>'}
    <p style="color:#666;font-size:12px;margin-top:16px">Sent automatically by the Bill Tracker.</p></div>`;
  return { html, subject: `Incentive ${long} · ₹${total}` };
}
async function mailIncentive(date) {
  if (!MAIL.user || !MAIL.pass || !MAIL.to.length) throw new Error('Email is not set up yet (SMTP_USER, SMTP_PASS and INCENTIVE_EMAIL_TO on the server)');
  const { html, subject } = incentiveSheetHtml(date);
  await smtpSend({ to: MAIL.to, cc: MAIL.cc, subject, html });
  db.prepare('INSERT OR REPLACE INTO incentive_mail (date, sent_at, recipients) VALUES (?, ?, ?)').run(date, now(), [...MAIL.to, ...MAIL.cc].join(', '));
  return { ok: true, sent_to: [...MAIL.to, ...MAIL.cc] };
}
// Each minute: from 11:00 IST, send yesterday's sheet if it hasn't gone yet; after a failure wait 15 minutes before trying again.
let mailRetryAt = 0;
setInterval(() => {
  if (!MAIL.user || !MAIL.pass || !MAIL.to.length || Date.now() < mailRetryAt) return;
  const ist = new Date(Date.now() + 330 * 60000);
  if (ist.getUTCHours() < 11) return;
  const y = new Date(ist.getTime() - 86400e3).toISOString().slice(0, 10);
  if (db.prepare('SELECT 1 FROM incentive_mail WHERE date = ?').get(y)) return;
  mailRetryAt = Date.now() + 15 * 60000;
  mailIncentive(y).then(() => console.log('Incentive email sent for', y)).catch((e) => console.error('Incentive email failed:', e.message));
}, 60000).unref();

server.listen(PORT, () => console.log(`Bill tracker running on http://localhost:${PORT}`));
