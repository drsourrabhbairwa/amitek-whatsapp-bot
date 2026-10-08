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
                     'Started', 'Finished', 'Total', 'Sent', 'Failed', 'Last Error', 'Start At'];
var CAMPAIGN_LOG_COLS = ['Time', 'Campaign ID', 'Phone', 'Result', 'Detail'];
var LEARN_COLS = ['Time', 'Source', 'Title', 'Content', 'Why', 'Status'];
var GROW_SHEETS = { campaigns: 'Campaigns', campaignLog: 'Campaign Log', learning: 'Learning' };
var MOBILE_RE = /^91[6-9]\d{9}$/;

function growSheet_(name, cols) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(cols); }
  else if (sh.getLastColumn() < cols.length) sh.getRange(1, 1, 1, cols.length).setValues([cols]);  // columns added in an update
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
function campaignBlock_(l, team) {
  var phone = String(l['Phone'] || '');
  if (!MOBILE_RE.test(phone)) return 'not a mobile number';
  if ((team || []).indexOf(phone) >= 0) return 'our team';
  if (l['Opt-in'] === 'Opted out' || l['Status'] === 'Opted out') return 'said STOP';
  if (l['Status'] === 'Won' || l['Status'] === 'Lost') return 'closed';
  return '';
}

function audience_(filter, excludePhones, since) {
  var f = cleanFilter_(filter);
  var team = teamPhones_();
  var lower = function (a) { return a.map(function (x) { return x.toLowerCase(); }); };
  var cats = lower(f.categories), cities = lower(f.cities), states = lower(f.states);
  var seen = {};
  var out = leadsFull_().filter(function (l) {
    var phone = String(l['Phone'] || '');
    if (!phone || seen[phone] || (excludePhones && excludePhones[phone])) return false;
    if (campaignBlock_(l, team)) return false;
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
  var text = String(c['Message Text'] || openingText_(l) || '[Template ' + c['Template'] + ']');
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

function newCampaign_(fields, status) {
  var id = 'C' + campaignsSheet_().getLastRow() + '-' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyMMddHHmm').replace(/\D/g, '').slice(-8);
  var base = { 'ID': id, 'Status': status || 'Draft', 'Created': new Date(), 'Total': 0, 'Sent': 0, 'Failed': 0 };
  campaignsSheet_().appendRow(CAMPAIGN_COLS.map(function (k) {
    return base[k] !== undefined ? base[k] : (fields[k] !== undefined ? fields[k] : '');
  }));
  return id;
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
  var all = rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS);
  var running = all.filter(function (c) { return c['Status'] === 'Running'; });
  var waiting = all.filter(function (c) { return c['Status'] === 'Scheduled'; });
  if (!running.length && !waiting.length) { ensureCampaignTimer_(false); return { sent: 0, reason: 'nothing running' }; }
  if (!sendEnabled_()) return { sent: 0, reason: 'test mode' };  // waits; resumes when sending is switched on
  var now = new Date();
  waiting.forEach(function (c) {  // scheduled campaigns start when their time comes
    var at = asDate_(c['Start At']);
    if (at && at > now) return;
    setCampaign_(c, { 'Status': 'Running', 'Started': now, 'Last Error': '' });
    running.push(c);
    alertSales_('📣 Campaign "' + c['Name'] + '" has started sending.');
  });
  if (!running.length) return { sent: 0, reason: 'scheduled' };
  var room = Number(growSetting_('CAMPAIGN_DAILY_LIMIT')) - sentLast24h_();
  if (room <= 0) return { sent: 0, reason: 'daily limit' };
  // welcome (always-on) campaigns first, so new leads are greeted quickly; then the oldest bulk campaign
  var keep = function (c) { return cleanFilter_(JSON.parse(c['Filter'] || '{}')).keepOn; };
  var order = running.filter(keep).concat(running.filter(function (c) { return !keep(c); }));
  var total = { sent: 0, failed: 0 };
  var perTick = Number(growSetting_('CAMPAIGN_BATCH')) || 40;
  order.forEach(function (c) {
    var left = Math.min(room - total.sent, perTick - total.sent - total.failed);
    if (left <= 0) return;
    var r = sendBatch_(c, left);
    total.sent += r.sent; total.failed += r.failed;
  });
  if (!rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS).some(function (x) { return x['Status'] === 'Running' || x['Status'] === 'Scheduled'; })) {
    ensureCampaignTimer_(false);
  }
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
  var byPhone = {}, order = [];
  rows.forEach(function (r) {
    var t = asDate_(r[0]), phone = String(r[1]);
    if (!t || t.getTime() < since || !phone || isTeam_(phone)) return;
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
// ===================================================================== pitch by category
/** What each type of lead is offered: the opening template and what the bot steers the chat towards. Editable in Settings. */
var PLAYBOOK_DEFAULTS = {
  'Applicator': { template: 'amitek_applicator', text: 'Namaste {{1}} ji. This is Amitek Waterproofing, Jaipur (APP Paints Chemicals Pvt. Ltd.). 25+ years of manufacturing and field expertise, 1000+ contractors and dealers across India and overseas, Govt. Approved Star Export House. Would you like to sell waterproofing products under your own brand name? We do third party manufacturing, and also offer Amitek products at special applicator rates. Shall we send the details?', pitch:
    'Main offer: third-party manufacturing (private label). Amitek manufactures waterproofing and coating products under the ' +
    "applicator's own brand name, so they can sell and apply their own brand. Ask whether they already have (or want) their own " +
    'brand, which products they need and roughly how much per month. Also offer Amitek products at applicator rates for their sites. ' +
    'Minimum quantity, rates and timelines come from the team: call handoff_to_sales when they are interested.' },
  'End Client': { template: 'amitek_end_client', text: 'Namaste {{1}} ji. This is Amitek Waterproofing, Jaipur. We make waterproofing products for roof and terrace leaks, wall dampness, bathrooms and water tanks. 25+ years of experience. Do you have a leakage or dampness problem at your home or building? Tell us and we will suggest the right product.', pitch:
    'Main offer: Amitek products for their own home or building (roof and terrace, walls and damp, bathrooms, water tanks). ' +
    'First find the problem (where, how big, leaking now or not), then recommend the right product from the knowledge. ' +
    'Offer a site visit or an applicator through the team (handoff_to_sales).' },
  'Builder': { template: 'amitek_builder', text: 'Namaste {{1}} ji. This is Amitek, Jaipur (APP Paints Chemicals Pvt. Ltd.). For your projects we offer, from one partner: waterproofing systems, seamless flooring, home automation, security cameras (CCTV) and our other solutions. Shall we send details and a project rate for any current or upcoming project?', pitch:
    'Main offer: complete solutions for their projects: waterproofing systems, seamless flooring, home automation, ' +
    'security cameras (CCTV) and our other building solutions. Ask which project, its stage and city, and which of these they ' +
    'need. A meeting or site visit goes to the team (handoff_to_sales).' },
  'Architect': { template: 'amitek_builder', text: 'Namaste {{1}} ji. This is Amitek, Jaipur (APP Paints Chemicals Pvt. Ltd.). For your projects we offer, from one partner: waterproofing systems, seamless flooring, home automation, security cameras (CCTV) and our other solutions. Shall we send details and a project rate for any current or upcoming project?', pitch:
    'Main offer: solutions to specify in their projects: waterproofing systems, seamless flooring, home automation, security ' +
    'cameras (CCTV) and our other building solutions. Offer product specs and a meeting with the team (handoff_to_sales).' },
  'Contractor': { template: 'amitek_contractor', text: 'Namaste {{1}} ji. This is Amitek Waterproofing, Jaipur. We supply waterproofing and construction chemicals for your sites, at project rates and with application support. Which site are you working on right now? Shall we send the product details?', pitch:
    'Main offer: Amitek waterproofing and construction chemicals for their sites at project rates, with application support. ' +
    'Ask about current sites, area and timeline; rates come from the team (handoff_to_sales).' },
  'Dealer': { template: 'amitek_dealer', text: 'Namaste {{1}} ji. This is Amitek Waterproofing, Jaipur. We are adding dealers in your area for waterproofing, coatings and construction chemicals. Would you like to know about an Amitek dealership?', pitch:
    'Main offer: Amitek dealership for their area (waterproofing, coatings and construction chemicals). Ask about their shop, ' +
    'area and current brands; dealer terms come from the team (handoff_to_sales).' }
};

function playbook_() {
  var saved = {};
  try { saved = JSON.parse(setting_('CATEGORY_PLAYBOOK') || '{}') || {}; } catch (err) { saved = {}; }
  var out = {};
  CATEGORIES.forEach(function (c) {
    var d = PLAYBOOK_DEFAULTS[c] || {}, s = saved[c] || {};
    out[c] = { template: String(s.template !== undefined ? s.template : (d.template || '')).trim(),
               language: String(s.language || d.language || 'hi').trim(),
               text: String(s.text !== undefined ? s.text : (d.text || '')).trim(),
               pitch: String(s.pitch !== undefined ? s.pitch : (d.pitch || '')).trim() };
  });
  return out;
}

/** What the first (template) message said to this lead, so the bot continues the same conversation. */
function openingText_(l) { return (playbook_()[String(l['Category'] || '')] || {}).text || ''; }

/** Added to the bot's instructions for a lead, so each category hears its own offer. */
function pitchFor_(lead) {
  var cat = String((lead && lead['Category']) || '');
  var p = playbook_()[cat];
  if (!p || !p.pitch) return '';
  return '\n\n<pitch customer_type="' + cat + '">\nAmitek\'s first message to this person already made this offer, so talking about it is expected ' +
         'and is allowed even in gentle mode (it overrides "no offers"). Steer the chat towards it naturally, with claims only ' +
         'from the knowledge and no invented prices:\n' + p.pitch + '\n</pitch>';
}

// ===================================================================== tell the bot who to message, and when
var CAT_WORDS = [
  ['End Client', /\b(end ?clients?|home ?owners?|house ?owners?|customers?|grahak)\b/],
  ['Applicator', /\bapplicat\w*/], ['Contractor', /\b(contractors?|thekedar\w*)\b/],
  ['Builder', /\b(builders?|developers?)\b/], ['Architect', /\b(architects?|interior\w*)\b/],
  ['Dealer', /\b(dealers?|distributors?|retailers?|shops?|dukaan\w*)\b/], ['Manufacturer', /\bmanufacturers\b/]
];
var DAY_WORDS = { sunday: 0, sun: 0, ravivar: 0, raviwar: 0, itwar: 0, monday: 1, mon: 1, somvar: 1, somwar: 1,
  tuesday: 2, tue: 2, tues: 2, mangalvar: 2, mangalwar: 2, wednesday: 3, wed: 3, budhvar: 3, budhwar: 3,
  thursday: 4, thu: 4, thurs: 4, guruvar: 4, guruwar: 4, veervar: 4, friday: 5, fri: 5, shukravar: 5, shukrawar: 5,
  saturday: 6, sat: 6, shanivar: 6, shaniwar: 6 };
var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
var IST_MS = 330 * 60000;

/** India date parts of a moment (the script may run in another time zone). */
function ist_(d) { var x = new Date(d.getTime() + IST_MS); return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), wd: x.getUTCDay() }; }
function istDate_(y, m, d, h, min) { return new Date(Date.UTC(y, m, d, h, min || 0) - IST_MS); }

/** "monday 11 baje", "kal", "15 oct 4 pm", "abhi" -> a Date (null = now). Default time 10 AM. */
function parseWhen_(t, now) {
  var today = ist_(now), day = null;
  if (/\b(abhi|now|turant|right away|immediately)\b/.test(t)) return null;
  var tm = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|baje|bje)\b/);
  var hour = 10, min = 0;
  if (tm) {
    hour = parseInt(tm[1], 10) % 24; min = parseInt(tm[2] || '0', 10);
    if (tm[3] === 'pm' && hour < 12) hour += 12;
    if (tm[3] === 'am' && hour === 12) hour = 0;
    if (/ba?je/.test(tm[3]) && hour >= 1 && hour <= 7 && !/subah|morning/.test(t)) hour += 12;  // "4 baje" = 4 PM
    if (/\b(shaam|sham|evening|raat)\b/.test(t) && hour < 12) hour += 12;
  }
  var mDate = t.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*/) ||
              t.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-]\d{2,4})?\b/);
  if (mDate) {
    var mon = isNaN(mDate[2]) ? MONTHS.indexOf(mDate[2]) : parseInt(mDate[2], 10) - 1;
    day = { y: today.y, m: mon, d: parseInt(mDate[1], 10) };
    if (istDate_(day.y, day.m, day.d, 23, 59) < now) day.y++;
  } else if (/\b(parso|parson|day after tomorrow)\b/.test(t)) { day = { y: today.y, m: today.m, d: today.d + 2 };
  } else if (/\b(kal|tomorrow|tmrw)\b/.test(t)) { day = { y: today.y, m: today.m, d: today.d + 1 };
  } else if (/\b(aaj|today)\b/.test(t)) { day = { y: today.y, m: today.m, d: today.d };
  } else {
    var w = Object.keys(DAY_WORDS).filter(function (k) { return new RegExp('\\b' + k + '\\b').test(t); })[0];
    if (w) {
      var add = (DAY_WORDS[w] - today.wd + 7) % 7;
      if (add === 0 && istDate_(today.y, today.m, today.d, hour, min) <= now) add = 7;
      day = { y: today.y, m: today.m, d: today.d + add };
    }
  }
  if (!day && !tm) return null;
  if (!day) day = { y: today.y, m: today.m, d: today.d };
  var at = istDate_(day.y, day.m, day.d, hour, min);
  return at <= now ? null : at;
}

