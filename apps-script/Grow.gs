/**
 * Campaigns and learning.
 *
 * Campaigns: send a Meta-approved WhatsApp template to many leads (WhatsApp does not allow a business to write
 * first with free text). Sending runs in small batches every 5 minutes, with a daily limit, and skips anyone who
 * said STOP, is closed (won/lost), is marked "Can Message = No", or already got this campaign.
 *
 * Learning: the bot learns from real chats, campaign results and anything the team teaches it (company and product
 * info, price lists, old campaign exports). The AI turns this into short notes; nothing reaches the bot's
 * knowledge until someone approves it in the app (Learn screen), so it never "learns" a wrong price by itself.
 */

var CAMPAIGN_COLS = ['ID', 'Name', 'Template', 'Language', 'Uses Name', 'Message Text', 'Filter', 'Status', 'Created',
                     'Started', 'Finished', 'Total', 'Sent', 'Failed', 'Last Error'];
var CAMPAIGN_LOG_COLS = ['Time', 'Campaign ID', 'Phone', 'Result', 'Detail'];
var LEARN_COLS = ['Time', 'Source', 'Title', 'Content', 'Why', 'Status'];
var GROW_SHEETS = { campaigns: 'Campaigns', campaignLog: 'Campaign Log', learning: 'Learning' };
var MOBILE_RE = /^91[6-9]\d{9}$/;

function growSheet_(name, cols) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(cols); }
  return sh;
}
function campaignsSheet_() { return growSheet_(GROW_SHEETS.campaigns, CAMPAIGN_COLS); }
function campaignLogSheet_() { return growSheet_(GROW_SHEETS.campaignLog, CAMPAIGN_LOG_COLS); }
function learningSheet_() { return growSheet_(GROW_SHEETS.learning, LEARN_COLS); }
function growSetting_(k) { return setting_(k); }

function rowsAsObjects_(sh, cols) {
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues().map(function (r, i) {
    var o = { _row: i + 2 }; cols.forEach(function (c, j) { o[c] = r[j]; }); return o;
  });
}

// ===================================================================== audience
/** All leads with every column of the Leads tab (including extra ones such as "Can Message"). */
function leadsFull_() {
  var sh = sheet_(SHEETS.leads);
  var last = sh.getLastRow(), width = Math.max(sh.getLastColumn ? sh.getLastColumn() : LEAD_COLS.length, LEAD_COLS.length);
  if (last < 2) return [];
  var header = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
  return sh.getRange(2, 1, last - 1, width).getValues().map(function (r) {
    var l = {}; header.forEach(function (c, j) { if (c) l[c] = r[j]; }); return l;
  });
}

function cleanFilter_(f) {
  f = f || {};
  var list = function (v) {
    return (Array.isArray(v) ? v : String(v || '').split(',')).map(function (x) { return String(x).trim(); }).filter(Boolean);
  };
  return { categories: list(f.categories), cities: list(f.cities), states: list(f.states),
           newOnly: f.newOnly !== false, canMessageOnly: f.canMessageOnly !== false, keepOn: !!f.keepOn,
           limit: Math.max(0, parseInt(f.limit, 10) || 0) };
}

/** Why a lead must not get a campaign message, or '' when it may. */
function campaignBlock_(l, sales) {
  var phone = String(l['Phone'] || '');
  if (!MOBILE_RE.test(phone)) return 'not a mobile number';
  if (phone === sales) return 'salesperson';
  if (l['Opt-in'] === 'Opted out' || l['Status'] === 'Opted out') return 'said STOP';
  if (l['Status'] === 'Won' || l['Status'] === 'Lost') return 'closed';
  return '';
}

