window.API_BASE_URL = window.API_BASE_URL || (window.location.protocol === "file:" ? "http://localhost:3000" : "");
window.__activeStatMode = "all";
window.__allIdentityRecords = [];
window.__militaryFilterActive = false;

window.__authDebugCatcher = true;
window.addEventListener("error", (ev) => {
  console.error("GLOBAL_ERR:", ev.message, ev.filename, ev.lineno);
  if (typeof showToast === "function") {
    showToast("خطأ برمجي: " + (ev.message || "غير معروف"), "error");
  }
});
window.addEventListener("unhandledrejection", (ev) => {
  const msg = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason || "");
  console.error("PROMISE_ERR:", msg);
  if (typeof showToast === "function") {
    showToast("خطأ غير متوقع: " + msg, "error");
  }
});

window.__recordStatusMap = new Map();

(() => {
  let currentUser = null;
  let tempRecordImage = '';
  let tempBrandingImage = '';
  let liveCameraStream = null;
  let cameraTargetMode = 'scan';

  const DEFAULT_BRANDING = {
    id: 1,
    system_name: 'نظام إدارة وثائق الهوية',
    logo_data: ''
  };

  window.__copyFieldValue = async (val, label) => {
    if (!val) return;
    const text = String(val);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showToast(`تم نسخ ${label}`, "success");
    } catch {
      showToast("تعذر النسخ التلقائي", "info");
    }
  };

  (function injectStatCardStyles() {
    if (document.getElementById("statCardAnimationStyle")) return;
    const style = document.createElement("style");
    style.id = "statCardAnimationStyle";
    style.textContent = `
      @keyframes statPopPulse {
        0% { transform: scale(1); }
        45% { transform: scale(1.035); }
        100% { transform: scale(1.015); }
      }
      .stat-card-interactive {
        transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.22s ease, border-color 0.22s ease, background-color 0.22s ease;
        cursor: pointer;
        user-select: none;
        position: relative;
      }
      .stat-card-interactive:active {
        transform: scale(0.97);
      }
      .stat-card-active {
        animation: statPopPulse 0.32s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        transform: scale(1.015);
      }
    `;
    document.head.appendChild(style);
  })();

  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    const colors = {
      info: 'bg-slate-900 text-white',
      success: 'bg-emerald-600 text-white',
      error: 'bg-rose-600 text-white',
      warning: 'bg-amber-600 text-white'
    };
    el.className = `px-4 py-3 rounded-2xl shadow-lg text-sm font-bold pointer-events-auto ${colors[type] || colors.info}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
  window.showToast = showToast;

  // دالة موحدة لتحميل أو مشاركة الملفات في المتصفح وتطبيق الأندرويد WebView
  async function saveOrShareFile(blob, filename, mimeType) {
    try {
      const file = new File([blob], filename, { type: mimeType });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
        await navigator.share({
          files: [file],
          title: filename
        });
        showToast(`تم تجهيز ومشاركة الملف: ${filename}`, "success");
        return true;
      }
    } catch (shareErr) {
      if (shareErr && shareErr.name === "AbortError") return false;
    }

    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1500);
      showToast(`تم حفظ الملف في التنزيلات (Downloads): ${filename}`, "success");
      return true;
    } catch {
      // بديل Data URL لـ WebView
      const reader = new FileReader();
      reader.onload = () => {
        const a = document.createElement("a");
        a.href = reader.result;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast(`تم تنزيل الملف: ${filename}`, "success");
      };
      reader.readAsDataURL(blob);
      return true;
    }
  }
  window.__saveOrShareFile = saveOrShareFile;

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function stopLiveCamera() {
    if (liveCameraStream) {
      liveCameraStream.getTracks().forEach((t) => t.stop());
      liveCameraStream = null;
    }
    const box = document.getElementById('liveCameraBox');
    const video = document.getElementById('liveCameraVideo');
    if (video) video.srcObject = null;
    if (box) {
      box.classList.add('hidden');
      const scanAnchor = document.getElementById('scanCropBox');
      if (scanAnchor && scanAnchor.parentElement && box.parentElement !== scanAnchor.parentElement) {
        scanAnchor.parentElement.insertBefore(box, scanAnchor);
      }
    }
  }

  function triggerNativeCameraInput(mode = 'scan') {
    const fallbackInput = mode === 'record'
      ? document.getElementById('recordImageInput')
      : document.getElementById('scanFileInput');
    if (!fallbackInput) return;
    fallbackInput.setAttribute('accept', 'image/*');
    fallbackInput.setAttribute('capture', 'environment');
    fallbackInput.click();
  }

  async function startLiveCamera(mode = 'scan') {
    cameraTargetMode = mode;
    const box = document.getElementById('liveCameraBox');
    const video = document.getElementById('liveCameraVideo');

    // محاولة استخدام كاميرا Capacitor الأصلية إذا كانت متوفرة
    try {
      const capCam = window.Capacitor?.Plugins?.Camera;
      if (capCam && typeof capCam.getPhoto === 'function') {
        const photo = await capCam.getPhoto({
          quality: 90,
          allowEditing: false,
          resultType: 'dataUrl',
          source: 'CAMERA'
        });
        if (photo && photo.dataUrl) {
          await handleCapturedImageDataUrl(photo.dataUrl, mode === 'scan');
          return;
        }
      }
    } catch (capErr) {
      if (String(capErr?.message || '').toLowerCase().includes('cancel')) return;
    }

    if (!box || !video || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      triggerNativeCameraInput(mode);
      return;
    }

    try {
      await stopLiveCamera();
      liveCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      if (mode === "record") {
        const recordImgPreview = document.getElementById("recordImagePreview");
        const recordParent = recordImgPreview?.parentElement;
        if (recordParent && box.parentElement !== recordParent) {
          recordParent.appendChild(box);
        }
      } else {
        const scanAnchor = document.getElementById("scanCropBox");
        if (scanAnchor && scanAnchor.parentElement && box.parentElement !== scanAnchor.parentElement) {
          scanAnchor.parentElement.insertBefore(box, scanAnchor);
        }
      }
      video.setAttribute('playsinline', 'true');
      video.setAttribute('autoplay', 'true');
      video.muted = true;
      video.srcObject = liveCameraStream;
      box.classList.remove('hidden');
      await video.play();
    } catch {
      showToast("تعذر فتح البث المباشر، يتم فتح كاميرا الهاتف...", "info");
      triggerNativeCameraInput(mode);
    }
  }

  let cropSourceImage = null;
  let cropDataUrl = "";
  let cropRect = null;
  let isDraggingCrop = false;
  let cropDragStart = null;

  function renderCropCanvas() {
    const canvas = document.getElementById("scanCropCanvas");
    if (!canvas || !cropSourceImage) return;

    const maxW = Math.min(520, (canvas.parentElement?.clientWidth || 500) - 8);
    const maxH = 280;
    const imgW = cropSourceImage.naturalWidth || cropSourceImage.width;
    const imgH = cropSourceImage.naturalHeight || cropSourceImage.height;
    if (!imgW || !imgH) return;

    const scale = Math.min(maxW / imgW, maxH / imgH, 1.5);
    canvas.width = Math.max(1, Math.round(imgW * scale));
    canvas.height = Math.max(1, Math.round(imgH * scale));

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(cropSourceImage, 0, 0, canvas.width, canvas.height);

    if (cropRect && cropRect.w > 4 && cropRect.h > 4) {
      ctx.save();
      ctx.fillStyle = "rgba(15, 23, 42, 0.55)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.clearRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      ctx.drawImage(
        cropSourceImage,
        (cropRect.x / canvas.width) * imgW,
        (cropRect.y / canvas.height) * imgH,
        (cropRect.w / canvas.width) * imgW,
        (cropRect.h / canvas.height) * imgH,
        cropRect.x,
        cropRect.y,
        cropRect.w,
        cropRect.h
      );
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      ctx.restore();
    }
  }

  function openCropBoxWithImage(dataUrl) {
    cropDataUrl = dataUrl;
    cropRect = null;
    const box = document.getElementById("scanCropBox");
    const img = new Image();
    img.onload = () => {
      cropSourceImage = img;
      if (box) box.classList.remove("hidden");
      renderCropCanvas();
    };
    img.src = dataUrl;
  }

  function getCroppedRegionDataUrl() {
    const canvas = document.getElementById("scanCropCanvas");
    if (!cropSourceImage || !canvas || !cropRect || cropRect.w < 8 || cropRect.h < 8) {
      return cropDataUrl;
    }

    const imgW = cropSourceImage.naturalWidth || cropSourceImage.width;
    const imgH = cropSourceImage.naturalHeight || cropSourceImage.height;

    const sx = Math.max(0, Math.round((cropRect.x / canvas.width) * imgW));
    const sy = Math.max(0, Math.round((cropRect.y / canvas.height) * imgH));
    const sw = Math.min(imgW - sx, Math.round((cropRect.w / canvas.width) * imgW));
    const sh = Math.min(imgH - sy, Math.round((cropRect.h / canvas.height) * imgH));

    if (sw < 10 || sh < 10) return cropDataUrl;

    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    out.getContext("2d").drawImage(cropSourceImage, sx, sy, sw, sh, 0, 0, sw, sh);
    return out.toDataURL("image/png");
  }

  async function runOcrOnImage(targetDataUrl, appendMode = false) {
    const textArea = document.getElementById("scanRawText");
    if (!textArea || !SilentOCREngine.recognizeImage) return;

    textArea.placeholder = "جارٍ قراءة النص من الصورة...";
    try {
      const recognized = await SilentOCREngine.recognizeImage(targetDataUrl);
      if (recognized) {
        textArea.value = appendMode && textArea.value.trim()
          ? `${textArea.value.trim()}\n${recognized}`
          : recognized;
        showToast("تمت قراءة النص بنجاح، يمكنك مراجعته أو نقله للنموذج", "info");
      } else {
        showToast("لم يتم العثور على نص واضح في الجزء المحدد", "warning");
      }
    } catch (err) {
      showToast(err?.message || "تعذر إتمام المسح الضوئي", "error");
    } finally {
      textArea.placeholder = "";
    }
  }

  async function handleCapturedImageDataUrl(dataUrl, autoOcr = false) {
    if (!dataUrl) return;
    tempRecordImage = dataUrl;

    if (cameraTargetMode === "record") {
      const img = document.getElementById("recordImagePreview");
      if (img) {
        img.src = dataUrl;
        img.classList.remove("hidden");
      }
      return;
    }

    if (autoOcr) {
      openCropBoxWithImage(dataUrl);
      showToast("حدّد الجزء المطلوب من البطاقة ثم اضغط قراءة الجزء المحدد أو قراءة البطاقة كاملة", "info");
    }
  }

  async function loadBranding() {
    let settings = await IDVaultDB.getSettings();
    if (!settings) settings = { ...DEFAULT_BRANDING };

    document.title = settings.system_name || DEFAULT_BRANDING.system_name;
    document.getElementById('loginSystemName').textContent = settings.system_name;
    document.getElementById('headerSystemName').textContent = settings.system_name;
    document.getElementById('brandingSystemName').value = settings.system_name;

    ['loginBrandVisual', 'headerBrandVisual'].forEach((id) => {
      const box = document.getElementById(id);
      if (!box) return;
      if (settings.logo_data) {
        box.innerHTML = `<img src="${settings.logo_data}" alt="" class="w-full h-full object-cover" />`;
      } else {
        box.innerHTML = `<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>`;
      }
    });
  }

  function applyRolePermissions(user) {
    const isAdmin = user.role === 'admin';
    const canWrite = user.role === 'admin' || user.role === 'writer';

    document.querySelectorAll('[data-admin-only="true"]').forEach((el) => {
      el.classList.toggle('hidden', !isAdmin);
    });
    document.querySelectorAll('[data-write-only="true"]').forEach((el) => {
      el.classList.toggle('hidden', !canWrite);
    });

    const roleLabels = { admin: 'مدير', writer: 'كاتب', reader: 'قارئ' };
    document.getElementById('currentUserDisplay').textContent = user.full_name;
    document.getElementById('currentRoleBadge').textContent = roleLabels[user.role] || user.role;
  }

  function getExpiryStatus(expiryDate) {
    if (!expiryDate) return { label: 'غير محدد', cls: 'bg-slate-100 text-slate-600' };
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const exp = new Date(expiryDate);
    const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return { label: 'منتهية', cls: 'bg-rose-100 text-rose-700' };
    if (diffDays <= 30) return { label: `تنتهي خلال ${diffDays} يوم`, cls: 'bg-amber-100 text-amber-800' };
    return { label: 'سارية', cls: 'bg-emerald-100 text-emerald-700' };
  }

  // دالة موحدة للتحقق هل السجل "عسكري بهوية مدنية"
  window.__isRecordMilitaryCivil = function(r) {
    if (!r || typeof r !== 'object') return false;
    const st = String(r.military_status || '').trim();
    const dt = String(r.doc_type || '').trim();
    const isMil = st === 'عسكري' || /عسكري|عسكرية|جيش|أمن|شرطة/i.test(dt);
    const hasCivilDoc = dt && !/عسكري|عسكرية|جيش|أمن|شرطة/i.test(dt);
    return isMil && hasCivilDoc;
  };

  window.__getFilteredRecordsList = function(sourceRecords) {
    const records = Array.isArray(sourceRecords) ? sourceRecords : (window.__allIdentityRecords || []);
    const q = (document.getElementById('searchQuery')?.value || '').trim().toLowerCase();
    const phoneQ = (document.getElementById('searchPhone')?.value || '').trim();
    const typeSel = document.getElementById('filterDocType');
    const typeQ = (typeSel?.value || '').trim();
    const typeLabel = (typeSel?.selectedOptions?.[0]?.textContent || '').trim();
    const quickMilCivilBtn = document.getElementById('quickFilterMilCivilBtn');
    const isQuickMilCivil = quickMilCivilBtn && quickMilCivilBtn.dataset.active === '1';
    const isDropdownMilCivil = typeQ === '__mil_civil_doc__' || /عسكري.*هوية\s*مدنية/i.test(typeQ + ' ' + typeLabel);

    const __nowRef = new Date();
    __nowRef.setHours(0, 0, 0, 0);

    return records.filter((r) => {
      const mode = window.__activeStatMode || "all";
      if (mode === "military") {
        if (r.military_status !== "عسكري") return false;
      } else if (mode === "expiring") {
        if (!r.expiry_date) return false;
        const diff = Math.ceil((new Date(r.expiry_date) - __nowRef) / (1000 * 60 * 60 * 24));
        if (!(diff >= 0 && diff <= 30)) return false;
      } else if (mode === "expired") {
        if (!r.expiry_date) return false;
        const diff = Math.ceil((new Date(r.expiry_date) - __nowRef) / (1000 * 60 * 60 * 24));
        if (!(diff < 0)) return false;
      }
      if (window.__militaryFilterActive && r.military_status !== "عسكري") {
        return false;
      }
      if (isQuickMilCivil || isDropdownMilCivil) {
        if (!window.__isRecordMilitaryCivil(r)) return false;
      } else if (typeQ) {
        if (String(r.doc_type || '').trim() !== typeQ) return false;
      }
      const matchText = !q ||
        String(r.full_name || '').toLowerCase().includes(q) ||
        String(r.doc_number || '').toLowerCase().includes(q);
      const matchPhone = !phoneQ || String(r.phone || '').includes(phoneQ);
      return matchText && matchPhone;
    });
  };

  async function renderAll() {
    const records = await IDVaultDB.getAll('identity_records');

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    let militaryCount = 0;
    let expiringCount = 0;
    let expiredCount = 0;

    window.__recordStatusMap.clear();
    for (const r of records) {
      const isMil = r.military_status === 'عسكري';
      if (isMil) militaryCount++;
      let expState = "valid";
      if (r.expiry_date) {
        const diff = Math.ceil((new Date(r.expiry_date) - now) / (1000 * 60 * 60 * 24));
        if (diff < 0) { expiredCount++; expState = "expired"; }
        else if (diff <= 30) { expiringCount++; expState = "expiring"; }
      }
      const keyByNum = String(r.doc_number || "").trim();
      const keyByName = String(r.full_name || "").trim();
      const info = { isMilitary: isMil, militaryStatus: r.military_status || "مدني", expState };
      if (keyByNum) window.__recordStatusMap.set("num:" + keyByNum, info);
      if (keyByName) window.__recordStatusMap.set("name:" + keyByName, info);
    }

    document.getElementById('statTotal').textContent = records.length;
    document.getElementById('statMilitary').textContent = militaryCount;
    document.getElementById('statExpiring').textContent = expiringCount;
    document.getElementById('statExpired').textContent = expiredCount;

    window.__allIdentityRecords = Array.isArray(records) ? records.slice() : [];
    const filtered = window.__getFilteredRecordsList(records);

    const tbody = document.getElementById('recordsTableBody');
    const canWrite = currentUser.role === 'admin' || currentUser.role === 'writer';

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-slate-400 font-semibold">لا توجد سجلات مطابقة</td></tr>`;
    } else {
      tbody.innerHTML = filtered.map((r) => {
        const exp = getExpiryStatus(r.expiry_date);
        return `
          <tr class="hover:bg-slate-50/80 smooth-transition">
            <td class="py-3 px-4 font-bold text-slate-800">${escapeHtml(r.full_name)}</td>
            <td class="py-3 px-4 text-slate-600">${escapeHtml(r.doc_type)}</td>
            <td class="py-3 px-4 font-mono text-xs text-slate-700">${escapeHtml(r.doc_number)}</td>
            <td class="py-3 px-4 text-slate-600">${escapeHtml(r.phone || '-')}</td>
            <td class="py-3 px-4 text-slate-600">${escapeHtml(r.destination_place || '-')}</td>
            <td class="py-3 px-4"><span class="px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${exp.cls}">${exp.label}</span></td>
            <td class="py-3 px-4 text-center whitespace-nowrap">
              <button onclick="AppActions.viewRecord(${r.id})" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold cursor-pointer">عرض</button>
              ${canWrite ? `<button onclick="AppActions.editRecord(${r.id})" class="px-2.5 py-1 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-bold cursor-pointer">تعديل</button>` : ''}
              ${canWrite ? `<button onclick="AppActions.deleteRecord(${r.id})" class="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold cursor-pointer">حذف</button>` : ''}
            </td>
          </tr>
        `;
      }).join('');
    }

    window.__recordsByLookup = { byDoc: {}, byName: {} };
    for (const __rec of (records || [])) {
      if (__rec && __rec.doc_number) window.__recordsByLookup.byDoc[String(__rec.doc_number).trim()] = __rec;
      if (__rec && __rec.full_name) window.__recordsByLookup.byName[String(__rec.full_name).trim()] = __rec;
    }
    renderAnalytics(records);
    if (currentUser.role === 'admin') {
      await renderUsers();
      await renderAudit();
    }
  }
  window.__renderAllRecords = renderAll;

  function renderAnalytics(records) {
    const types = ['بطاقة شخصية إلكترونية', 'بطاقة شخصية قديمة', 'جواز سفر', 'بطاقة عسكرية'];
    const total = records.length || 1;
    const container = document.getElementById('typeDistributionBars');
    if (!container) return;

    const standardBars = types.map((t) => {
      const count = records.filter((r) => String(r.doc_type || '').trim() === t).length;
      const pct = records.length > 0 ? Math.round((count / total) * 100) : 0;
      return `
        <div>
          <div class="flex justify-between text-xs font-bold text-slate-700 mb-1.5">
            <span>${t}</span>
            <span>${count} (${pct}%)</span>
          </div>
          <div class="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full bg-indigo-600 rounded-full" style="width:${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');

    const milCivilCount = records.filter((r) => window.__isRecordMilitaryCivil(r)).length;
    const milCivilPct = records.length > 0 ? Math.round((milCivilCount / total) * 100) : 0;
    const milCivilBar = `
      <div class="pt-2 border-t border-slate-100">
        <div class="flex justify-between text-xs font-bold text-rose-700 mb-1.5">
          <span>عسكري بهوية مدنية</span>
          <span>${milCivilCount} (${milCivilPct}%)</span>
        </div>
        <div class="w-full h-2.5 bg-rose-100 rounded-full overflow-hidden">
          <div class="h-full bg-rose-600 rounded-full" style="width:${milCivilPct}%"></div>
        </div>
      </div>
    `;

    container.innerHTML = standardBars + milCivilBar;
  }

  async function renderUsers() {
    const users = await IDVaultDB.getAll('users');
    const roleNames = { admin: 'مدير', writer: 'كاتب', reader: 'قارئ' };
    document.getElementById('usersTableBody').innerHTML = users.map((u) => `
      <tr>
        <td class="py-3 px-4 font-bold text-slate-800">${escapeHtml(u.full_name)}</td>
        <td class="py-3 px-4 font-mono text-xs text-slate-600">${escapeHtml(u.username)}</td>
        <td class="py-3 px-4"><span class="px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-indigo-50 text-indigo-700">${roleNames[u.role] || u.role}</span></td>
        <td class="py-3 px-4 text-center">
          ${u.username === 'admin' ? '<span class="text-xs text-slate-400">افتراضي</span>' : `
            <button onclick="AppActions.changeRole(${u.id})" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-bold cursor-pointer">تغيير الصلاحية</button>
            <button onclick="AppActions.deleteUser(${u.id})" class="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold cursor-pointer">حذف</button>
          `}
        </td>
      </tr>
    `).join('');
  }

  async function renderAudit() {
    const logs = await IDVaultDB.getAll('audit_logs');
    document.getElementById('auditTableBody').innerHTML = logs.map((l) => `
      <tr>
        <td class="py-3 px-4 text-xs text-slate-500">${new Date(l.created_at).toLocaleString('ar')}</td>
        <td class="py-3 px-4 font-bold text-slate-700">${escapeHtml(l.actor)}</td>
        <td class="py-3 px-4 font-mono text-xs text-indigo-700">${escapeHtml(l.action_type || l.actionType || '')}</td>
        <td class="py-3 px-4 text-slate-600">${escapeHtml(l.details || '')}</td>
      </tr>
    `).join('');
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }
  async function closeModal(id) {
    if (id === 'scanModal' || id === 'recordModal') {
      await stopLiveCamera();
    }
    document.getElementById(id).classList.add('hidden');
  }

  function resetRecordForm() {
    document.getElementById('recordForm').reset();
    document.getElementById('recordId').value = '';
    document.getElementById('recordModalTitle').textContent = 'إضافة وثيقة';
    document.getElementById('militaryExtraFields').classList.add('hidden');
    tempRecordImage = '';
    const img = document.getElementById('recordImagePreview');
    img.src = '';
    img.classList.add('hidden');
  }

  window.AppActions = {
    async viewRecord(id) {
      const r = await IDVaultDB.getById('identity_records', id);
      if (!r) return;
      const rows = [
        ['الاسم الكامل', r.full_name],
        ['نوع الهوية', r.doc_type],
        ['رقم الوثيقة', r.doc_number],
        ['تاريخ الميلاد', r.birth_date],
        ['محل الميلاد', r.birth_place],
        ['تاريخ الإصدار', r.issue_date],
        ['تاريخ الانتهاء', r.expiry_date],
        ['المهنة', r.profession],
        ['رقم الجوال', r.phone],
        ['السكن الحالي', r.address],
        ['حالة العسكرية', r.military_status],
        ['الرتبة العسكرية', r.military_rank],
        ['الرقم العسكري', r.military_number],
        ['مكان الوجهة', r.destination_place],
        ['سبب الوجهة', r.destination_reason]
      ].filter(([, v]) => v);

      document.getElementById('viewModalBody').innerHTML = `
        ${r.doc_image_data ? `<img src="${r.doc_image_data}" alt="" class="w-full max-h-60 object-contain rounded-2xl bg-slate-50 border border-slate-200 mb-3" />` : ''}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          ${rows.map(([k, v]) => `
            <div class="p-3 rounded-xl bg-slate-50 border border-slate-100">
              <div class="text-xs text-slate-400 font-semibold">${k}</div>
              <div class="font-bold text-slate-800 mt-0.5">${escapeHtml(v)}</div>
            </div>
          `).join('')}
        </div>
      `;
      openModal('viewModal');
    },
    async editRecord(id) {
      const r = await IDVaultDB.getById('identity_records', id);
      if (!r) return;
      resetRecordForm();
      document.getElementById('recordModalTitle').textContent = 'تعديل وثيقة';
      document.getElementById('recordId').value = r.id;
      document.getElementById('recFullName').value = r.full_name || '';
      document.getElementById('recDocType').value = r.doc_type || 'بطاقة شخصية إلكترونية';
      document.getElementById('recDocNumber').value = r.doc_number || '';
      document.getElementById('recBirthDate').value = r.birth_date || '';
      document.getElementById('recBirthPlace').value = r.birth_place || '';
      document.getElementById('recIssueDate').value = r.issue_date || '';
      document.getElementById('recExpiryDate').value = r.expiry_date || '';
      document.getElementById('recProfession').value = r.profession || '';
      document.getElementById('recPhone').value = r.phone || '';
      document.getElementById('recAddress').value = r.address || '';
      document.getElementById('recMilitaryStatus').value = r.military_status || 'مدني';
      document.getElementById('recMilitaryRank').value = r.military_rank || '';
      document.getElementById('recMilitaryNumber').value = r.military_number || '';
      document.getElementById('recDestinationPlace').value = r.destination_place || '';
      document.getElementById('recDestinationReason').value = r.destination_reason || '';

      if (r.military_status === 'عسكري') {
        document.getElementById('militaryExtraFields').classList.remove('hidden');
      }
      if (r.doc_image_data) {
        tempRecordImage = r.doc_image_data;
        const img = document.getElementById('recordImagePreview');
        img.src = r.doc_image_data;
        img.classList.remove('hidden');
      }
      openModal('recordModal');
    },
    async deleteRecord(id) {
      await IDVaultDB.remove('identity_records', id);
      showToast('تم حذف السجل', 'success');
      await renderAll();
    },
    async changeRole(userId) {
      const u = await IDVaultDB.getById('users', userId);
      if (!u || u.username === 'admin') return;
      const order = ['reader', 'writer', 'admin'];
      const nextRole = order[(order.indexOf(u.role) + 1) % order.length];
      await IDVaultDB.put('users', { id: u.id, role: nextRole });
      showToast('تم تحديث الصلاحية', 'success');
      await renderUsers();
    },
    async deleteUser(userId) {
      const u = await IDVaultDB.getById('users', userId);
      if (!u || u.username === 'admin') return;
      await IDVaultDB.remove('users', userId);
      showToast('تم حذف المستخدم', 'success');
      await renderUsers();
    }
  };

  function mapRecordsToExportRows(recordsList) {
    return (recordsList || []).map((r) => ({
      "الاسم الكامل": r.full_name || "",
      "نوع الهوية": r.doc_type || "بطاقة شخصية إلكترونية",
      "رقم الهوية": r.doc_number || "",
      "تاريخ الميلاد": r.birth_date || "",
      "محل الميلاد": r.birth_place || "",
      "تاريخ الإصدار": r.issue_date || "",
      "تاريخ الانتهاء": r.expiry_date || "",
      "المهنة": r.profession || "",
      "رقم الهاتف": r.phone || "",
      "العنوان": r.address || "",
      "الحالة العسكرية": r.military_status || "مدني",
      "الرتبة العسكرية": r.military_rank || "",
      "الرقم العسكري": r.military_number || "",
      "مكان الوجهة": r.destination_place || "",
      "سبب الوجهة": r.destination_reason || ""
    }));
  }

  async function exportRecordsToExcelFile(recordsList, filePrefix) {
    const list = Array.isArray(recordsList) ? recordsList : [];
    if (!list.length) {
      showToast("لا توجد سجلات لتصديرها", "warning");
      return;
    }
    const rows = mapRecordsToExportRows(list);
    if (typeof XLSX !== "undefined") {
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "الوثائق");
      const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      await saveOrShareFile(blob, `${filePrefix}_${new Date().toISOString().slice(0, 10)}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } else {
      const headers = Object.keys(rows[0]);
      const csvRows = [headers.join(",")];
      for (const row of rows) {
        csvRows.push(headers.map((h) => `"${String(row[h] || "").replace(/"/g, '""')}"`).join(","));
      }
      const bom = String.fromCharCode(0xFEFF);
      const blob = new Blob([bom + csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
      await saveOrShareFile(blob, `${filePrefix}_${new Date().toISOString().slice(0, 10)}.csv`, "text/csv;charset=utf-8;");
    }
  }
  window.__exportFilteredRecordsNow = async () => {
    const all = window.__allIdentityRecords.length ? window.__allIdentityRecords : await IDVaultDB.getAll('identity_records');
    const filtered = window.__getFilteredRecordsList(all);
    await exportRecordsToExcelFile(filtered, "identity_filtered");
  };

  async function enterMainApp(session) {
    if (!session) return;
    currentUser = session;
    window.currentUser = session;
    try {
      sessionStorage.setItem('idvault_session', JSON.stringify(session));
      localStorage.setItem('idvault_session_backup', JSON.stringify(session));
    } catch {}
    try {
      if (IDVaultDB && typeof IDVaultDB.setActor === "function") {
        IDVaultDB.setActor(session.username);
      }
    } catch {}

    const loginEl = document.getElementById('loginScreen');
    const shellEl = document.getElementById('appShell');
    if (loginEl) loginEl.classList.add('hidden');
    if (shellEl) shellEl.classList.remove('hidden');

    try {
      applyRolePermissions(currentUser);
    } catch (err) {
      console.error("applyRolePermissions error:", err);
    }

    try {
      if (typeof SilentOCREngine !== "undefined" && SilentOCREngine && typeof SilentOCREngine.refreshMemory === "function") {
        await SilentOCREngine.refreshMemory();
      }
    } catch (err) {
      console.error("SilentOCREngine error:", err);
    }

    try {
      await renderAll();
    } catch (err) {
      console.error("renderAll error:", err);
      showToast("تم الدخول، وحدث تنبيه أثناء تحميل بعض البيانات", "info");
    }
  }

  function bindEvents() {
    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const u = document.getElementById('loginUsername').value;
      const p = document.getElementById('loginPassword').value;
      try {
        const session = await AuthModule.login(u, p);
        if (!session) {
          showToast('بيانات الدخول غير صحيحة', 'error');
          return;
        }
        await enterMainApp(session);
      } catch (err) {
        showToast(err.message || 'تعذر تسجيل الدخول', 'error');
      }
    });

    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await stopLiveCamera();
      AuthModule.logout();
      currentUser = null;
      window.currentUser = null;
      document.getElementById('appShell').classList.add('hidden');
      document.getElementById('loginScreen').classList.remove('hidden');
      document.getElementById('loginForm').reset();
    });

    document.querySelectorAll('.nav-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach((t) => {
          t.classList.remove('bg-indigo-600', 'text-white');
          t.classList.add('text-slate-600', 'hover:bg-slate-100');
        });
        tab.classList.add('bg-indigo-600', 'text-white');
        tab.classList.remove('text-slate-600', 'hover:bg-slate-100');

        const target = tab.dataset.tab;
        document.querySelectorAll('main > section').forEach((sec) => sec.classList.add('hidden'));
        document.getElementById(`tab-${target}`).classList.remove('hidden');
        if (target === 'analytics' && window.__allIdentityRecords.length) {
          renderAnalytics(window.__allIdentityRecords);
        }
      });
    });

    ['searchQuery', 'searchPhone', 'filterDocType'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', renderAll);
      el.addEventListener('change', renderAll);
    });

    document.getElementById('openAddModalBtn').addEventListener('click', () => {
      resetRecordForm();
      openModal('recordModal');
    });

    document.getElementById('openRecordCameraBtn')?.addEventListener('click', () => {
      startLiveCamera('record');
    });

    document.getElementById('openScanCameraBtn')?.addEventListener('click', () => {
      startLiveCamera('scan');
    });

    document.getElementById('stopCameraBtn')?.addEventListener('click', () => {
      stopLiveCamera();
    });

    document.getElementById('snapCameraBtn')?.addEventListener('click', async () => {
      const video = document.getElementById('liveCameraVideo');
      if (!video || !video.videoWidth) return;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      await stopLiveCamera();
      await handleCapturedImageDataUrl(dataUrl, cameraTargetMode === 'scan');
    });

    document.getElementById('recMilitaryStatus').addEventListener('change', (e) => {
      document.getElementById('militaryExtraFields').classList.toggle('hidden', e.target.value !== 'عسكري');
    });

    document.getElementById('recordImageInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      cameraTargetMode = 'record';
      const dataUrl = await fileToBase64(file);
      await handleCapturedImageDataUrl(dataUrl, false);
    });

    document.getElementById('recordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const idVal = document.getElementById('recordId').value;
      const docNumber = document.getElementById('recDocNumber').value.trim();

      const payload = {
        full_name: document.getElementById('recFullName').value.trim(),
        doc_type: document.getElementById('recDocType').value,
        doc_number: docNumber,
        birth_date: document.getElementById('recBirthDate').value,
        birth_place: document.getElementById('recBirthPlace').value.trim(),
        issue_date: document.getElementById('recIssueDate').value,
        expiry_date: document.getElementById('recExpiryDate').value,
        profession: document.getElementById('recProfession').value.trim(),
        phone: document.getElementById('recPhone').value.trim(),
        address: document.getElementById('recAddress').value.trim(),
        military_status: document.getElementById('recMilitaryStatus').value,
        military_rank: document.getElementById('recMilitaryRank').value.trim(),
        military_number: document.getElementById('recMilitaryNumber').value.trim(),
        destination_place: document.getElementById('recDestinationPlace').value.trim(),
        destination_reason: document.getElementById('recDestinationReason').value.trim(),
        doc_image_data: tempRecordImage
      };

      try {
        if (idVal) {
          payload.id = Number(idVal);
          await IDVaultDB.put('identity_records', payload);
          showToast('تم تحديث الوثيقة', 'success');
        } else {
          await IDVaultDB.add('identity_records', payload);
          showToast('تم حفظ الوثيقة', 'success');
        }
        await SilentOCREngine.learnSilently(payload);
        closeModal('recordModal');
        await renderAll();
      } catch (err) {
        showToast(err.message || 'تعذر حفظ الوثيقة', 'error');
      }
    });

    document.getElementById('openScanModalBtn').addEventListener('click', () => {
      document.getElementById('scanFileInput').value = '';
      document.getElementById('scanRawText').value = '';
      tempRecordImage = '';
      cropSourceImage = null;
      cropDataUrl = '';
      cropRect = null;
      isDraggingCrop = false;
      cropDragStart = null;
      const cropBox = document.getElementById('scanCropBox');
      if (cropBox) cropBox.classList.add('hidden');
      const cropCanvas = document.getElementById('scanCropCanvas');
      if (cropCanvas) {
        const ctx = cropCanvas.getContext('2d');
        ctx?.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
      }
      cameraTargetMode = 'scan';
      openModal('scanModal');
    });

    const scanCropCanvas = document.getElementById("scanCropCanvas");
    const getCanvasPoint = (e) => {
      const rect = scanCropCanvas.getBoundingClientRect();
      const clientX = e.touches?.[0]?.clientX ?? e.clientX;
      const clientY = e.touches?.[0]?.clientY ?? e.clientY;
      return {
        x: Math.max(0, Math.min(scanCropCanvas.width, ((clientX - rect.left) / rect.width) * scanCropCanvas.width)),
        y: Math.max(0, Math.min(scanCropCanvas.height, ((clientY - rect.top) / rect.height) * scanCropCanvas.height))
      };
    };

    scanCropCanvas?.addEventListener("pointerdown", (e) => {
      if (!cropSourceImage) return;
      isDraggingCrop = true;
      cropDragStart = getCanvasPoint(e);
      cropRect = { x: cropDragStart.x, y: cropDragStart.y, w: 0, h: 0 };
      renderCropCanvas();
    });

    window.addEventListener("pointermove", (e) => {
      if (!isDraggingCrop || !cropDragStart) return;
      const pt = getCanvasPoint(e);
      cropRect = {
        x: Math.min(cropDragStart.x, pt.x),
        y: Math.min(cropDragStart.y, pt.y),
        w: Math.abs(pt.x - cropDragStart.x),
        h: Math.abs(pt.y - cropDragStart.y)
      };
      renderCropCanvas();
    });

    window.addEventListener("pointerup", () => {
      isDraggingCrop = false;
      cropDragStart = null;
    });

    document.getElementById("clearCropBtn")?.addEventListener("click", () => {
      cropRect = null;
      renderCropCanvas();
    });

    document.getElementById("scanCroppedRegionBtn")?.addEventListener("click", async () => {
      if (!cropDataUrl) return;
      const cropped = getCroppedRegionDataUrl();
      await runOcrOnImage(cropped, true);
    });

    document.getElementById("scanFullImageBtn")?.addEventListener("click", async () => {
      if (!cropDataUrl) return;
      await runOcrOnImage(cropDataUrl, false);
    });

    document.getElementById('scanFileInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      cameraTargetMode = 'scan';
      const dataUrl = await fileToBase64(file);
      await handleCapturedImageDataUrl(dataUrl, true);
    });

    document.getElementById('processScanBtn').addEventListener('click', async () => {
      const raw = document.getElementById('scanRawText').value;
      if (SilentOCREngine.refreshMemory) {
        await SilentOCREngine.refreshMemory();
      }
      const extracted = SilentOCREngine.extractFields(raw);
      if (SilentOCREngine.setLastScanContext) SilentOCREngine.setLastScanContext(raw, extracted);
      const savedImg = tempRecordImage;
      resetRecordForm();
      tempRecordImage = savedImg;

      if (extracted.full_name) document.getElementById('recFullName').value = extracted.full_name;
      if (extracted.doc_type) document.getElementById('recDocType').value = extracted.doc_type;
      if (extracted.doc_number) document.getElementById('recDocNumber').value = extracted.doc_number;
      if (extracted.phone) document.getElementById('recPhone').value = extracted.phone;
      if (extracted.birth_date) document.getElementById('recBirthDate').value = extracted.birth_date;
      if (extracted.birth_place) document.getElementById('recBirthPlace').value = extracted.birth_place;
      if (extracted.issue_date) document.getElementById('recIssueDate').value = extracted.issue_date;
      if (extracted.expiry_date) document.getElementById('recExpiryDate').value = extracted.expiry_date;
      if (extracted.profession) document.getElementById('recProfession').value = extracted.profession;
      if (extracted.destination_place) document.getElementById('recDestinationPlace').value = extracted.destination_place;
      if (extracted.destination_reason) document.getElementById('recDestinationReason').value = extracted.destination_reason;
      if (extracted.military_status) {
        document.getElementById('recMilitaryStatus').value = extracted.military_status;
        document.getElementById('militaryExtraFields').classList.toggle('hidden', extracted.military_status !== 'عسكري');
      }
      if (extracted.military_rank) document.getElementById('recMilitaryRank').value = extracted.military_rank;

      if (tempRecordImage) {
        const img = document.getElementById('recordImagePreview');
        img.src = tempRecordImage;
        img.classList.remove('hidden');
      }
      await closeModal('scanModal');
      openModal('recordModal');
    });

    document.getElementById('addUserForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await IDVaultDB.add('users', {
          full_name: document.getElementById('newUserFullName').value.trim(),
          username: document.getElementById('newUsername').value.trim(),
          password: document.getElementById('newUserPassword').value,
          role: document.getElementById('newUserRole').value
        });
        document.getElementById('addUserForm').reset();
        showToast('تم إضافة المستخدم', 'success');
        await renderUsers();
      } catch (err) {
        showToast(err.message || 'تعذر إضافة المستخدم', 'error');
      }
    });

    document.getElementById('brandingLogoFile').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (file) tempBrandingImage = await fileToBase64(file);
    });

    document.getElementById('brandingForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const current = (await IDVaultDB.getSettings()) || { ...DEFAULT_BRANDING };
      const updated = {
        id: 1,
        system_name: document.getElementById('brandingSystemName').value.trim() || DEFAULT_BRANDING.system_name,
        logo_data: tempBrandingImage || current.logo_data || ''
      };
      await IDVaultDB.saveSettings(updated);
      await loadBranding();
      showToast('تم حفظ هوية النظام', 'success');
    });

    document.getElementById('resetBrandingBtn').addEventListener('click', async () => {
      tempBrandingImage = '';
      await IDVaultDB.saveSettings({ ...DEFAULT_BRANDING });
      await loadBranding();
      showToast('تمت استعادة الهوية الافتراضية', 'success');
    });

    document.getElementById('exportCsvBtn').addEventListener('click', async () => {
      const records = await IDVaultDB.getAll('identity_records');
      await exportRecordsToExcelFile(records, "identity_records");
    });

    function mapExcelRowToRecord(rawRow) {
      const pick = (keys) => {
        for (const k of keys) {
          if (rawRow[k] !== undefined && rawRow[k] !== null && String(rawRow[k]).trim() !== "") {
            return String(rawRow[k]).trim();
          }
        }
        return "";
      };

      return {
        full_name: pick(["الاسم الكامل", "الاسم", "full_name", "name"]),
        doc_type: pick(["نوع الهوية", "نوع الوثيقة", "doc_type"]) || "بطاقة شخصية إلكترونية",
        doc_number: pick(["رقم الهوية", "رقم الهوية / الجواز", "الرقم الوطني", "doc_number", "id_number"]),
        birth_date: pick(["تاريخ الميلاد", "birth_date"]),
        birth_place: pick(["محل الميلاد", "مكان الميلاد", "birth_place"]),
        issue_date: pick(["تاريخ الإصدار", "تاريخ الاصدار", "issue_date"]),
        expiry_date: pick(["تاريخ الانتهاء", "expiry_date"]),
        phone: pick(["رقم الهاتف", "الهاتف", "phone"]),
        address: pick(["العنوان", "السكن", "address"]),
        military_status: pick(["الحالة العسكرية", "الحالة", "military_status"]) || "مدني",
        military_rank: pick(["الرتبة العسكرية", "الرتبة", "military_rank"]),
        military_number: pick(["الرقم العسكري", "military_number"]),
        destination_place: pick(["مكان الوجهة", "الوجهة", "destination_place"]),
        destination_reason: pick(["سبب الوجهة", "السبب", "destination_reason"])
      };
    }

    document.getElementById('importCsvInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      let parsedRows = [];
      try {
        if (typeof XLSX !== "undefined") {
          const buffer = await file.arrayBuffer();
          const wb = XLSX.read(buffer, { type: "array" });
          const firstSheetName = wb.SheetNames[0];
          const sheet = wb.Sheets[firstSheetName];
          parsedRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        } else {
          const text = await file.text();
          const lines = text.split(/\r?\n/).filter(Boolean);
          if (lines.length < 2) return;
          const headers = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
            const row = {};
            headers.forEach((h, idx) => {
              row[h] = (cols[idx] || "").replace(/^"|"$/g, "").replace(/""/g, '"').trim();
            });
            parsedRows.push(row);
          }
        }
      } catch (err) {
        showToast("تعذر قراءة ملف Excel أو CSV", "error");
        e.target.value = "";
        return;
      }

      let added = 0;
      let updated = 0;
      const existingAll = await IDVaultDB.getAll('identity_records');
      const existingByDoc = new Map((existingAll || []).map((x) => [String(x.doc_number || "").trim(), x]));

      for (const raw of parsedRows) {
        const normalizedRaw = Object.assign({}, raw, {
          "نوع الهوية": raw["نوع الهوية"] || raw["نوع الوثيقة"] || raw.doc_type || "",
          "رقم الهوية": raw["رقم الهوية"] || raw["رقم الوثيقة"] || raw.doc_number || "",
          "رقم الهاتف": raw["رقم الهاتف"] || raw["رقم الجوال"] || raw.phone || "",
          "العنوان": raw["العنوان"] || raw["السكن الحالي"] || raw.address || "",
          "الحالة العسكرية": /عسكري/i.test(String(raw["الحالة العسكرية"] || raw["الحالة"] || raw.military_status || "") + " " + String(raw["نوع الهوية"] || raw["نوع الوثيقة"] || ""))
            ? "عسكري"
            : (raw["الحالة العسكرية"] || raw["الحالة"] || raw.military_status || "مدني")
        });
        const rec = mapExcelRowToRecord(normalizedRaw);
        if (!rec.doc_number || !rec.full_name) continue;
        if (/عسكري/i.test(String(rec.military_status || "") + " " + String(rec.doc_type || ""))) {
          rec.military_status = "عسكري";
        }
        const prev = existingByDoc.get(String(rec.doc_number).trim());
        if (prev && prev.id != null) {
          try {
            await IDVaultDB.put('identity_records', Object.assign({}, prev, rec, { id: prev.id }));
            updated++;
          } catch {}
        } else {
          try {
            await IDVaultDB.add('identity_records', rec);
            added++;
          } catch {}
        }
      }

      e.target.value = "";
      showToast(`تم استيراد ${added} سجل جديد وتحديث ${updated} سجل`, "success");
      await renderAll();
    });

    document.getElementById('downloadBackupBtn')?.addEventListener('click', async () => {
      try {
        let dump = null;
        if (typeof IDVaultDB.exportJSON === 'function') {
          dump = await IDVaultDB.exportJSON();
        }
        if (!dump) {
          const [identity_records, users, settings, audit_logs] = await Promise.all([
            IDVaultDB.getAll('identity_records').catch(() => []),
            IDVaultDB.getAll('users').catch(() => []),
            IDVaultDB.getSettings().catch(() => DEFAULT_BRANDING),
            IDVaultDB.getAll('audit_logs').catch(() => [])
          ]);
          dump = {
            exported_at: new Date().toISOString(),
            identity_records,
            users,
            settings,
            audit_logs
          };
        }
        const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
        await saveOrShareFile(blob, `idvault_backup_${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
      } catch (err) {
        showToast(err?.message || 'تعذر إنشاء النسخة الاحتياطية', 'error');
      }
    });

    document.getElementById('restoreBackupInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        await IDVaultDB.importJSON(parsed);
        await loadBranding();
        await renderAll();
        showToast('تمت استعادة النسخة الاحتياطية بنجاح', 'success');
      } catch (err) {
        showToast(err.message || 'تعذر استعادة الملف', 'error');
      } finally {
        e.target.value = '';
      }
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    try {
      await IDVaultDB.open();
      await loadBranding();
      const existingSession = AuthModule.getSession();
      if (existingSession) {
        await enterMainApp(existingSession);
      }
    } catch (err) {
      showToast(err.message || 'تعذر تهيئة الاتصال بالخادم', 'error');
    }
  });
})();

function attachQuickCopyToRows() {
  const tbody = document.getElementById("recordsTableBody");
  if (!tbody) return;
  tbody.querySelectorAll("tr").forEach((tr) => {
    if (tr.dataset.quickCopyReady === "1") return;
    const tds = Array.from(tr.querySelectorAll("td"));
    if (tds.length < 2) return;

    tds.forEach((td) => {
      if (td.querySelector("[data-quick-copy]")) return;
      const rawText = (td.textContent || "").trim();
      const match = rawText.match(/\b0?7\d{7,8}\b|\b\d{6,16}\b/);
      if (!match) return;
      const val = match[0];
      const label = /^0?7\d{7,8}$/.test(val) ? "رقم الجوال" : "رقم البطاقة";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.quickCopy = "1";
      btn.title = `نسخ ${label}`;
      btn.textContent = "نسخ";
      btn.className = "mr-1.5 px-2 py-0.5 rounded-md bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-[11px] font-bold transition align-middle cursor-pointer whitespace-nowrap";
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        window.__copyFieldValue(val, label);
      });
      td.appendChild(btn);
    });

    tr.dataset.quickCopyReady = "1";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const tbody = document.getElementById("recordsTableBody");
  if (!tbody) return;
  attachQuickCopyToRows();
  const obs = new MutationObserver(() => attachQuickCopyToRows());
  obs.observe(tbody, { childList: true, subtree: true });
});

(function initDirectStatFilterAndMotion() {
  if (window.__directStatFilterReady) return;
  window.__directStatFilterReady = true;

  let currentStatFilter = null;

  const styleId = "directStatFilterMotionStyle";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes statCardBounce {
        0% { transform: scale(1); }
        40% { transform: scale(1.04) translateY(-2px); }
        100% { transform: scale(1.015) translateY(-1px); }
      }
      .stat-box-btn {
        cursor: pointer;
        user-select: none;
        transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
      }
      .stat-box-btn:active {
        transform: scale(0.96);
      }
      .stat-box-selected {
        animation: statCardBounce 0.3s ease forwards;
        transform: scale(1.015) translateY(-1px);
      }
    `;
    document.head.appendChild(style);
  }

  const statsMap = [
    { id: "statTotal", key: null, cls: ["ring-2", "ring-slate-800", "border-slate-800", "bg-slate-50", "shadow-lg", "stat-box-selected"] },
    { id: "statMilitary", key: "military", cls: ["ring-2", "ring-indigo-600", "border-indigo-600", "bg-indigo-50/70", "shadow-lg", "shadow-indigo-600/20", "stat-box-selected"] },
    { id: "statExpiring", key: "expiring", cls: ["ring-2", "ring-amber-500", "border-amber-500", "bg-amber-50/70", "shadow-lg", "shadow-amber-500/20", "stat-box-selected"] },
    { id: "statExpired", key: "expired", cls: ["ring-2", "ring-rose-600", "border-rose-600", "bg-rose-50/70", "shadow-lg", "shadow-rose-600/20", "stat-box-selected"] }
  ];

  const allCls = Array.from(new Set(statsMap.flatMap((s) => s.cls)));
  let isFilteringRows = false;

  window.__parseLooseDate = function(val) {
    if (!val) return null;
    if (val instanceof Date && !isNaN(val.getTime())) return val;
    const s = String(val).trim();
    if (!s) return null;
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
      const dt = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
      return isNaN(dt.getTime()) ? null : dt;
    }
    const dt = new Date(s);
    return isNaN(dt.getTime()) ? null : dt;
  };

  window.__evalExpiryMatch = function(tr, kind) {
    const tds = Array.from(tr.querySelectorAll("td"));
    const nameKey = (tds[0]?.textContent || "").replace(/نسخ/g, "").trim();
    const docKey = (tds[2]?.textContent || "").replace(/نسخ/g, "").trim();
    const lookup = window.__recordsByLookup || { byDoc: {}, byName: {} };
    const rec = (docKey && lookup.byDoc[docKey]) || (nameKey && lookup.byName[nameKey]) || null;

    if (rec && rec.expiry_date) {
      const exp = window.__parseLooseDate(rec.expiry_date);
      if (exp) {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        exp.setHours(0, 0, 0, 0);
        const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
        if (kind === "expired" && diffDays < 0) return true;
        if (kind === "expiring" && diffDays >= 0 && diffDays <= 30) return true;
      }
    }

    const badgeSpans = Array.from(tr.querySelectorAll("span")).filter((sp) => {
      const t = (sp.textContent || "").trim();
      return t.includes("منته") || t.includes("تنتهي خلال") || t.includes("ينتهي خلال") || t.includes("سارية") || t.includes("ساري");
    });
    const combinedBadgeText = badgeSpans.map((b) => (b.textContent || "").trim()).join(" ");

    if (kind === "expired") {
      return /منته(?:ية|ي|اة)?/.test(combinedBadgeText) || /منته(?:ية|ي|اة)?/.test(tr.textContent || "");
    }
    if (kind === "expiring") {
      return /(تنتهي خلال|ينتهي خلال|قريب)/.test(combinedBadgeText);
    }
    return false;
  };

  window.__isRecordMilitary = function(rec) {
    try {
      if (!rec) return false;
      const st = String(rec.military_status || "").trim();
      const dt = String(rec.doc_type || "").trim();
      return st === "عسكري" || /عسكري|عسكرية|جيش|أمن|شرطة/i.test(dt);
    } catch {
      return false;
    }
  };

  window.__getMilitaryStatusBadgeHtml = function(rec, isMil, docTypeText) {
    try {
      if (!isMil) {
        return "<span style='display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:9999px;border:1px solid #cbd5e1;background:#f8fafc;color:#475569;font-weight:700;font-size:12px;'><span style='width:8px;height:8px;border-radius:9999px;background:#94a3b8;display:inline-block;'></span>مدني</span>";
      }
      const dt = String((rec && rec.doc_type) || docTypeText || "").trim();
      const hasCivilDoc = dt && !/عسكري|عسكرية|جيش|أمن|شرطة/i.test(dt);
      const label = hasCivilDoc ? "عسكري · هوية مدنية" : "عسكري";
      return "<span style='display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:9999px;border:1.5px solid #e11d48;background:#ffe4e6;color:#be123c;font-weight:800;font-size:12px;'><span style='width:8px;height:8px;border-radius:9999px;background:#e11d48;display:inline-block;'></span>" + label + "</span>";
    } catch {
      return "<span>" + (isMil ? "عسكري" : "مدني") + "</span>";
    }
  };

  const filterRowsNow = () => {
    if (isFilteringRows) return;
    isFilteringRows = true;
    try {
      const tbody = document.getElementById("recordsTableBody");
      if (!tbody) return;

      tbody.querySelectorAll("tr[data-stat-empty-row]").forEach((el) => el.remove());
      const rows = Array.from(tbody.querySelectorAll("tr"));
      if (!rows.length) return;

      if (!currentStatFilter) {
        rows.forEach((tr) => { tr.style.display = ""; });
        return;
      }

      let visibleCount = 0;
      rows.forEach((tr) => {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (tds.length < 6) {
          tr.style.display = "";
          return;
        }

        const docTypeText = (tds[1]?.textContent || "").trim();
        const fullRowText = (tr.textContent || "").trim();

        let ok = false;
        if (currentStatFilter === "military") {
          const nameKey = (tds[0]?.textContent || "").replace(/نسخ/g, "").trim();
          const docKey = (tds[2]?.textContent || "").replace(/نسخ/g, "").trim();
          const lookup = window.__recordsByLookup || { byDoc: {}, byName: {} };
          const rec = (docKey && lookup.byDoc[docKey]) || (nameKey && lookup.byName[nameKey]) || null;
          ok = window.__isRecordMilitary(rec) || /عسكري|عسكرية|جيش|أمن|شرطة/i.test(docTypeText) || /عسكري/i.test(fullRowText);
        } else if (currentStatFilter === "expiring") {
          ok = window.__evalExpiryMatch(tr, "expiring");
        } else if (currentStatFilter === "expired") {
          ok = window.__evalExpiryMatch(tr, "expired");
        }

        tr.style.display = ok ? "" : "none";
        if (ok) visibleCount++;
      });

      if (visibleCount === 0) {
        const emptyTr = document.createElement("tr");
        emptyTr.dataset.statEmptyRow = "1";
        emptyTr.innerHTML = `<td colspan="7" class="py-8 text-center text-slate-400 font-semibold">لا توجد سجلات مطابقة لهذا الفلتر</td>`;
        tbody.appendChild(emptyTr);
      }

      if (typeof attachQuickCopyToRows === "function") {
        attachQuickCopyToRows();
      }
    } finally {
      setTimeout(() => { isFilteringRows = false; }, 50);
    }
  };

  const paintStatCards = () => {
    statsMap.forEach((item) => {
      const numEl = document.getElementById(item.id);
      const card = numEl ? (numEl.closest("div.rounded-2xl") || numEl.parentElement) : null;
      if (!card) return;
      card.classList.add("stat-box-btn");
      card.classList.remove(...allCls);

      let tag = card.querySelector("[data-stat-active-tag]");
      if (!tag) {
        tag = document.createElement("span");
        tag.dataset.statActiveTag = "1";
        tag.className = "hidden mt-2 inline-block px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-600 text-white";
        card.appendChild(tag);
      }

      const isSelected = item.key !== null && currentStatFilter === item.key;
      if (isSelected) {
        card.classList.add(...item.cls);
        tag.textContent = "مفعّل الآن";
        tag.classList.remove("hidden");
      } else {
        tag.classList.add("hidden");
      }
    });

    const badge = document.getElementById("activeStatFilterBadge");
    const resetBtn = document.getElementById("resetFiltersBtn");
    if (badge) {
      if (currentStatFilter) {
        const names = {
          military: "فلتر: سجلات عسكرية",
          expiring: "فلتر: قريبة الانتهاء",
          expired: "فلتر: منتهية الصلاحية"
        };
        badge.textContent = names[currentStatFilter] || "فلتر نشط";
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }
    if (resetBtn) {
      resetBtn.classList.toggle("hidden", !currentStatFilter);
    }
  };

  const wireCards = () => {
    let wiredCount = 0;
    statsMap.forEach((item) => {
      const numEl = document.getElementById(item.id);
      const card = numEl ? (numEl.closest("div.rounded-2xl") || numEl.parentElement) : null;
      if (!card) return;
      wiredCount++;
      if (card.dataset.statWired === "1") return;
      card.dataset.statWired = "1";
      card.addEventListener("click", () => {
        if (item.key === null) {
          currentStatFilter = null;
        } else {
          currentStatFilter = currentStatFilter === item.key ? null : item.key;
        }
        paintStatCards();
        filterRowsNow();
        if (typeof showToast === "function") {
          showToast(currentStatFilter ? "تم تطبيق الفلترة على الجدول" : "تم إلغاء فلتر البطاقة", "info");
        }
      });
    });
    paintStatCards();
    return wiredCount > 0;
  };

  const resetBtn = document.getElementById("resetFiltersBtn");
  if (resetBtn && resetBtn.dataset.statResetWired !== "1") {
    resetBtn.dataset.statResetWired = "1";
    resetBtn.addEventListener("click", () => {
      currentStatFilter = null;
      paintStatCards();
      filterRowsNow();
    });
  }

  if (!wireCards()) {
    const iv = setInterval(() => {
      if (wireCards()) clearInterval(iv);
    }, 250);
    setTimeout(() => clearInterval(iv), 10000);
  }
})();

window.__renderSingleStatusColAndFilter = function() {
  const tbody = document.getElementById("recordsTableBody");
  if (!tbody) return;

  const table = tbody.closest("table");
  const theadRow = table ? table.querySelector("thead tr") : null;

  if (theadRow) {
    theadRow.querySelectorAll("[data-status-th], [data-col-status-th], [data-clean-status-th]").forEach((el) => el.remove());
    const th = document.createElement("th");
    th.setAttribute("data-clean-status-th", "1");
    th.className = "py-3 px-4 text-right font-extrabold text-slate-700 whitespace-nowrap";
    th.textContent = "الحالة";
    const ths = Array.from(theadRow.querySelectorAll("th"));
    const docTypeThIdx = ths.findIndex((h) => (h.textContent || "").includes("نوع الوثيقة"));
    if (docTypeThIdx !== -1 && ths[docTypeThIdx]) {
      ths[docTypeThIdx].insertAdjacentElement("afterend", th);
    } else if (ths.length >= 2) {
      ths[1].insertAdjacentElement("afterend", th);
    } else {
      theadRow.appendChild(th);
    }
  }

  const lookup = window.__recordsByLookup || { byDoc: {}, byName: {} };
  const rows = Array.from(tbody.querySelectorAll("tr")).filter(
    (tr) => !tr.dataset.statEmptyRow && !tr.querySelector("td[colspan]")
  );

  rows.forEach((tr) => {
    tr.querySelectorAll("[data-status-td], [data-col-status-td], [data-clean-status-td]").forEach((el) => el.remove());

    const tds = Array.from(tr.querySelectorAll("td"));
    if (tds.length < 3) return;

    const nameKey = (tds[0]?.textContent || "").trim();
    const docKey = (tds[2]?.textContent || "").replace(/نسخ/g, "").trim();
    const rec = (docKey && lookup.byDoc[docKey]) || (nameKey && lookup.byName[nameKey]) || null;
    const isMil = typeof window.__isRecordMilitary === "function" ? window.__isRecordMilitary(rec) : (rec ? rec.military_status === "عسكري" : /عسكري/i.test(tr.textContent || ""));

    tr.dataset.isMilitary = isMil ? "1" : "0";
    if (isMil) {
      tr.classList.add("ring-2", "ring-rose-500", "bg-rose-50/70");
      tr.style.borderLeft = "4px solid #e11d48";
    } else {
      tr.classList.remove("ring-2", "ring-rose-500", "bg-rose-50/70");
      tr.style.borderLeft = "";
    }

    const td = document.createElement("td");
    td.setAttribute("data-clean-status-td", "1");
    td.className = "py-3 px-4 whitespace-nowrap";
    td.innerHTML = window.__getMilitaryStatusBadgeHtml(rec, isMil, (tds[1]?.textContent || "").trim());

    tds[1].insertAdjacentElement("afterend", td);
  });
};

if (!window.__singleStatusObserverInstalled) {
  window.__singleStatusObserverInstalled = true;
  const runSync = () => {
    if (typeof window.__renderSingleStatusColAndFilter === "function") {
      window.__renderSingleStatusColAndFilter();
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    runSync();
    const tbody = document.getElementById("recordsTableBody");
    if (tbody) {
      const mo = new MutationObserver(() => {
        clearTimeout(window.__statusSyncDeb);
        window.__statusSyncDeb = setTimeout(runSync, 60);
      });
      mo.observe(tbody, { childList: true, subtree: false });
    }
  });
  setInterval(runSync, 1200);
}

window.__normalizePersonName = function(name) {
  return String(name || "")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
};

window.__checkDuplicateBeforeSave = async function(payload, ignoreId) {
  try {
    if (typeof IDVaultDB === "undefined" || !IDVaultDB || typeof IDVaultDB.getAll !== "function") {
      return true;
    }
    const existing = await IDVaultDB.getAll("identity_records");
    if (!Array.isArray(existing) || !existing.length) return true;

    const normNewName = window.__normalizePersonName(payload && payload.full_name);
    const cleanNewDoc = String((payload && payload.doc_number) || "").trim().toLowerCase();

    const others = existing.filter((item) => !ignoreId || String(item.id) !== String(ignoreId));

    if (cleanNewDoc) {
      const sameDoc = others.find((item) => String(item.doc_number || "").trim().toLowerCase() === cleanNewDoc);
      if (sameDoc) {
        const msg = "تنبيه: رقم الوثيقة (" + sameDoc.doc_number + ") مسجل مسبقاً باسم: " + (sameDoc.full_name || "غير محدد") + ". لا يمكن حفظ رقم وثيقة مكرر.";
        if (typeof showToast === "function") showToast(msg, "error");
        else alert(msg);
        return false;
      }
    }

    if (normNewName) {
      const sameNameMatches = others.filter((item) => window.__normalizePersonName(item.full_name) === normNewName);
      if (sameNameMatches.length > 0) {
        const sample = sameNameMatches[0];
        const details = "الاسم (" + payload.full_name + ") موجود مسبقاً في السجلات (" + sameNameMatches.length + " سجل)\n"
          + "مثال السجل المسجل: " + (sample.full_name || "") + " | " + (sample.doc_type || "") + " | رقم: " + (sample.doc_number || "بدون رقم") + "\n\n"
          + "هل تؤكد أن هذا شخص مختلف أو إضافة وثيقة جديدة وتريد المتابعة؟";
        const ok = window.confirm(details);
        if (!ok) {
          if (typeof showToast === "function") showToast("تم إلغاء الحفظ لوجود الاسم مسبقاً", "warning");
          return false;
        }
      }
    }

    return true;
  } catch {
    return true;
  }
};

window.__dupSubmitGuardInstalled = true;
document.addEventListener("submit", async (ev) => {
  const form = ev.target;
  if (!form || form.id !== "recordForm") return;

  if (form.dataset.dupConfirmedOnce === "1") {
    form.dataset.dupConfirmedOnce = "";
    return;
  }

  ev.preventDefault();
  ev.stopImmediatePropagation();

  const nameEl = document.getElementById("recFullName");
  const docEl = document.getElementById("recDocNumber");
  const typeEl = document.getElementById("recDocType");
  const idEl = document.getElementById("recordId");

  const allowed = await window.__checkDuplicateBeforeSave({
    full_name: nameEl ? nameEl.value || "" : "",
    doc_number: docEl ? docEl.value || "" : "",
    doc_type: typeEl ? typeEl.value || "" : ""
  }, idEl && idEl.value ? idEl.value : null);

  if (allowed) {
    form.dataset.dupConfirmedOnce = "1";
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.submit();
    }
  }
}, true);