/** Reads a plain request ("applicators ko monday 11 baje, builders ko kal") into who gets which template, and when. */
function readRequest_(text, now) {
  var t = ' ' + String(text || '').toLowerCase() + ' ';
  var all = /\b(all|sabko|sab ko|sabhi|everyone|every category|har category)\b/.test(t);
  var book = playbook_();
  var cats = all ? CATEGORIES.filter(function (c) { return book[c] && book[c].template; })
                 : CAT_WORDS.filter(function (cw) { return cw[1].test(t); }).map(function (cw) { return cw[0]; });
  var names = {}, cities = {};
  leadsFull_().forEach(function (l) { var c = String(l['City'] || '').trim(); if (c.length >= 3) names[c] = true; });
  Object.keys(names).forEach(function (c) {
    var k = c.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (k.length >= 3 && new RegExp('\\b' + k + '\\b').test(t)) cities[c] = true;
  });
  var lim = t.match(/\b(?:first|pehle|sirf|only|max|limit)\s*(\d{1,5})\b/) || t.match(/\b(\d{1,5})\s*(?:leads|logo|log|people|logon)\b/);
  return { categories: cats, cities: Object.keys(cities), at: parseWhen_(t, now), limit: lim ? parseInt(lim[1], 10) : 0 };
}

/** Builds the plan the team confirms with YES. */
function makePlan_(text) {
  var now = new Date();
  var r = readRequest_(text, now);
  if (!r.categories.length) return { error: 'Which leads? Name a category: applicators, contractors, builders, architects, dealers, ' +
                                             'end clients (or "all").\nExample: applicators ko monday 11 baje message bhejo' };
  var book = playbook_(), items = [], missing = [];
  r.categories.forEach(function (cat) {
    var p = book[cat] || {};
    if (!p.template) { missing.push(cat); return; }
    var filter = cleanFilter_({ categories: [cat], cities: r.cities, limit: r.limit });
    items.push({ category: cat, template: p.template, language: p.language || 'en', count: audience_(filter).length, filter: filter });
  });
  if (!items.length) return { error: 'No template is set for ' + missing.join(', ') + '. Add it in the app: Settings > Pitch by category.' };
  return { items: items, missing: missing, at: r.at ? r.at.toISOString() : '', cities: r.cities, limit: r.limit, made: now.toISOString() };
}