function audience_(filter, excludePhones, since) {
  var f = cleanFilter_(filter);
  var sales = normPhone_(setting_('SALES_WHATSAPP'));
  var lower = function (a) { return a.map(function (x) { return x.toLowerCase(); }); };
  var cats = lower(f.categories), cities = lower(f.cities), states = lower(f.states);
  var seen = {};
  var out = leadsFull_().filter(function (l) {
    var phone = String(l['Phone'] || '');
    if (!phone || seen[phone] || (excludePhones && excludePhones[phone])) return false;
    if (campaignBlock_(l, sales)) return false;
    if (f.canMessageOnly && 'Can Message' in l && String(l['Can Message']).toLowerCase() === 'no') return false;
    // "new only" = we never messaged them and they never wrote to us
    if (f.newOnly && (asDate_(l['Last Outbound']) || asDate_(l['Last Inbound']))) return false;
    if (since) { var cr = asDate_(l['Created']); if (!cr || cr < since) return false; }  // welcome: only leads added later
    if (cats.length && cats.indexOf(String(l['Category']).toLowerCase()) < 0) return false;
    if (states.length && states.indexOf(String(l['State']).toLowerCase()) < 0) return false;
    if (cities.length && !cities.some(function (c) { return String(l['City']).toLowerCase().indexOf(c) >= 0; })) return false;
    seen[phone] = true;
    return true;
  });
  return f.limit ? out.slice(0, f.limit) : out;
}

function campaignDone_(id) {
  var done = {};
  rowsAsObjects_(campaignLogSheet_(), CAMPAIGN_LOG_COLS).forEach(function (r) {
    if (String(r['Campaign ID']) === String(id)) done[String(r['Phone'])] = r['Result'];
  });
  return done;
}

function sentLast24h_() {
  var since = Date.now() - 86400000;
  return rowsAsObjects_(campaignLogSheet_(), CAMPAIGN_LOG_COLS).filter(function (r) {
    var t = asDate_(r['Time']); return r['Result'] === 'sent' && t && t.getTime() >= since;
  }).length;
}

// ===================================================================== sending
function firstName_(l) {
  var n = String(l['Name'] || l['Business'] || '').trim();
  return n ? n.split(/\s+/)[0].slice(0, 30) : 'ji';
}

function templateBody_(c, l) {
  var t = { name: String(c['Template']).trim(), language: { code: String(c['Language'] || 'en').trim() } };
  if (isOn_(c['Uses Name'])) t.components = [{ type: 'body', parameters: [{ type: 'text', text: firstName_(l) }] }];
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(l['Phone']), type: 'template', template: t };
}

function campaignText_(c, l) {
  var text = String(c['Message Text'] || '[Template ' + c['Template'] + ']');
  return '[Campaign: ' + c['Name'] + '] ' + text.replace(/\{\{1\}\}/g, firstName_(l));
}

function setCampaign_(c, fields) {
  var sh = campaignsSheet_();
  Object.keys(fields).forEach(function (k) {
    var j = CAMPAIGN_COLS.indexOf(k);
    if (j >= 0) { sh.getRange(c._row, j + 1).setValue(fields[k]); c[k] = fields[k]; }
  });
}

function getCampaign_(id) {
  return rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS).filter(function (c) { return String(c['ID']) === String(id); })[0] || null;
}

function ensureCampaignTimer_(on) {
  var have = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'campaignTick'; });
  if (on && !have.length) ScriptApp.newTrigger('campaignTick').timeBased().everyMinutes(5).create();
  if (!on) have.forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/** Timer (every 5 minutes while a campaign runs): sends the next batch within the daily limit. */
function campaignTick() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return campaignTick_(); } finally { lock.releaseLock(); }
}

function campaignTick_() {
  var running = rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS).filter(function (c) { return c['Status'] === 'Running'; });
  if (!running.length) { ensureCampaignTimer_(false); return { sent: 0, reason: 'nothing running' }; }
  if (!sendEnabled_()) return { sent: 0, reason: 'test mode' };  // waits; resumes when sending is switched on
  var room = Number(growSetting_('CAMPAIGN_DAILY_LIMIT')) - sentLast24h_();
  if (room <= 0) return { sent: 0, reason: 'daily limit' };
  // welcome (always-on) campaigns first, so new leads are greeted quickly; then the oldest bulk campaign
  var keep = function (c) { return cleanFilter_(JSON.parse(c['Filter'] || '{}')).keepOn; };
  var order = running.filter(keep).concat(running.filter(function (c) { return !keep(c); }).slice(0, 1));
  var total = { sent: 0, failed: 0 };
  var perTick = Number(growSetting_('CAMPAIGN_BATCH')) || 40;
  order.forEach(function (c) {
    var left = Math.min(room - total.sent, perTick - total.sent - total.failed);
    if (left <= 0) return;
    var r = sendBatch_(c, left);
    total.sent += r.sent; total.failed += r.failed;
  });
  if (!rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS).some(function (x) { return x['Status'] === 'Running'; })) ensureCampaignTimer_(false);
  return total;
}

