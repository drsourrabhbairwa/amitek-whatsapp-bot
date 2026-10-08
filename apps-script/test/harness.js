// Runs Code.gs in Node with fake Google services, for offline tests. No network, no real sheets.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeSheet(name) {
  const rows = [];
  const sh = {
    name, rows,
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    appendRow: r => { rows.push(r.slice()); },
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => { const v = (rows[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
      setValues: vals => vals.forEach((vr, i) => {
        while (rows.length < r + i) rows.push([]);
        vr.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; });
      }),
      setValue: v => { while (rows.length < r) rows.push([]); rows[r - 1][c - 1] = v; }
    }),
    deleteRows: (start, n) => rows.splice(start - 1, n),
    clearContents: () => rows.splice(0, rows.length)
  };
  return sh;
}

function load({ claude = [], props = {}, settings = {} } = {}) {
  const sheets = {};
  const sent = [];       // WhatsApp sends
  const claudeCalls = [];
  const triggers = [];
  const store = Object.assign({}, props);
  const cache = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n))
  };
  let waCounter = 0;
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => ctx.errors.push(a.join(' ')) },
    errors: [],
    Date, JSON, Math, Object, Array, String, Number, isNaN, parseInt,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null), setProperty: (k, v) => { store[k] = v; }, deleteProperty: k => { delete store[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; } }) },
    HtmlService: {
      createHtmlOutputFromFile: f => { const o = { file: f, setTitle: () => o, addMetaTag: () => o }; return o; },
      createHtmlOutput: html => { const o = { file: 'App', html, setTitle: () => o, addMetaTag: () => o }; return o; }
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => { const o = { text: t, setMimeType: () => o }; return o; } },
    Utilities: {
      formatDate: (d, tz, f) => new Date(d).toISOString(),
      getUuid: () => '1234-5678-uuid',
      sleep: () => {}
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: fn => {
        const b = { timeBased: () => b, everyHours: () => b, everyMinutes: () => b, atHour: () => b, everyDays: () => b, inTimezone: () => b,
                    create: () => { const t = { getHandlerFunction: () => fn }; triggers.push(t); return t; } };
        return b;
      }
    },
    UrlFetchApp: {
      fetch: (url, opt) => {
        const body = JSON.parse(opt.payload);
        if (url.startsWith('https://api.anthropic.com')) {
          claudeCalls.push({ headers: opt.headers, body: JSON.parse(JSON.stringify(body)) });
          const next = claude.shift();
          if (!next) throw new Error('unexpected Claude call');
          if (next.http) return { getResponseCode: () => next.http, getContentText: () => 'err' };
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify(next) };
        }
        sent.push({ url, headers: opt.headers, body });
        const id = 'wamid.out' + (++waCounter);
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ messages: [{ id }] }) };
      }
    }
  };
  vm.createContext(ctx);
  (process.env.DIST ? ['dist/Amitek_Bot.gs'] : ['Code.gs', 'App.gs', 'Grow.gs']).forEach(f =>
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f }));
  ctx.setup();
  // apply test settings to the Settings tab
  const st = sheets['Settings'];
  Object.keys(settings).forEach(k => {
    const row = st.rows.find(r => r[0] === k);
    row[1] = settings[k];
  });
  vm.runInContext('settingsCache_ = null;', ctx);
  return { ctx, sheets, sent, claude, claudeCalls, triggers, props: store, cache };
}

module.exports = { load };
