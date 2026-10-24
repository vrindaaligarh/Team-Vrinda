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
migrate('2026-10-24-work-code-u-supply', () => {
  db.prepare(`INSERT INTO tasks (code, name, kind) VALUES ('U', 'Supply', 'startend') ON CONFLICT(code) DO UPDATE SET name = excluded.name`).run();
});

// ---------- helpers ----------
const now = () => new Date().toISOString();
const stages = () => db.prepare('SELECT * FROM tasks WHERE stage_order IS NOT NULL ORDER BY stage_order').all();
const userTasks = (u) => u.tasks.split(',').map((s) => s.trim()).filter(Boolean);
const canDo = (u, code) => u.is_admin || userTasks(u).includes(code);

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
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1`).get(m[1]) || null;
}
// The bill this person has started (preparing or checking) but not finished yet, if any.
const busyBill = (u) => db.prepare(`SELECT b.bill_no, e.task_code FROM entries e JOIN bills b ON b.id = e.bill_id
  WHERE e.start_by = ? AND e.start_at IS NOT NULL AND e.end_at IS NULL LIMIT 1`).get(u.id) || null;
function startingBill(u) {
  const busy = busyBill(u);
  if (busy) fail(400, `Finish bill ${busy.bill_no} first`);
  // Starting a bill ends any work task the person had running.
  db.prepare('UPDATE entries SET end_at = ?, end_by = ? WHERE bill_id IS NULL AND start_by = ? AND end_at IS NULL').run(now(), u.id, u.id);
}
const BILL_NO = /^[TR]\d{6}$/;
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, is_admin: !!u.is_admin, tasks: userTasks(u), active: !!u.active });

// Full status of bills: one row per bill with its stage entries attached.
function billRows(where = '', params = []) {
  const bills = db.prepare(`SELECT b.*, u.name AS created_by_name FROM bills b LEFT JOIN users u ON u.id = b.created_by ${where} ORDER BY b.id DESC`).all(...params);
  if (!bills.length) return [];
  const ids = bills.map((b) => b.id);
  const entries = db.prepare(`
    SELECT e.*, su.name AS start_by_name, eu.name AS end_by_name FROM entries e
    LEFT JOIN users su ON su.id = e.start_by LEFT JOIN users eu ON eu.id = e.end_by
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

