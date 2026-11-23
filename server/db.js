// === DEDUPE_LOGIN_AUDIT_START ===
const _recentLoginMap = new Map();
function _shouldSkipDuplicateLogin(username) {
  const key = String(username || "");
  const now = Date.now();
  const prev = _recentLoginMap.get(key) || 0;
  if (now - prev < 2000) return true;
  _recentLoginMap.set(key, now);
  return false;
}
// === DEDUPE_LOGIN_AUDIT_END ===
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_FILE = path.join(__dirname, 'database.sqlite');

let db = null;
let SQL = null;

function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

function addAudit(actor, actionType, details) {
  run(
    'INSERT INTO audit_logs (actor, action_type, details, created_at) VALUES (?, ?, ?, ?)',
    [actor || 'system', actionType, details || '', new Date().toISOString()]
  );
}

async function init() {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
  });

  if (fs.existsSync(DB_FILE)) {
    const fileBuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'reader'
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS identity_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      doc_number TEXT NOT NULL UNIQUE,
      birth_date TEXT,
      birth_place TEXT,
      issue_date TEXT,
      expiry_date TEXT,
      profession TEXT,
      phone TEXT,
      address TEXT,
      military_status TEXT DEFAULT 'مدني',
      military_rank TEXT,
      military_number TEXT,
      destination_place TEXT,
      destination_reason TEXT,
      doc_image_data TEXT,
      created_at TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      system_name TEXT NOT NULL,
      logo_data TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT,
      action_type TEXT,
      details TEXT,
      created_at TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ocr_learning_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type TEXT,
      field_name TEXT,
      pattern_key TEXT,
      normalized_value TEXT,
      hit_count INTEGER DEFAULT 1,
      updated_at TEXT
    );
  `);

  const admin = queryOne("SELECT * FROM users WHERE username = 'admin'");
  if (!admin) {
    run(
      "INSERT INTO users (full_name, username, password, role) VALUES (?, ?, ?, ?)",
      ['مدير النظام', 'admin', 'admin123', 'admin']
    );
  }

  const settings = queryOne("SELECT * FROM settings WHERE id = 1");
  if (!settings) {
    run(
      "INSERT INTO settings (id, system_name, logo_data) VALUES (1, ?, '')",
      ['نظام إدارة وثائق الهوية']
    );
  }

  persist();
}

function login(username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u || !p) return null;
  const user = queryOne(
    'SELECT id, full_name, username, role FROM users WHERE username = ? AND password = ?',
    [u, p]
  );
  if (user) {
    if (!_shouldSkipDuplicateLogin(user.username)) addAudit(user.username, 'LOGIN', `تسجيل دخول المستخدم ${user.username}`);
  }
  return user || null;
}

function getSettings() {
  return queryOne('SELECT id, system_name, logo_data FROM settings WHERE id = 1');
}

function saveSettings(payload) {
  const actor = payload.actor || 'admin';
  const systemName = String(payload.system_name || 'نظام إدارة وثائق الهوية').trim();
  const logoData = String(payload.logo_data || '');
  const existing = getSettings();
  if (!existing) {
    run('INSERT INTO settings (id, system_name, logo_data) VALUES (1, ?, ?)', [systemName, logoData]);
  } else {
    run('UPDATE settings SET system_name = ?, logo_data = ? WHERE id = 1', [systemName, logoData]);
  }
  addAudit(actor, 'UPDATE_SETTINGS', `تحديث هوية النظام: ${systemName}`);
  return getSettings();
}

function getAllRecords() {
  return queryAll('SELECT * FROM identity_records ORDER BY id DESC');
}

function addRecord(r) {
  const fullName = String(r.full_name || '').trim();
  const docType = String(r.doc_type || 'بطاقة شخصية إلكترونية').trim();
  const docNumber = String(r.doc_number || '').trim();
  if (!fullName || !docNumber) {
    throw new Error('الاسم الكامل ورقم الوثيقة مطلوبان');
  }
  const existing = queryOne('SELECT id FROM identity_records WHERE doc_number = ?', [docNumber]);
  if (existing) {
    throw new Error('رقم الوثيقة مسجل مسبقاً');
  }
  const createdAt = new Date().toISOString();
  run(
    `INSERT INTO identity_records (
      full_name, doc_type, doc_number, birth_date, birth_place,
      issue_date, expiry_date, profession, phone, address,
      military_status, military_rank, military_number,
      destination_place, destination_reason, doc_image_data, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fullName,
      docType,
      docNumber,
      r.birth_date || '',
      r.birth_place || '',
      r.issue_date || '',
      r.expiry_date || '',
      r.profession || '',
      r.phone || '',
      r.address || '',
      r.military_status || 'مدني',
      r.military_rank || '',
      r.military_number || '',
      r.destination_place || '',
      r.destination_reason || '',
      r.doc_image_data || '',
      createdAt
    ]
  );
  const created = queryOne('SELECT * FROM identity_records WHERE doc_number = ?', [docNumber]);
  addAudit(r.actor || 'system', 'CREATE_RECORD', `إضافة وثيقة: ${fullName} (${docNumber})`);
  return created;
}