function sendBatch_(c, max) {
  var filter = cleanFilter_(JSON.parse(c['Filter'] || '{}'));
  var done = campaignDone_(c['ID']);
  // a welcome campaign only greets leads added after it was started, never the old list
  var batch = audience_(filter, done, filter.keepOn ? (asDate_(c['Started']) || new Date()) : null);
  var total = Object.keys(done).filter(function (p) { return done[p] === 'sent'; }).length + batch.length;
  if (filter.limit) batch = batch.slice(0, Math.max(0, filter.limit - Object.keys(done).length));
  var finished = batch.length === 0;
  batch = batch.slice(0, max);

  var log = campaignLogSheet_(), sent = 0, failed = 0, streak = 0;
  for (var i = 0; i < batch.length; i++) {
    var l = batch[i], phone = String(l['Phone']);
    lastWaError_ = '';
    var id = waPost_(templateBody_(c, l));
    if (id) {
      sent++; streak = 0;
      log.appendRow([new Date(), c['ID'], phone, 'sent', id === 'sent' ? '' : id]);
      addMessage_(phone, 'out', 'campaign', campaignText_(c, l), id === 'sent' ? '' : id);
      var u = { 'Campaign': c['Name'], 'Last Outbound': new Date() };
      if (['', 'New'].indexOf(String(l['Status'])) >= 0) u['Status'] = 'Contacted';
      upsertLead_(phone, u, 'campaign');
    } else {
      failed++; streak++;
      log.appendRow([new Date(), c['ID'], phone, 'failed', String(lastWaError_).slice(0, 300)]);
      // the template itself is wrong (not approved, wrong name or language): stop and tell the team
      if (/132000|132001|132005|132007|132012|132015|132016|template/i.test(lastWaError_) || streak >= 5) {
        setCampaign_(c, { 'Status': 'Paused', 'Last Error': String(lastWaError_).slice(0, 300) });
        alertSales_('⚠️ Campaign "' + c['Name'] + '" paused: WhatsApp refused the message.\n' + String(lastWaError_).slice(0, 200) +
                    '\nCheck the template name and language in the app (Campaigns).');
        break;
      }
    }
  }
  var counts = campaignCounts_(c['ID']);
  var fields = { 'Sent': counts.sent, 'Failed': counts.failed, 'Total': Math.max(total, counts.sent) };
  if (c['Status'] === 'Running' && finished && !filter.keepOn) {  // a welcome campaign keeps waiting for new leads
    fields['Status'] = 'Done'; fields['Finished'] = new Date();
    alertSales_('✅ Campaign "' + c['Name'] + '" finished: ' + counts.sent + ' sent, ' + counts.failed + ' failed.');
  }
  setCampaign_(c, fields);
  return { sent: sent, failed: failed };
}

/** Called when a lead is added in the app: an always-on welcome campaign greets them right away. */
function welcomeNewLead_() {
  var on = rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS).some(function (c) {
    return c['Status'] === 'Running' && cleanFilter_(JSON.parse(c['Filter'] || '{}')).keepOn;
  });
  if (!on || !sendEnabled_()) return false;
  try { return campaignTick_().sent > 0; } catch (err) { console.error('welcome failed: ' + err); return false; }
}

function campaignCounts_(id) {
  var o = { sent: 0, failed: 0, replied: 0, optedOut: 0 };
  var phones = {};
  rowsAsObjects_(campaignLogSheet_(), CAMPAIGN_LOG_COLS).forEach(function (r) {
    if (String(r['Campaign ID']) !== String(id)) return;
    if (r['Result'] === 'sent') { o.sent++; phones[String(r['Phone'])] = asDate_(r['Time']); }
    if (r['Result'] === 'failed') o.failed++;
  });
  if (o.sent) {
    leadsFull_().forEach(function (l) {
      var at = phones[String(l['Phone'])];
      if (!at) return;
      var li = asDate_(l['Last Inbound']);
      if (li && li >= at) o.replied++;
      if (l['Opt-in'] === 'Opted out') o.optedOut++;
    });
  }
  return o;
}

