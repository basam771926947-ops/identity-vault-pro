const AuthModule = (() => {
  async function login(username, password) {
    const user = await IDVaultDB.login(username, password);
    if (!user) return null;
    const session = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role
    };
    sessionStorage.setItem('idvault_session', JSON.stringify(session));
    try { localStorage.setItem('idvault_session_backup', JSON.stringify(session)); } catch {}
    return session;
  }

  function getSession() {
    try {
      const raw = sessionStorage.getItem('idvault_session') || (() => { try { return localStorage.getItem('idvault_session_backup'); } catch { return null; } })();
      return JSON.parse(raw || 'null');
    } catch {
      return null;
    }
  }

  function logout() {
    try {
      let actor = "";
      if (typeof getSession === "function") {
        const s = getSession();
        actor = (s && (s.username || (s.user && s.user.username))) || "";
      }
      if (!actor) {
        for (const k of ["idvault_session", "idvault_session_backup"]) {
          const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
          if (!raw) continue;
          const p = JSON.parse(raw);
          actor = (p && (p.username || (p.user && p.user.username))) || "";
          if (actor) break;
        }
      }
      actor = actor || (window.currentUser && window.currentUser.username) || "admin";
      const _nowLogout = Date.now();
      if (_nowLogout - (window.__idvaultLastLogoutSentAt || 0) < 4000) {
        sessionStorage.removeItem('idvault_session');
        try { localStorage.removeItem('idvault_session_backup'); } catch {}
        if (typeof IDVaultDB !== "undefined" && typeof IDVaultDB.setActor === "function") {
          IDVaultDB.setActor('system');
        }
        return;
      }
      window.__idvaultLastLogoutSentAt = _nowLogout;
      const payload = JSON.stringify({ actor, action_type: "LOGOUT", details: `تسجيل خروج المستخدم ${actor}` });
      fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true
      }).catch(() => {});
    } catch {}

    sessionStorage.removeItem('idvault_session');
    try { localStorage.removeItem('idvault_session_backup'); } catch {}
    if (typeof IDVaultDB !== "undefined" && typeof IDVaultDB.setActor === "function") {
      IDVaultDB.setActor('system');
    }
  }

  return { login, getSession, logout };
})();