window.__isMilitaryDocSelected = function() {
  const docSel = document.getElementById("recDocType");
  if (!docSel) return false;
  const docVal = String(docSel.value || "");
  const docLabel = String(docSel.selectedOptions?.[0]?.textContent || "");
  return /عسكري|عسكرية|جيش|أمن|شرطة/i.test(docVal + " " + docLabel);
};

window.__syncDocTypeToMilitaryStatus = function() {
  const docSel = document.getElementById("recDocType");
  const statusSel = document.getElementById("recMilitaryStatus");
  const extraFields = document.getElementById("militaryExtraFields");
  if (!docSel || !statusSel) return;

  const lockedMilitary = window.__isMilitaryDocSelected();

  if (lockedMilitary) {
    statusSel.value = "عسكري";
    statusSel.disabled = true;
    statusSel.classList.add("bg-slate-100", "cursor-not-allowed");
    statusSel.dataset.lockedByMilitaryDoc = "1";
    if (extraFields) extraFields.classList.remove("hidden");
  } else {
    if (statusSel.dataset.lockedByMilitaryDoc === "1") {
      statusSel.disabled = false;
      statusSel.classList.remove("bg-slate-100", "cursor-not-allowed");
      statusSel.dataset.lockedByMilitaryDoc = "";
      statusSel.value = "مدني";
      statusSel.dispatchEvent(new Event("change", { bubbles: true }));
      if (extraFields) extraFields.classList.add("hidden");
    } else {
      statusSel.disabled = false;
      statusSel.classList.remove("bg-slate-100", "cursor-not-allowed");
    }
  }
};