function updateRecord(id, r) {
  const existing = queryOne('SELECT * FROM identity_records WHERE id = ?', [id]);
  if (!existing) throw new Error('السجل غير موجود');
  const fullName = String(r.full_name ?? existing.full_name).trim();
  const docType = String(r.doc_type ?? existing.doc_type).trim();
  const docNumber = String(r.doc_number ?? existing.doc_number).trim();
  if (!fullName || !docNumber) throw new Error('الاسم الكامل ورقم الوثيقة مطلوبان');

  run(
    `UPDATE identity_records SET
      full_name = ?, doc_type = ?, doc_number = ?, birth_date = ?, birth_place = ?,
      issue_date = ?, expiry_date = ?, profession = ?, phone = ?, address = ?,
      military_status = ?, military_rank = ?, military_number = ?,
      destination_place = ?, destination_reason = ?, doc_image_data = ?
     WHERE id = ?`,
    [
      fullName,
      docType,
      docNumber,
      r.birth_date ?? existing.birth_date ?? '',
      r.birth_place ?? existing.birth_place ?? '',
      r.issue_date ?? existing.issue_date ?? '',
      r.expiry_date ?? existing.expiry_date ?? '',
      r.profession ?? existing.profession ?? '',
      r.phone ?? existing.phone ?? '',
      r.address ?? existing.address ?? '',
      r.military_status ?? existing.military_status ?? 'مدني',
      r.military_rank ?? existing.military_rank ?? '',
      r.military_number ?? existing.military_number ?? '',
      r.destination_place ?? existing.destination_place ?? '',
      r.destination_reason ?? existing.destination_reason ?? '',
      r.doc_image_data !== undefined ? r.doc_image_data : (existing.doc_image_data || ''),
      id
    ]
  );
  addAudit(r.actor || 'system', 'UPDATE_RECORD', `تعديل وثيقة: ${fullName} (${docNumber})`);
  return queryOne('SELECT * FROM identity_records WHERE id = ?', [id]);
}

function deleteRecord(id, actor = 'system') {
  const existing = queryOne('SELECT * FROM identity_records WHERE id = ?', [id]);
  run('DELETE FROM identity_records WHERE id = ?', [id]);
  if (existing) {
    addAudit(actor, 'DELETE_RECORD', `حذف وثيقة: ${existing.full_name} (${existing.doc_number})`);
  }
}

function getAllUsers() {
  return queryAll('SELECT id, full_name, username, role FROM users ORDER BY id ASC');
}

function addUser(u) {
  const fullName = String(u.full_name || '').trim();
  const username = String(u.username || '').trim();
  const password = String(u.password || '');
  const role = ['admin', 'writer', 'reader'].includes(u.role) ? u.role : 'reader';
  if (!fullName || !username || !password) {
    throw new Error('جميع حقول المستخدم مطلوبة');
  }
  const dup = queryOne('SELECT id FROM users WHERE username = ?', [username]);
  if (dup) throw new Error('اسم المستخدم موجود مسبقاً');

  run('INSERT INTO users (full_name, username, password, role) VALUES (?, ?, ?, ?)', [fullName, username, password, role]);
  addAudit(u.actor || 'admin', 'CREATE_USER', `إضافة مستخدم: ${username} (${role})`);
  return queryOne('SELECT id, full_name, username, role FROM users WHERE username = ?', [username]);
}