// ===================================================================== learning
var LEARN_SYSTEM = [
  'You help train the WhatsApp assistant of Amitek Waterproofing (Jaipur): coatings, waterproofing and construction chemicals,',
  'customers are applicators, contractors, builders, architects, dealers and home owners, chats are in English, Hindi and Hinglish.',
  'From the material, write short knowledge notes the assistant should know when it replies to customers:',
  '- product facts and uses customers asked about, and the answers the Amitek team gave (team answers are the most reliable)',
  '- frequent questions with their answer, only when the answer is in the material',
  '- objections and what worked; which campaign messages got replies and which did not',
  '- company facts (address, timings, delivery areas, contacts) found in the material',
  'Rules: never invent prices, rates, warranties or claims that are not in the material. Do not repeat what the current',
  'knowledge already says. No customer names or phone numbers. Each note under 600 characters, in simple English',
  '(Hinglish phrases are fine). At most 8 notes; fewer is fine; none if nothing new.',
  'Answer with JSON only, no other text: [{"title": "...", "content": "...", "why": "where this came from"}]'
].join('\n');

function aiText_(system, user) {
  var r = callModel_(system + '\nDo not use tools.', [{ role: 'user', content: user }]);
  return (r.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
}

function parseNotes_(text) {
  var m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0]).filter(function (n) { return n && n.title && n.content; }).slice(0, 8).map(function (n) {
      return { title: String(n.title).slice(0, 120), content: String(n.content).slice(0, 2000), why: String(n.why || '').slice(0, 300) };
    });
  } catch (err) { return []; }
}

function addSuggestions_(notes, source) {
  var sh = learningSheet_();
  notes.forEach(function (n) { sh.appendRow([new Date(), source, n.title, n.content, n.why, 'Suggested']); });
  return notes.length;
}

/** Recent chats as plain text for the AI (customers who wrote in, newest first). */
function chatDigest_(days, maxChars) {
  var sh = sheet_(SHEETS.messages);
  var last = sh.getLastRow();
  if (last < 2) return '';
  var since = Date.now() - days * 86400000;
  var start = Math.max(2, last - 5000);
  var rows = sh.getRange(start, 1, last - start + 1, MESSAGE_COLS.length).getValues();
  var sales = normPhone_(setting_('SALES_WHATSAPP'));
  var byPhone = {}, order = [];
  rows.forEach(function (r) {
    var t = asDate_(r[0]), phone = String(r[1]);
    if (!t || t.getTime() < since || !phone || phone === sales) return;
    if (!byPhone[phone]) { byPhone[phone] = { lines: [], hasIn: false, last: 0 }; order.push(phone); }
    var who = r[2] === 'in' ? 'Customer' : r[3] === 'human' ? 'Amitek team' : r[3] === 'campaign' ? 'Campaign message' : 'Bot';
    byPhone[phone].lines.push(who + ': ' + String(r[4]).slice(0, 500));
    if (r[2] === 'in') byPhone[phone].hasIn = true;
    byPhone[phone].last = t.getTime();
  });
  order.sort(function (a, b) { return byPhone[b].last - byPhone[a].last; });
  var out = '', n = 0;
  for (var i = 0; i < order.length; i++) {
    var c = byPhone[order[i]];
    if (!c.hasIn) continue;
    var block = '<chat ' + (++n) + '>\n' + c.lines.slice(-30).join('\n') + '\n</chat>\n';
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out;
}

function campaignDigest_() {
  return rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS).filter(function (c) { return Number(c['Sent']) > 0; }).map(function (c) {
    var k = campaignCounts_(c['ID']);
    return '- "' + c['Name'] + '" (template ' + c['Template'] + '): ' + k.sent + ' sent, ' + k.replied + ' replied, ' +
           k.optedOut + ' said STOP. Message: ' + String(c['Message Text'] || '').slice(0, 400);
  }).join('\n');
}

