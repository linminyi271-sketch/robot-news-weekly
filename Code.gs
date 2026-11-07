/**
 * 機器人產業新聞週報 — 後端（Google Apps Script）
 *
 * 這段程式綁定在 Google 試算表上，負責：
 *   1. 提供新聞資料給網頁讀取（doGet）——只回傳公開欄位，不含上傳者。
 *   2. 接收網頁上傳的新聞與重點觀察（doPost），並記錄上傳者與時間。
 *
 * 試算表分頁：
 *   news          一列一則新聞
 *   observations  每次儲存重點觀察都新增一列（保留修改紀錄），網頁顯示每期最新一筆
 *
 * 管理方式：
 *   - 隱藏某則新聞：在 news 分頁的 status 欄填「hidden」（或「隱藏」）。
 *   - 查詢上傳紀錄：看 uploader、uploaded_at 欄位，可用試算表篩選。
 *   - 設定團隊上傳碼：專案設定 → 指令碼屬性 → 新增 UPLOAD_CODE（同時把網站 config.js 的 UPLOAD_CODE_REQUIRED 改為 true）。
 *
 * 修改這個檔案後，要到「部署 → 管理部署作業 → 編輯 → 版本：新版本 → 部署」才會生效。
 */

var NEWS_SHEET = 'news';
var OBS_SHEET = 'observations';
var NEWS_HEADERS = ['id', 'week_start', 'week_end', 'region', 'title', 'source', 'date', 'summary', 'url', 'tags', 'status', 'uploader', 'uploaded_at'];
var OBS_HEADERS = ['week_start', 'text', 'status', 'uploader', 'uploaded_at'];
var PUBLIC_FIELDS = ['id', 'week_start', 'week_end', 'region', 'title', 'source', 'date', 'summary', 'url', 'tags'];
var REGIONS = ['國內', '國外'];
var WEEK_START_DAY = 4; // 與網站 config.js 相同：4 = 週四
var LIMITS = { title: 300, source: 80, summary: 3000, url: 2000, tags: 300, uploader: 80, observation: 5000, items: 100 };
var HIDDEN = { hidden: 1, '隱藏': 1, '刪除': 1, deleted: 1 };