document.addEventListener("change", (e) => {
  const t = e.target;
  if (!t) return;
  if (t.id === "recDocType") {
    window.__syncDocTypeToMilitaryStatus();
  } else if (t.id === "recMilitaryStatus" && window.__isMilitaryDocSelected()) {
    t.value = "عسكري";
    t.disabled = true;
    const extraFields = document.getElementById("militaryExtraFields");
    if (extraFields) extraFields.classList.remove("hidden");
    if (typeof showToast === "function") {
      showToast("لا يمكن تغيير الحالة إلى مدني لأن نوع الوثيقة بطاقة عسكرية", "warning");
    }
  }
}, true);

/* === ALL_SEVEN_IMPROVEMENTS_START === */
(function() {
  window.__savedActiveStatFilter = window.__savedActiveStatFilter || "";

  function ensureCivilDocMilitaryFilterUi() {
    const typeSel = document.getElementById("filterDocType");
    if (typeSel && !typeSel.querySelector("option[value='__mil_civil_doc__']")) {
      const opt = document.createElement("option");
      opt.value = "__mil_civil_doc__";
      opt.textContent = "عسكري · هوية مدنية";
      typeSel.appendChild(opt);
    }
    const filterBar = typeSel ? (typeSel.closest("div.grid, div.flex, form, section") || typeSel.parentElement) : null;
    if (filterBar && !document.getElementById("quickFilterMilCivilBtn")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = "quickFilterMilCivilBtn";
      btn.textContent = "عسكري · هوية مدنية";
      btn.className = "px-3 py-2 rounded-xl border border-rose-300 bg-rose-50 text-rose-700 text-xs font-extrabold hover:bg-rose-100 transition whitespace-nowrap";
      btn.addEventListener("click", async () => {
        const active = btn.dataset.active === "1";
        btn.dataset.active = active ? "0" : "1";
        btn.classList.toggle("ring-2", !active);
        btn.classList.toggle("ring-rose-500", !active);
        btn.classList.toggle("bg-rose-600", !active);
        btn.classList.toggle("text-white", !active);
        btn.classList.toggle("bg-rose-50", active);
        btn.classList.toggle("text-rose-700", active);
        if (typeof window.__renderAllRecords === "function") {
          await window.__renderAllRecords();
        }
      });
      filterBar.appendChild(btn);
    }
  }

  window.__resetMilitaryLockState = function() {
    const statusSel = document.getElementById("recMilitaryStatus");
    const extraFields = document.getElementById("militaryExtraFields");
    if (!statusSel) return;
    statusSel.disabled = false;
    statusSel.classList.remove("bg-slate-100", "cursor-not-allowed");
    statusSel.dataset.lockedByMilitaryDoc = "";
    setTimeout(() => {
      if (typeof window.__syncDocTypeToMilitaryStatus === "function") window.__syncDocTypeToMilitaryStatus();
      if (extraFields) extraFields.classList.toggle("hidden", statusSel.value !== "عسكري");
    }, 30);
  };

  async function renderInlineNameAlert() {
    const nameInput = document.getElementById("recFullName");
    const form = document.getElementById("recordForm");
    if (!nameInput || !form) return;
    let box = document.getElementById("inlineDuplicateNameAlert");
    if (!box) {
      box = document.createElement("div");
      box.id = "inlineDuplicateNameAlert";
      box.className = "hidden sm:col-span-2 p-3 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 text-xs font-bold";
      nameInput.parentElement?.insertAdjacentElement("afterend", box);
    }
    const rawName = String(nameInput.value || "").trim();
    if (!rawName || typeof window.__normalizePersonName !== "function" || typeof IDVaultDB === "undefined") {
      box.classList.add("hidden");
      box.textContent = "";
      return;
    }
    try {
      const all = await IDVaultDB.getAll("identity_records");
      const idVal = document.getElementById("recordId")?.value || "";
      const norm = window.__normalizePersonName(rawName);
      const matches = (Array.isArray(all) ? all : []).filter((r) => {
        if (idVal && String(r.id) === String(idVal)) return false;
        return window.__normalizePersonName(r.full_name) === norm;
      });
      if (matches.length > 0) {
        const first = matches[0];
        box.textContent = "تنبيه: الاسم موجود مسبقاً (" + matches.length + " سجل) — " + (first.full_name || "") + " | " + (first.doc_type || "") + " | رقم: " + (first.doc_number || "بدون رقم");
        box.classList.remove("hidden");
      } else {
        box.classList.add("hidden");
        box.textContent = "";
      }
    } catch {
      box.classList.add("hidden");
    }
  }

  function validateLogicalDates() {
    const birthEl = document.getElementById("recBirthDate");
    const issueEl = document.getElementById("recIssueDate");
    const expiryEl = document.getElementById("recExpiryDate");
    const parseD = typeof window.__parseLooseDate === "function" ? window.__parseLooseDate : (v) => { const d = new Date(v); return isNaN(d.getTime()) ? null : d; };
    const bDate = birthEl?.value ? parseD(birthEl.value) : null;
    const iDate = issueEl?.value ? parseD(issueEl.value) : null;
    const eDate = expiryEl?.value ? parseD(expiryEl.value) : null;
    if (iDate && eDate && eDate < iDate) {
      const msg = "تنبيه: تاريخ الانتهاء أقدم من تاريخ الإصدار. هل تريد المتابعة رغم ذلك؟";
      if (typeof showToast === "function") showToast(msg, "warning");
      return window.confirm(msg);
    }
    if (bDate && iDate && iDate < bDate) {
      const msg = "تنبيه: تاريخ الإصدار أقدم من تاريخ الميلاد. هل تريد المتابعة رغم ذلك؟";
      if (typeof showToast === "function") showToast(msg, "warning");
      return window.confirm(msg);
    }
    return true;
  }

  function injectFilteredExportButton() {
    const exportBtn = document.getElementById("exportCsvBtn") || Array.from(document.querySelectorAll("button")).find((b) => /تصدير\s*Excel/i.test(b.textContent || ""));
    if (!exportBtn || document.getElementById("exportFilteredExcelBtn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "exportFilteredExcelBtn";
    btn.textContent = "تصدير المفلتر Excel";
    btn.className = "px-3 py-2 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-800 text-xs font-bold hover:bg-emerald-100 transition whitespace-nowrap";
    btn.addEventListener("click", () => {
      if (typeof window.__exportFilteredRecordsNow === "function") {
        window.__exportFilteredRecordsNow();
      }
    });
    exportBtn.insertAdjacentElement("afterend", btn);
  }

  function updateExpiryStatsAlertBadge() {
    const statCards = Array.from(document.querySelectorAll("[data-stat-filter], .stat-card, [onclick*='expired']"));
    const expiredCard = statCards.find((el) => /expired/.test((el.getAttribute("data-stat-filter") || el.getAttribute("onclick") || "")));
    if (expiredCard && !document.getElementById("expiredUrgentPulseDot")) {
      const dot = document.createElement("span");
      dot.id = "expiredUrgentPulseDot";
      dot.className = "inline-block w-2.5 h-2.5 rounded-full bg-rose-600 animate-ping mr-1.5 align-middle";
      expiredCard.prepend(dot);
    }
  }

  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === "recFullName") renderInlineNameAlert();
  }, true);

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t) return;
    if (t.closest("[data-edit-id], [onclick*='editRecord'], #openAddRecordBtn, #openAddModalBtn, [onclick*='openAddModal']")) {
      window.__resetMilitaryLockState();
      setTimeout(renderInlineNameAlert, 80);
    }
    const statEl = t.closest("[data-stat-filter]");
    if (statEl) window.__savedActiveStatFilter = statEl.getAttribute("data-stat-filter") || "";
  }, true);

  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!form || form.id !== "recordForm") return;
    if (form.dataset.dateCheckedOnce === "1") {
      form.dataset.dateCheckedOnce = "";
      return;
    }
    if (!validateLogicalDates()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    form.dataset.dateCheckedOnce = "1";
    setTimeout(() => { if (form) form.dataset.dateCheckedOnce = ""; }, 600);
  }, true);

  const runUiEnhancements = () => {
    ensureCivilDocMilitaryFilterUi();
    injectFilteredExportButton();
    updateExpiryStatsAlertBadge();
  };

  document.addEventListener("DOMContentLoaded", runUiEnhancements);
  setTimeout(runUiEnhancements, 400);
})();
/* === ALL_SEVEN_IMPROVEMENTS_END === */

