/*
 * 週報解析器：把 Word（.docx）或貼上的文字拆成一則一則的新聞。
 * 純邏輯、不碰畫面。需要 JSZip（assets/vendor/jszip.min.js）才能讀 .docx。
 *
 * 支援的格式（與現行週報相同）：
 *   機器人產業新聞週報 2026/10/29–11/04      ← 選填：期別
 *   【本週重點觀察】                          ← 選填：一行一點
 *   【國內新聞】 / 【國外新聞】                ← 區塊
 *   1. 新聞標題 - 來源媒體 2026/10/29          ← 標題行（分隔可用 - – — －）
 *   摘要段落（可多段）
 *   原文連結：https://...
 */
(function () {
  'use strict';

  var CFG = window.SITE_CONFIG || {};
  var W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  var SEP = '[-–—－]';
  var DATE_PART = '(\\d{4})\\s*[\\/.\\-年]\\s*(\\d{1,2})\\s*[\\/.\\-月]\\s*(\\d{1,2})\\s*日?';
  var TITLE_RE = new RegExp('^(.+?)\\s*' + SEP + '\\s*([^-–—－]*?\\S)\\s*' + DATE_PART + '\\s*$');
  var LINK_RE = /^(?:原文)?(?:連結|網址|來源連結)\s*[:：]\s*(.*)$/;
  var URL_RE = /https?:\/\/[^\s<>"'，。、）)]+/i;
  var HEADER_RE = /^[【\[［]\s*([^】\]］]{1,20})\s*[】\]］]\s*(.{0,12})$/;
  var NUMBERING_RE = /^\s*(?:\(?\d{1,2}[.)、．]|\(\d{1,2}\)|[•●▪■◆\-–*])\s*/;
  var RANGE_RE = /(\d{4})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[~～\-–—至到]\s*(?:(\d{4})\s*[\/.\-]\s*)?(\d{1,2})\s*[\/.\-]\s*(\d{1,2})/;
  var FILE_RANGE_RE = /(\d{2})(\d{2})\s*[-_~～–]\s*(\d{2})(\d{2})/;

  // ---------- 日期工具 ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) { return y + '-' + pad(+m) + '-' + pad(+d); }
  function toDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    var dt = new Date(+m[1], +m[2] - 1, +m[3]);
    return dt.getMonth() === +m[2] - 1 ? dt : null;
  }
  function fromDate(dt) { return ymd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()); }
  function addDays(s, n) { var dt = toDate(s); dt.setDate(dt.getDate() + n); return fromDate(dt); }
  function isValidDate(s) { return !!toDate(s); }

  /** 依設定的起始星期，算出某天所屬的期別 {start, end}。 */
  function weekOf(dateStr) {
    var dt = toDate(dateStr);
    if (!dt) return null;
    var startDay = typeof CFG.WEEK_START_DAY === 'number' ? CFG.WEEK_START_DAY : 4;
    var diff = (dt.getDay() - startDay + 7) % 7;
    dt.setDate(dt.getDate() - diff);
    var start = fromDate(dt);
    return { start: start, end: addDays(start, 6) };
  }

  // ---------- 文字整理 ----------
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[ 　]/g, ' ')
      .replace(/[​-‍﻿]/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }
  function normalizeSource(s) {
    return clean(s)
      .replace(/([A-Za-z0-9])\s+([㐀-鿿])/g, '$1$2')
      .replace(/([㐀-鿿])\s+([A-Za-z0-9])/g, '$1$2');
  }
  function stripNumbering(s) { return s.replace(NUMBERING_RE, ''); }
  function isValidUrl(u) {
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u || '')) return false;
    try { var x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch (e) { return false; }
  }
  function urlKey(u) {
    try {
      var x = new URL(u);
      return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase();
    } catch (e) { return String(u || '').toLowerCase(); }
  }

  // ---------- 標籤建議 ----------
  function suggestTags(text) {
    var hay = String(text || '').toLowerCase();
    return (CFG.TAGS || []).filter(function (t) {
      return (t.keywords || []).some(function (k) { return hay.indexOf(String(k).toLowerCase()) !== -1; });
    }).map(function (t) { return t.name; });
  }

  function regionFromHeader(name) {
    if (/觀察|重點|摘要|導讀/.test(name)) return 'OBS';
    if (/國內|台灣|臺灣/.test(name)) return '國內';
    if (/國外|國際|海外|全球/.test(name)) return '國外';
    var regions = CFG.REGIONS || [];
    for (var i = 0; i < regions.length; i++) if (name.indexOf(regions[i]) !== -1) return regions[i];
    return 'UNKNOWN';
  }

  // ---------- 主要解析 ----------
  /**
   * @param {Array<{text:string,bold?:boolean,links?:string[]}>} paras
   * @param {{filename?:string}} opts
   */
  function parseParagraphs(paras, opts) {
    opts = opts || {};
    var items = [], obsLines = [], warnings = [];
    var section = null, cur = null, docRange = null, sawHeader = false;

    function startItem(fields) {
      cur = {
        region: section === '國內' || section === '國外' || (CFG.REGIONS || []).indexOf(section) !== -1 ? section : '',
        title: fields.title || '', source: fields.source || '', date: fields.date || '',
        summaryParts: [], url: ''
      };
      items.push(cur);
    }

    paras.forEach(function (p) {
      var raw = clean(p.text);
      if (!raw) return;
      var lines = raw.split(/\n+/).map(clean).filter(Boolean);
      lines.forEach(function (t, li) {
        var links = li === 0 ? (p.links || []) : [];

        var hm = HEADER_RE.exec(t);
        if (hm) {
          sawHeader = true;
          section = regionFromHeader(clean(hm[1]));
          if (section === 'UNKNOWN') warnings.push('無法辨識的區塊「' + hm[1] + '」，該區新聞的區域請在預覽中選擇。');
          cur = null;
          return;
        }

        if (!sawHeader) {
          var rm = RANGE_RE.exec(t);
          if (rm && !docRange) {
            var y2 = rm[4] || (+rm[5] < +rm[2] ? String(+rm[1] + 1) : rm[1]);
            docRange = { start: ymd(rm[1], rm[2], rm[3]), end: ymd(y2, rm[5], rm[6]) };
          }
          return; // 第一個區塊之前的文字（標題、說明）不當成新聞
        }

        if (section === 'OBS') {
          var line = stripNumbering(t);
          if (line) obsLines.push(line);
          return;
        }

        var lm = LINK_RE.exec(t);
        if (lm) {
          var u = links[0] || (URL_RE.exec(lm[1]) || [])[0] || clean(lm[1]);
          if (cur) cur.url = u; else warnings.push('有一行原文連結找不到對應的新聞標題：' + t.slice(0, 40));
          return;
        }
        if (/^https?:\/\/\S+$/i.test(t) && cur && !cur.url) { cur.url = links[0] || t; return; }

        var body = stripNumbering(t);
        var tm = TITLE_RE.exec(body);
        if (tm) {
          startItem({ title: clean(tm[1]), source: normalizeSource(tm[2]), date: ymd(tm[3], tm[4], tm[5]) });
          return;
        }
        // 粗體短句、且前一則已有連結 → 視為格式不完整的標題
        if (p.bold && body.length <= 120 && (!cur || cur.url)) {
          startItem({ title: body });
          return;
        }
        if (cur) cur.summaryParts.push(t);
        else warnings.push('有一段文字不屬於任何新聞，已略過：' + t.slice(0, 40));
      });
    });

    // 期別：文件內標示 > 檔名 > 依新聞日期推算
    var dates = items.map(function (i) { return i.date; }).filter(isValidDate).sort();
    var range = docRange;
    if (!range && opts.filename) {
      var fm = FILE_RANGE_RE.exec(opts.filename);
      if (fm && dates.length) {
        var yEnd = +dates[dates.length - 1].slice(0, 4);
        var yStart = +fm[1] > +fm[3] ? yEnd - 1 : yEnd;
        var s = ymd(yStart, fm[1], fm[2]), e = ymd(yEnd, fm[3], fm[4]);
        if (isValidDate(s) && isValidDate(e)) range = { start: s, end: e };
      }
    }
    if (!range && dates.length) range = weekOf(dates[0]);
    if (!range) range = weekOf(fromDate(new Date()));

    var out = items.map(function (it) {
      var summary = it.summaryParts.join('\n');
      var w = [];
      if (!it.region) w.push('未指定區域');
      if (!it.title) w.push('缺少標題');
      if (!it.source) w.push('缺少來源媒體');
      if (!isValidDate(it.date)) w.push('缺少或無法辨識日期');
      if (!isValidUrl(it.url)) w.push('缺少或無效的原文連結');
      if (!summary) w.push('沒有摘要');
      if (isValidDate(it.date) && (it.date < range.start || it.date > range.end)) w.push('日期不在本期區間內');
      return {
        region: it.region, title: it.title, source: it.source, date: it.date,
        summary: summary, url: it.url,
        tags: suggestTags(it.title + ' ' + summary),
        warnings: w
      };
    });

    if (!out.length) warnings.push('沒有找到任何新聞。請確認標題行的格式為「標題 - 來源 2026/10/29」。');
    return { weekStart: range.start, weekEnd: range.end, observation: obsLines.join('\n'), items: out, warnings: warnings };
  }

  // ---------- .docx ----------
  function readParagraph(pEl, rels) {
    var text = '', links = [], boldChars = 0, totalChars = 0;
    function walk(node, inBold) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1) continue;
        var ln = c.localName;
        if (ln === 'pPr' || ln === 'rPr' || ln === 'del' || ln === 'delText') continue;
        if (ln === 'r') {
          var rPr = null;
          for (var k = c.firstChild; k; k = k.nextSibling) if (k.nodeType === 1 && k.localName === 'rPr') rPr = k;
          var b = false;
          if (rPr) {
            for (var q = rPr.firstChild; q; q = q.nextSibling) {
              if (q.nodeType === 1 && q.localName === 'b') {
                var v = q.getAttributeNS(W_NS, 'val') || q.getAttribute('w:val');
                b = !(v === '0' || v === 'false' || v === 'off');
              }
            }
          }
          walk(c, b);
          continue;
        }
        if (ln === 't') {
          var s = c.textContent || '';
          text += s; totalChars += s.trim().length; if (inBold) boldChars += s.trim().length;
          continue;
        }
        if (ln === 'tab') { text += ' '; continue; }
        if (ln === 'br' || ln === 'cr') { text += '\n'; continue; }
        if (ln === 'hyperlink') {
          var id = c.getAttributeNS(R_NS, 'id') || c.getAttribute('r:id');
          if (id && rels[id]) links.push(rels[id]);
        }
        if (ln === 'instrText') {
          var hm = /HYPERLINK\s+"([^"]+)"/.exec(c.textContent || '');
          if (hm) links.push(hm[1]);
          continue;
        }
        walk(c, inBold);
      }
    }
    walk(pEl, false);
    return { text: text, links: links, bold: totalChars > 0 && boldChars / totalChars > 0.6 };
  }

  function parseDocx(arrayBuffer, filename) {
    if (typeof JSZip === 'undefined') return Promise.reject(new Error('讀取 Word 的元件尚未載入，請重新整理頁面後再試。'));
    return JSZip.loadAsync(arrayBuffer).then(function (zip) {
      var docFile = zip.file('word/document.xml');
      if (!docFile) throw new Error('這不是有效的 Word（.docx）檔案。若是舊版 .doc，請先另存為 .docx。');
      var relFile = zip.file('word/_rels/document.xml.rels');
      return Promise.all([docFile.async('string'), relFile ? relFile.async('string') : Promise.resolve('')]);
    }).then(function (res) {
      var parser = new DOMParser();
      var rels = {};
      if (res[1]) {
        var rdoc = parser.parseFromString(res[1], 'application/xml');
        var relEls = rdoc.getElementsByTagName('Relationship');
        for (var i = 0; i < relEls.length; i++) rels[relEls[i].getAttribute('Id')] = relEls[i].getAttribute('Target');
      }
      var doc = parser.parseFromString(res[0], 'application/xml');
      var ps = doc.getElementsByTagNameNS(W_NS, 'p');
      var paras = [];
      for (var j = 0; j < ps.length; j++) paras.push(readParagraph(ps[j], rels));
      return parseParagraphs(paras, { filename: filename });
    });
  }

  function parseText(text) {
    var trimmed = String(text || '').trim();
    if (/^[\[{]/.test(trimmed)) {
      try { return fromJson(JSON.parse(trimmed)); } catch (e) { /* 不是 JSON，當一般文字處理 */ }
    }
    var paras = trimmed.split(/\r?\n/).map(function (l) { return { text: l }; });
    return parseParagraphs(paras, {});
  }

  /** 也接受 AI 產生的 JSON：[{region,title,source,date,summary,url,tags}] 或 {week_start, observation, items:[...]} */
  function fromJson(data) {
    var list = Array.isArray(data) ? data : (data.items || data.news || []);
    var paras = [];
    var start = data.week_start || data.weekStart;
    var end = data.week_end || data.weekEnd;
    if (start) paras.push({ text: start.replace(/-/g, '/') + '–' + (end || addDays(start, 6)).replace(/-/g, '/') });
    if (data.observation) {
      paras.push({ text: '【本週重點觀察】' });
      String(data.observation).split(/\n+/).forEach(function (l) { paras.push({ text: l }); });
    }
    (CFG.REGIONS || ['國內', '國外']).forEach(function (r) {
      var group = list.filter(function (n) { return n.region === r; });
      if (!group.length) return;
      paras.push({ text: '【' + r + '新聞】' });
      group.forEach(function (n) {
        paras.push({ text: n.title + ' - ' + n.source + ' ' + String(n.date || '').replace(/-/g, '/') });
        paras.push({ text: n.summary || '' });
        paras.push({ text: '原文連結：' + (n.url || '') });
      });
    });
    var res = parseParagraphs(paras, {});
    // 保留 JSON 中明確給的標籤
    res.items.forEach(function (it) {
      var src = list.filter(function (n) { return n.title === it.title; })[0];
      if (src && Array.isArray(src.tags) && src.tags.length) it.tags = src.tags.slice();
    });
    return res;
  }

  /** 把新聞轉回週報文字格式（複製、AI 指令用）。 */
  function toText(n) {
    return n.title + ' - ' + n.source + ' ' + String(n.date).replace(/-/g, '/') + '\n' + n.summary + '\n原文連結：' + n.url;
  }

  window.NewsParser = {
    parseDocx: parseDocx, parseText: parseText, parseParagraphs: parseParagraphs,
    suggestTags: suggestTags, weekOf: weekOf, addDays: addDays, isValidDate: isValidDate,
    isValidUrl: isValidUrl, urlKey: urlKey, toText: toText, todayStr: function () { return fromDate(new Date()); }
  };
})();
