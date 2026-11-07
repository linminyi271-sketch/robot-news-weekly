/*
 * 機器人產業新聞週報 — 畫面與互動
 * 依賴：config.js（設定）、parser.js（解析）、store.js（資料讀寫）
 * 新聞資料一律從 NewsStore 讀取，請不要把新聞寫死在 HTML 裡。
 */
(function () {
  'use strict';

  var C = window.SITE_CONFIG;
  var P = window.NewsParser;
  var S = window.NewsStore;
  var REGIONS = C.REGIONS || ['國內', '國外'];
  var TAG_NAMES = (C.TAGS || []).map(function (t) { return t.name; });
  var ARCHIVE_LIMIT = 12;

  // ---------- 小工具 ----------
  var $ = function (id) { return document.getElementById(id); };
  var PROPS = { value: 1, checked: 1, disabled: 1, selected: 1, hidden: 1, open: 1 };
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (PROPS[k]) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid.nodeType ? kid : String(kid));
  }
  var ICONS = {
    ext: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 3h4v4M13 3L7.5 8.5M12 9.5V13H3V4h3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>',
    back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M10 3L5 8l5 5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function icon(name) { var t = document.createElement('template'); t.innerHTML = ICONS[name]; return t.content.firstChild; }
  function fmtD(s) { return s ? s.replace(/-/g, '/') : ''; }
  function fmtRange(a, b) {
    if (!a) return '';
    if (!b) return fmtD(a);
    return a.slice(0, 4) === b.slice(0, 4) ? fmtD(a) + ' – ' + fmtD(b.slice(5)) : fmtD(a) + ' – ' + fmtD(b);
  }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }
  function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }
  function safeUrl(u) { return P.isValidUrl(u) ? u : null; }
  function inArtifact() { return !!(window.claude && typeof window.claude.use === 'function'); }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3600);
  }
  function copyText(text, okMsg) {
    function fallback() {
      var ta = h('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' });
      ta.value = text; document.body.append(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? (okMsg || '已複製') : '無法自動複製，請手動選取文字複製。');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg || '已複製'); }, fallback);
    } else fallback();
  }

  // ---------- 狀態 ----------
  var state = {
    news: [], obs: {}, weeks: [], week: null, updatedAt: null,
    region: 'all', tags: new Set(), source: '', q: '', scope: 'all',
    expanded: new Set(), loaded: false, showAllWeeks: false
  };

  function regionIdx(r) { var i = REGIONS.indexOf(r); return i === -1 ? 99 : i; }
  function sortItems(list) {
    return list.slice().sort(function (a, b) {
      return b.week_start.localeCompare(a.week_start) || regionIdx(a.region) - regionIdx(b.region) ||
        a.date.localeCompare(b.date) || a.seq - b.seq;
    });
  }
  function rebuild() {
    var map = new Map();
    state.news.forEach(function (n) {
      var w = map.get(n.week_start);
      if (!w) { w = { start: n.week_start, end: n.week_end, items: [] }; map.set(n.week_start, w); }
      if (n.week_end > w.end) w.end = n.week_end;
      w.items.push(n);
    });
    Object.keys(state.obs).forEach(function (k) {
      if (!map.has(k) && state.obs[k].text && P.isValidDate(k)) map.set(k, { start: k, end: P.addDays(k, 6), items: [] });
    });
    state.weeks = Array.from(map.values()).sort(function (a, b) { return b.start.localeCompare(a.start); });
    if (!state.week || !map.has(state.week)) state.week = state.weeks.length ? state.weeks[0].start : null;
  }
  function curWeek() {
    for (var i = 0; i < state.weeks.length; i++) if (state.weeks[i].start === state.week) return state.weeks[i];
    return null;
  }
  function tokens() { return state.q.trim().toLowerCase().split(/\s+/).filter(Boolean); }
  function searchingAll() { return tokens().length > 0 && state.scope === 'all'; }
  function hay(n) { return (n.title + ' ' + n.summary + ' ' + n.source + ' ' + n.tags.join(' ')).toLowerCase(); }
  function scopeItems() { return searchingAll() ? state.news : state.news.filter(function (n) { return n.week_start === state.week; }); }
  function visible() {
    var tk = tokens();
    var list = scopeItems();
    if (state.region !== 'all') list = list.filter(function (n) { return n.region === state.region; });
    if (state.source) list = list.filter(function (n) { return n.source === state.source; });
    if (state.tags.size) list = list.filter(function (n) { return n.tags.some(function (t) { return state.tags.has(t); }); });
    if (tk.length) list = list.filter(function (n) { var s = hay(n); return tk.every(function (t) { return s.indexOf(t) !== -1; }); });
    return sortItems(list);
  }
  function hasFilters() { return state.region !== 'all' || state.source || state.tags.size || state.q.trim(); }
  function clearFilters() {
    state.region = 'all'; state.source = ''; state.tags.clear(); state.q = ''; $('q').value = '';
    renderFilters(); renderList(); renderRail();
  }

  function highlight(text, tk) {
    var frag = document.createDocumentFragment();
    if (!tk.length || !text) { frag.append(text || ''); return frag; }
    var re = new RegExp(tk.map(escRe).join('|'), 'gi');
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      frag.append(h('mark', null, m[0]));
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  // ---------- 期別標頭 ----------
  function renderIssue() {
    var sel = $('week-select');
    sel.replaceChildren.apply(sel, state.weeks.map(function (w) {
      return h('option', { value: w.start, selected: w.start === state.week }, fmtRange(w.start, w.end) + '（' + w.items.length + ' 則）');
    }));
    sel.disabled = state.weeks.length < 2;
    var w = curWeek();
    var stats = $('stats');
    if (!w) {
      $('issue-range').textContent = state.loaded ? '尚無週報' : '載入中…';
      $('issue-eyebrow').textContent = '機器人產業新聞週報';
      $('prev-week').disabled = $('next-week').disabled = true;
      stats.replaceChildren();
      return;
    }
    $('issue-range').replaceChildren(h('span', { class: 'num' }, fmtRange(w.start, w.end)));
    var idx = state.weeks.indexOf(w);
    $('issue-eyebrow').textContent = idx === 0 ? '最新一期' : '過往期別';
    $('prev-week').disabled = idx >= state.weeks.length - 1;
    $('next-week').disabled = idx <= 0;
    var sources = new Set(w.items.map(function (n) { return n.source; }));
    var parts = [['本期新聞', w.items.length]];
    REGIONS.forEach(function (r) { parts.push([r, w.items.filter(function (n) { return n.region === r; }).length]); });
    parts.push(['來源媒體', sources.size]);
    stats.replaceChildren.apply(stats, parts.map(function (p) {
      return h('div', { class: 'stat' }, h('dt', null, p[0]), h('dd', null, p[1]));
    }));
    $('print-head').textContent = C.SITE_TITLE;
  }

  // ---------- 重點觀察 ----------
  function renderObs() {
    var box = $('obs');
    box.hidden = !state.week;
    if (!state.week) return;
    var o = state.obs[state.week];
    var text = ((o && o.text) || '').trim();
    var lines = text ? text.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean) : [];
    var list = $('obs-list');
    list.replaceChildren.apply(list, lines.map(function (line) {
      var i = line.indexOf('：');
      if (i > 1 && i <= 30) return h('li', null, h('span', null, h('strong', null, line.slice(0, i + 1)), line.slice(i + 1)));
      return h('li', null, h('span', null, line));
    }));
    list.hidden = !lines.length;
    $('obs-empty').hidden = !!lines.length;
    $('obs-edit').hidden = !lines.length;
  }

  // ---------- 篩選列 ----------
  function renderFilters() {
    var seg = $('region-seg');
    var opts = [['all', '全部']].concat(REGIONS.map(function (r) { return [r, r]; }));
    seg.replaceChildren.apply(seg, opts.map(function (o) {
      return h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(state.region === o[0]),
        onclick: function () { state.region = o[0]; renderFilters(); renderList(); }
      }, o[1]);
    }));

    var base = scopeItems();
    var srcCount = {};
    base.forEach(function (n) { srcCount[n.source] = (srcCount[n.source] || 0) + 1; });
    var srcs = Object.keys(srcCount).sort(function (a, b) { return srcCount[b] - srcCount[a] || a.localeCompare(b); });
    if (state.source && srcs.indexOf(state.source) === -1) srcs.unshift(state.source);
    var ss = $('source-select');
    ss.replaceChildren.apply(ss, [h('option', { value: '' }, '所有來源')].concat(srcs.map(function (s) {
      return h('option', { value: s, selected: s === state.source }, s + '（' + (srcCount[s] || 0) + '）');
    })));

    var tagCount = {};
    base.forEach(function (n) { n.tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1; }); });
    var chips = $('tag-chips');
    var names = TAG_NAMES.slice();
    Object.keys(tagCount).forEach(function (t) { if (names.indexOf(t) === -1) names.push(t); });
    chips.replaceChildren.apply(chips, names.filter(function (t) { return tagCount[t] || state.tags.has(t); }).map(function (t) {
      return h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(state.tags.has(t)),
        onclick: function () { toggleTag(t); }
      }, t, h('span', { class: 'num' }, tagCount[t] || 0));
    }));

    var st = $('filters-status');
    var n = visible().length;
    var kids = [h('span', null, (searchingAll() ? '在所有期別找到 ' : '顯示 ') + n + ' 則')];
    if (tokens().length) {
      kids.push(h('span', { class: 'scope' }, '搜尋範圍',
        h('button', { type: 'button', 'aria-pressed': String(state.scope === 'all'), onclick: function () { state.scope = 'all'; renderFilters(); renderList(); } }, '所有期別'),
        h('button', { type: 'button', 'aria-pressed': String(state.scope === 'week'), onclick: function () { state.scope = 'week'; renderFilters(); renderList(); } }, '只搜本期')));
    }
    if (hasFilters()) kids.push(h('button', { type: 'button', class: 'btn-text', onclick: clearFilters }, '清除篩選'));
    st.replaceChildren.apply(st, kids);
  }
  function toggleTag(t) {
    if (state.tags.has(t)) state.tags.delete(t); else state.tags.add(t);
    renderFilters(); renderList(); renderRail();
  }

  // ---------- 新聞列表 ----------
  function renderList() {
    var list = $('list');
    if (!state.loaded && !state.news.length) {
      var sk = h('div', { class: 'panel skeleton', 'aria-busy': 'true' });
      for (var i = 0; i < 3; i++) sk.append(h('div', { class: 'news' }, h('div'), h('div', null, h('div', { class: 'sk t' }), h('div', { class: 'sk' }), h('div', { class: 'sk' }), h('div', { class: 'sk', style: 'width:60%' }))));
      list.replaceChildren(h('section', { class: 'group' }, sk));
      return;
    }
    if (!state.weeks.length) {
      list.replaceChildren(h('div', { class: 'panel empty' }, h('strong', null, '目前還沒有任何新聞'),
        '按右上角「新增新聞」上傳第一份 Word 週報。'));
      return;
    }
    var items = visible();
    if (!items.length) {
      list.replaceChildren(h('div', { class: 'panel empty' }, h('strong', null, '沒有符合條件的新聞'),
        h('span', null, '試試其他關鍵字，或 '), h('button', { type: 'button', class: 'btn-text', onclick: clearFilters }, '清除篩選')));
      return;
    }
    var tk = tokens();
    var byWeek = searchingAll();
    var weekKeys = [];
    items.forEach(function (n) { if (weekKeys.indexOf(n.week_start) === -1) weekKeys.push(n.week_start); });
    var regionKeys = REGIONS.slice();
    items.forEach(function (n) { if (regionKeys.indexOf(n.region) === -1) regionKeys.push(n.region); });
    var frag = document.createDocumentFragment();
    weekKeys.forEach(function (wk) {
      if (byWeek) {
        var wobj = state.weeks.filter(function (w) { return w.start === wk; })[0];
        frag.append(h('div', { class: 'week-head' },
          h('button', { type: 'button', class: 'btn-text', onclick: function () { goWeek(wk); } }, fmtRange(wk, wobj ? wobj.end : ''))));
      }
      regionKeys.forEach(function (r) {
        var g = items.filter(function (n) { return n.week_start === wk && n.region === r; });
        if (!g.length) return;
        frag.append(h('section', { class: 'group', 'aria-label': (r || '未分類') + '新聞' },
          h('div', { class: 'sec-head' },
            h('h2', { class: 'sec-title' }, h('span', { class: 'marker' }, (r || '未分類') + '新聞')),
            h('span', { class: 'sec-count' }, g.length + ' 則')),
          h('div', { class: 'panel' }, g.map(function (n, i) { return newsEl(n, i, tk); }))));
      });
    });
    list.replaceChildren(frag);
    requestAnimationFrame(updateClamps);
  }

  function newsEl(n, i, tk) {
    var url = safeUrl(n.url);
    var autoOpen = tk.length > 0;
    var open = autoOpen || state.expanded.has(n.id);
    var sumId = 'sum-' + n.id.replace(/[^\w-]/g, '');
    var sum = h('p', { class: 'news-sum' + (open ? '' : ' clamp'), id: sumId }, highlight(n.summary, tk));
    var more = h('button', { type: 'button', class: 'btn-text more', 'aria-controls': sumId, 'aria-expanded': String(open), hidden: true },
      open ? '收合' : '展開全文');
    more.dataset.user = state.expanded.has(n.id) ? '1' : '';
    more.addEventListener('click', function () {
      var clamped = sum.classList.toggle('clamp');
      if (clamped) state.expanded.delete(n.id); else state.expanded.add(n.id);
      more.textContent = clamped ? '展開全文' : '收合';
      more.setAttribute('aria-expanded', String(!clamped));
      more.dataset.user = clamped ? '' : '1';
    });
    var titleKids = highlight(n.title, tk);
    return h('article', { class: 'news' },
      h('div', { class: 'news-no', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
      h('div', { class: 'news-body' },
        h('h3', { class: 'news-title' }, url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, titleKids) : titleKids),
        h('div', { class: 'news-meta' },
          h('span', { class: 'src' }, highlight(n.source, tk)),
          h('span', { 'aria-hidden': 'true' }, '·'),
          h('time', { datetime: n.date }, fmtD(n.date))),
        n.summary ? sum : null,
        h('div', { class: 'news-foot' },
          h('div', { class: 'tags' }, n.tags.map(function (t) {
            return h('button', { type: 'button', class: 'tag' + (state.tags.has(t) ? ' on' : ''), title: '篩選「' + t + '」', onclick: function () { toggleTag(t); } }, t);
          })),
          h('div', { class: 'news-actions' },
            n.summary ? more : null,
            url ? h('a', { class: 'link-out', href: url, target: '_blank', rel: 'noopener noreferrer' }, '閱讀原文', icon('ext')) : null,
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': '複製這則新聞', title: '複製（標題、摘要、連結）',
              onclick: function () { copyText(P.toText(n), '已複製這則新聞'); } }, icon('copy')))),
        url ? h('p', { class: 'print-url' }, '原文連結：' + url) : null));
  }

  function updateClamps() {
    document.querySelectorAll('#list .news-sum').forEach(function (el) {
      var btn = el.parentNode.querySelector('.more');
      if (!btn) return;
      if (el.classList.contains('clamp')) btn.hidden = el.scrollHeight <= el.clientHeight + 2;
      else btn.hidden = btn.dataset.user !== '1';
    });
  }

  // ---------- 右側欄 ----------
  function renderRail() {
    var w = curWeek();
    var dist = $('tag-dist');
    if (!w) { dist.replaceChildren(); $('archive').replaceChildren(); return; }
    var cnt = {};
    w.items.forEach(function (n) { n.tags.forEach(function (t) { cnt[t] = (cnt[t] || 0) + 1; }); });
    var tags = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a] || TAG_NAMES.indexOf(a) - TAG_NAMES.indexOf(b); });
    var max = Math.max.apply(null, [1].concat(tags.map(function (t) { return cnt[t]; })));
    dist.replaceChildren.apply(dist, tags.length ? tags.map(function (t) {
      return h('li', null, h('button', { type: 'button', 'aria-pressed': String(state.tags.has(t)), onclick: function () { toggleTag(t); } },
        h('span', null, t), h('span', { class: 'num' }, cnt[t] + ' 則'),
        h('span', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.round(cnt[t] / max * 100) + '%' }))));
    }) : [h('li', { class: 'note-line' }, '本期尚無標籤')]);

    var arc = $('archive');
    var weeks = state.showAllWeeks ? state.weeks : state.weeks.slice(0, ARCHIVE_LIMIT);
    var rows = weeks.map(function (x) {
      return h('li', null, h('button', { type: 'button', 'aria-current': String(x.start === state.week), onclick: function () { goWeek(x.start); } },
        h('span', null, fmtRange(x.start, x.end)), h('span', { class: 'cnt' }, x.items.length)));
    });
    if (state.weeks.length > ARCHIVE_LIMIT) {
      rows.push(h('li', null, h('button', { type: 'button', class: 'btn-text', onclick: function () { state.showAllWeeks = !state.showAllWeeks; renderRail(); } },
        state.showAllWeeks ? '收合' : '顯示全部 ' + state.weeks.length + ' 期')));
    }
    arc.replaceChildren.apply(arc, rows);
  }

  function renderAll() {
    renderIssue(); renderObs(); renderFilters(); renderList(); renderRail();
    if (state.updatedAt) $('updated-at').textContent = '資料更新：' + String(state.updatedAt).replace('T', ' ').slice(0, 16).replace(/-/g, '/');
    if (state.week) { try { history.replaceState(null, '', '#w-' + state.week); } catch (e) { /* 忽略 */ } }
  }

  function goWeek(start) {
    if (!start) return;
    state.week = start;
    state.q = ''; $('q').value = '';
    state.expanded.clear();
    renderAll();
    var top = document.querySelector('.issue');
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' });
  }
  function stepWeek(delta) {
    var idx = state.weeks.indexOf(curWeek());
    var next = state.weeks[idx + delta];
    if (next) goWeek(next.start);
  }

  // ---------- 資料載入 ----------
  function apply(d) {
    state.news = d.news; state.obs = d.observations; state.updatedAt = d.updatedAt || state.updatedAt;
    rebuild();
  }
  function reload(targetWeek) {
    return S.load().then(function (d) {
      apply(d);
      if (targetWeek && state.weeks.some(function (w) { return w.start === targetWeek; })) state.week = targetWeek;
      $('error-banner').hidden = true;
    }, function (e) {
      $('error-text').textContent = '資料讀取失敗：' + (e && e.message ? e.message : '請檢查網路連線') + '。';
      $('error-banner').hidden = false;
    }).then(function () { state.loaded = true; renderAll(); });
  }

  // ---------- 匯出 ----------
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function toCsv(list) {
    var head = ['期別起', '期別迄', '區域', '標題', '來源', '日期', '標籤', '摘要', '原文連結'];
    var rows = sortItems(list).map(function (n) {
      return [n.week_start, n.week_end, n.region, n.title, n.source, n.date, n.tags.join('、'), n.summary, n.url].map(csvCell).join(',');
    });
    return '﻿' + [head.map(csvCell).join(',')].concat(rows).join('\r\n');
  }
  function saveFile(filename, text, mime) {
    if (inArtifact()) {
      window.claude.use('downloads').then(function (d) {
        if (!d) { toast('這個預覽環境無法下載檔案；部署到正式網址後即可使用。'); return; }
        return d.save({ filename: filename, data: text }).then(function () { toast('已匯出 ' + filename); }, function (e) {
          if (!e || e.code !== 'declined') toast('這個環境無法下載檔案。');
        });
      }, function () { toast('這個預覽環境無法下載檔案。'); });
      return;
    }
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
    toast('已匯出 ' + filename);
  }
  function exportPdf() {
    if (inArtifact()) { toast('預覽環境無法開啟列印視窗；部署到正式網址後，這個按鈕即可另存 PDF。'); return; }
    var w = curWeek();
    var old = document.title;
    document.title = C.SITE_TITLE + (w ? '_' + w.start + '_' + w.end : '');
    function restore() { document.title = old; window.removeEventListener('afterprint', restore); }
    window.addEventListener('afterprint', restore);
    toast('在列印視窗的「目的地」選擇「另存為 PDF」。');
    setTimeout(function () { window.print(); }, 60);
  }
  function doExport(kind) {
    var w = curWeek();
    if (kind === 'pdf') return exportPdf();
    if (kind === 'csv-view') {
      var list = visible();
      if (!list.length) { toast('目前沒有可匯出的新聞。'); return; }
      var name = C.SITE_TITLE + (searchingAll() ? '_搜尋結果' : (w ? '_' + w.start + '_' + w.end : '')) + '.csv';
      return saveFile(name, toCsv(list), 'text/csv;charset=utf-8');
    }
    if (kind === 'csv-all') {
      if (!state.news.length) { toast('目前沒有可匯出的新聞。'); return; }
      return saveFile(C.SITE_TITLE + '_全部_' + P.todayStr() + '.csv', toCsv(state.news), 'text/csv;charset=utf-8');
    }
  }

  // ---------- AI 指令 ----------
  var CONVERT_PROMPT = [
    '請把我在最後提供的新聞，整理成「' + C.SITE_TITLE + '」的固定格式。只輸出整理後的內容，不要加任何說明，也不要使用 Markdown 符號（例如 **、#）。',
    '',
    '格式範例：',
    '2026/10/29–11/04',
    '【國內新聞】',
    '1. 新聞標題 - 來源媒體 2026/10/29',
    '新聞摘要（繁體中文，100–250 字）',
    '原文連結：https://完整網址',
    '',
    '【國外新聞】',
    '1. 新聞標題 - 來源媒體 2026/10/31',
    '新聞摘要',
    '原文連結：https://完整網址',
    '',
    '規則：',
    '1. 第一行是期別（週四到下週三），不確定就省略這一行。',
    '2. 國內＝台灣企業或在台灣發生的新聞；其他都放國外。',
    '3. 標題、來源與日期之間用「 - 」分隔，日期一律寫成 YYYY/MM/DD。',
    '4. 摘要客觀陳述重點，不加評論，不要寫「摘要：」字樣。',
    '5. 每則都要有原文連結，必須是我提供的網址，不可自行編造；沒有網址就寫「原文連結：（缺）」。',
    '6. 同一則新聞不要重複列出。',
    '',
    '以下是新聞內容：',
    ''
  ].join('\n');

  function obsPrompt() {
    var w = curWeek();
    var lines = [
      '你是機器人產業分析師。請根據下列「' + C.SITE_TITLE + '」本期新聞（' + (w ? fmtRange(w.start, w.end) : '') + '），寫出 3–4 點「本週重點觀察」。',
      '',
      '格式要求：',
      '- 每點一行，不要編號，也不要項目符號。',
      '- 每行開頭是 20 字以內的重點短句，接全形冒號「：」，再用 1–2 句說明，並點出相關公司。',
      '- 只能使用下列新聞中的事實，不要加入新聞以外的資訊或數字。',
      '- 只輸出這幾行，不要其他文字。',
      ''
    ];
    REGIONS.forEach(function (r) {
      var g = sortItems((w ? w.items : []).filter(function (n) { return n.region === r; }));
      if (!g.length) return;
      lines.push('【' + r + '新聞】');
      g.forEach(function (n, i) { lines.push((i + 1) + '. ' + P.toText(n)); lines.push(''); });
    });
    return lines.join('\n');
  }

  // ---------- 新增新聞（對話框） ----------
  var up = { tab: 'word', parsed: null, parsedFrom: null, single: { region: REGIONS[0], tags: new Set(), touched: false } };

  function blocking(it) {
    var e = [];
    if (REGIONS.indexOf(it.region) === -1) e.push('請選擇區域');
    if (!it.title.trim()) e.push('缺少標題');
    if (!it.source.trim()) e.push('缺少來源媒體');
    if (!P.isValidDate(it.date)) e.push('日期格式不正確');
    if (!P.isValidUrl(it.url)) e.push('缺少或無效的原文連結');
    return e;
  }
  function soft(it, r) {
    var e = [];
    if (it.dup) e.push('網站上已有相同連結的新聞，預設不重複刊登');
    if (!it.summary.trim()) e.push('沒有摘要');
    if (r && P.isValidDate(it.date) && (it.date < r.weekStart || it.date > r.weekEnd)) e.push('日期不在本期區間內');
    return e;
  }

  function openUpload(tab) {
    up.parsed = null; up.parsedFrom = null;
    up.single = { region: REGIONS[0], tags: new Set(), touched: false };
    ['s-title', 's-source', 's-url', 's-summary'].forEach(function (id) { $(id).value = ''; $(id).classList.remove('bad'); });
    $('s-date').value = P.todayStr();
    $('paste-input').value = '';
    $('file-input').value = '';
    $('uploader').value = lsGet('rnw-uploader');
    $('upload-code').value = lsGet('rnw-code');
    $('code-field').hidden = !C.UPLOAD_CODE_REQUIRED;
    $('uploader').classList.remove('bad');
    var dl = $('source-list');
    var srcs = Array.from(new Set(state.news.map(function (n) { return n.source; }))).sort();
    dl.replaceChildren.apply(dl, srcs.map(function (s) { return h('option', { value: s }); }));
    renderSingle();
    setTab(tab || 'word');
    $('upload-dlg').showModal();
  }
  function setTab(t) {
    up.tab = t;
    document.querySelectorAll('#upload-dlg [role="tab"]').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.tab === t));
    });
    var showPreview = (t === 'word' || t === 'paste') && up.parsed && up.parsedFrom === t;
    $('panel-word').hidden = t !== 'word' || showPreview;
    $('panel-paste').hidden = t !== 'paste' || showPreview;
    $('panel-single').hidden = t !== 'single';
    $('preview').hidden = !showPreview;
    if (showPreview) renderPreview();
    updatePublish();
  }

  function handleFile(file) {
    if (!file) return;
    if (!/\.docx$/i.test(file.name)) { toast('請選擇 .docx 格式的 Word 檔（舊版 .doc 請先另存為 .docx）。'); return; }
    file.arrayBuffer().then(function (buf) { return P.parseDocx(buf, file.name); }).then(function (r) {
      r.fileName = file.name;
      setParsed(r, 'word');
    }).catch(function (e) { toast(e.message || '讀取 Word 檔失敗'); });
  }
  function setParsed(r, from) {
    var existing = new Set(state.news.map(function (n) { return P.urlKey(n.url); }));
    r.items.forEach(function (it) {
      it.dup = !!it.url && existing.has(P.urlKey(it.url));
      it.include = !it.dup && blocking(it).length === 0;
    });
    r.includeObs = !!r.observation;
    r.obsText = r.observation;
    up.parsed = r; up.parsedFrom = from;
    setTab(from);
  }

  function renderPreview() {
    var r = up.parsed, pv = $('preview');
    var counts = REGIONS.map(function (g) { return g + ' ' + r.items.filter(function (i) { return i.region === g; }).length; }).join('、');
    var startIn = h('input', { class: 'input', type: 'date', id: 'pv-start', value: r.weekStart });
    var endIn = h('input', { class: 'input', type: 'date', id: 'pv-end', value: r.weekEnd });
    function onRange() {
      if (P.isValidDate(startIn.value)) r.weekStart = startIn.value;
      if (P.isValidDate(endIn.value)) r.weekEnd = endIn.value;
      refreshers.forEach(function (f) { f(); });
    }
    startIn.addEventListener('change', function () {
      if (P.isValidDate(startIn.value)) { endIn.value = P.addDays(startIn.value, 6); }
      onRange();
    });
    endIn.addEventListener('change', onRange);
    var refreshers = [];
    var kids = [
      h('div', { class: 'pv-head' },
        h('div', null,
          h('button', { type: 'button', class: 'btn-text', onclick: function () { up.parsed = null; setTab(up.tab); } }, icon('back'), up.parsedFrom === 'word' ? ' 重新選擇檔案' : ' 返回修改文字'),
          h('p', { class: 'pv-title' }, '找到 ' + r.items.length + ' 則新聞'),
          h('p', { class: 'pv-sub' }, counts + (r.fileName ? ' · ' + r.fileName : ''))),
        h('div', { class: 'pv-range' },
          h('div', { class: 'field' }, h('label', { for: 'pv-start' }, '期別起'), startIn),
          h('div', { class: 'field' }, h('label', { for: 'pv-end' }, '期別迄'), endIn)))
    ];
    if (r.warnings.length) kids.push(h('ul', { class: 'pv-msgs' }, r.warnings.map(function (w) { return h('li', null, w); })));
    if (r.observation) {
      var ta = h('textarea', { class: 'textarea', rows: '5', id: 'pv-obs', 'aria-label': '本週重點觀察內容' });
      ta.value = r.obsText;
      ta.addEventListener('input', function () { r.obsText = ta.value; });
      var cb = h('input', { type: 'checkbox', checked: r.includeObs, id: 'pv-obs-on' });
      cb.addEventListener('change', function () { r.includeObs = cb.checked; updatePublish(); });
      kids.push(h('div', { class: 'pv-obs' },
        h('label', { class: 'chk', for: 'pv-obs-on' }, cb, '同時更新這一期的「本週重點觀察」'),
        h('div', { style: 'margin-top:8px' }, ta)));
    }
    var listEl = h('div', { class: 'pv-list' });
    r.items.forEach(function (it, idx) { listEl.append(pvItem(it, idx, r, refreshers)); });
    kids.push(listEl);
    pv.replaceChildren.apply(pv, kids);
  }

  function pvItem(it, idx, r, refreshers) {
    var pre = 'pv' + idx + '-';
    var cb = h('input', { type: 'checkbox', checked: it.include, 'aria-label': '刊登這則新聞', id: pre + 'on' });
    var region = h('select', { class: 'select', id: pre + 'region', 'aria-label': '區域' },
      [h('option', { value: '' }, '區域')].concat(REGIONS.map(function (g) { return h('option', { value: g, selected: it.region === g }, g); })));
    var title = h('input', { class: 'input', id: pre + 'title', value: it.title, 'aria-label': '標題', placeholder: '標題' });
    var source = h('input', { class: 'input', id: pre + 'source', value: it.source, 'aria-label': '來源媒體', placeholder: '來源媒體' });
    var date = h('input', { class: 'input', type: 'date', id: pre + 'date', value: it.date, 'aria-label': '日期' });
    var url = h('input', { class: 'input', type: 'url', id: pre + 'url', value: it.url, 'aria-label': '原文連結', placeholder: 'https://' });
    var sum = h('textarea', { class: 'textarea', rows: '5', id: pre + 'sum', 'aria-label': '摘要' });
    sum.value = it.summary;
    var sumLabel = h('summary', null, '');
    var tagBox = h('div', { class: 'chips small' });
    var warn = h('p', { class: 'pv-warn' });
    var softWarn = h('p', { class: 'pv-warn soft' });
    var box = h('div', { class: 'pv-item' },
      cb,
      h('div', { class: 'pv-body' },
        h('div', { class: 'pv-r1' }, region, title),
        h('div', { class: 'pv-r2' }, source, date, url),
        h('details', null, sumLabel, sum),
        tagBox, warn, softWarn));

    function drawTags() {
      tagBox.replaceChildren.apply(tagBox, TAG_NAMES.map(function (t) {
        var on = it.tags.indexOf(t) !== -1;
        return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), onclick: function () {
          if (on) it.tags = it.tags.filter(function (x) { return x !== t; }); else it.tags = it.tags.concat(t);
          drawTags();
        } }, t);
      }));
    }
    function refresh() {
      var b = blocking(it), s = soft(it, r);
      if (b.length) { it.include = false; cb.checked = false; }
      cb.disabled = b.length > 0;
      box.classList.toggle('bad', b.length > 0);
      box.classList.toggle('off', !it.include);
      warn.textContent = b.length ? '需要修正：' + b.join('、') : '';
      warn.hidden = !b.length;
      softWarn.textContent = s.length ? '提醒：' + s.join('、') : '';
      softWarn.hidden = !s.length;
      title.classList.toggle('bad', !it.title.trim());
      source.classList.toggle('bad', !it.source.trim());
      date.classList.toggle('bad', !P.isValidDate(it.date));
      url.classList.toggle('bad', !P.isValidUrl(it.url));
      region.classList.toggle('bad', REGIONS.indexOf(it.region) === -1);
      sumLabel.textContent = '摘要（' + it.summary.length + ' 字）';
      updatePublish();
    }
    function bind(el, key, ev) {
      el.addEventListener(ev || 'input', function () {
        var wasBlocked = blocking(it).length > 0;
        it[key] = el.value.trim();
        if (wasBlocked && !blocking(it).length && !it.dup) { it.include = true; cb.checked = true; }
        refresh();
      });
    }
    bind(title, 'title'); bind(source, 'source'); bind(date, 'date', 'change'); bind(url, 'url');
    bind(region, 'region', 'change');
    sum.addEventListener('input', function () { it.summary = sum.value; refresh(); });
    cb.addEventListener('change', function () { it.include = cb.checked; refresh(); });
    drawTags(); refresh();
    refreshers.push(refresh);
    return box;
  }

  // 單則新增
  function singleWeek(date) {
    if (!P.isValidDate(date)) return null;
    for (var i = 0; i < state.weeks.length; i++) {
      var w = state.weeks[i];
      if (date >= w.start && date <= w.end) return { start: w.start, end: w.end, existing: true };
    }
    var x = P.weekOf(date);
    return { start: x.start, end: x.end, existing: false };
  }
  function singleItem() {
    var date = $('s-date').value;
    var w = singleWeek(date);
    return {
      region: up.single.region, title: $('s-title').value.trim(), source: $('s-source').value.trim(),
      date: date, url: $('s-url').value.trim(), summary: $('s-summary').value.trim(),
      tags: TAG_NAMES.filter(function (t) { return up.single.tags.has(t); }),
      week_start: w ? w.start : '', week_end: w ? w.end : ''
    };
  }
  function renderSingle() {
    var seg = $('single-region');
    seg.replaceChildren.apply(seg, REGIONS.map(function (r) {
      return h('button', { type: 'button', role: 'radio', 'aria-checked': String(up.single.region === r), onclick: function () { up.single.region = r; renderSingle(); } }, r);
    }));
    if (!up.single.touched) {
      up.single.tags = new Set(P.suggestTags($('s-title').value + ' ' + $('s-summary').value));
    }
    var box = $('s-tags');
    box.replaceChildren.apply(box, TAG_NAMES.map(function (t) {
      return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(up.single.tags.has(t)), onclick: function () {
        up.single.touched = true;
        if (up.single.tags.has(t)) up.single.tags.delete(t); else up.single.tags.add(t);
        renderSingle();
      } }, t);
    }));
    var w = singleWeek($('s-date').value);
    var note = $('s-week');
    note.replaceChildren(w ? h('span', null, '將歸入期別：', h('span', { class: 'num' }, fmtRange(w.start, w.end)), w.existing ? '' : '（新的一期）') : '請選擇新聞日期');
    updatePublish();
  }

  function updatePublish() {
    var btn = $('publish-btn');
    if (!btn || btn.dataset.busy) return;
    if (up.tab === 'single') {
      var ok = blocking(singleItem()).length === 0;
      btn.disabled = !ok;
      btn.textContent = '發布 1 則';
      return;
    }
    var r = up.parsed && up.parsedFrom === up.tab ? up.parsed : null;
    if (!r) { btn.disabled = true; btn.textContent = '發布'; return; }
    var n = r.items.filter(function (i) { return i.include && !blocking(i).length; }).length;
    var withObs = r.observation && r.includeObs;
    btn.disabled = n === 0 && !withObs;
    btn.textContent = n ? '發布 ' + n + ' 則' + (withObs ? '與重點觀察' : '') : (withObs ? '只更新重點觀察' : '發布');
  }

  function who(nameId, codeId) {
    var name = $(nameId).value.trim();
    var code = $(codeId).value.trim();
    if (!name) { $(nameId).classList.add('bad'); $(nameId).focus(); toast('請填寫姓名或員工編號，才能發布。'); return null; }
    if (C.UPLOAD_CODE_REQUIRED && !code) { $(codeId).classList.add('bad'); $(codeId).focus(); toast('請輸入團隊上傳碼。'); return null; }
    $(nameId).classList.remove('bad');
    lsSet('rnw-uploader', name);
    if (code) lsSet('rnw-code', code);
    return { uploader: name, code: code };
  }

  function publish() {
    var meta = who('uploader', 'upload-code');
    if (!meta) return;
    var items, obsText = null, target;
    if (up.tab === 'single') {
      var it = singleItem();
      var errs = blocking(it);
      if (errs.length) { toast(errs.join('、')); return; }
      if (state.news.some(function (n) { return P.urlKey(n.url) === P.urlKey(it.url); })) { toast('網站上已有相同連結的新聞。'); return; }
      items = [it]; target = it.week_start;
    } else {
      var r = up.parsed;
      if (!r) return;
      items = r.items.filter(function (i) { return i.include && !blocking(i).length; }).map(function (i) {
        return { region: i.region, title: i.title, source: i.source, date: i.date, summary: i.summary, url: i.url, tags: i.tags, week_start: r.weekStart, week_end: r.weekEnd };
      });
      if (r.observation && r.includeObs && r.obsText.trim()) obsText = r.obsText.trim();
      target = r.weekStart;
    }
    var btn = $('publish-btn');
    btn.dataset.busy = '1'; btn.disabled = true; btn.textContent = '發布中…';
    var result = { added: 0, skipped: 0 };
    var job = items.length ? S.addNews(items, meta).then(function (res) { result = res; }) : Promise.resolve();
    job.then(function () {
      if (obsText) return S.saveObservation(target, obsText, meta);
    }).then(function () {
      $('upload-dlg').close();
      var msg = '已發布 ' + result.added + ' 則';
      if (result.skipped) msg += '，略過 ' + result.skipped + ' 則重複';
      if (obsText) msg += '，並更新重點觀察';
      toast(msg);
      state.q = ''; $('q').value = '';
      return reload(target);
    }).catch(function (e) {
      if (e && e.code === 'bad_code') { $('code-field').hidden = false; $('upload-code').classList.add('bad'); }
      toast((e && e.message) || '發布失敗，請稍後再試。');
    }).then(function () {
      delete btn.dataset.busy;
      updatePublish();
    });
  }

  // ---------- 重點觀察（對話框） ----------
  function openObs() {
    var w = curWeek();
    if (!w) { toast('目前還沒有期別，請先新增新聞。'); return; }
    var o = state.obs[w.start];
    $('obs-text').value = (o && o.text) || '';
    $('obs-dlg-week').replaceChildren('期別：', h('span', { class: 'num' }, fmtRange(w.start, w.end)));
    $('obs-uploader').value = lsGet('rnw-uploader');
    $('obs-code').value = lsGet('rnw-code');
    $('obs-code-field').hidden = !C.UPLOAD_CODE_REQUIRED;
    $('obs-dlg').showModal();
  }
  function saveObs() {
    var meta = who('obs-uploader', 'obs-code');
    if (!meta) return;
    var w = curWeek();
    var text = $('obs-text').value.trim();
    var btn = $('obs-save');
    btn.disabled = true; btn.textContent = '儲存中…';
    S.saveObservation(w.start, text, meta).then(function () {
      $('obs-dlg').close();
      toast(text ? '已更新本週重點觀察' : '已清除本週重點觀察');
      return reload(w.start);
    }).catch(function (e) {
      if (e && e.code === 'bad_code') { $('obs-code-field').hidden = false; $('obs-code').classList.add('bad'); }
      toast((e && e.message) || '儲存失敗，請稍後再試。');
    }).then(function () { btn.disabled = false; btn.textContent = '儲存'; });
  }

  // ---------- 事件綁定 ----------
  function bindEvents() {
    $('brand-link').addEventListener('click', function (e) { e.preventDefault(); if (state.weeks.length) goWeek(state.weeks[0].start); });
    $('prev-week').addEventListener('click', function () { stepWeek(1); });
    $('next-week').addEventListener('click', function () { stepWeek(-1); });
    $('week-select').addEventListener('change', function (e) { goWeek(e.target.value); });
    $('source-select').addEventListener('change', function (e) { state.source = e.target.value; renderFilters(); renderList(); });
    var onSearch = debounce(function () {
      var v = $('q').value;
      if (!state.q.trim() && v.trim()) state.scope = 'all';
      state.q = v;
      renderFilters(); renderList();
    }, 140);
    $('q').addEventListener('input', onSearch);
    $('q').addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('q').value) { e.preventDefault(); $('q').value = ''; state.q = ''; renderFilters(); renderList(); } });

    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(tag) && !document.querySelector('dialog[open]')) {
        e.preventDefault(); $('q').focus();
      }
    });
    window.addEventListener('resize', debounce(updateClamps, 150));
    window.addEventListener('hashchange', function () {
      var m = /^#w-(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
      if (m && m[1] !== state.week && state.weeks.some(function (w) { return w.start === m[1]; })) goWeek(m[1]);
    });

    // 深色／淺色
    $('theme-btn').addEventListener('click', function () {
      var root = document.documentElement;
      var cur = root.getAttribute('data-theme');
      var dark = cur ? cur === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
      var next = dark ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      lsSet('rnw-theme', next);
    });

    // 匯出選單
    var pop = $('export-pop'), ebtn = $('export-btn');
    function closeMenu() { pop.hidden = true; ebtn.setAttribute('aria-expanded', 'false'); }
    ebtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = pop.hidden;
      pop.hidden = !open; ebtn.setAttribute('aria-expanded', String(open));
      if (open) pop.querySelector('button').focus();
    });
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('[data-export]');
      if (!b) return;
      closeMenu(); doExport(b.dataset.export);
    });
    document.addEventListener('click', function (e) { if (!pop.hidden && !e.target.closest('#export-menu')) closeMenu(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden) { closeMenu(); ebtn.focus(); } });

    // 新增新聞
    $('add-btn').addEventListener('click', function () { openUpload('word'); });
    document.querySelectorAll('#upload-dlg [role="tab"]').forEach(function (b) {
      b.addEventListener('click', function () { setTab(b.dataset.tab); });
    });
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { b.closest('dialog').close(); });
    });
    $('file-input').addEventListener('change', function (e) { handleFile(e.target.files[0]); });
    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { handleFile(e.dataTransfer.files[0]); });
    $('paste-parse').addEventListener('click', function () {
      var v = $('paste-input').value;
      if (!v.trim()) { toast('請先貼上內容。'); return; }
      setParsed(P.parseText(v), 'paste');
    });
    $('copy-convert-prompt').addEventListener('click', function () { copyText(CONVERT_PROMPT, '已複製 AI 轉檔指令，貼到 ChatGPT 後接著貼上新聞即可'); });
    ['s-title', 's-source', 's-url', 's-summary'].forEach(function (id) {
      $(id).addEventListener('input', debounce(renderSingle, 200));
    });
    $('s-date').addEventListener('change', renderSingle);
    $('uploader').addEventListener('input', function () { $('uploader').classList.remove('bad'); });
    $('publish-btn').addEventListener('click', publish);

    // 重點觀察
    $('obs-edit').addEventListener('click', openObs);
    $('obs-write').addEventListener('click', openObs);
    $('obs-save').addEventListener('click', saveObs);
    $('copy-obs-prompt').addEventListener('click', function () { copyText(obsPrompt(), '已複製 AI 撰寫指令（含本期新聞）'); });
    $('retry-btn').addEventListener('click', function () { reload(); });
  }

  // ---------- 啟動 ----------
  function init() {
    document.title = C.SITE_TITLE;
    $('site-title').textContent = C.SITE_TITLE;
    $('site-sub').textContent = C.SITE_SUBTITLE || '';
    $('demo-banner').hidden = S.mode !== 'demo';
    var m = /^#w-(\d{4}-\d{2}-\d{2})$/.exec(location.hash);
    if (m) state.week = m[1];
    bindEvents();
    var cached = S.cached();
    if (cached) { apply(cached); }
    renderAll();
    reload(m ? m[1] : null);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