/* === CONFIRM_DELETE_EDIT_START === */
(function() {
  function findRecordMeta(id, fallbackText) {
    const list = Array.isArray(window.__allIdentityRecords) ? window.__allIdentityRecords : [];
    const found = list.find((r) => String(r.id) === String(id));
    if (found) {
      return {
        name: found.full_name || "غير محدد",
        docType: found.doc_type || "",
        docNumber: found.doc_number || "بدون رقم"
      };
    }
    const clean = String(fallbackText || "").replace(/\s+/g, " ").trim();
    return { name: clean || "هذا السجل", docType: "", docNumber: "" };
  }

  function askConfirmAction(kind, meta) {
    const label = kind === "delete" ? "حذف" : "تعديل";
    const details = [
      meta.name ? "الاسم: " + meta.name : "",
      meta.docType ? "النوع: " + meta.docType : "",
      meta.docNumber ? "رقم الوثيقة: " + meta.docNumber : ""
    ].filter(Boolean).join(" | ");
    const msg = "تنبيه قبل " + label + " السجل:\n" + details + "\nهل أنت متأكد من المتابعة؟";
    if (typeof showToast === "function") {
      showToast("يرجى تأكيد عملية " + label + " للسجل", "warning");
    }
    return window.confirm(msg);
  }

  if (typeof IDVaultDB !== "undefined") {
    if (typeof IDVaultDB.remove === "function" && !IDVaultDB.__removeGuarded) {
      IDVaultDB.__removeGuarded = true;
      const origRemove = IDVaultDB.remove.bind(IDVaultDB);
      IDVaultDB.remove = async function(storeName, key) {
        if (storeName === "identity_records") {
          const meta = findRecordMeta(key, "");
          if (!askConfirmAction("delete", meta)) return false;
        }
        return await origRemove(storeName, key);
      };
    }
    if (typeof IDVaultDB.delete === "function" && !IDVaultDB.__deleteGuarded) {
      IDVaultDB.__deleteGuarded = true;
      const origDelete = IDVaultDB.delete.bind(IDVaultDB);
      IDVaultDB.delete = async function(storeName, key) {
        if (storeName === "identity_records") {
          const meta = findRecordMeta(key, "");
          if (!askConfirmAction("delete", meta)) return false;
        }
        return await origDelete(storeName, key);
      };
    }
  }

  const wrapAppActionsDelete = () => {
    if (typeof AppActions !== "undefined" && typeof AppActions.deleteRecord === "function" && !AppActions.deleteRecord.__guarded) {
      const origDelRec = AppActions.deleteRecord.bind(AppActions);
      const guardedDelRec = async function(id) {
        const meta = findRecordMeta(id, "");
        if (!askConfirmAction("delete", meta)) return;
        return await origDelRec(id);
      };
      guardedDelRec.__guarded = true;
      AppActions.deleteRecord = guardedDelRec;
    }
  };
  wrapAppActionsDelete();
  document.addEventListener("DOMContentLoaded", wrapAppActionsDelete);
  setTimeout(wrapAppActionsDelete, 500);

  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!form || form.id !== "recordForm") return;
    const idVal = document.getElementById("recordId")?.value || "";
    if (!idVal) return;
    if (form.dataset.editConfirmedOnce === "1") {
      form.dataset.editConfirmedOnce = "";
      return;
    }
    const nameVal = document.getElementById("recFullName")?.value?.trim() || "";
    const typeVal = document.getElementById("recDocType")?.value || "";
    const numVal = document.getElementById("recDocNumber")?.value?.trim() || "";
    const ok = askConfirmAction("edit", { name: nameVal, docType: typeVal, docNumber: numVal });
    if (!ok) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    form.dataset.editConfirmedOnce = "1";
    setTimeout(() => { if (form) form.dataset.editConfirmedOnce = ""; }, 600);
  }, true);
})();
/* === CONFIRM_DELETE_EDIT_END === */

