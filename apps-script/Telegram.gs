// ===================================================================== Telegram: the team's own bot
// Employees chat with a private Telegram bot to add leads, get lead alerts, reply to leads and plan WhatsApp
// campaigns from the company number. Only people allowed in the app (Settings > Telegram) get answers.
// Telegram posts updates to the same webhook link as WhatsApp (through the relay); doPost sends them here.

var TG_API = 'https://api.telegram.org/bot';
var TG_MAX_LEADS = 300;  // per file or message

var TG_GUIDE = [
  '*Amitek team bot* 🙏',
  'I work with our WhatsApp sales bot. Customers chat with the WhatsApp bot; you use me to feed it leads and to follow up.',
  '',
  '*1. Give me leads*',
  'Send one lead per line: name, mobile, category, city, note',
  'e.g. Ramesh Sharma, 9812345678, applicator, Jaipur, terrace 2000 sqft',
  'Many lines at once are fine. A CSV file works too (columns Name, Phone, Category, City, Business, Note).',
  'Excel? Use File > Save as / Download > CSV and send that file.',
  'Categories: applicator, contractor, builder, architect, dealer, manufacturer, end client. Not sure? Leave it out, the bot sorts it.',
  '',
  '*2. What happens next*',
  'New leads wait for a campaign. A campaign sends our approved WhatsApp template; when a lead answers, the WhatsApp bot',
  'talks to them, asks what they need and never quotes prices. When someone is interested, you get an alert here with the summary.',
  '',
  '*3. Follow up*',
  'LIST - leads that need you',
  'INFO 98xxxxxxxx - one lead and the last messages',
  'REPLY 98xxxxxxxx your message - send them a WhatsApp from the company number (only within 24 hours of their last message)',
  'DONE 98xxxxxxxx note - you called them',
  'LATER 98xxxxxxxx 3 note - remind in 3 days',
  'WON 98xxxxxxxx / LOST 98xxxxxxxx reason',
  '',
  '*4. Campaigns* (if the admin allowed you)',
  'applicators ko monday 11 baje message bhejo - I show the plan, you reply YES',
  'Add "bot reply mat karna" if the team will answer: the bot stays quiet and every reply comes to you here.',
  'CAMPAIGNS - what is running',
  '',
  'Any other question about the bot: just ask in your own words.'
].join('\n');

var TG_HELP_SYSTEM = [
  'You help employees of Amitek Waterproofing (Jaipur) use the team Telegram bot and the WhatsApp sales bot.',
  'Answer in the language the employee uses (English, Hindi or Hinglish), short and practical, plain text, at most 8 lines.',
  'Only explain what the guide below says. If they ask for something the bot cannot do, say so and suggest asking the admin.',
  'Never invent prices, commands or features. Never share customer numbers.',
  '',
  'GUIDE:',
  TG_GUIDE
].join('\n');

function tgToken_() { return secret_('TELEGRAM_BOT_TOKEN'); }

function tgCall_(method, body) {
  var t = tgToken_();
  if (!t) return { ok: false, description: 'No Telegram bot token' };
  var res = UrlFetchApp.fetch(TG_API + t + '/' + method, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(body || {})
  });
  try { return JSON.parse(res.getContentText()); } catch (err) { return { ok: false, description: String(res.getContentText()).slice(0, 200) }; }
}

/** WhatsApp-style *bold* and _italic_ become Telegram HTML; everything else is escaped. */
function tgHtml_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/gm, '$1<i>$2</i>');
}

function tgSend_(chatId, text) {
  var s = String(text || '');
  for (var i = 0; i < s.length && i < 12000; i += 3800) {
    var part = s.slice(i, i + 3800);
    var r = tgCall_('sendMessage', { chat_id: chatId, text: tgHtml_(part), parse_mode: 'HTML', disable_web_page_preview: true });
    if (!r.ok) tgCall_('sendMessage', { chat_id: chatId, text: part });  // fall back to plain text
  }
}

