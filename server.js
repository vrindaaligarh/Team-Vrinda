// Bill workflow tracker: zero-dependency Node.js (22+) server with built-in SQLite.
// Run: node server.js   then open http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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

// ---------- helpers ----------
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
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
const busyBills = (u) => db.prepare(`SELECT b.id AS bill_id, b.bill_no, b.items, e.task_code, e.start_at, t.name AS task_name,
  (SELECT name FROM users WHERE id = CASE WHEN e.start_by = ?1 THEN e.partner_by ELSE e.start_by END) AS with_name FROM entries e
  JOIN bills b ON b.id = e.bill_id JOIN tasks t ON t.code = e.task_code
  WHERE (e.start_by = ?1 OR e.partner_by = ?1) AND e.start_at IS NOT NULL AND e.end_at IS NULL ORDER BY e.id`).all(u.id);
const busyBill = (u) => busyBills(u)[0] || null;
// Ends the person's running work task. Tasks with a count (racks, syrup cases) need it first.
function endOpenWork(u, qty, id) {
  const e = db.prepare(`SELECT e.id, t.count_label FROM entries e JOIN tasks t ON t.code = e.task_code
    WHERE e.bill_id IS NULL AND e.start_by = ? AND e.end_at IS NULL ${id ? 'AND e.id = ?' : ''}`).get(...(id ? [u.id, id] : [u.id]));
  if (!e) return false;
  let n = null;
  if (e.count_label) {
    n = Number(qty);
    if (qty === undefined || qty === null || qty === '' || !Number.isInteger(n) || n < 0) fail(400, `Enter how many ${e.count_label}`);
  }
  db.prepare('UPDATE entries SET end_at = ?, end_by = ?, qty = ?, entered_by = COALESCE(?, entered_by) WHERE id = ?').run(now(), u.id, n, u.entered_by ?? null, e.id);
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
// Staff may skip leading zeros: CA7536 -> CA007536, T50810 -> T050810. Exactly 5 digits: below 50000 is an R bill (12345 -> R012345), 50000 and up a T bill (50810 -> T050810).
const padBillNo = (no) => no.replace(/^(\d{5})$/, (m, d) => (Number(d) < 50000 ? 'R0' : 'T0') + d).replace(/^([A-Z]{1,2})(\d{1,6})$/, (m, p, d) => p + d.padStart(6, '0'));
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, is_admin: !!u.is_admin, is_manager: !!u.is_manager, tasks: userTasks(u), blocked: (u.blocked || '').split(',').filter(Boolean), can_proxy: !!u.can_proxy, can_alldone: !!u.can_alldone, active: !!u.active });

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
    if (!BILL_NO.test(billNo)) fail(400, 'Type the 5 digits (50810), a full bill no. like T050810, or a challan no. like CA007536');
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
    if (!BILL_NO.test(billNo)) fail(400, 'Type the 5 digits (50810), a full bill no. like T050810, or a challan no. like CA007536');
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
    if (!u.can_proxy) fail(403, 'Not allowed');
    const first = stages()[0];
    const staff = db.prepare('SELECT id, name, tasks FROM users WHERE active = 1 AND is_admin = 0 ORDER BY name').all()
      .filter((x) => userTasks(x).includes(first.code)).map(({ id, name }) => ({ id, name }));
    send(res, 200, { staff, bills: billRows().filter((b) => b.current === first.code && b.stages[first.code] && b.stages[first.code].start_at) });
  },
  // All done: end the running step and record every step still missing, so the bill is Final Ready now.
  // Running steps end under the person doing them; missing steps are saved under whoever pressed, marked "All done".
  'POST /api/bills/alldone': async (req, res, u) => {
    if (!u.can_alldone) fail(403, 'Not allowed');
    const { bill_id } = await readBody(req);
    const [bill] = billRows('WHERE b.id = ?', [bill_id]);
    if (!bill) fail(404, 'Bill not found');
    if (bill.current === 'DONE') fail(400, `Bill ${bill.bill_no} is already final ready`);
    const t = now();
    for (const st of stages()) {
      const e = bill.stages[st.code];
      if (e && e.end_at) continue;
      if (e) db.prepare("UPDATE entries SET end_at = ?, end_by = ?, entered_by = ?, note = 'All done' WHERE id = ?").run(t, e.start_by || u.id, u.id, e.id);
      else db.prepare("INSERT INTO entries (bill_id, task_code, start_at, start_by, end_at, end_by, entered_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, 'All done')")
        .run(bill.id, st.code, st.kind === 'startend' ? t : null, st.kind === 'startend' ? u.id : null, t, u.id, u.id);
    }
    send(res, 200, { ok: true, bill_no: bill.bill_no });
  },
  // Live Board for the manager (ARUN): the owners' view of every bill step and work task, read-only plus End.
  'GET /api/board': async (req, res, u) => {
    if (!u.is_admin && !u.is_manager) fail(403, 'Not allowed');
    const open = billRows().filter((b) => b.current !== 'DONE');
    send(res, 200, { stages: stages().map((t) => ({ task: t, bills: open.filter((b) => b.current === t.code).reverse() })), onTask: liveOnTask(), idle: idleNames() });
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
    const proxyEnd = action === 'end' && (u.can_proxy || u.is_manager) && !u.entered_by;
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
        const pw = db.prepare(`SELECT t.code, t.name, t.count_label FROM entries e JOIN tasks t ON t.code = e.task_code WHERE e.bill_id IS NULL AND e.start_by = ? AND e.end_at IS NULL`).get(partner.id);
        if (pw && pw.count_label) fail(400, `${partner.name} must first end ${pw.code} ${pw.name} (needs the number of ${pw.count_label})`);
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
      if (task.code === stages()[0].code && e.start_by !== u.id && !u.is_admin && !u.can_proxy && !u.is_manager) fail(403, `Only ${e.start_by_name} can end this bill`);
      // Ended by MANSI/AFZAL/owner for someone else: saved as the starter's end, entered by them.
      const forOther = (u.can_proxy || u.is_manager) && !u.entered_by && e.start_by !== u.id && e.partner_by !== u.id;
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
    // Only the owners (admin, ajanta) see who is not on any work.
    const idle = u.is_admin && !u.entered_by ? idleNames() : null;
    send(res, 200, { rows, busy: busyBill(u), busyAll: busyBills(u), onTask: liveOnTask(), idle });
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
    send(res, 200, db.prepare(`SELECT e.id, e.task_code, e.start_at, e.end_at, e.qty, e.verified_at, t.name AS task_name, t.count_label,
        b.bill_no, vu.name AS verified_by_name FROM entries e JOIN tasks t ON t.code = e.task_code
      LEFT JOIN bills b ON b.id = e.bill_id LEFT JOIN users vu ON vu.id = e.verified_by
      WHERE ((e.start_by = ?1 OR e.partner_by = ?1) AND e.start_at >= ?2 AND e.start_at < ?3) OR (e.start_by IS NULL AND e.end_by = ?1 AND e.end_at >= ?2 AND e.end_at < ?3)
      ORDER BY COALESCE(e.start_at, e.end_at) DESC`).all(u.id, from, to));
  },
  // Manager/owner confirms a finished job (work task or bill step) was punched correctly. undo: true clears it.
  'POST /api/verify': async (req, res, u) => {
    if (!canReview(u)) fail(403, 'Managers only');
    const { id, undo } = await readBody(req);
    const r = db.prepare('UPDATE entries SET verified_by = ?, verified_at = ? WHERE id = ? AND end_at IS NOT NULL').run(undo ? null : u.id, undo ? null : now(), id);
    if (!r.changes) fail(400, 'Nothing to verify');
    send(res, 200, { ok: true });
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
    if (q.get('verify')) where.push('e.end_at IS NOT NULL AND e.verified_at IS NULL');
    send(res, 200, db.prepare(`SELECT e.*, t.name AS task_name, t.count_label, su.name AS start_by_name, vu.name AS verified_by_name, pu.name AS entered_by_name FROM entries e
      JOIN tasks t ON t.code = e.task_code LEFT JOIN users su ON su.id = e.start_by LEFT JOIN users vu ON vu.id = e.verified_by LEFT JOIN users pu ON pu.id = e.entered_by
      WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT 500`).all(...params));
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
      const proxyPaths = ['/api/me', '/api/queue', '/api/bills', '/api/stage', '/api/work', '/api/bills/edit'];
      if (forId && u && proxyPaths.includes(url.pathname)) {
        if (!u.can_proxy) fail(403, 'Not allowed to enter work for others');
        const t = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(forId);
        if (!t) fail(404, 'Employee not found');
        return await handler(req, res, { ...t, entered_by: u.id }, url.searchParams);
      }
      return await handler(req, res, u, url.searchParams);
    }
    if (url.pathname === '/sw.js') return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'sw.js')), { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    const types = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
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
server.listen(PORT, () => console.log(`Bill tracker running on http://localhost:${PORT}`));