/* === ADMIN_ONLY_PERMISSIONS_START === */
(function() {
  function getCurrentUserRole() {
    try {
      if (window.currentUser && window.currentUser.role) return String(window.currentUser.role).toLowerCase();
      for (const k of ["idvault_session", "idvault_session_backup", "currentUser", "authUser", "loggedInUser", "sessionUser", "user"]) {
        const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.role) return String(parsed.role).toLowerCase();
          if (parsed && parsed.user && parsed.user.role) return String(parsed.user.role).toLowerCase();
        } catch {}
      }
    } catch {}
    return "";
  }

  function isCurrentUserAdmin() {
    const role = getCurrentUserRole();
    if (role) return role === "admin";
    return Array.from(document.querySelectorAll("button, a, [role=tab]")).some((el) => {
      const t = (el.textContent || "").trim();
      return /المستخدمون|الصلاحيات|users/i.test(t) && el.offsetParent !== null;
    });
  }

  function isDeleteElement(el) {
    if (!el) return false;
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    const aria = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("data-action") || "")).toLowerCase();
    const onclick = ((el.getAttribute && el.getAttribute("onclick")) || "").toLowerCase();
    const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
    return /حذف|delete|remove/i.test(txt) || /حذف|delete|remove/i.test(aria) || /deleterecord|remove\(/i.test(onclick) || /delete-btn|btn-delete/i.test(cls);
  }

  function getRestrictedElements() {
    const set = new Set();
    ["exportCsvBtn", "exportFilteredExcelBtn", "importCsvInput", "downloadBackupBtn", "restoreBackupInput"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      set.add((id === "importCsvInput" || id === "restoreBackupInput") && el.closest("label") ? el.closest("label") : el);
    });
    document.querySelectorAll("button, a, label").forEach((el) => {
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/تصدير\s*Excel|تصدير\s*المفلتر\s*Excel|استيراد\s*Excel|تحميل\s*نسخة\s*احتياطية|استعادة\s*نسخة\s*JSON/i.test(txt) || isDeleteElement(el)) {
        set.add(el);
      }
    });
    return Array.from(set);
  }

  function syncAdminVisibility() {
    const admin = isCurrentUserAdmin();
    getRestrictedElements().forEach((target) => {
      if (!target) return;
      if (admin) {
        if (target.dataset.adminHidden === "1") {
          target.style.removeProperty("display");
          delete target.dataset.adminHidden;
        }
      } else {
        target.dataset.adminHidden = "1";
        target.style.setProperty("display", "none", "important");
      }
    });
  }

  function denyNonAdmin(e, msg) {
    if (isCurrentUserAdmin()) return false;
    if (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    syncAdminVisibility();
    const text = msg || "هذا الإجراء متاح للأدمن فقط";
    if (typeof showToast === "function") {
      showToast(text, "error");
    } else {
      alert(text);
    }
    return true;
  }

  document.addEventListener("click", (e) => {
    const el = e.target && e.target.closest("#exportCsvBtn, #exportFilteredExcelBtn, #downloadBackupBtn, button, a, label");
    if (!el) return;
    if (isDeleteElement(el)) {
      denyNonAdmin(e, "حذف السجلات متاح للأدمن فقط");
      return;
    }
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (el.id === "exportCsvBtn" || el.id === "exportFilteredExcelBtn" || el.id === "downloadBackupBtn" || /تصدير|استيراد|نسخة احتياطية|استعادة نسخة/i.test(txt)) {
      denyNonAdmin(e, "هذا الإجراء متاح للأدمن فقط");
    }
  }, true);

  document.addEventListener("change", (e) => {
    const inp = e.target;
    if (inp && (inp.id === "importCsvInput" || inp.id === "restoreBackupInput")) {
      if (denyNonAdmin(e, "الاستيراد والاستعادة متاحان للأدمن فقط")) inp.value = "";
    }
  }, true);

  const obs = new MutationObserver(() => syncAdminVisibility());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", syncAdminVisibility);
  setInterval(syncAdminVisibility, 600);
})();
/* === ADMIN_ONLY_PERMISSIONS_END === */