function planText_(plan) {
  var lines = ['📣 *Campaign plan*'];
  plan.items.forEach(function (i) { lines.push('• ' + i.category + ': ' + i.count + ' leads, template ' + i.template); });
  if (plan.cities.length) lines.push('Cities: ' + plan.cities.join(', '));
  if (plan.limit) lines.push('At most ' + plan.limit + ' per category');
  lines.push('When: ' + (plan.at ? fmt_(plan.at) : 'now'));
  lines.push('Only leads never messaged before. Up to ' + growSetting_('CAMPAIGN_DAILY_LIMIT') + ' a day.');
  if (plan.missing.length) lines.push('⚠️ No template set for ' + plan.missing.join(', ') + ' (Settings > Pitch by category).');
  if (!sendEnabled_()) lines.push('⚠️ Test mode is on: nothing goes out until "Send on WhatsApp" is switched on.');
  lines.push('The templates must be APPROVED in BlueTick.');
  return lines.join('\n');
}

/** Creates the campaigns of a confirmed plan (scheduled, or started now). */
function runPlan_(plan, who) {
  var at = plan.at ? new Date(plan.at) : null;
  if (at && at <= new Date()) at = null;
  var stamp = Utilities.formatDate(at || new Date(), 'Asia/Kolkata', 'dd MMM');
  var ids = plan.items.filter(function (i) { return i.count > 0; }).map(function (i) {
    return newCampaign_({ 'Name': i.category + ' · ' + stamp, 'Template': i.template, 'Language': i.language, 'Uses Name': 'true',
                          'Message Text': '', 'Filter': JSON.stringify(i.filter), 'Start At': at || '', 'Started': at ? '' : new Date() },
                        at ? 'Scheduled' : 'Running');
  });
  if (!ids.length) return 'Nothing to send: no new leads match.';
  logChange_('', who, 'Campaign plan: ' + plan.items.map(function (i) { return i.category; }).join(', ') + (at ? ' at ' + fmt_(at) : ' now'));
  ensureCampaignTimer_(true);
  if (!at && sendEnabled_()) { var r = campaignTick_(); return '✅ Started. ' + (r.sent || 0) + ' sent now, the rest every 5 minutes.'; }
  return at ? '✅ Scheduled for ' + fmt_(at) + '. You will get a message when it starts.' :
              '✅ Saved. It starts when "Send on WhatsApp" is switched on.';
}

