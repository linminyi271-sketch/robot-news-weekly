/*
 * 資料層：網頁只透過這裡讀寫資料。
 * - 正式模式（config.js 有 API_URL）：讀寫 Google 試算表（經由 Apps Script）。
 * - 預覽模式（API_URL 留空）：使用 data/seed.js，新增的內容只存在自己的瀏覽器。
 * 上傳者（uploader）只會送到後台保存，前端讀取的公開資料不含上傳者。
 */
(function () {
  'use strict';

  var C = window.SITE_CONFIG || {};
  var P = window.NewsParser;
  var LS_DEMO = 'rnw-demo-v1';
  var LS_CACHE = 'rnw-cache-v1';

  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無痕視窗等情況可忽略 */ } }

  function splitTags(t) {
    if (Array.isArray(t)) return t.map(String).map(function (s) { return s.trim(); }).filter(Boolean);
    return String(t || '').split(/[,，、;；]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function normItem(raw, i) {
    var date = String(raw.date || '').slice(0, 10);
    var start = String(raw.week_start || '').slice(0, 10);
    if (!P.isValidDate(start)) { var w = P.weekOf(date); start = w ? w.start : ''; }
    var end = String(raw.week_end || '').slice(0, 10);
    if (!P.isValidDate(end) && start) end = P.addDays(start, 6);
    return {
      id: String(raw.id || ('n' + i)),
      week_start: start, week_end: end,
      region: String(raw.region || ''),
      title: String(raw.title || ''),
      source: String(raw.source || ''),
      date: date,
      summary: String(raw.summary || ''),
      url: String(raw.url || ''),
      tags: splitTags(raw.tags),
      seq: typeof raw.seq === 'number' ? raw.seq : i
    };
  }

  function normalize(data) {
    var news = (data.news || []).map(normItem).filter(function (n) { return n.title && n.week_start; });
    var obs = {};
    var o = data.observations || {};
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      obs[k] = { text: typeof v === 'string' ? v : String((v && v.text) || '') };
    });
    return { news: news, observations: obs, updatedAt: data.updatedAt || null };
  }

  function publicItem(it) {
    return {
      week_start: it.week_start, week_end: it.week_end, region: it.region, title: it.title,
      source: it.source, date: it.date, summary: it.summary, url: it.url, tags: it.tags
    };
  }

  // ---------- 預覽模式 ----------
  function demoLocal() { return lsGet(LS_DEMO) || { news: [], observations: {} }; }
  function demoLoad() {
    var seed = window.SEED_DATA || { news: [], observations: {} };
    var local = demoLocal();
    var obs = {};
    Object.keys(seed.observations || {}).forEach(function (k) { obs[k] = seed.observations[k]; });
    Object.keys(local.observations || {}).forEach(function (k) { obs[k] = { text: local.observations[k].text }; });
    return normalize({ news: (seed.news || []).concat(local.news || []), observations: obs });
  }

  // ---------- 正式模式 ----------
  function withTimeout(promiseFn, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
    return promiseFn(ctrl ? ctrl.signal : undefined).then(function (v) { clearTimeout(timer); return v; }, function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('連線逾時，請稍後再試');
      throw e;
    });
  }
  function apiGet() {
    var url = C.API_URL + (C.API_URL.indexOf('?') === -1 ? '?' : '&') + 'action=list&t=' + Date.now();
    return withTimeout(function (signal) { return fetch(url, { method: 'GET', redirect: 'follow', signal: signal }); }, 25000).then(function (r) {
      if (!r.ok) throw new Error('讀取資料失敗（HTTP ' + r.status + '）');
      return r.json();
    }).then(function (j) {
      if (!j || j.ok === false) throw new Error((j && j.message) || '讀取資料失敗');
      return j;
    });
  }
  function apiPost(payload) {
    // 以 text/plain 傳送，避免瀏覽器跨網域預檢（Apps Script 不支援 OPTIONS）
    return withTimeout(function (signal) { return fetch(C.API_URL, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow', signal: signal }); }, 45000)
      .then(function (r) { if (!r.ok) throw new Error('傳送失敗（HTTP ' + r.status + '）'); return r.json(); })
      .then(function (j) {
        if (!j || j.ok === false) {
          var err = new Error((j && j.message) || '傳送失敗，請稍後再試。');
          err.code = j && j.error;
          throw err;
        }
        return j;
      });
  }

  var Store = {
    mode: C.API_URL ? 'live' : 'demo',

    /** 上次成功讀取的資料（讓頁面能先顯示，再背景更新）。 */
    cached: function () {
      if (this.mode !== 'live') return null;
      var c = lsGet(LS_CACHE);
      return c && c.api === C.API_URL ? normalize(c.data) : null;
    },

    load: function () {
      if (this.mode === 'demo') return Promise.resolve(demoLoad());
      return apiGet().then(function (j) {
        lsSet(LS_CACHE, { api: C.API_URL, data: j });
        return normalize(j);
      });
    },

    /** items: 已整理好的新聞陣列；meta: {uploader, code}。回傳 {added, skipped}。 */
    addNews: function (items, meta) {
      var clean = items.map(publicItem);
      if (this.mode === 'live') {
        return apiPost({ action: 'addNews', items: clean, uploader: meta.uploader, code: meta.code || '' });
      }
      var local = demoLocal();
      var existing = demoLoad().news;
      var keys = {};
      existing.forEach(function (n) { keys[P.urlKey(n.url)] = 1; });
      var added = 0, skipped = 0, now = new Date().toISOString();
      clean.forEach(function (it, i) {
        var k = P.urlKey(it.url);
        if (keys[k]) { skipped++; return; }
        keys[k] = 1;
        it.id = 'local-' + Date.now().toString(36) + '-' + i;
        it.seq = 10000 + (local.news || []).length;
        it.uploader = meta.uploader; // 僅保存在本機紀錄，畫面不顯示
        it.uploaded_at = now;
        local.news.push(it);
        added++;
      });
      lsSet(LS_DEMO, local);
      return Promise.resolve({ ok: true, added: added, skipped: skipped });
    },

    saveObservation: function (weekStart, text, meta) {
      if (this.mode === 'live') {
        return apiPost({ action: 'saveObservation', week_start: weekStart, text: text, uploader: meta.uploader, code: meta.code || '' });
      }
      var local = demoLocal();
      local.observations[weekStart] = { text: text, uploader: meta.uploader, uploaded_at: new Date().toISOString() };
      lsSet(LS_DEMO, local);
      return Promise.resolve({ ok: true });
    },

    resetDemo: function () { try { localStorage.removeItem(LS_DEMO); } catch (e) { /* 忽略 */ } }
  };

  window.NewsStore = Store;
})();