// ---- who may use the bot: {"<telegram id>": {name, user, status: asked|allowed, campaigns, alerts, at}}
function tgUsers_() {
  try { return JSON.parse(secret_('TG_USERS') || '{}') || {}; } catch (err) { return {}; }
}
function saveTgUsers_(u) { PropertiesService.getScriptProperties().setProperty('TG_USERS', JSON.stringify(u)); }
function tgAllowed_(id) { var u = tgUsers_()[String(id)]; return !!u && u.status === 'allowed'; }
function tgCanCampaign_(from) {
  var m = /^tg:(\d+)$/.exec(String(from || ''));
  if (!m) return false;
  var u = tgUsers_()[m[1]];
  return !!u && u.status === 'allowed' && !!u.campaigns;
}

/** Lead alerts also go to allowed Telegram users who keep alerts on (no 24-hour limit there). */
function tgAlert_(text) {
  if (!tgToken_()) return;
  var u = tgUsers_();
  Object.keys(u).forEach(function (id) {
    if (u[id].status === 'allowed' && u[id].alerts !== false) {
      try { tgSend_(id, text); } catch (err) { console.error('telegram alert failed ' + err); }
    }
  });
}

function isTelegram_(p) { return !!p && typeof p.update_id === 'number' && !p.entry; }

/** One Telegram update. Runs outside the WhatsApp lock; takes it only around sheet changes. */
function handleTelegram_(u) {
  var cache = CacheService.getScriptCache();
  if (cache.get('tg_' + u.update_id)) return;  // Telegram retries; do each update once
  cache.put('tg_' + u.update_id, '1', 21600);
  var m = u.message || u.edited_message;
  if (!m || !m.from || !m.chat || m.chat.type !== 'private' || m.from.is_bot) return;  // groups are ignored
  var id = String(m.from.id);
  var name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || id;
  var users = tgUsers_();
  var me = users[id];
  if (!me || me.status !== 'allowed') {
    var first = !me;
    if (first) {
      var asked = Object.keys(users).filter(function (k) { return users[k].status === 'asked'; });
      if (asked.length >= 20) { delete users[asked[0]]; }
      users[id] = { name: name.slice(0, 60), user: String(m.from.username || ''), status: 'asked', at: new Date().toISOString() };
      saveTgUsers_(users);
      alertSales_('Telegram: ' + name + ' wants to use the team bot. Allow or ignore in the Amitek app: Settings > Telegram.', true);
    }
    if (first || /^\/start/.test(String(m.text || ''))) {
      tgSend_(m.chat.id, 'Namaste ' + name + ' 🙏 This bot is only for the Amitek team. Your request has gone to the admin. ' +
                         'Once you are allowed, send /start again.');
    }
    return;
  }
  var answer = tgAnswer_(m, id, name);
  if (answer) tgSend_(m.chat.id, answer);
}