/** Who may plan campaigns from WhatsApp: the main salesperson and the "every lead" team members. */
function canPlan_(phone) {
  return !!phone && (phone === normPhone_(setting_('SALES_WHATSAPP')) || (teamRouting_()['All'] || []).indexOf(phone) >= 0);
}
function savePlan_(key, plan) { PropertiesService.getScriptProperties().setProperty('PLAN_' + key, JSON.stringify(plan)); }
function takePlan_(key) {
  var props = PropertiesService.getScriptProperties(), raw = props.getProperty('PLAN_' + key);
  if (!raw) return null;
  props.deleteProperty('PLAN_' + key);
  var plan = JSON.parse(raw);
  return Date.now() - new Date(plan.made).getTime() < 30 * 60000 ? plan : null;  // a plan is good for 30 minutes
}

/** WhatsApp from the team: plan, confirm or cancel a campaign. Returns the answer, or '' if the text is not about campaigns. */
function campaignChat_(text, from) {
  if (!canPlan_(from)) return '';
  var word = String(text).trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(yes|haan|han|ha|ok|okay|confirm|haan bhejo)$/.test(word)) {
    var plan = takePlan_(from);
    return plan ? runPlan_(plan, 'sales') : 'No campaign plan is waiting. Tell me who to message, e.g. "applicators ko monday 11 baje".';
  }
  if (/^(no|nahi|nahin|cancel|ruko|mat bhejo)$/.test(word)) return takePlan_(from) ? 'Cancelled. Nothing was sent.' : '';
  if (/^(campaigns?|status)$/.test(word)) return campaignStatus_();
  var p = makePlan_(text);
  if (p.error) return /\b(message|msg|mess|bhej|send|campaign|campa?gin)\w*/i.test(text) ? p.error : '';
  savePlan_(from, p);
  return planText_(p) + '\n\nReply *YES* to confirm or *NO* to cancel.';
}