/* === SESSION_TIMEOUT_GUARD_START === */
(function() {
  const MAX_IDLE_MS = 12 * 60 * 60 * 1000;
  const LAST_ACTIVE_KEY = "idvault_last_active_ts";
  let syncing = false;
  let loginProtectUntil = Date.now() + 8000;

  function readSession() {
    for (const k of ["idvault_session", "idvault_session_backup"]) {
      try {
        const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.username || parsed.role || parsed.id || (parsed.user && (parsed.user.username || parsed.user.role)))) {
          return parsed.user && !parsed.role ? parsed.user : parsed;
        }
      } catch {}
    }
    return null;
  }

  function clearSessionKeys() {
    ["idvault_session", "idvault_session_backup"].forEach((k) => {
      try { sessionStorage.removeItem(k); } catch {}
      try { localStorage.removeItem(k); } catch {}
    });
    try { localStorage.removeItem(LAST_ACTIVE_KEY); } catch {}
    try { window.currentUser = null; } catch {}
  }

  function touchActive() {
    if (!readSession()) return;
    try { localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now())); } catch {}
  }

  function applyInstantSessionState() {
    if (syncing) return;
    const s = readSession();
    if (!s) return;
    if (Date.now() >= loginProtectUntil) {
      const last = Number(localStorage.getItem(LAST_ACTIVE_KEY) || "0");
      if (last > 0 && Date.now() - last > MAX_IDLE_MS) {
        clearSessionKeys();
        const loginEl = document.getElementById("loginScreen");
        if (loginEl) loginEl.classList.remove("hidden");
        return;
      }
    }
    syncing = true;
    try {
      const str = JSON.stringify(s);
      if (!sessionStorage.getItem("idvault_session")) {
        try { sessionStorage.setItem("idvault_session", str); } catch {}
      }
      if (!localStorage.getItem("idvault_session_backup")) {
        try { localStorage.setItem("idvault_session_backup", str); } catch {}
      }
      if (!window.currentUser) window.currentUser = s;
      const loginEl = document.getElementById("loginScreen");
      if (loginEl && !loginEl.classList.contains("hidden")) {
        loginEl.classList.add("hidden");
      }
      if (!localStorage.getItem(LAST_ACTIVE_KEY)) touchActive();
    } finally {
      syncing = false;
    }
  }

  applyInstantSessionState();
  document.addEventListener("DOMContentLoaded", applyInstantSessionState);
  window.addEventListener("load", applyInstantSessionState);
  document.addEventListener("submit", () => {
    loginProtectUntil = Date.now() + 8000;
    setTimeout(() => { touchActive(); applyInstantSessionState(); }, 50);
  }, true);
  document.addEventListener("click", touchActive, true);
  document.addEventListener("keydown", touchActive, true);
})();
/* === SESSION_TIMEOUT_GUARD_END === */