function tgLocked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function tgAnswer_(m, id, name) {
  var who = 'tg:' + id, actor = 'telegram ' + name;
  if (m.document) return tgFile_(m.document, actor);
  var text = String(m.text || m.caption || '').trim();
  if (!text) return 'Send text or a CSV file. /help shows what I can do.';
  var word = text.split(/\s+/)[0].replace(/@\w+$/, '').toUpperCase();
  if (word === '/START' || word === '/HELP' || word === 'HELP' || word === 'GUIDE' || word === '?') return TG_GUIDE;
  if (word === 'INFO' || word === '/INFO') return tgInfo_(text.split(/\s+/)[1]);
  if (word === 'REPLY' || word === '/REPLY') {
    var rp = /^\S+\s+([+\d][\d\s-]{8,})\s+([\s\S]+)$/.exec(text);
    if (!rp) return 'Write it like: REPLY 9812345678 your message';
    var r = tgLocked_(function () { return APP_ACTIONS.reply({ phone: rp[1], text: rp[2] }); });
    return r.error ? '❌ ' + r.error : '✅ Sent on WhatsApp. The bot stays quiet with this lead for a while so you can talk.';
  }
  text = text.replace(/^\//, '');
  word = word.replace(/^\//, '');
  if (word === 'ADD') return tgLocked_(function () { return tgAddLeads_(text.replace(/^\S+\s*/, ''), actor); });
  if (['LIST', 'PENDING', 'DONE', 'LATER', 'WON', 'LOST', 'CAMPAIGNS', 'CAMPAIGN', 'STATUS', 'YES', 'NO', 'HAAN', 'NAHI', 'CONFIRM', 'CANCEL']
        .indexOf(word.replace(/[.!]+$/, '')) >= 0) {
    var said = tgLocked_(function () { return salesCommand_(text, who); });
    return /^Command not understood/.test(said) ? TG_GUIDE : said;
  }
  var plan = tgLocked_(function () { return campaignChat_(text, who); });
  if (plan) return plan;
  if (tgLeadLines_(text).length) return tgLocked_(function () { return tgAddLeads_(text, actor); });
  if (/\b(message|msg|bhej|send|campaign|template)\w*/i.test(text) && !tgCanCampaign_(who)) {
    return 'Only people the admin allowed can send campaigns. Ask the admin, or add leads and they will be in the next campaign.';
  }
  return tgAsk_(text);
}

/** A question about the bot: the AI answers from the guide, or the guide itself when there is no AI key. */
function tgAsk_(text) {
  if (!secret_(aiKeyName_())) return TG_GUIDE;
  try {
    var a = aiText_(TG_HELP_SYSTEM, String(text).slice(0, 1500)).trim();
    return a || TG_GUIDE;
  } catch (err) {
    console.error('telegram ask failed ' + err);
    return TG_GUIDE;
  }
}

function tgInfo_(raw) {
  var phone = normPhone_(raw);
  var lead = phone && getLead_(phone);
  if (!lead) return 'No lead found. Write it like: INFO 9812345678';
  var bits = ['Category: ' + (lead['Category'] || '-'), 'City: ' + (lead['City'] || '-'), 'Status: ' + (lead['Status'] || '-') +
              (lead['Stage'] ? ' / ' + lead['Stage'] : '')];
  if (lead['Requirement']) bits.push('Need: ' + lead['Requirement']);
  if (lead['Area sqft']) bits.push('Area: ' + lead['Area sqft'] + ' sq ft');
  var nf = asDate_(lead['Next Follow-up']);
  if (nf) bits.push('Next follow-up: ' + fmt_(nf) + (lead['Follow-up Note'] ? ' (' + lead['Follow-up Note'] + ')' : ''));
  var h = history_(phone, 6).map(function (x) {
    return (x.direction === 'in' ? '👤 ' : x.sender === 'bot' ? '🤖 ' : '🧑‍💼 ') + String(x.body).slice(0, 200);
  });
  return '*' + label_(lead) + '*\n' + bits.join('\n') + (h.length ? '\n\n*Last messages*\n' + h.join('\n') : '\n\nNo messages yet.');
}

// ---- leads from text: one per line, "name, mobile, category, city, note" (order is loose; the mobile number is what counts)
function tgLeadLines_(text) {
  return String(text).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).filter(function (l) {
    return /(^|[^\d])(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}([^\d]|$)/.test(l);
  });
}

/** The category a word names ("applicator", "builders", "end client"). only = the text must be just that word. */
function tgCategory_(s, only) {
  var t = ' ' + String(s || '').toLowerCase() + ' ';
  for (var i = 0; i < CAT_WORDS.length; i++) {
    if (!CAT_WORDS[i][1].test(t)) continue;
    if (!only || !t.replace(CAT_WORDS[i][1], '').replace(/\b(ko|hai|category|type)\b/g, '').trim()) return CAT_WORDS[i][0];
  }
  for (var j = 0; j < CATEGORIES.length; j++) if (t.trim() === CATEGORIES[j].toLowerCase()) return CATEGORIES[j];
  return '';
}

function tgParseLine_(line) {
  var m = /(\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})/.exec(line);
  if (!m) return null;
  var phone = normPhone_(m[0]);
  var rest = (line.slice(0, m.index) + ',' + line.slice(m.index + m[0].length)).split(/[,;|\t]+/)
      .map(function (x) { return x.replace(/^[\s:-]+|[\s:-]+$/g, ''); }).filter(Boolean);
  var lead = { phone: phone, name: '', category: '', city: '', note: [] };
  rest.forEach(function (part) {
    var c = !lead.category && tgCategory_(part, true);
    if (c) { lead.category = c; return; }
    if (!lead.name) { lead.name = part; return; }
    if (!lead.city && /^[a-z .]+$/i.test(part) && part.split(/\s+/).length <= 3) { lead.city = part; return; }
    lead.note.push(part);
  });
  lead.note = lead.note.join(', ');
  return lead;
}