// ---------- API ----------
const routes = {
  'POST /api/login': async (req, res) => {
    const { username, password } = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').toLowerCase().trim());
    if (!u || !checkPassword(String(password || ''), u.pass_hash)) fail(401, 'Wrong username or password');
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, u.id, now());
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
      if (!canDo(u, t.code)) continue;
      out.push({ task: t, bills: open.filter((b) => b.current === t.code).reverse() });
    }
    send(res, 200, out);
  },
  // First stage: enter a bill number and press Start.
  'POST /api/bills': async (req, res, u) => {
    const first = stages()[0];
    if (!canDo(u, first.code)) fail(403, 'Not allowed');
    const billNo = String((await readBody(req)).bill_no || '').trim().toUpperCase();
    if (!BILL_NO.test(billNo)) fail(400, 'Bill number must be T or R and 6 digits, like T050810');
    startingBill(u);
    if (db.prepare('SELECT 1 FROM bills WHERE bill_no = ?').get(billNo)) fail(400, `Bill ${billNo} already exists`);
    const t = now();
    const { lastInsertRowid } = db.prepare('INSERT INTO bills (bill_no, created_at, created_by) VALUES (?, ?, ?)').run(billNo, t, u.id);
    db.prepare('INSERT INTO entries (bill_id, task_code, start_at, start_by) VALUES (?, ?, ?, ?)').run(lastInsertRowid, first.code, t, u.id);
    send(res, 200, { ok: true });
  },
  // Press a button on a bill: action = start | end | done (single timestamp).
  'POST /api/stage': async (req, res, u) => {
    const { bill_id, task_code, action } = await readBody(req);
    const task = db.prepare('SELECT * FROM tasks WHERE code = ? AND stage_order IS NOT NULL').get(task_code);
    if (!task) fail(400, 'Unknown stage');
    if (!canDo(u, task.code)) fail(403, 'This stage is not in your login');
    const [bill] = billRows('WHERE b.id = ?', [bill_id]);
    if (!bill) fail(404, 'Bill not found');
    if (bill.current !== task.code) fail(400, `Bill ${bill.bill_no} is not waiting for ${task.name}`);
    const e = bill.stages[task.code];
    const t = now();
    if (action === 'start') {
      if (task.kind !== 'startend') fail(400, 'This stage has one button only');
      if (e && e.start_at) fail(400, `Already started by ${e.start_by_name}`);
      startingBill(u);
      db.prepare('INSERT INTO entries (bill_id, task_code, start_at, start_by) VALUES (?, ?, ?, ?)').run(bill.id, task.code, t, u.id);
    } else if (action === 'end') {
      if (task.kind !== 'startend') fail(400, 'This stage has one button only');
      if (!e || !e.start_at) fail(400, 'Press Start first');
      db.prepare('UPDATE entries SET end_at = ?, end_by = ? WHERE id = ?').run(t, u.id, e.id);
    } else if (action === 'done') {
      if (task.kind !== 'single') fail(400, 'This stage needs Start and End');
      db.prepare('INSERT INTO entries (bill_id, task_code, end_at, end_by) VALUES (?, ?, ?, ?)').run(bill.id, task.code, t, u.id);
    } else fail(400, 'Unknown action');
    send(res, 200, { ok: true });
  },

  // General (non-bill) work, e.g. "C Basement Cleaning": start/end with optional note.
  'GET /api/work': async (req, res, u) => {
    const rows = db.prepare(`SELECT e.*, t.name AS task_name FROM entries e JOIN tasks t ON t.code = e.task_code
      WHERE e.bill_id IS NULL AND e.start_by = ? ORDER BY e.id DESC LIMIT 30`).all(u.id);
    send(res, 200, { rows, busy: busyBill(u) });
  },
  'POST /api/work': async (req, res, u) => {
    const { action, task_code, id, note } = await readBody(req);
    if (action === 'start') {
      if (!db.prepare('SELECT 1 FROM tasks WHERE code = ? AND stage_order IS NULL').get(task_code)) fail(400, 'Unknown task');
      const busy = busyBill(u);
      if (busy) fail(400, `Finish bill ${busy.bill_no} first`);
      const t = now();
      // Starting a new task ends whatever this person was doing before.
      db.prepare('UPDATE entries SET end_at = ?, end_by = ? WHERE bill_id IS NULL AND start_by = ? AND end_at IS NULL').run(t, u.id, u.id);
      db.prepare('INSERT INTO entries (task_code, start_at, start_by, note) VALUES (?, ?, ?, ?)').run(task_code, t, u.id, String(note || ''));
    } else if (action === 'end') {
      const r = db.prepare('UPDATE entries SET end_at = ?, end_by = ? WHERE id = ? AND bill_id IS NULL AND start_by = ? AND end_at IS NULL').run(now(), u.id, id, u.id);
      if (!r.changes) fail(400, 'Nothing to end');
    } else fail(400, 'Unknown action');
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
    send(res, 200, db.prepare(`SELECT e.*, t.name AS task_name, su.name AS start_by_name FROM entries e
      JOIN tasks t ON t.code = e.task_code LEFT JOIN users su ON su.id = e.start_by
      WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT 500`).all(...params));
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
      db.prepare('UPDATE users SET name = ?, tasks = ?, is_admin = ?, active = ? WHERE id = ?').run(b.name, tasks, b.is_admin ? 1 : 0, b.active ? 1 : 0, b.id);
      if (b.password) db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.password), b.id);
      if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(b.id);
    } else {
      const username = String(b.username || '').toLowerCase().trim();
      if (!/^[a-z0-9_.]+$/.test(username)) fail(400, 'Username: letters and numbers only');
      if (!b.password) fail(400, 'Set a password');
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(400, 'Username already taken');
      db.prepare('INSERT INTO users (username, name, pass_hash, is_admin, tasks) VALUES (?, ?, ?, ?, ?)').run(username, b.name || username, hashPassword(b.password), b.is_admin ? 1 : 0, tasks);
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
        if (url.pathname.startsWith('/api/admin/') && !u.is_admin) fail(403, 'Owner only');
      }
      return await handler(req, res, u, url.searchParams);
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