/** Read recent chats and campaign results and suggest new knowledge notes. */
function learnFromChats_(days) {
  var chats = chatDigest_(days || 14, 40000);
  var camps = campaignDigest_();
  if (!chats && !camps) return { added: 0, message: 'No new chats or campaign results to learn from yet' };
  var user = '<current_knowledge>\n' + knowledge_().slice(0, 20000) + '\n</current_knowledge>\n\n' +
             (camps ? '<campaign_results>\n' + camps + '\n</campaign_results>\n\n' : '') +
             (chats ? '<recent_chats days="' + (days || 14) + '">\n' + chats + '</recent_chats>' : '');
  var notes = parseNotes_(aiText_(LEARN_SYSTEM, user));
  var added = addSuggestions_(notes, 'Chats and campaigns');
  logChange_('', 'learn', 'Learned from chats: ' + added + ' suggestions');
  return { added: added, message: added ? added + ' new things to review' : 'Nothing new to learn this time' };
}

/** Teach the bot from pasted text or a file (catalog, price list, company profile, old campaign export). */
function learnFromText_(title, text) {
  var user = '<current_knowledge>\n' + knowledge_().slice(0, 20000) + '\n</current_knowledge>\n\n' +
             '<material title="' + String(title).replace(/"/g, "'") + '">\n' + String(text).slice(0, 60000) + '\n</material>';
  var notes = parseNotes_(aiText_(LEARN_SYSTEM, user));
  return { added: addSuggestions_(notes, 'Taught: ' + String(title).slice(0, 60)) };
}

function addKnowledge_(title, content) {
  sheet_(SHEETS.knowledge).appendRow([String(title).slice(0, 200), String(content).slice(0, 45000)]);
}

/** Weekly (Monday, from the daily summary timer): learn from the last week and tell the salesperson. */
function weeklyLearn_() {
  if (!isOn_(growSetting_('LEARN_AUTO'))) return;
  if (new Date().getDay() !== 1) return;
  try {
    var r = learnFromChats_(7);
    if (r.added) alertSales_('🧠 The bot found ' + r.added + ' new things it could learn from last week\'s chats. ' +
                             'Open the app > Learn to approve or reject them.');
  } catch (err) { console.error('weekly learn failed: ' + err); }
}

// ===================================================================== app actions
var GROW_ACTIONS = {
  campaigns: function () {
    var leads = leadsFull_();
    var count = function (k) {
      var m = {}; leads.forEach(function (l) { var v = String(l[k] || '').trim(); if (v) m[v] = (m[v] || 0) + 1; });
      return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }).slice(0, 40).map(function (v) { return { name: v, n: m[v] }; });
    };
    return {
      campaigns: rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS).reverse().map(function (c) {
        var k = campaignCounts_(c['ID']);
        return { id: String(c['ID']), name: String(c['Name']), template: String(c['Template']), language: String(c['Language']),
                 usesName: isOn_(c['Uses Name']), text: String(c['Message Text']), filter: JSON.parse(c['Filter'] || '{}'),
                 status: String(c['Status']), total: Number(c['Total']) || 0, sent: k.sent, failed: k.failed, replied: k.replied,
                 optedOut: k.optedOut, error: String(c['Last Error'] || ''), created: iso_(c['Created']) };
      }),
      dailyLimit: Number(growSetting_('CAMPAIGN_DAILY_LIMIT')), sent24h: sentLast24h_(), sendEnabled: sendEnabled_(),
      options: { categories: count('Category'), states: count('State'), cities: count('City') }
    };
  },

  campaignPreview: function (a) {
    if (cleanFilter_(a.filter).keepOn) return { count: 0, welcome: true, sample: [] };
    var list = audience_(a.filter);
    return { count: list.length, sample: list.slice(0, 5).map(function (l) {
      return String(l['Name'] || l['Business'] || 'Lead') + ' · ' + String(l['City'] || '') + ' · ' + String(l['Category'] || ''); }) };
  },

  campaignSave: function (a) {
    var name = String(a.name || '').trim(), template = String(a.template || '').trim();
    if (!name) return { error: 'Give the campaign a name' };
    if (!/^[a-z0-9_]+$/.test(template)) return { error: 'Template name must be exactly as approved in BlueTick (small letters, numbers and _ only)' };
    var lang = String(a.language || 'en').trim();
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(lang)) return { error: 'Language code like en, hi or en_US' };
    var filter = JSON.stringify(cleanFilter_(a.filter));
    var fields = { 'Name': name, 'Template': template, 'Language': lang, 'Uses Name': a.usesName ? 'true' : 'false',
                   'Message Text': String(a.text || '').slice(0, 1024), 'Filter': filter };
    if (a.id) {
      var c = getCampaign_(a.id);
      if (!c) return { error: 'Campaign not found' };
      if (c['Status'] === 'Running') return { error: 'Pause the campaign before editing it' };
      setCampaign_(c, fields);
      return { message: 'Saved', id: String(c['ID']) };
    }
    var id = 'C' + campaignsSheet_().getLastRow() + '-' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyMMddHHmm').replace(/\D/g, '').slice(-8);
    campaignsSheet_().appendRow(CAMPAIGN_COLS.map(function (k) {
      return { 'ID': id, 'Status': 'Draft', 'Created': new Date(), 'Total': 0, 'Sent': 0, 'Failed': 0 }[k] !== undefined ?
        { 'ID': id, 'Status': 'Draft', 'Created': new Date(), 'Total': 0, 'Sent': 0, 'Failed': 0 }[k] : (fields[k] !== undefined ? fields[k] : '');
    }));
    logChange_('', 'app', 'Campaign created: ' + name);
    return { message: 'Campaign saved', id: id };
  },

  campaignTest: function (a) {
    var c = getCampaign_(a.id);
    if (!c) return { error: 'Campaign not found' };
    var to = normPhone_(setting_('SALES_WHATSAPP'));
    if (!to) return { error: 'Add the salesperson WhatsApp number in Settings first' };
    lastWaError_ = '';
    var id = waPost_(templateBody_(c, { 'Phone': to, 'Name': 'Test' }), true);
    return id ? { message: 'Template sent to +' + to + '. Check it looks right.' } : { error: 'WhatsApp refused it: ' + lastWaError_ };
  },

  campaignStart: function (a) {
    var c = getCampaign_(a.id);
    if (!c) return { error: 'Campaign not found' };
    if (!sendEnabled_()) return { error: 'Test mode is on. Turn on "Send on WhatsApp" in Settings first.' };
    if (['Draft', 'Paused'].indexOf(c['Status']) < 0) return { error: 'This campaign is ' + c['Status'] };
    var keepOn = cleanFilter_(JSON.parse(c['Filter'] || '{}')).keepOn;
    var left = audience_(JSON.parse(c['Filter'] || '{}'), campaignDone_(c['ID'])).length;
    if (!left && !keepOn) return { error: 'No leads match (or everyone already got it)' };
    setCampaign_(c, { 'Status': 'Running', 'Started': c['Started'] || new Date(), 'Last Error': '' });
    if (keepOn) {
      ensureCampaignTimer_(true);
      logChange_('', 'app', 'Welcome campaign on: ' + c['Name']);
      return { message: 'Welcome messages are on. Every new lead you add gets this template.' };
    }
    logChange_('', 'app', 'Campaign started: ' + c['Name'] + ' (' + left + ' leads left)');
    ensureCampaignTimer_(true);
    var r = campaignTick_();
    return { message: 'Started. ' + (r.sent || 0) + ' sent now; the rest go out every 5 minutes (up to ' +
                      growSetting_('CAMPAIGN_DAILY_LIMIT') + ' a day).' };
  },

  campaignPause: function (a) {
    var c = getCampaign_(a.id);
    if (!c) return { error: 'Campaign not found' };
    if (c['Status'] !== 'Running') return { error: 'Not running' };
    setCampaign_(c, { 'Status': 'Paused' });
    logChange_('', 'app', 'Campaign paused: ' + c['Name']);
    return { message: 'Paused' };
  },

  campaignDelete: function (a) {
    var c = getCampaign_(a.id);
    if (!c) return { error: 'Campaign not found' };
    if (c['Status'] !== 'Draft') return { error: 'Only drafts can be deleted. Pause it instead.' };
    setCampaign_(c, { 'Status': 'Deleted' });
    return { message: 'Deleted' };
  },

  campaignLimit: function (a) {
    var n = parseInt(a.limit, 10);
    if (!(n >= 1 && n <= 100000)) return { error: 'Enter a number' };
    writeSettings_({ CAMPAIGN_DAILY_LIMIT: String(n) });
    return { message: 'Daily limit saved' };
  },

  knowledge: function () {
    var sh = sheet_(SHEETS.knowledge);
    var docs = sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().map(function (r, i) {
      return { row: i + 2, title: String(r[0]), content: String(r[1]) };
    }).filter(function (d) { return d.title || d.content; });
    var sugg = rowsAsObjects_(learningSheet_(), LEARN_COLS).filter(function (r) { return r['Status'] === 'Suggested'; })
        .map(function (r) { return { row: r._row, source: String(r['Source']), title: String(r['Title']), content: String(r['Content']),
                                     why: String(r['Why']), time: iso_(r['Time']) }; });
    return { docs: docs, suggestions: sugg, auto: isOn_(growSetting_('LEARN_AUTO')),
             size: docs.reduce(function (s, d) { return s + d.content.length; }, 0) };
  },

  knowledgeSave: function (a) {
    var title = String(a.title || '').trim(), content = String(a.content || '').trim();
    if (!title || !content) return { error: 'Add a title and the text' };
    var sh = sheet_(SHEETS.knowledge);
    if (a.row) {
      var row = parseInt(a.row, 10);
      if (!(row >= 2 && row <= sh.getLastRow())) return { error: 'Not found' };
      sh.getRange(row, 1, 1, 2).setValues([[title.slice(0, 200), content.slice(0, 45000)]]);
    } else addKnowledge_(title, content);
    logChange_('', 'app', 'Knowledge ' + (a.row ? 'edited' : 'added') + ': ' + title);
    return { message: 'Saved. The bot uses it from the next message.' };
  },

  knowledgeDelete: function (a) {
    var sh = sheet_(SHEETS.knowledge), row = parseInt(a.row, 10);
    if (!(row >= 2 && row <= sh.getLastRow())) return { error: 'Not found' };
    var title = sh.getRange(row, 1).getValues()[0][0];
    sh.getRange(row, 1, 1, 2).setValues([['', '']]);
    logChange_('', 'app', 'Knowledge removed: ' + title);
    return { message: 'Removed' };
  },

  learnChats: function (a) {
    if (!secret_(aiKeyName_())) return { error: 'Add the AI key in Settings first' };
    return learnFromChats_(parseInt(a.days, 10) || 14);
  },

  learnText: function (a) {
    var title = String(a.title || '').trim(), text = String(a.text || '').trim();
    if (!title || !text) return { error: 'Add a title and the text' };
    if (a.direct) { addKnowledge_(title, text); logChange_('', 'app', 'Knowledge added: ' + title); return { message: 'Saved as it is' }; }
    if (!secret_(aiKeyName_())) return { error: 'Add the AI key in Settings first' };
    var r = learnFromText_(title, text);
    return { message: r.added ? r.added + ' notes to review below' : 'The AI found nothing new in it', added: r.added };
  },

  learnDecide: function (a) {
    var sh = learningSheet_(), row = parseInt(a.row, 10);
    if (!(row >= 2 && row <= sh.getLastRow())) return { error: 'Not found' };
    var r = sh.getRange(row, 1, 1, LEARN_COLS.length).getValues()[0];
    if (r[5] !== 'Suggested') return { error: 'Already decided' };
    if (a.approve) {
      var title = String(a.title || r[2]).trim(), content = String(a.content || r[3]).trim();
      addKnowledge_('Learned: ' + title, content);
      sh.getRange(row, 6).setValue('Approved');
      logChange_('', 'app', 'Learned: ' + title);
      return { message: 'The bot knows this now' };
    }
    sh.getRange(row, 6).setValue('Rejected');
    return { message: 'Rejected' };
  },

  learnAuto: function (a) {
    writeSettings_({ LEARN_AUTO: a.on ? 'true' : 'false' });
    return { message: a.on ? 'The bot will look for new things every Monday' : 'Weekly learning is off' };
  }
};
