/**
 * Phone app API, used by the Android app (HTTP POST to the web app URL) and by the browser version
 * (web app URL opened without ?key=). Every call needs the app PIN (Script Property APP_PIN); the first
 * app that connects chooses it.
 */

function appPage_() {
  var out = typeof APP_HTML !== 'undefined' ? HtmlService.createHtmlOutput(APP_HTML) : HtmlService.createHtmlOutputFromFile('App');
  return out.setTitle('Amitek Leads')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

var EDITABLE = ['Name', 'Business', 'Category', 'Tier', 'City', 'Requirement', 'Area sqft', 'Assigned To', 'Follow-up Note'];
var BULK_FIELDS = ['Category', 'Tier', 'City', 'Assigned To'];
var APP_SETTINGS = ['SEND_ENABLED', 'BOT_ENABLED', 'BOT_MODE', 'SALES_WHATSAPP', 'TEAM_ROUTING', 'BUSINESS_NUMBER'];

/** Single entry point for the phone app: api(pin, action, argsJson) -> JSON string. */
function api(pin, action, argsJson) {
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('pin_fails') || 0);
  if (fails >= 10) return JSON.stringify({ error: 'Too many wrong PINs. Try again in an hour.' });
  var args = {};
  try { args = JSON.parse(argsJson || '{}'); } catch (err) { /* empty */ }
  var real = secret_('APP_PIN');
  if (!real) {
    // First connection: this app chooses the PIN and installs the sheet tabs and timers.
    if (action !== 'claim') return JSON.stringify({ error: 'NOPIN', message: 'Choose a PIN to finish setup' });
    var np = String(args.newPin || '');
    if (!/^\d{4,8}$/.test(np)) return JSON.stringify({ error: 'PIN must be 4 to 8 digits' });
    PropertiesService.getScriptProperties().setProperty('APP_PIN', np);
    try { setup(); } catch (err) { return JSON.stringify({ error: 'PIN saved, but setup failed: ' + err.message }); }
    return JSON.stringify({ message: 'Connected' });
  }
  if (String(pin) !== real) {
    cache.put('pin_fails', String(fails + 1), 3600);
    return JSON.stringify({ error: 'PIN', message: 'Wrong PIN' });
  }
  // slow AI actions only append rows, so they run without holding up incoming WhatsApp messages
  var lock = { sortRun: 1, learnChats: 1, learnText: 1 }[action] ? { releaseLock: function () {} } : LockService.getScriptLock();
  if (lock.waitLock) lock.waitLock(25000);
  try {
    var fn = APP_ACTIONS[action] || (typeof GROW_ACTIONS !== 'undefined' && GROW_ACTIONS[action]) ||
             (typeof TG_ACTIONS !== 'undefined' && TG_ACTIONS[action]);
    if (!fn) return JSON.stringify({ error: 'Unknown action ' + action });
    return JSON.stringify(fn(args), function (k, v) { return v; });
  } catch (err) {
    console.error('app ' + action + ' failed: ' + (err && err.stack));
    return JSON.stringify({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function iso_(v) { var d = asDate_(v); return d ? d.toISOString() : ''; }

function allLeads_() {
  var sh = sheet_(SHEETS.leads);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, LEAD_COLS.length).getValues().map(function (r) {
    var l = {}; LEAD_COLS.forEach(function (c, j) { l[c] = r[j]; }); return l;
  }).filter(function (l) { return l['Phone']; });
}

function need_(l, now) {
  if (CLOSED.indexOf(l['Status']) >= 0) return l['Status'];
  var nf = asDate_(l['Next Follow-up']), li = asDate_(l['Last Inbound']);
  var answered = [asDate_(l['Last Outbound']), asDate_(l['Last Human Contact'])].filter(Boolean)
      .sort(function (a, b) { return b - a; })[0];
  if (l['Status'] === 'Hot') return 'Hot';
  if (nf && nf <= now) return 'Overdue';
  if (li && (!answered || answered < li)) return 'Waiting reply';
  if (nf) return 'Scheduled';
  return 'Active';
}

function card_(l, now) {
  return { phone: String(l['Phone']), name: String(l['Name'] || l['Business'] || 'Lead'),
           business: String(l['Business'] || ''), category: String(l['Category'] || ''), city: String(l['City'] || ''),
           status: String(l['Status'] || ''), need: need_(l, now), next: iso_(l['Next Follow-up']),
           note: String(l['Follow-up Note'] || l['Requirement'] || ''), lastIn: iso_(l['Last Inbound']) };
}

function cleanRows_() {
  var sh = sheet_(SHEETS.leads);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, LEAD_COLS.length).getValues().map(function (r, i) {
    var l = {}; LEAD_COLS.forEach(function (c, j) { l[c] = r[j]; });
    return { row: i + 2, lead: l };
  }).filter(function (x) { return x.lead['Phone']; });
}
function validPhone_(p) { return /^91\d{10}$/.test(String(p)); }
function runningCampaigns_() {
  return rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS).some(function (c) {
    return c['Status'] === 'Running' || c['Status'] === 'Scheduled';
  });
}

function cleanReport_(rows) {
  var seen = {}, dupes = [], fixable = [], bad = [], noCity = 0, noBusiness = 0;
  rows.forEach(function (x) {
    var l = x.lead, p = String(l['Phone']);
    var card = { row: x.row, phone: p, name: l['Name'] || l['Business'] || '', city: l['City'] || '', note: '' };
    if (seen[p]) {
      dupes.push(Object.assign({}, card, { note: 'Same number as row ' + seen[p] + ', merge by hand' }));
    } else {
      seen[p] = x.row;
    }
    if (!validPhone_(p)) {
      var norm = normPhone_(p);
      if (validPhone_(norm)) fixable.push(Object.assign({}, card, { note: 'Will become ' + norm }));
      else bad.push(Object.assign({}, card, { note: 'Not a valid Indian mobile number' }));
    }
    if (!l['City']) noCity++;
    if (!l['Business'] && !l['Name']) noBusiness++;
  });
  return {
    checked: rows.length,
    duplicates: dupes.slice(0, 100), duplicateCount: dupes.length,
    fixable: fixable.slice(0, 100), fixableCount: fixable.length,
    badPhones: bad.slice(0, 100), badPhoneCount: bad.length,
    noCity: noCity, noBusiness: noBusiness
  };
}

var APP_ACTIONS = {
  cleanCheck: function () { return cleanReport_(cleanRows_()); },
  cleanFix: function () {
    var rows = cleanRows_(), taken = {}, sh = sheet_(SHEETS.leads), col = LEAD_COLS.indexOf('Phone') + 1, fixed = 0;
    rows.forEach(function (x) { taken[String(x.lead['Phone'])] = true; });
    rows.forEach(function (x) {
      var p = String(x.lead['Phone']), norm = normPhone_(p);
      if (validPhone_(p) || !validPhone_(norm) || taken[norm]) return;
      sh.getRange(x.row, col).setValue(norm);
      taken[norm] = true;
      fixed++;
    });
    return { fixed: fixed };
  },
  deleteLead: function (a) {
    var phone = normPhone_(a.phone);
    var found = findLead_(phone);
    if (!found) return { error: 'Lead not found' };
    if (a.confirm !== true) return { error: 'Confirm before deleting' };
    sheet_(SHEETS.leads).deleteRow(found.row);
    logChange_(phone, 'app', 'deleted from the lead list');
    return { message: 'Deleted' };
  },

  bulkEdit: function (a) {
    var field = String(a.field || '');
    var value = String(a.value == null ? '' : a.value).trim();
    if (BULK_FIELDS.indexOf(field) < 0) return { error: 'This field cannot be changed in bulk' };
    if (field === 'Category' && value && CATEGORIES.indexOf(value) < 0) return { error: 'Unknown category' };
    if (field === 'Tier' && value && TIERS.indexOf(value) < 0) return { error: 'Unknown tier' };
    var f = a.filter || {};
    var want = { category: String(f.category || ''), city: String(f.city || '').toLowerCase().trim(), status: String(f.status || '') };
    if (!want.category && !want.city && !want.status) return { error: 'Choose at least one filter' };
    var rows = cleanRows_().filter(function (x) {
      var l = x.lead;
      if (want.category && String(l['Category']) !== want.category) return false;
      if (want.city && String(l['City'] || '').toLowerCase().indexOf(want.city) < 0) return false;
      if (want.status && String(l['Status']) !== want.status) return false;
      return true;
    });
    if (a.preview !== false) {
      return { count: rows.length, field: field, value: value, sample: rows.slice(0, 8).map(function (x) {
        return { phone: String(x.lead['Phone']), name: x.lead['Name'] || x.lead['Business'] || '', from: String(x.lead[field] || '') };
      }) };
    }
    if (rows.length > 1000) return { error: 'Narrow the filter: more than 1000 leads' };
    rows.forEach(function (x) {
      var u = {}; u[field] = value;
      upsertLead_(String(x.lead['Phone']), u, 'app');
    });
    return { count: rows.length, message: 'Changed ' + rows.length + ' leads' };
  },

  importLeads: function (a) {
    if (runningCampaigns_()) return { error: 'A campaign is running. Pause it in Send before importing, so new leads are not messaged by surprise.' };
    var rows = Array.isArray(a.rows) ? a.rows : [];
    if (rows.length > 300) return { error: 'Import up to 300 rows at a time' };
    var known = {};
    cleanRows_().forEach(function (x) { known[String(x.lead['Phone'])] = true; });
    var out = { added: 0, skipped: 0, invalid: 0 };
    rows.forEach(function (r) {
      var phone = normPhone_(r.phone);
      if (!validPhone_(phone)) { out.invalid++; return; }
      if (known[phone]) { out.skipped++; return; }
      var cat = CATEGORIES.indexOf(r.category) >= 0 ? r.category : 'Other';
      upsertLead_(phone, { 'Name': r.name || '', 'Business': r.business || '', 'Category': cat, 'Tier': TIER_OF[cat] || 'To confirm',
                           'City': r.city || '', 'State': r.state || '', 'Campaign': 'Imported' }, 'app');
      known[phone] = true; out.added++;
    });
    return out;
  },

  dashboard: function () {
    var now = new Date();
    var leads = allLeads_();
    var active = leads.filter(function (l) { return l['Status'] && l['Status'] !== 'New' && CLOSED.indexOf(l['Status']) < 0; });
    var cards = active.map(function (l) { return card_(l, now); });
    function pick(need) {
      return cards.filter(function (c) { return c.need === need; })
          .sort(function (a, b) { return (a.next || 'z') < (b.next || 'z') ? -1 : 1; }).slice(0, 100);
    }
    var weekAgo = now - 7 * 86400000;
    return {
      counts: {
        total: leads.length, active: active.length,
        hot: cards.filter(function (c) { return c.need === 'Hot'; }).length,
        overdue: cards.filter(function (c) { return c.need === 'Overdue'; }).length,
        waiting: cards.filter(function (c) { return c.need === 'Waiting reply'; }).length,
        newThisWeek: leads.filter(function (l) { var d = asDate_(l['Created']); return d && d >= weekAgo; }).length,
        wrote7d: leads.filter(function (l) { var d = asDate_(l['Last Inbound']); return d && d >= weekAgo; }).length,
        won: leads.filter(function (l) { return l['Status'] === 'Won'; }).length
      },
      hot: pick('Hot'), overdue: pick('Overdue'), waiting: pick('Waiting reply'), scheduled: pick('Scheduled').slice(0, 30),
      bot: botState_()
    };
  },

  search: function (a) {
    var q = String(a.q || '').toLowerCase().trim();
    var digits = q.replace(/\D/g, '');
    var now = new Date();
    var status = a.status || '';
    var out = allLeads_().filter(function (l) {
      if (status && l['Status'] !== status) return false;
      if (!q) return true;
      if (digits.length >= 4 && String(l['Phone']).indexOf(digits) >= 0) return true;
      return [l['Name'], l['Business'], l['City'], l['Category'], l['Lead ID']].some(function (x) {
        return String(x || '').toLowerCase().indexOf(q) >= 0;
      });
    });
    out.sort(function (a, b) { return (asDate_(b['Updated']) || 0) - (asDate_(a['Updated']) || 0); });
    return { total: out.length, leads: out.slice(0, 60).map(function (l) { return card_(l, now); }) };
  },

  lead: function (a) {
    var phone = normPhone_(a.phone);
    var l = getLead_(phone);
    if (!l) return { error: 'Lead not found' };
    var fields = {};
    LEAD_COLS.forEach(function (c) { fields[c] = asDate_(l[c]) && /At|Inbound|Outbound|Contact|Until|Follow-up$|Alerted|Created|Updated/.test(c) ? iso_(l[c]) : String(l[c] === undefined ? '' : l[c]); });
    var lastIn = asDate_(l['Last Inbound']);
    var paused = asDate_(l['Bot Paused Until']);
    return {
      lead: fields, card: card_(l, new Date()),
      messages: history_(phone, 80).map(function (m) { return { dir: m.direction, sender: m.sender, body: m.body, time: m.time }; }),
      log: leadLog_(phone, 30),
      canReply: !!(lastIn && Date.now() - lastIn < 24 * 3600000),
      botPaused: !!(paused && paused > new Date()), pausedUntil: iso_(paused),
      options: { categories: CATEGORIES, tiers: TIERS }
    };
  },

  act: function (a) {
    var r = leadAction_(normPhone_(a.phone), String(a.cmd || '').toUpperCase(), a.days, a.note, 'app');
    return r.ok ? { message: r.message } : { error: r.message };
  },

  edit: function (a) {
    var phone = normPhone_(a.phone);
    if (!getLead_(phone)) return { error: 'Lead not found' };
    var f = {};
    Object.keys(a.fields || {}).forEach(function (k) {
      if (EDITABLE.indexOf(k) < 0) return;
      var v = String(a.fields[k]).trim();
      if (k === 'Category' && v && CATEGORIES.indexOf(v) < 0) return;
      if (k === 'Tier' && v && TIERS.indexOf(v) < 0) return;
      if (k === 'Area sqft') v = v ? (parseInt(v, 10) || '') : '';
      f[k] = v;
    });
    upsertLead_(phone, f, 'app');
    return { message: 'Saved' };
  },

  addLead: function (a) {
    var phone = normPhone_(a.phone);
    if (phone.length < 11) return { error: 'Enter a 10-digit mobile number' };
    if (getLead_(phone)) return { error: 'This number is already in the list', phone: phone };
    var cat = CATEGORIES.indexOf(a.category) >= 0 ? a.category : 'Other';  // unknown ones are sorted later (Learn > Sort leads), with your approval
    upsertLead_(phone, { 'Name': a.name || '', 'Business': a.business || '', 'Category': cat, 'Tier': TIER_OF[cat] || 'To confirm',
                         'City': a.city || '', 'Requirement': a.note || '', 'Status': 'Contacted', 'Campaign': 'Added from app',
                         'Next Follow-up': addHours_(24), 'Follow-up Note': a.note || 'New lead added from app' }, 'app');
    var welcomed = a.welcome !== false && welcomeNewLead_();
    return { message: welcomed ? 'Lead added and welcome message sent' : 'Lead added', phone: phone };
  },

  reply: function (a) {
    var phone = normPhone_(a.phone);
    var text = String(a.text || '').trim();
    if (!text) return { error: 'Type a message' };
    var lead = getLead_(phone);
    if (!lead) return { error: 'Lead not found' };
    if (lead['Opt-in'] === 'Opted out') return { error: 'This customer opted out (STOP). Do not message them.' };
    if (!sendEnabled_()) return { error: 'Test mode is on, nothing is sent. Turn it off in Settings to send.' };
    lastWaError_ = '';
    var id = waText_(phone, text);
    if (!id) {
      var outside = /131047|re-engage|24 ?hours?/i.test(lastWaError_);
      return { error: outside ? 'WhatsApp only allows a free message within 24 hours of the customer\'s last message. ' +
                               'Call them, or send an approved template from BlueTick.' : 'Not sent: ' + lastWaError_ };
    }
    addMessage_(phone, 'out', 'human', text, id === 'sent' ? '' : id);
    upsertLead_(phone, { 'Last Outbound': new Date(), 'Last Human Contact': new Date(),
                         'Bot Paused Until': humanPause_(lead) }, 'app');
    return { message: 'Sent' };
  },

  // One chat box for the whole team: type anything a WhatsApp command or campaign-chat line would say
  // (DONE/LATER/WON/LOST/LIST/HELP, "applicators ko monday 11 baje message bhejo", CAMPAIGNS), or ask to open
  // a screen ("show board", "open leads", "add a lead", "settings") and the app navigates there for you.
  assistant: function (a) {
    var text = String(a.text || '').trim();
    if (!text) return { error: 'Type something' };
    var nav = assistantNav_(text);
    var reply = salesCommand_(text, setting_('SALES_WHATSAPP'));
    return { reply: String(reply || 'Done.'), nav: nav };
  },

  pause: function (a) {
    var phone = normPhone_(a.phone);
    if (!getLead_(phone)) return { error: 'Lead not found' };
    var until = a.resume ? '' : addHours_(Number(a.hours) || 24 * 365);
    upsertLead_(phone, { 'Bot Paused Until': until }, 'app');
    return { message: a.resume ? 'Bot will reply to this lead again' : 'Bot paused for this lead' };
  },

  settings: function () { return { bot: botState_() }; },

  claim: function () { return { message: 'Already set up' }; },

  /** Everything the setup screen needs. Secret values are never sent back, only whether they are set. */
  status: function () {
    var props = PropertiesService.getScriptProperties();
    var raw = ss_().getSheetByName(SHEETS.raw);
    var lastHook = raw && raw.getLastRow() > 1 ? iso_(raw.getRange(raw.getLastRow(), 1).getValues()[0][0]) : '';
    var leads = ss_().getSheetByName(SHEETS.leads);
    var triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    return {
      keys: { claude: !!props.getProperty('ANTHROPIC_API_KEY'), ai: !!props.getProperty(aiKeyName_()), waToken: !!props.getProperty('WA_ACCESS_TOKEN'),
              waPhoneId: !!props.getProperty('WA_PHONE_NUMBER_ID') },
      webhookKey: props.getProperty('WEBHOOK_SECRET') || '',
      relayUrl: setting_('RELAY_URL'),
      serviceUrl: (function () { try { return ScriptApp.getService().getUrl() || ''; } catch (err) { return ''; } })(),
      ai: { provider: aiProvider_(), model: aiModel_(), customModel: setting_('AI_MODEL'),
            providers: [{ id: 'claude', name: 'Claude (best, paid)' }].concat(Object.keys(AI_PROVIDERS).map(function (k) {
              return { id: k, name: AI_PROVIDERS[k].name + ' (free tier, testing)', model: AI_PROVIDERS[k].model }; })) },
      waApiUrl: setting_('WA_API_URL'), waApiVersion: setting_('WA_API_VERSION'),
      installed: triggers.indexOf('hourlyCheck') >= 0 && triggers.indexOf('dailySummary') >= 0,
      leads: leads ? Math.max(leads.getLastRow() - 1, 0) : 0, lastWebhook: lastHook, bot: botState_()
    };
  },

  install: function () { setup(); return { message: 'Sheet tabs and timers are ready' }; },

  saveKeys: function (a) {
    var props = PropertiesService.getScriptProperties();
    if (a.provider !== undefined) {
      var p = String(a.provider);
      if (p !== 'claude' && !AI_PROVIDERS[p]) return { error: 'Unknown AI provider' };
      writeSettings_({ AI_PROVIDER: p, AI_MODEL: String(a.model || '').trim() });
    }
    var map = { claude: 'ANTHROPIC_API_KEY', waToken: 'WA_ACCESS_TOKEN', waPhoneId: 'WA_PHONE_NUMBER_ID' };
    if (a.aiKey) a[aiProvider_() === 'claude' ? 'claude' : '_other'] = a.aiKey;
    if (a._other) map._other = aiKeyName_();
    var saved = [];
    Object.keys(map).forEach(function (k) {
      var v = String(a[k] || '').trim();
      if (v) { props.setProperty(map[k], v); saved.push(k); }
    });
    var s = {};
    if (a.waApiUrl) s.WA_API_URL = String(a.waApiUrl).trim();
    if (a.waApiVersion) s.WA_API_VERSION = String(a.waApiVersion).trim();
    if (a.relayUrl !== undefined) {
      var ru = String(a.relayUrl).trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
      if (ru && !/^https:\/\/[^\s]+$/.test(ru)) return { error: 'The relay link must start with https://' };
      s.RELAY_URL = ru;
    }
    if (Object.keys(s).length) writeSettings_(s);
    if (saved.length) logChange_('', 'app', 'Keys updated: ' + saved.join(', '));
    return { message: 'Saved' };
  },

  testClaude: function () {
    var p = aiProvider_(), name = p === 'claude' ? 'Claude' : AI_PROVIDERS[p].name;
    if (!secret_(aiKeyName_())) return { error: 'Add the ' + name + ' API key first' };
    var r = callModel_('Reply with one short friendly line in Hinglish confirming you are ready. Do not use tools.',
                       [{ role: 'user', content: 'Test' }]);
    var text = (r.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join(' ');
    return { message: name + ' works: ' + (text || 'OK').slice(0, 160) };
  },

  testWhatsApp: function () {
    var to = normPhone_(setting_('SALES_WHATSAPP'));
    if (!to) return { error: 'Add the salesperson WhatsApp number in Settings first' };
    if (!secret_('WA_ACCESS_TOKEN') || !secret_('WA_PHONE_NUMBER_ID')) return { error: 'Add the BlueTick token and Phone Number ID first' };
    lastWaError_ = '';
    var id = waPost_({ messaging_product: 'whatsapp', recipient_type: 'individual', to: to, type: 'text',
                       text: { body: '✅ Amitek bot is connected to WhatsApp.' } }, true);
    if (!id) return { error: /131047|re-engage/i.test(lastWaError_) ?
        'Token works, but WhatsApp needs the salesperson to message the business number first (24-hour rule). Send "hi" from that phone and test again.' :
        'WhatsApp test failed: ' + lastWaError_ };
    return { message: 'Test message sent to +' + to };
  },

  changePin: function (a) {
    var np = String(a.newPin || '');
    if (!/^\d{4,8}$/.test(np)) return { error: 'PIN must be 4 to 8 digits' };
    PropertiesService.getScriptProperties().setProperty('APP_PIN', np);
    return { message: 'PIN changed' };
  },

  saveSettings: function (a) {
    var s = {};
    Object.keys(a).forEach(function (k) {
      if (APP_SETTINGS.indexOf(k) < 0) return;
      var v = String(a[k]);
      if (k === 'BOT_MODE' && ['gentle', 'sales'].indexOf(v) < 0) return;
      if (k === 'SALES_WHATSAPP') v = v ? normPhone_(v) : '';
      if (k === 'BUSINESS_NUMBER') {
        v = v ? normPhone_(v) : '';
        if (v && !/^91[6-9]\d{9}$/.test(v)) throw new Error('Business number: enter the 10-digit mobile number');
      }
      if (k === 'TEAM_ROUTING') {
        var o = {}, bad = [];
        try { o = JSON.parse(v || '{}') || {}; } catch (err) { return; }
        Object.keys(o).forEach(function (cat) {
          if (CATEGORIES.indexOf(cat) < 0 && cat !== 'All') { delete o[cat]; return; }
          var nums = String(o[cat] || '').split(/[,;\s]+/).filter(Boolean).map(normPhone_);
          nums.forEach(function (p) { if (p.length < 12) bad.push(p); });
          o[cat] = nums.filter(function (p) { return p.length >= 12; }).join(', ');
          if (!o[cat]) delete o[cat];
        });
        if (bad.length) throw new Error('Check these numbers: ' + bad.join(', '));
        v = Object.keys(o).length ? JSON.stringify(o) : '';
      }
      s[k] = v;
    });
    writeSettings_(s);
    return { message: 'Saved', bot: botState_() };
  }
};

function botState_() {
  return { sendEnabled: sendEnabled_(), botEnabled: botEnabled_(), mode: setting_('BOT_MODE'),
           salesWhatsapp: String(setting_('SALES_WHATSAPP')), businessNumber: String(setting_('BUSINESS_NUMBER')), model: aiModel_(), provider: aiProvider_(),
           team: (function () { var r = teamRouting_(), o = {}; Object.keys(r).forEach(function (c) { o[c] = r[c].join(', '); }); return o; })(),
           categories: CATEGORIES };
}

function leadLog_(phone, limit) {
  var sh = sheet_(SHEETS.log);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var start = Math.max(2, last - 3000);
  var rows = sh.getRange(start, 1, last - start + 1, LOG_COLS.length).getValues();
  var out = [];
  for (var i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    if (String(rows[i][1]) === phone) out.push({ time: iso_(rows[i][0]), actor: String(rows[i][2]), change: String(rows[i][3]) });
  }
  return out;
}

function writeSettings_(s) {
  var sh = sheet_(SHEETS.settings);
  var names = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  Object.keys(s).forEach(function (k) {
    var i = names.indexOf(k);
    if (i >= 0) sh.getRange(i + 2, 2).setValue(s[k]); else { sh.appendRow([k, s[k], '']); names.push(k); }
    logChange_('', 'app', 'Setting ' + k + ' -> ' + s[k]);
  });
  settingsCache_ = null;
}

/** Reads an "open ___" / "show ___" style ask out of an assistant chat line, so the app can switch screens itself.
 * Never fires for a real command word (HELP/LIST/DONE/...) - those get their answer typed back in the chat instead. */
function assistantNav_(text) {
  var first = String(text).trim().split(/\s+/)[0] || '';
  if (['HELP', '?', 'LIST', 'PENDING', 'DONE', 'LATER', 'WON', 'LOST', 'CAMPAIGNS'].indexOf(first.toUpperCase()) >= 0) return null;
  var t = String(text).toLowerCase();
  if (/\b(board|dashboard|today|overdue|hot leads)\b/.test(t)) return { tab: 'today' };
  if (/\b(add|new)\b.*\blead\b/.test(t)) return { tab: 'add' };
  if (/\bsettings\b/.test(t)) return { tab: 'settings' };
  if (/\blearn\b|\bknowledge\b/.test(t)) return { tab: 'learn' };
  if (/\bcampaigns?\b|\bsend\b/.test(t) && !/\bbhejo\b|\bmessage\b/.test(t)) return { tab: 'send' };
  if (/\bleads?\b|\bsearch\b/.test(t)) return { tab: 'leads' };
  return null;
}

/** HTTP version of api() for the Android app: POST {"_app":1,"pin":..,"action":..,"args":{..}} as text/plain. */
function appHttp_(body) {
  var out = api(body.pin, body.action, JSON.stringify(body.args || {}));
  return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
}