/* === AUDIT_LOG_MANAGER_START === */
(function() {
  const RETENTION_DAYS = 30;
  const AUTO_CHECK_MS = 6 * 60 * 60 * 1000;
  const LAST_AUTO_KEY = "idvault_audit_last_auto_clean_ts";

  function getActiveRole() {
    try {
      if (window.currentUser && window.currentUser.role) return String(window.currentUser.role).toLowerCase();
      for (const k of ["idvault_session", "idvault_session_backup"]) {
        const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
        if (!raw) continue;
        const u = JSON.parse(raw);
        const role = (u && (u.role || (u.user && u.user.role))) || "";
        if (role) return String(role).toLowerCase();
      }
    } catch {}
    return "";
  }

  function syncAuditButtonVisibility() {
    const btn = document.getElementById("clearAuditLogBtn");
    if (!btn) return;
    btn.style.display = getActiveRole() === "admin" ? "" : "none";
  }

  async function deleteAuditFromApi(olderThanDays) {
    const base = window.API_BASE_URL || "";
    const url = olderThanDays ? `${base}/api/audit?olderThanDays=${olderThanDays}` : `${base}/api/audit`;
    const res = await fetch(url, { method: "DELETE" });
    return res.ok;
  }

  function renderEmptyAuditTable() {
    const tbody = document.getElementById("auditTableBody");
    if (tbody) {
      tbody.innerHTML = "<tr><td colspan=\"6\" class=\"text-center py-6 text-slate-400\">لا توجد سجلات تدقيق حالياً</td></tr>";
    }
  }

  window.clearAuditLogManual = async function() {
    if (getActiveRole() !== "admin") {
      alert("هذا الإجراء متاح لمدير النظام (admin) فقط.");
      return;
    }
    const ok = confirm("هل أنت متأكد من مسح سجل التدقيق بالكامل من قاعدة البيانات؟");
    if (!ok) return;
    try {
      const done = await deleteAuditFromApi(null);
      renderEmptyAuditTable();
      if (done) {
        alert("تم مسح سجل التدقيق بنجاح.");
      } else {
        alert("تعذر مسح السجل من الخادم، تأكد من إعادة تشغيل السيرفر.");
      }
    } catch {
      alert("حدث خطأ أثناء محاولة مسح سجل التدقيق.");
    }
  };

  async function runPeriodicAuditCleanup() {
    try {
      const lastRun = Number(localStorage.getItem(LAST_AUTO_KEY) || "0");
      if (lastRun && Date.now() - lastRun < AUTO_CHECK_MS) return;
      localStorage.setItem(LAST_AUTO_KEY, String(Date.now()));
      await deleteAuditFromApi(RETENTION_DAYS);
    } catch {}
  }

  window.addEventListener("load", () => {
    syncAuditButtonVisibility();
    setTimeout(() => { syncAuditButtonVisibility(); runPeriodicAuditCleanup().catch(() => {}); }, 2500);
  });
  document.addEventListener("click", () => setTimeout(syncAuditButtonVisibility, 150), true);
  setInterval(runPeriodicAuditCleanup, AUTO_CHECK_MS);
})();
/* === AUDIT_LOG_MANAGER_END === */

