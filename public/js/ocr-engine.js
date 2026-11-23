const SilentOCREngine = (() => {
  let memoryCache = [];
  let lastScanRawText = '';
  let lastScanExtracted = {};

  function normalizeArabicDigits(str) {
    const map = {
      '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
      '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
      '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
      '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
    };
    return String(str || '').replace(/[٠-٩۰-۹]/g, (ch) => map[ch] || ch);
  }

  function cleanArabicText(str) {
    return normalizeArabicDigits(String(str || ''))
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/[^\u0600-\u06FF0-9A-Za-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function tokenizeForSimilarity(str) {
    const cleaned = cleanArabicText(str);
    if (!cleaned) return [];
    return cleaned
      .split(/\s+/)
      .filter((t) => t.length >= 2);
  }

  function computeSimilarity(textA, textB) {
    const tokensA = new Set(tokenizeForSimilarity(textA));
    const tokensB = new Set(tokenizeForSimilarity(textB));
    if (!tokensA.size || !tokensB.size) return 0;

    let intersection = 0;
    for (const tok of tokensA) {
      if (tokensB.has(tok)) intersection++;
    }
    const union = new Set([...tokensA, ...tokensB]).size;
    return union ? intersection / union : 0;
  }

  function preprocessCanvasForOCR(source) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const scale = img.width < 1400 ? 1.75 : 1.0;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;
        const contrast = 1.35;
        const intercept = 128 * (1 - contrast);

        for (let i = 0; i < d.length; i += 4) {
          const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          let v = gray * contrast + intercept;
          if (v < 0) v = 0;
          if (v > 255) v = 255;
          d[i] = d[i + 1] = d[i + 2] = v;
        }

        ctx.putImageData(imgData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => resolve(source);
      img.src = source;
    });
  }

  async function refreshMemory() {
    try {
      if (window.IDVaultDB && typeof IDVaultDB.getAll === 'function') {
        const rows = await IDVaultDB.getAll('ocr_learning_memory');
        if (Array.isArray(rows)) memoryCache = rows;
      }
    } catch (err) {
      console.error("learnSilently error:", err);
      if (typeof showToast === "function") showToast("تنبيه ذاكرة OCR: " + (err?.message || err), "warning");
    }
  }

  function setLastScanContext(rawText, extracted) {
    lastScanRawText = String(rawText || '');
    lastScanExtracted = extracted && typeof extracted === 'object' ? { ...extracted } : {};
  }

  async function recognizeImage(source) {
    if (!source) return '';
    if (!window.Tesseract) {
      throw new Error('تعذر تحميل محرك القراءة OCR (يتطلب اتصالاً بالإنترنت لتحميل المكتبة)');
    }
    await refreshMemory();
    const enhanced = await preprocessCanvasForOCR(source);
    const result = await window.Tesseract.recognize(enhanced, 'ara+eng');
    const raw = String(result?.data?.text || '').trim();
    return normalizeArabicDigits(raw);
  }

  function extractDocNumber(normalizedText, lines) {
    // 1. البحث المباشر بعد وسوم رقم الهوية/البطاقة/الجواز
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/(?:رقم\s*(?:الهويه|الهوية|البطاقه|البطاقة|الجواز|الوثيقه|الوثيقة|الشخصي|الوطني)|id\s*no|passport\s*no)/i.test(line)) {
        const sameLineMatch = line.match(/([0-9]{6,16}|[A-Za-z0-9\-]{6,20})/);
        if (sameLineMatch) {
          const digitsOnly = sameLineMatch[1].replace(/[^0-9A-Za-z-]/g, '');
          if (digitsOnly.length >= 6) return digitsOnly;
        }
        if (lines[i + 1]) {
          const nextLineMatch = lines[i + 1].match(/([0-9]{6,16}|[A-Za-z0-9\-]{6,20})/);
          if (nextLineMatch) {
            const digitsOnly = nextLineMatch[1].replace(/[^0-9A-Za-z-]/g, '');
            if (digitsOnly.length >= 6) return digitsOnly;
          }
        }
      }
    }

    // 2. استبعاد التواريخ وأرقام الهواتف والبحث عن أرقام الوثيقة المحتملة
    const dateTokens = new Set(
      (normalizedText.match(/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/g) || []).map((x) => x.trim())
    );
    const phoneTokens = new Set(
      (normalizedText.match(/(?:\+?967|00967|07|7)\d{7,9}/g) || []).map((x) => x.trim())
    );

    const candidates = (normalizedText.match(/\b[0-9]{6,16}\b/g) || [])
      .filter((num) => {
        if (phoneTokens.has(num)) return false;
        for (const dt of dateTokens) {
          if (dt.includes(num)) return false;
        }
        return true;
      });

    return (
      candidates.find((c) => c.length >= 9 && c.length <= 12) ||
      candidates[0] ||
      ''
    );
  }

  function extractFullName(lines) {
    const stopWords =
      /(?:الجمهوريه|الجمهورية|اليمنيه|اليمنية|وزاره|وزارة|الداخليه|الداخلية|الامن|السجل|المدني|بطاقه|بطاقة|شخصيه|شخصية|الوطني|تاريخ|محل|الميلاد|اصدار|إصدار|انتهاء|مهنه|مهنة|سكن|حاله|حالة|جواز|رتبه|رتبة|رقم|الهويه|الهوية|الجنسيه|الجنسية)/i;

    // البحث عن سطر يبدأ بكلمة "الاسم" أو "الاسم الكامل"
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^(?:الاسم(?:\s+الكامل)?|الاسم\s*:)/i.test(line)) {
        const inlineVal = line
          .replace(/^(?:الاسم(?:\s+الكامل)?)\s*[:\-]?\s*/i, '')
          .replace(/[A-Za-z0-9_=+|\\/~^@#$%&*(){}\[\]<>:;,!?.-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (inlineVal.split(' ').filter((w) => w.length >= 2).length >= 2 && !stopWords.test(inlineVal)) {
          return inlineVal;
        }
        if (lines[i + 1]) {
          const nextVal = lines[i + 1]
            .replace(/[A-Za-z0-9_=+|\\/~^@#$%&*(){}\[\]<>:;,!?.-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (nextVal.split(' ').filter((w) => w.length >= 2).length >= 2 && !stopWords.test(nextVal)) {
            return nextVal;
          }
        }
      }
    }

    // البحث عن أفضل سطر اسم عربي (من 3 إلى 5 كلمات)
    const candidates = lines
      .map((l) => {
        const cleaned = l
          .replace(/[A-Za-z0-9_=+|\\/~^@#$%&*(){}\[\]<>:;,!?.-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const words = cleaned.split(' ').filter((w) => w.length >= 2);
        if (words.length < 2 || words.length > 6) return '';
        if (stopWords.test(cleaned)) return '';
        return words.join(' ');
      })
      .filter(Boolean);

    return (
      candidates.find((c) => {
        const wc = c.split(' ').length;
        return wc >= 3 && wc <= 5;
      }) ||
      candidates[0] ||
      ''
    );
  }

  function matchFromMemory(text, docType, currentGuess = {}) {
    const learned = {
      full_name: '',
      doc_number: '',
      doc_type: '',
      profession: '',
      birth_place: '',
      address: '',
      destination_place: '',
      destination_reason: '',
      military_status: '',
      military_rank: '',
      military_number: ''
    };

    const normText = normalizeArabicDigits(String(text || ''));
    const cleanedQuery = cleanArabicText(normText);
    const queryDigits = new Set(normText.match(/\b\d{5,16}\b/g) || []);

    let bestSnapshot = null;
    let bestScore = 0;

    for (const item of memoryCache) {
      if (!item || !item.normalized_value) continue;

      if (item.field_name === 'doc_snapshot') {
        try {
          const snap = JSON.parse(item.normalized_value);
          if (!snap || typeof snap !== 'object') continue;

          const sampleText = String(snap.sample_text || item.pattern_key || '');
          let score = computeSimilarity(normText, sampleText);

          // تعزيز التطابق إذا اشتركت الوثيقتان في أرقام أو اسم أو رقم وثيقة
          const snapDigits = Array.isArray(snap.digits) ? snap.digits : [];
          for (const d of snapDigits) {
            if (queryDigits.has(d)) score += 0.35;
          }

          if (snap.doc_number && normText.includes(String(snap.doc_number))) {
            score += 0.45;
          }

          const guessNameCleaned = cleanArabicText(currentGuess.full_name || '');
          const snapNameCleaned = cleanArabicText(snap.full_name || '');
          if (guessNameCleaned && snapNameCleaned && computeSimilarity(guessNameCleaned, snapNameCleaned) >= 0.5) {
            score += 0.35;
          }

          if (item.doc_type && docType && item.doc_type === docType) {
            score += 0.1;
          }

          if (score > bestScore && score >= 0.35) {
            bestScore = score;
            bestSnapshot = snap;
          }
        } catch {
          // تجاهل
        }
        continue;
      }

      // دعم الأنماط السابقة للبيانات الإضافية
      const key = String(item.pattern_key || '').toLowerCase();
      if (!key) continue;
      const keyParts = key.split(':');
      const token = keyParts[keyParts.length - 1] || key;
      if (token.length >= 2 && (cleanedQuery.includes(token) || (docType && item.doc_type === docType))) {
        try {
          const parsed = JSON.parse(item.normalized_value || '{}');
          for (const k of Object.keys(learned)) {
            if (!learned[k] && parsed[k]) learned[k] = parsed[k];
          }
        } catch {
          // تجاهل
        }
      }
    }

    if (bestSnapshot) {
      for (const k of Object.keys(learned)) {
        if (bestSnapshot[k]) {
          learned[k] = bestSnapshot[k];
        }
      }
    }

    return learned;
  }

  function extractBirthPlace(lines) {
    const stopWords = /(?:تاريخ|اصدار|إصدار|انتهاء|مهنه|مهنة|سكن|حاله|حالة|رقم|الهويه|الهوية|الجنسيه|الجنسية|الاسم)/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/(?:محل\s*(?:الميلاد|الولاده|الولادة)|مكان\s*(?:الميلاد|الولاده|الولادة)|مولده|مولدها)/i.test(line)) {
        const inlineVal = line
          .replace(/^.*?(?:محل\s*(?:الميلاد|الولاده|الولادة)|مكان\s*(?:الميلاد|الولاده|الولادة)|مولده|مولدها)\s*[:\-]?\s*/i, "")
          .replace(/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/g, " ")
          .replace(/[0-9A-Za-z_=+|\\/~^@#$%&*(){}\[\]<>:;,!?]+/g, " ")
          .replace(/\s*-\s*$/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (inlineVal && inlineVal.length >= 2 && !stopWords.test(inlineVal)) {
          return inlineVal;
        }
        if (lines[i + 1]) {
          const nextVal = lines[i + 1]
            .replace(/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/g, " ")
            .replace(/[0-9A-Za-z_=+|\\/~^@#$%&*(){}\[\]<>:;,!?]+/g, " ")
            .replace(/\s*-\s*$/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (nextVal && nextVal.length >= 2 && !stopWords.test(nextVal)) {
            return nextVal;
          }
        }
      }
    }

    // استخراج محل الميلاد من سطر يجمع بين المكان والتاريخ مثل: "تعز - حيفان - 1996/03/02"
    for (const line of lines) {
      if (/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/.test(line)) {
        const placePart = line
          .replace(/\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/g, " ")
          .replace(/[0-9A-Za-z_=+|\\/~^@#$%&*(){}\[\]<>:;,!?]+/g, " ")
          .replace(/(\s*-\s*)+$/g, "")
          .replace(/^(\s*-\s*)+/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (placePart && placePart.length >= 2 && !stopWords.test(placePart)) {
          return placePart;
        }
      }
    }

    return "";
  }

  function extractFields(rawText) {
    const normalizedText = normalizeArabicDigits(String(rawText || '').trim());
    const lines = normalizedText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const phoneMatch = normalizedText.match(/(?:\+?967|00967|07|7)\d{7,9}/);
    const dateMatches = normalizedText.match(/\b\d{4}[-/]\d{2}[-/]\d{2}\b|\b\d{2}[-/]\d{2}[-/]\d{4}\b/g) || [];

    const normalizeDate = (d) => {
      if (!d) return '';
      const parts = d.split(/[-/]/);
      if (parts[0].length === 4) {
        return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      }
      return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    };

    let docType = 'بطاقة شخصية إلكترونية';
    if (/جواز|passport/i.test(normalizedText)) docType = 'جواز سفر';
    else if (/عسكري|رتبه|رتبة|ملازم|رقيب|نقيب|عقيد/i.test(normalizedText)) docType = 'بطاقة عسكرية';
    else if (/قديمه|قديمة/i.test(normalizedText)) docType = 'بطاقة شخصية قديمة';

    const nameLine = extractFullName(lines);
    const preferredDocNum = extractDocNumber(normalizedText, lines);
    const extractedBirthPlace = extractBirthPlace(lines);

    const learned = matchFromMemory(normalizedText, docType, {
      full_name: nameLine,
      doc_number: preferredDocNum
    });

    return {
      full_name: learned.full_name || nameLine,
      doc_type: learned.doc_type || docType,
      doc_number: learned.doc_number || preferredDocNum,
      phone: phoneMatch ? phoneMatch[0] : '',
      birth_date: normalizeDate(dateMatches[0] || ''),
      issue_date: normalizeDate(dateMatches[1] || ''),
      expiry_date: normalizeDate(dateMatches[2] || ''),
      birth_place: learned.birth_place || extractedBirthPlace || '',
      address: learned.address || '',
      profession: learned.profession || '',
      destination_place: learned.destination_place || '',
      destination_reason: learned.destination_reason || '',
      military_status: learned.military_status || (docType === 'بطاقة عسكرية' ? 'عسكري' : 'مدني'),
      military_rank: learned.military_rank || '',
      military_number: learned.military_number || ''
    };
  }

  async function learnSilently(record) {
    try {
      if (!record || !window.IDVaultDB?.add) return;

      const docType = record.doc_type || 'بطاقة شخصية إلكترونية';
      const rawSource = lastScanRawText || [
        record.full_name,
        record.doc_number,
        record.profession,
        record.birth_place,
        record.address
      ].filter(Boolean).join(' ');

      const normalizedRaw = normalizeArabicDigits(rawSource).trim();
      const digits = Array.from(new Set(normalizedRaw.match(/\b\d{5,16}\b/g) || []));
      const tokens = tokenizeForSimilarity(normalizedRaw).slice(0, 12);

      const snapshotKey = [
        record.doc_number ? `doc:${String(record.doc_number).trim()}` : '',
        tokens.join('_')
      ].filter(Boolean).join('|').slice(0, 80) || `rec:${Date.now()}`;

      const snapshotPayload = {
        sample_text: normalizedRaw.slice(0, 500),
        digits,
        full_name: String(record.full_name || '').trim(),
        doc_number: normalizeArabicDigits(String(record.doc_number || '')).trim(),
        doc_type: docType,
        profession: String(record.profession || '').trim(),
        birth_place: String(record.birth_place || '').trim(),
        address: String(record.address || '').trim(),
        destination_place: String(record.destination_place || '').trim(),
        destination_reason: String(record.destination_reason || '').trim(),
        military_status: String(record.military_status || 'مدني').trim(),
        military_rank: String(record.military_rank || '').trim(),
        military_number: String(record.military_number || '').trim()
      };

      if (snapshotPayload.full_name || snapshotPayload.doc_number) {
        await IDVaultDB.add('ocr_learning_memory', {
          doc_type: docType,
          field_name: 'doc_snapshot',
          pattern_key: snapshotKey,
          normalized_value: JSON.stringify(snapshotPayload)
        });
      }

      lastScanRawText = '';
      lastScanExtracted = {};
      await refreshMemory();
    } catch {
      // صامت
    }
  }

  return {
    recognizeImage,
    extractFields,
    learnSilently,
    refreshMemory,
    setLastScanContext
  };
})();