function tgAddLeads_(text, actor) {
  var lines = tgLeadLines_(text);
  if (!lines.length) return 'I did not find a mobile number. Send: name, mobile, category, city, note';
  return tgSaveLeads_(lines.slice(0, TG_MAX_LEADS).map(tgParseLine_).filter(Boolean), actor, lines.length > TG_MAX_LEADS);
}

/** Saves new leads (existing numbers are left as they are). They wait as "New" for the next campaign. */
function tgSaveLeads_(list, actor, cut) {
  var added = [], had = 0, bad = 0, seen = {};
  list.forEach(function (l) {
    if (!l || String(l.phone).length !== 12) { bad++; return; }
    if (seen[l.phone]) return;
    seen[l.phone] = true;
    if (getLead_(l.phone)) { had++; return; }
    var cat = CATEGORIES.indexOf(l.category) >= 0 ? l.category : 'Other';
    var f = { 'Name': l.name || '', 'Business': l.business || '', 'Category': cat, 'Tier': TIER_OF[cat] || 'To confirm',
              'City': l.city || '', 'Requirement': l.note || '', 'Campaign': 'Added on Telegram' };
    if (cat === 'Other') {
      var g = guessCategory_({ 'Name': l.name, 'Business': l.business || l.name, 'Business Type': l.type || '' });
      if (g) { f['Category'] = g.category; f['Tier'] = TIER_OF[g.category] || 'To confirm'; }
    }
    upsertLead_(l.phone, f, actor);
    added.push(f);
  });
  var byCat = {};
  added.forEach(function (f) { byCat[f['Category']] = (byCat[f['Category']] || 0) + 1; });
  var out = ['✅ ' + added.length + ' new lead' + (added.length === 1 ? '' : 's') + ' added' +
             (added.length ? ' (' + Object.keys(byCat).map(function (c) { return c + ' ' + byCat[c]; }).join(', ') + ')' : '') + '.'];
  if (had) out.push(had + ' already in the list, left as they are.');
  if (bad) out.push(bad + ' skipped: the mobile number did not look right.');
  if (cut) out.push('Only the first ' + TG_MAX_LEADS + ' were read. Send the rest in another message or file.');
  if (byCat['Other']) out.push('"Other" ones get sorted by the admin in the app (Learn > Sort leads).');
  if (added.length) out.push('They will get our WhatsApp message in the next campaign. I tell you here when someone is interested.');
  return out.join('\n');
}

// ---- CSV files
function tgFile_(doc, actor) {
  var name = String(doc.file_name || '');
  if (/\.(xlsx?|ods)$/i.test(name)) return 'Please save the Excel sheet as CSV (File > Save as / Download > CSV) and send that file.';
  if (!/\.(csv|txt|tsv)$/i.test(name) && !/csv|text\/plain/.test(String(doc.mime_type || ''))) {
    return 'I can read CSV files only. Or send the leads as text, one per line.';
  }
  if (doc.file_size && doc.file_size > 2000000) return 'This file is too big. Send at most ' + TG_MAX_LEADS + ' leads per file.';
  var f = tgCall_('getFile', { file_id: doc.file_id });
  if (!f.ok || !f.result || !f.result.file_path) return 'Could not open the file. Please send it again.';
  var res = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + tgToken_() + '/' + f.result.file_path, { muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) return 'Could not download the file. Please send it again.';
  var leads = tgParseCsv_(res.getContentText());
  if (!leads.length) return 'I found no mobile numbers in this file. It needs a Phone (or Mobile) column.';
  return tgLocked_(function () { return tgSaveLeads_(leads.slice(0, TG_MAX_LEADS), actor, leads.length > TG_MAX_LEADS); });
}