function campaignStatus_() {
  var rows = rowsAsObjects_(campaignsSheet_(), CAMPAIGN_COLS).filter(function (c) { return ['Running', 'Scheduled', 'Paused'].indexOf(c['Status']) >= 0; });
  if (!rows.length) return 'No campaigns running or scheduled.';
  return '📣 *Campaigns*\n' + rows.map(function (c) {
    var k = campaignCounts_(c['ID']);
    return '• ' + c['Name'] + ': ' + c['Status'] + (c['Status'] === 'Scheduled' ? ' for ' + fmt_(c['Start At']) : ', ' + k.sent + ' sent, ' + k.replied + ' replied');
  }).join('\n');
}

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
                 optedOut: k.optedOut, error: String(c['Last Error'] || ''), created: iso_(c['Created']),
                 startAt: asDate_(c['Start At']) ? iso_(c['Start At']) : '' };
      }),
      dailyLimit: Number(growSetting_('CAMPAIGN_DAILY_LIMIT')), sent24h: sentLast24h_(), sendEnabled: sendEnabled_(),
      options: { categories: count('Category'), states: count('State'), cities: count('City') }
    };
  },

  playbook: function () { return { playbook: playbook_(), categories: CATEGORIES }; },

  playbookSave: function (a) {
    var o = {}, bad = [];
    Object.keys(a.playbook || {}).forEach(function (cat) {
      if (CATEGORIES.indexOf(cat) < 0) return;
      var p = a.playbook[cat] || {}, tpl = String(p.template || '').trim();
      if (tpl && !/^[a-z0-9_]+$/.test(tpl)) bad.push(cat);
      o[cat] = { template: tpl, language: /^[a-z]{2}(_[A-Z]{2})?$/.test(String(p.language || '')) ? p.language : 'en',
                 text: String(p.text || '').trim().slice(0, 1024), pitch: String(p.pitch || '').trim().slice(0, 2000) };
    });
    if (bad.length) return { error: 'Template names use small letters, numbers and _ only. Check: ' + bad.join(', ') };
    writeSettings_({ CATEGORY_PLAYBOOK: JSON.stringify(o) });
    return { message: 'Saved. The bot uses it from the next message.' };
  },

  planFromText: function (a) {
    var p = makePlan_(a.text);
    if (p.error) return { error: p.error };
    savePlan_('app', p);
    return { plan: p, summary: planText_(p) };
  },

  planConfirm: function () {
    var plan = takePlan_('app');
    if (!plan) return { error: 'The plan expired. Write it again.' };
    return { message: runPlan_(plan, 'app') };
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
    var startAt = a.startAt ? new Date(a.startAt) : '';
    if (startAt && isNaN(startAt.getTime())) return { error: 'Check the start date and time' };
    var fields = { 'Name': name, 'Template': template, 'Language': lang, 'Uses Name': a.usesName ? 'true' : 'false',
                   'Message Text': String(a.text || '').slice(0, 1024), 'Filter': filter, 'Start At': startAt };
    if (a.id) {
      var c = getCampaign_(a.id);
      if (!c) return { error: 'Campaign not found' };
      if (c['Status'] === 'Running') return { error: 'Pause the campaign before editing it' };
      setCampaign_(c, fields);
      return { message: 'Saved', id: String(c['ID']) };
    }
    var id = newCampaign_(fields, 'Draft');
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
    var at = asDate_(c['Start At']);
    if (at && at > new Date() && !c['Started']) {
      setCampaign_(c, { 'Status': 'Scheduled', 'Last Error': '' });
      ensureCampaignTimer_(true);
      logChange_('', 'app', 'Campaign scheduled: ' + c['Name'] + ' for ' + fmt_(at));
      return { message: 'Scheduled for ' + fmt_(at) + '. ' + left + ' leads match now.' };
    }
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
    if (c['Status'] === 'Scheduled') { setCampaign_(c, { 'Status': 'Draft' }); return { message: 'Schedule cancelled. It is a draft again.' }; }
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
