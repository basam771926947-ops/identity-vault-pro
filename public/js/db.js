const IDVaultDB = (() => {
  const API_BASE = '/api';
  let currentActor = 'system';

  function setActor(actor) {
    currentActor = actor || 'system';
  }

  async function request(url, options = {}) {
    const res = await fetch(`${API_BASE}${url}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `خطأ في الخادم (${res.status})`);
    }
    return data;
  }

  async function open() {
    await request('/settings');
    return true;
  }

  async function login(username, password) {
    const data = await request('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    return data.user || null;
  }

  async function getSettings() {
    return request('/settings');
  }

  async function saveSettings(settings) {
    return request('/settings', {
      method: 'PUT',
      body: JSON.stringify({ ...settings, actor: currentActor })
    });
  }

  async function getAll(storeName) {
    if (storeName === 'identity_records') return request('/records');
    if (storeName === 'users') return request('/users');
    if (storeName === 'audit_logs') return request('/audit');
    if (storeName === 'ocr_learning_memory') return request('/ocr-memory');
    return [];
  }

  async function getById(storeName, id) {
    const all = await getAll(storeName);
    return all.find((item) => Number(item.id) === Number(id)) || null;
  }

  async function add(storeName, payload) {
    if (storeName === 'identity_records') {
      return request('/records', {
        method: 'POST',
        body: JSON.stringify({ ...payload, actor: currentActor })
      });
    }
    if (storeName === 'users') {
      return request('/users', {
        method: 'POST',
        body: JSON.stringify({ ...payload, actor: currentActor })
      });
    }
    if (storeName === 'ocr_learning_memory') {
      return request('/ocr-memory', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }
    throw new Error('عملية غير مدعومة');
  }

  async function put(storeName, payload) {
    if (storeName === 'identity_records') {
      return request(`/records/${payload.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...payload, actor: currentActor })
      });
    }
    if (storeName === 'users') {
      return request(`/users/${payload.id}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role: payload.role, actor: currentActor })
      });
    }
    throw new Error('تحديث غير مدعوم');
  }

  async function remove(storeName, id) {
    if (storeName === 'identity_records') {
      return request(`/records/${id}?actor=${encodeURIComponent(currentActor)}`, {
        method: 'DELETE'
      });
    }
    if (storeName === 'users') {
      return request(`/users/${id}?actor=${encodeURIComponent(currentActor)}`, {
        method: 'DELETE'
      });
    }
    throw new Error('حذف غير مدعوم');
  }

  async function exportJSON() {
    return request('/backup');
  }

  async function importJSON(dump) {
    return request('/restore', {
      method: 'POST',
      body: JSON.stringify(dump)
    });
  }

  return {
    open,
    login,
    setActor,
    getSettings,
    saveSettings,
    getAll,
    getById,
    add,
    put,
    remove,
    exportJSON,
    importJSON
  };
})();