function tgCsvRows_(text) {
  var s = String(text).replace(/^﻿/, ''), delim = (s.split('\n')[0].match(/\t/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  var rows = [], row = [], cell = '', q = false;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (q) {
      if (ch === '"' && s.charAt(i + 1) === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s.charAt(i + 1) === '\n') i++;
      row.push(cell); cell = '';
      if (row.join('').trim()) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.join('').trim()) rows.push(row);
  return rows;
}

function tgParseCsv_(text) {
  var rows = tgCsvRows_(text);
  if (!rows.length) return [];
  var head = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  function col(re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; }
  var ci = { phone: col(/phone|mobile|contact|number|whatsapp/), name: col(/^(name|contact name|person|owner)/),
             business: col(/business|company|firm|shop/), type: col(/type|category|segment/), city: col(/city|town|district|location/),
             note: col(/note|requirement|remark|need/) };
  if (ci.phone < 0) return rows.map(function (r) { return tgParseLine_(r.join(', ')); }).filter(Boolean);  // no header row
  return rows.slice(1).map(function (r) {
    var p = normPhone_(r[ci.phone]);
    if (!/^91[6-9]\d{9}$/.test(p)) return { phone: p };
    var get = function (k) { return ci[k] >= 0 ? String(r[ci[k]] || '').trim() : ''; };
    return { phone: p, name: get('name') || get('business'), business: get('business'), category: tgCategory_(get('type')),
             type: get('type'), city: get('city'), note: get('note') };
  });
}

// ---- app actions (Settings > Telegram)
var TG_ACTIONS = {
  tgStatus: function () {
    var u = tgUsers_();
    return { connected: !!tgToken_(), bot: secret_('TG_BOT_NAME'),
             users: Object.keys(u).map(function (id) { var x = u[id]; return { id: id, name: x.name, user: x.user, status: x.status,
                                                                                    campaigns: !!x.campaigns, alerts: x.alerts !== false, at: x.at }; }) };
  },
  /** Saves the token from @BotFather and points Telegram at this script (through the relay). */
  tgConnect: function (a) {
    var props = PropertiesService.getScriptProperties();
    var token = String(a.token || '').trim();
    if (token) {
      if (!/^\d+:[\w-]{30,}$/.test(token)) return { error: 'That does not look like a bot token from @BotFather' };
      props.setProperty('TELEGRAM_BOT_TOKEN', token);
    }
    if (!tgToken_()) return { error: 'Paste the bot token first' };
    var me = tgCall_('getMe', {});
    if (!me.ok) return { error: 'Telegram did not accept the token: ' + (me.description || 'unknown error') };
    props.setProperty('TG_BOT_NAME', String(me.result.username || ''));
    var relay = String(setting_('RELAY_URL') || '').replace(/\/+$/, '');
    var exec = '';
    try { exec = ScriptApp.getService().getUrl() || ''; } catch (err) { exec = ''; }
    if (!relay || !exec || !secret_('WEBHOOK_SECRET')) return { error: 'Set up the relay link first (Setup screen), then connect again.' };
    var hook = relay + '/?to=' + encodeURIComponent(exec) + '&key=' + secret_('WEBHOOK_SECRET');
    var r = tgCall_('setWebhook', { url: hook, allowed_updates: ['message', 'edited_message'], drop_pending_updates: true });
    if (!r.ok) return { error: 'Telegram did not take the link: ' + (r.description || 'unknown error') };
    logChange_('', 'app', 'Telegram bot connected: @' + me.result.username);
    return { message: 'Connected. Employees open t.me/' + me.result.username + ' and press Start; then allow them here.',
             bot: me.result.username };
  },
  tgDisconnect: function () {
    tgCall_('deleteWebhook', {});
    var props = PropertiesService.getScriptProperties();
    props.deleteProperty('TELEGRAM_BOT_TOKEN');
    props.deleteProperty('TG_BOT_NAME');
    logChange_('', 'app', 'Telegram bot disconnected');
    return { message: 'Telegram disconnected' };
  },
  tgUser: function (a) {
    var u = tgUsers_(), id = String(a.id || '');
    if (!u[id]) return { error: 'Not found' };
    if (a.remove) { delete u[id]; saveTgUsers_(u); logChange_('', 'app', 'Telegram user removed: ' + id); return TG_ACTIONS.tgStatus(); }
    var was = u[id].status;
    if (a.allow !== undefined) u[id].status = a.allow ? 'allowed' : 'asked';
    if (a.campaigns !== undefined) u[id].campaigns = !!a.campaigns;
    if (a.alerts !== undefined) u[id].alerts = !!a.alerts;
    saveTgUsers_(u);
    logChange_('', 'app', 'Telegram user ' + u[id].name + ': ' + u[id].status + (u[id].campaigns ? ', campaigns' : ''));
    if (was !== 'allowed' && u[id].status === 'allowed') tgSend_(id, 'You are allowed now 🙏\n\n' + TG_GUIDE);
    return TG_ACTIONS.tgStatus();
  }
};