function updateUserRole(id, payload) {
  const role = ['admin', 'writer', 'reader'].includes(payload.role) ? payload.role : 'reader';
  run('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  addAudit(payload.actor || 'admin', 'UPDATE_USER_ROLE', `تغيير صلاحية المستخدم #${id} إلى ${role}`);
  return queryOne('SELECT id, full_name, username, role FROM users WHERE id = ?', [id]);
}

function deleteUser(id, actor = 'admin') {
  const target = queryOne('SELECT * FROM users WHERE id = ?', [id]);
  if (!target || target.username === 'admin') return;
  run('DELETE FROM users WHERE id = ?', [id]);
  addAudit(actor, 'DELETE_USER', `حذف المستخدم ${target.username}`);
}

function getAuditLogs() {
  return queryAll('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200');
}

function getOcrMemory() {
  return queryAll('SELECT * FROM ocr_learning_memory ORDER BY hit_count DESC, id DESC LIMIT 200');
}

function saveOcrMemory(item) {
  const docType = String(item.doc_type || 'general').trim();
  const fieldName = String(item.field_name || 'general').trim();
  const patternKey = String(item.pattern_key || '').trim();
  const normalizedValue = String(item.normalized_value || '').trim();
  if (!patternKey || !normalizedValue) return;

  const now = new Date().toISOString();
  const existing = queryOne(
    'SELECT * FROM ocr_learning_memory WHERE doc_type = ? AND field_name = ? AND pattern_key = ?',
    [docType, fieldName, patternKey]
  );

  if (existing) {
    run(
      'UPDATE ocr_learning_memory SET normalized_value = ?, hit_count = ?, updated_at = ? WHERE id = ?',
      [normalizedValue, Number(existing.hit_count || 1) + 1, now, existing.id]
    );
  } else {
    run(
      'INSERT INTO ocr_learning_memory (doc_type, field_name, pattern_key, normalized_value, hit_count, updated_at) VALUES (?, ?, ?, ?, 1, ?)',
      [docType, fieldName, patternKey, normalizedValue, now]
    );
  }
}

function exportBackup() {
  return {
    exported_at: new Date().toISOString(),
    settings: getSettings(),
    users: queryAll('SELECT * FROM users'),
    identity_records: getAllRecords(),
    audit_logs: queryAll('SELECT * FROM audit_logs'),
    ocr_learning_memory: getOcrMemory()
  };
}

function restoreBackup(dump) {
  if (!dump || typeof dump !== 'object') throw new Error('ملف النسخة الاحتياطية غير صالح');

  if (dump.settings) {
    saveSettings({
      system_name: dump.settings.system_name || 'نظام إدارة وثائق الهوية',
      logo_data: dump.settings.logo_data || '',
      actor: 'admin'
    });
  }

  if (Array.isArray(dump.users)) {
    for (const u of dump.users) {
      if (!u.username || !u.password) continue;
      const exists = queryOne('SELECT id FROM users WHERE username = ?', [u.username]);
      if (!exists) {
        run('INSERT INTO users (full_name, username, password, role) VALUES (?, ?, ?, ?)', [
          u.full_name || u.username,
          u.username,
          u.password,
          u.role || 'reader'
        ]);
      }
    }
  }

  if (Array.isArray(dump.identity_records)) {
    for (const r of dump.identity_records) {
      if (!r.full_name || !r.doc_number) continue;
      try {
        addRecord({ ...r, actor: 'restore' });
      } catch {
        // تجاهل السجلات المكررة
      }
    }
  }

  if (Array.isArray(dump.ocr_learning_memory)) {
    for (const m of dump.ocr_learning_memory) {
      saveOcrMemory(m);
    }
  }

  addAudit('admin', 'RESTORE_BACKUP', 'استعادة نسخة احتياطية');
}


function clearAuditLogs(olderThanDays = null) {
  if (olderThanDays && Number(olderThanDays) > 0) {
    const days = Number(olderThanDays);
    if (typeof run === "function") {
      run("DELETE FROM audit_logs WHERE datetime(created_at) < datetime('now', ?)", [`-${days} days`]);
      return true;
    }
  }
  if (typeof run === "function") {
    run("DELETE FROM audit_logs");
    return true;
  }
  return false;
}


const _recentLogoutMap = new Map();
function logLogout(actor = "system") {
  const name = String(actor || "system");
  const now = Date.now();
  const prev = _recentLogoutMap.get(name) || 0;
  if (now - prev < 2000) return;
  _recentLogoutMap.set(name, now);
  if (typeof addAudit === "function") {
    addAudit(name, "LOGOUT", `تسجيل خروج المستخدم ${name}`);
  }
}

module.exports = {
  addAudit,
  logLogout,
  clearAuditLogs,
  init,
  login,
  getSettings,
  saveSettings,
  getAllRecords,
  addRecord,
  updateRecord,
  deleteRecord,
  getAllUsers,
  addUser,
  updateUserRole,
  deleteUser,
  getAuditLogs,
  getOcrMemory,
  saveOcrMemory,
  exportBackup,
  restoreBackup
};
