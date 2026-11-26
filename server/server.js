const fs = require('fs');
const path = require('path');
const express = require('express');
const dbModule = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const EXPORTS_DIR = path.join(__dirname, '..', 'exports');

if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

app.use(express.json({ limit: '25mb' }));
app.use(express.static(PUBLIC_DIR));

app.post('/api/save-export', (req, res) => {
  try {
    const rawName = path.basename(String((req.body && req.body.filename) || ''));
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const base64Data = String((req.body && req.body.base64Data) || '').replace(/^data:.*;base64,/, '');

    if (!safeName || !base64Data) {
      return res.status(400).json({ ok: false, error: 'اسم الملف أو البيانات مفقودة' });
    }

    const buffer = Buffer.from(base64Data, 'base64');
    if (!buffer.length) {
      return res.status(400).json({ ok: false, error: 'بيانات الملف فارغة' });
    }

    const targetPath = path.join(EXPORTS_DIR, safeName);
    fs.writeFileSync(targetPath, buffer);

    return res.json({ ok: true, savedPath: `exports/${safeName}` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'فشل حفظ الملف على الخادم' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => {
  try {
    const settings = dbModule.getSettings();
    res.json(settings || { id: 1, system_name: 'نظام إدارة وثائق الهوية', logo_data: '' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', (req, res) => {
  try {
    const updated = dbModule.saveSettings(req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = dbModule.login(username, password);
    if (!user) {
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    }
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/records', (req, res) => {
  try {
    res.json(dbModule.getAllRecords());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/records', (req, res) => {
  try {
    const created = dbModule.addRecord(req.body || {});
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/records/:id', (req, res) => {
  try {
    const updated = dbModule.updateRecord(Number(req.params.id), req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/records/:id', (req, res) => {
  try {
    dbModule.deleteRecord(Number(req.params.id), req.query.actor || 'system');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/users', (req, res) => {
  try {
    res.json(dbModule.getAllUsers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', (req, res) => {
  try {
    const created = dbModule.addUser(req.body || {});
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/role', (req, res) => {
  try {
    const updated = dbModule.updateUserRole(Number(req.params.id), req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', (req, res) => {
  try {
    dbModule.deleteUser(Number(req.params.id), req.query.actor || 'system');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/audit', (req, res) => {
  try {
    res.json(dbModule.getAuditLogs());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ocr-memory', (req, res) => {
  try {
    res.json(dbModule.getOcrMemory());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ocr-memory', (req, res) => {
  try {
    dbModule.saveOcrMemory(req.body || {});
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/backup', (req, res) => {
  try {
    res.json(dbModule.exportBackup());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/restore', (req, res) => {
  try {
    dbModule.restoreBackup(req.body || {});
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// === AUDIT_POST_ROUTE_START ===
const _auditDb = require('./db');
app.post('/api/audit', (req, res) => {
  try {
    const b = req.body || {};
    const actor = String(b.actor || b.username || 'admin');
    const actionType = String(b.action_type || b.actionType || b.action || 'ACTION');
    const details = String(b.details || '');
    if (typeof _auditDb.addAudit === 'function') {
      _auditDb.addAudit(actor, actionType, details);
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Audit error' });
  }
});

app.post('/api/logout', (req, res) => {
  try {
    const actor = (req.body && (req.body.actor || req.body.username)) || 'admin';
    if (typeof _auditDb.logLogout === 'function') {
      _auditDb.logLogout(actor);
    } else if (typeof _auditDb.addAudit === 'function') {
      _auditDb.addAudit(actor, 'LOGOUT', `تسجيل خروج المستخدم ${actor}`);
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Logout error' });
  }
});
// === AUDIT_POST_ROUTE_END ===

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

(async () => {
  await dbModule.init();
// === AUDIT_DELETE_ROUTE_START ===
const { clearAuditLogs: _clearAuditLogs } = require('./db');
app.delete('/api/audit', (req, res) => {
  try {
    const days = req.query && (req.query.olderThanDays || req.query.days);
    const ok = typeof _clearAuditLogs === 'function' ? _clearAuditLogs(days ? Number(days) : null) : false;
    if (!ok) {
      return res.status(500).json({ ok: false, error: 'clearAuditLogs failed' });
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Server error' });
  }
});
// === AUDIT_DELETE_ROUTE_END ===

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
})();