/* === PREVENT_DOUBLE_LOGIN_START === */
(function() {
  let lastLoginSubmitTs = 0;
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!form || !/login/i.test(form.id || form.className || "")) return;
    const now = Date.now();
    if (now - lastLoginSubmitTs < 1500) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    lastLoginSubmitTs = now;
  }, true);
})();
/* === PREVENT_DOUBLE_LOGIN_END === */

/* === UNIFIED_LOGIN_SCREEN_SYNC_START === */
(function() {
  function hasStoredSession() {
    try {
      for (const k of ["idvault_session", "idvault_session_backup"]) {
        const raw = sessionStorage.getItem(k) || localStorage.getItem(k);
        if (!raw) continue;
        const p = JSON.parse(raw);
        if (p && (p.username || p.role || p.id || (p.user && (p.user.username || p.user.role)))) return true;
      }
    } catch {}
    return false;
  }

  function syncLoginVisibility() {
    const el = document.getElementById("loginScreen");
    if (!el) return;
    if (hasStoredSession()) {
      window.__idvaultLoginDone = true;
      if (!el.classList.contains("hidden")) el.classList.add("hidden");
    }
  }

  syncLoginVisibility();
  document.addEventListener("DOMContentLoaded", syncLoginVisibility);
  window.addEventListener("load", syncLoginVisibility);
  document.addEventListener("submit", () => setTimeout(syncLoginVisibility, 60), true);
})();
/* === UNIFIED_LOGIN_SCREEN_SYNC_END === */