/** 第一次使用：在編輯器上方選擇 setup 後按「執行」。會建立分頁與欄位標題。 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, NEWS_SHEET, NEWS_HEADERS);
  ensureSheet_(ss, OBS_SHEET, OBS_HEADERS);
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'list';
  try {
    if (action === 'list') return json_(list_());
    if (action === 'ping') return json_({ ok: true });
    return json_({ ok: false, error: 'unknown_action', message: '未知的操作' });
  } catch (err) {
    return json_({ ok: false, error: 'server_error', message: '伺服器錯誤：' + err });
  }
}

function doPost(e) {
  var body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'bad_json', message: '資料格式錯誤' }); }

  var requiredCode = PropertiesService.getScriptProperties().getProperty('UPLOAD_CODE');
  if (requiredCode && String(body.code || '') !== requiredCode) {
    return json_({ ok: false, error: 'bad_code', message: '團隊上傳碼不正確' });
  }
  var uploader = clean_(body.uploader, LIMITS.uploader);
  if (!uploader) return json_({ ok: false, error: 'missing_uploader', message: '請填寫上傳者' });

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); }
  catch (err) { return json_({ ok: false, error: 'busy', message: '目前有人正在上傳，請稍後再試' }); }
  try {
    if (body.action === 'addNews') return json_(addNews_(body.items, uploader));
    if (body.action === 'saveObservation') return json_(saveObservation_(body, uploader));
    return json_({ ok: false, error: 'unknown_action', message: '未知的操作' });
  } catch (err) {
    return json_({ ok: false, error: 'server_error', message: '伺服器錯誤：' + err });
  } finally {
    lock.releaseLock();
  }
}

// ---------- 讀取 ----------
function list_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var newsRows = readRows_(ss, NEWS_SHEET);
  var news = [];
  var updatedAt = '';
  newsRows.forEach(function (row, i) {
    if (HIDDEN[String(row.status || '').trim().toLowerCase()]) return;
    if (!row.title) return;
    var item = {};
    PUBLIC_FIELDS.forEach(function (f) { item[f] = row[f]; });
    item.tags = String(row.tags || '').split(/[,，、]/).map(function (s) { return s.trim(); }).filter(String);
    item.seq = i;
    news.push(item);
    if (row.uploaded_at > updatedAt) updatedAt = row.uploaded_at;
  });

  var observations = {};
  readRows_(ss, OBS_SHEET).forEach(function (row) {
    if (HIDDEN[String(row.status || '').trim().toLowerCase()]) return;
    if (!row.week_start) return;
    observations[row.week_start] = { text: row.text || '' }; // 後面的列覆蓋前面的 → 取最新一筆
    if (row.uploaded_at > updatedAt) updatedAt = row.uploaded_at;
  });

  return { ok: true, news: news, observations: observations, updatedAt: updatedAt };
}

// ---------- 寫入 ----------
function addNews_(items, uploader) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'no_items', message: '沒有可發布的新聞' };
  if (items.length > LIMITS.items) return { ok: false, error: 'too_many', message: '一次最多上傳 ' + LIMITS.items + ' 則' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, NEWS_SHEET, NEWS_HEADERS);
  var existing = readRows_(ss, NEWS_SHEET);
  var seen = {};
  existing.forEach(function (r) { if (!HIDDEN[String(r.status || '').trim().toLowerCase()]) seen[urlKey_(r.url)] = 1; });

  var now = now_();
  var records = [], skipped = 0, invalid = 0;
  items.forEach(function (raw) {
    var it = {
      region: clean_(raw.region, 10),
      title: clean_(raw.title, LIMITS.title),
      source: clean_(raw.source, LIMITS.source),
      date: clean_(raw.date, 10),
      summary: cleanMultiline_(raw.summary, LIMITS.summary),
      url: clean_(raw.url, LIMITS.url),
      tags: (Array.isArray(raw.tags) ? raw.tags : String(raw.tags || '').split(/[,，、]/))
        .map(function (t) { return clean_(t, 30); }).filter(String).join(', ').slice(0, LIMITS.tags),
      week_start: clean_(raw.week_start, 10),
      week_end: clean_(raw.week_end, 10)
    };
    if (REGIONS.indexOf(it.region) === -1 || !it.title || !it.source || !isDate_(it.date) || !/^https?:\/\/\S+\.\S+/i.test(it.url)) { invalid++; return; }
    if (!isDate_(it.week_start)) it.week_start = weekStart_(it.date);
    if (!isDate_(it.week_end)) it.week_end = addDays_(it.week_start, 6);
    var key = urlKey_(it.url);
    if (seen[key]) { skipped++; return; }
    seen[key] = 1;
    it.id = 'n' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    it.status = '';
    it.uploader = uploader;
    it.uploaded_at = now;
    records.push(it);
  });

  if (records.length) appendRecords_(sheet, records);
  return { ok: true, added: records.length, skipped: skipped, invalid: invalid };
}

function saveObservation_(body, uploader) {
  var week = clean_(body.week_start, 10);
  if (!isDate_(week)) return { ok: false, error: 'bad_week', message: '期別格式錯誤' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet_(ss, OBS_SHEET, OBS_HEADERS);
  appendRecords_(sheet, [{
    week_start: week,
    text: cleanMultiline_(body.text, LIMITS.observation),
    status: '',
    uploader: uploader,
    uploaded_at: now_()
  }]);
  return { ok: true };
}

// ---------- 試算表工具 ----------
function ensureSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@'); // 全部存成純文字，避免日期被自動轉換
  }
  return sheet;
}

/** 讀取分頁成物件陣列（依標題對應欄位，所以管理者調整欄位順序也沒關係）。 */
function readRows_(ss, name) {
  var sheet = ss.getSheetByName(name);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var tz = Session.getScriptTimeZone();
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      var v = values[r][c];
      if (v instanceof Date) v = Utilities.formatDate(v, tz, headers[c] === 'uploaded_at' ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
      obj[headers[c]] = v === null || v === undefined ? '' : String(v).replace(/^\u200B/, '');
    }
    out.push(obj);
  }
  return out;
}

function appendRecords_(sheet, records) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var rows = records.map(function (rec) {
    return headers.map(function (h) { return textCell_(rec[h] === undefined ? '' : rec[h]); });
  });
  var start = sheet.getLastRow() + 1;
  var range = sheet.getRange(start, 1, rows.length, headers.length);
  range.setNumberFormat('@');
  range.setValues(rows);
}

/** 以 = + - @ 開頭的文字前面加上看不見的字元，避免被試算表當成公式執行（讀取時會自動去掉）。 */
var GUARD = '\u200B';
function textCell_(v) {
  var s = String(v);
  return /^[=+\-@]/.test(s) ? GUARD + s : s;
}

function clean_(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanMultiline_(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
function isDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return false;
  var d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}
function pad_(n) { return (n < 10 ? '0' : '') + n; }
function fmt_(d) { return d.getFullYear() + '-' + pad_(d.getMonth() + 1) + '-' + pad_(d.getDate()); }
function addDays_(s, n) { var p = s.split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]); d.setDate(d.getDate() + n); return fmt_(d); }
function weekStart_(s) {
  var p = s.split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]);
  d.setDate(d.getDate() - ((d.getDay() - WEEK_START_DAY + 7) % 7));
  return fmt_(d);
}
function urlKey_(u) {
  var s = String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '');
  return s.replace(/\/+(\?|$)/, '$1');
}
function now_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'); }
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
