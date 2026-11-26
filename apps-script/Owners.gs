/**
 * Lead owners: which employee a lead number belongs to.
 *
 * Each employee sends bulk WhatsApp from BlueTick to their own list of numbers. Give the bot each list once:
 *   EMPLOYEE Rajat 98xxxxxxxx          (Rajat's own WhatsApp: where his alerts go)
 *   ASSIGN Rajat 98xxxxxxxx, 97xxxxxxxx, ...   (the numbers Rajat messages)
 * Type these in the app's Chat screen, or send them on WhatsApp from the main salesperson's number.
 * When one of Rajat's numbers writes in, the alerts and reminders for that lead go to Rajat (marked "Rajat's lead").
 * A number that is already in another employee's list stays with the first employee and is reported as a
 * duplicate (DUPLICATES lists them).
 *
 * Code.gs calls into this file from handleInbound_, salesCommand_, teamPhones_, recipientsFor_, label_ and setup().
 */

var OWNER_SHEETS = { employees: 'Employees', owners: 'Lead Owners' };
var EMPLOYEE_COLS = ['Name', 'WhatsApp', 'Added'];
var OWNER_COLS = ['Phone', 'Employee', 'Also In', 'Added', 'Added By'];

var OWNER_HELP = [
  '*Who handles which lead*',
  'EMPLOYEE Rajat 98xxxxxxxx - add an employee and the WhatsApp number their alerts go to',
  'ASSIGN Rajat 98xxxxxxxx, 97xxxxxxxx, ... - the numbers Rajat sends bulk WhatsApp to (paste as many as you like)',
  'EMPLOYEES - everyone, with how many numbers each has',
  'WHO 98xxxxxxxx - whose lead a number is',
  'DUPLICATES - numbers that are in more than one employee\'s list',
  'REMOVE 98xxxxxxxx, ... - take numbers off their employee (to move one: REMOVE it, then ASSIGN it again)'
].join('\n');

/** Called by setup(): makes the Employees and Lead Owners tabs. */
function ownersSetup() {
  growSheet_(OWNER_SHEETS.employees, EMPLOYEE_COLS);
  growSheet_(OWNER_SHEETS.owners, OWNER_COLS);
}

// ===================================================================== data
var employeesCache_ = null, ownerMapCache_ = null;

/** {lowercase name: {name, phone, row}} from the Employees tab. */
function employees_() {
  if (employeesCache_) return employeesCache_;
  var out = {};
  rowsAsObjects_(growSheet_(OWNER_SHEETS.employees, EMPLOYEE_COLS), EMPLOYEE_COLS).forEach(function (r) {
    var name = String(r['Name'] || '').trim();
    if (name) out[name.toLowerCase()] = { name: name, phone: normPhone_(r['WhatsApp']), row: r._row };
  });
  return employeesCache_ = out;
}

function hasName_(list, name) {
  return String(list || '').split(/\s*,\s*/).some(function (x) { return x && x.toLowerCase() === String(name).toLowerCase(); });
}

/** {phone: {employee, also, row}} from the Lead Owners tab. The first row of a number decides who owns it. */
function ownerMap_() {
  if (ownerMapCache_) return ownerMapCache_;
  var out = {};
  rowsAsObjects_(growSheet_(OWNER_SHEETS.owners, OWNER_COLS), OWNER_COLS).forEach(function (r) {
    var p = normPhone_(r['Phone']), emp = String(r['Employee'] || '').trim();
    if (!p || !emp) return;
    var o = out[p];
    if (!o) out[p] = { employee: emp, also: String(r['Also In'] || '').trim(), row: r._row };
    else if (emp.toLowerCase() !== o.employee.toLowerCase() && !hasName_(o.also, emp)) o.also = o.also ? o.also + ', ' + emp : emp;
  });
  return ownerMapCache_ = out;
}

/** The employee whose list has this number: {name, phone, also}, or null. */
function ownerOf_(phone) {
  var o = ownerMap_()[normPhone_(phone)];
  if (!o) return null;
  var e = employees_()[o.employee.toLowerCase()] || {};
  return { name: e.name || o.employee, phone: e.phone || '', also: o.also };
}

/** Employees' WhatsApp numbers: they count as team (their messages are commands, never leads). */
function ownerPhones_() {
  var e = employees_();
  return Object.keys(e).map(function (k) { return e[k].phone; }).filter(function (p) { return MOBILE_RE.test(p); });
}

/** A number written with its own country code from outside India ("+234 801 234 5678", "00254..."): digits, or '' if not one. */
function intlPhone_(s) {
  var t = String(s || '').trim();
  if (!/^(\+|00)/.test(t)) return '';
  var d = t.replace(/\D/g, '');
  if (t.charAt(0) !== '+') d = d.slice(2);
  if (d.indexOf('91') === 0) return '';  // India is handled by MOBILE_RE, so a bad +91 number stays rejected
  return d.length >= 9 && d.length <= 15 ? d : '';
}

/** Mobile numbers in pasted text: commas, new lines or spaces between them; "+91 98123 45678" is one number.
 *  Indian mobiles (91 + 10 digits) and numbers with another country code (Africa, etc.) are accepted. */
function phonesIn_(text) {
  var phones = [], bad = [];
  String(text || '').split(/[,;\n|\/]+/).forEach(function (piece) {
    piece = piece.trim();
    if (!piece) return;
    var whole = normPhone_(piece);
    if (MOBILE_RE.test(whole)) { phones.push(whole); return; }
    var intl = intlPhone_(piece);
    if (intl) { phones.push(intl); return; }
    piece.split(/\s+/).forEach(function (w) {
      if (!/\d/.test(w)) return;
      var p = normPhone_(w);
      if (MOBILE_RE.test(p)) phones.push(p);
      else if (intlPhone_(w)) phones.push(intlPhone_(w));
      else bad.push(w);
    });
  });
  return { phones: phones, bad: bad };
}

// ===================================================================== commands (app Chat and WhatsApp)
/** Answer to an owner command, or '' when the text is not one. Called first by salesCommand_. */
function ownerCommand_(text, from) {
  var t = String(text || '').trim(), first = t.split(/\s+/)[0] || '';
  var word = first.toUpperCase().replace(/[:.]+$/, '');
  if (['ASSIGN', 'EMPLOYEE', 'EMPLOYEES', 'WHO', 'DUPLICATES', 'REMOVE'].indexOf(word) < 0) return '';
  var rest = t.slice(first.length).trim();
  if (word !== 'WHO' && from && !canPlan_(from)) return 'Only the main salesperson can change who handles which leads.';
  employeesCache_ = null; ownerMapCache_ = null;  // someone may have edited the tabs by hand
  var at = rest.search(/[+\d]/);
  var name = (at < 0 ? rest : rest.slice(0, at)).replace(/[\s:,\-]+$/, '').trim();
  if (word === 'ASSIGN') {
    if (!name || at < 0) return 'Write it like: ASSIGN Rajat 98xxxxxxxx, 97xxxxxxxx\n\n' + OWNER_HELP;
    return assignNumbers_(name, rest.slice(at), from || 'app');
  }
  if (word === 'EMPLOYEE' || word === 'EMPLOYEES') {
    if (!rest) return employeesReport_();
    var phone = at < 0 ? '' : normPhone_(rest.slice(at));
    if (!name || !MOBILE_RE.test(phone)) return 'Write it like: EMPLOYEE Rajat 98xxxxxxxx\n\n' + OWNER_HELP;
    return saveEmployee_(name, phone);
  }
  if (word === 'WHO') return whoReport_(rest);
  if (word === 'DUPLICATES') return duplicatesReport_();
  return removeNumbers_(rest);
}

function saveEmployee_(name, phone) {
  var sh = growSheet_(OWNER_SHEETS.employees, EMPLOYEE_COLS), emps = employees_(), key = name.toLowerCase();
  var taken = Object.keys(emps).filter(function (k) { return k !== key && emps[k].phone === phone; })[0];
  if (taken) return '+' + phone + ' is already saved for ' + emps[taken].name + '.';
  if (emps[key]) {
    sh.getRange(emps[key].row, 2).setNumberFormat('@').setValue(phone);
  } else {
    sh.appendRow([name, '', new Date()]);
    sh.getRange(sh.getLastRow(), 2).setNumberFormat('@').setValue(phone);
  }
  employeesCache_ = null;
  logChange_('', 'owners', 'Employee ' + name + ' -> +' + phone);
  return '✅ ' + name + ' saved. When one of ' + name + '\'s numbers replies, the alert goes to +' + phone + '.\n' +
         'Ask ' + name + ' to send "hi" once to the business WhatsApp number, so the bot can message them freely.\n' +
         'Next: ASSIGN ' + name + ' 98xxxxxxxx, 97xxxxxxxx, ...';
}

function assignNumbers_(name, numbersText, actor) {
  var parsed = phonesIn_(numbersText);
  if (!parsed.phones.length) return 'No mobile numbers found. Write it like: ASSIGN ' + name + ' 98xxxxxxxx, 97xxxxxxxx';
  var emp = employees_()[name.toLowerCase()], who = emp ? emp.name : name;
  var sh = growSheet_(OWNER_SHEETS.owners, OWNER_COLS), map = ownerMap_(), now = new Date();
  var seen = {}, rows = [], mine = 0, repeat = 0, clash = {}, clashN = 0;
  parsed.phones.forEach(function (p) {
    if (seen[p]) { repeat++; return; }
    seen[p] = true;
    var o = map[p];
    if (!o) { rows.push([p, who, '', now, actor]); return; }
    if (o.employee.toLowerCase() === who.toLowerCase()) { mine++; return; }
    clashN++;
    (clash[o.employee] = clash[o.employee] || []).push(p);
    if (!hasName_(o.also, who)) {  // remember that this employee has the number too
      o.also = o.also ? o.also + ', ' + who : who;
      sh.getRange(o.row, 3).setValue(o.also);
    }
  });
  if (rows.length) {
    var start = sh.getLastRow() + 1;
    sh.getRange(start, 1, rows.length, 1).setNumberFormat('@');
    sh.getRange(start, 1, rows.length, OWNER_COLS.length).setValues(rows);
  }
  ownerMapCache_ = null;
  logChange_('', 'owners', 'Assigned ' + rows.length + ' numbers to ' + who + (clashN ? ', ' + clashN + ' duplicates' : ''));
  var out = ['✅ ' + who + ': ' + rows.length + ' new number' + (rows.length === 1 ? '' : 's') + ' added.'];
  if (mine) out.push(mine + ' were already ' + who + '\'s.');
  if (repeat) out.push(repeat + ' were repeated in your list (counted once).');
  if (clashN) {
    out.push('\n⚠️ *' + clashN + ' duplicate' + (clashN === 1 ? '' : 's') + '*: already in another employee\'s list, so they stay with them:');
    Object.keys(clash).forEach(function (e) {
      out.push('• ' + e + ': ' + clash[e].slice(0, 15).map(function (p) { return p.slice(-10); }).join(', ') +
               (clash[e].length > 15 ? ' …and ' + (clash[e].length - 15) + ' more' : ''));
    });
  }
  if (parsed.bad.length) out.push('\nSkipped, not mobile numbers: ' + parsed.bad.slice(0, 10).join(', ') + (parsed.bad.length > 10 ? ' …' : ''));
  if (!emp || !emp.phone) out.push('\nℹ️ ' + who + '\'s WhatsApp is not saved, so their alerts go to the main salesperson. Add it: EMPLOYEE ' + who + ' 98xxxxxxxx');
  return out.join('\n');
}

function employeesReport_() {
  var emps = employees_(), map = ownerMap_(), count = {}, orphan = {}, dup = 0;
  Object.keys(map).forEach(function (p) {
    var k = map[p].employee.toLowerCase();
    count[k] = (count[k] || 0) + 1;
    if (map[p].also) dup++;
    if (!emps[k]) orphan[k] = map[p].employee;
  });
  if (!Object.keys(emps).length && !Object.keys(orphan).length) return 'No employees yet.\n\n' + OWNER_HELP;
  var lines = ['*Employees*'];
  Object.keys(emps).forEach(function (k) {
    lines.push('• ' + emps[k].name + ' (' + (emps[k].phone ? '+' + emps[k].phone : 'no WhatsApp saved') + '): ' + (count[k] || 0) + ' numbers');
  });
  Object.keys(orphan).forEach(function (k) {
    lines.push('• ' + orphan[k] + ' (not saved as an employee, alerts go to the main salesperson): ' + count[k] + ' numbers');
  });
  if (dup) lines.push('\n⚠️ ' + dup + ' numbers are in more than one list. Send DUPLICATES to see them.');
  return lines.join('\n');
}

function whoReport_(text) {
  var ps = phonesIn_(text).phones;
  if (!ps.length) return 'Write it like: WHO 98xxxxxxxx';
  return ps.slice(0, 10).map(function (p) {
    var o = ownerOf_(p), lead = getLead_(p);
    return '+' + p + ': ' + (o ? o.name + '\'s lead' + (o.also ? ' (also in ' + o.also + '\'s list)' : '') : 'not in any employee\'s list') +
           (lead ? ' · status ' + (lead['Status'] || '-') : ' · not in the lead list yet');
  }).join('\n');
}

function duplicatesReport_() {
  var map = ownerMap_(), dups = Object.keys(map).filter(function (p) { return map[p].also; });
  if (!dups.length) return '✅ No number is in two employees\' lists.';
  return '⚠️ *' + dups.length + ' numbers are in more than one list*\nThe first employee keeps the lead; the others are in brackets.\n' +
         dups.slice(0, 40).map(function (p) { return '• ' + p.slice(-10) + ' - ' + map[p].employee + ' (also ' + map[p].also + ')'; }).join('\n') +
         (dups.length > 40 ? '\n…and ' + (dups.length - 40) + ' more (Lead Owners tab, column "Also In").' : '') +
         '\nTo give one to someone else: REMOVE the number, then ASSIGN it again.';
}

function removeNumbers_(text) {
  var ps = phonesIn_(text).phones;
  if (!ps.length) return 'Write it like: REMOVE 98xxxxxxxx, 97xxxxxxxx';
  var sh = growSheet_(OWNER_SHEETS.owners, OWNER_COLS), want = {}, found = {}, rows = [];
  ps.forEach(function (p) { want[p] = true; });
  rowsAsObjects_(sh, OWNER_COLS).forEach(function (r) {
    var p = normPhone_(r['Phone']);
    if (want[p]) { rows.push(r._row); found[p] = true; }
  });
  rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
  ownerMapCache_ = null;
  var n = Object.keys(found).length;
  if (n) logChange_('', 'owners', 'Removed ' + n + ' numbers from their employee');
  return n ? '🗑 ' + n + ' number' + (n === 1 ? '' : 's') + ' removed from their employee\'s list.' + (n < ps.length ? ' ' + (ps.length - n) + ' were not in any list.' : '')
           : 'None of these numbers is in an employee\'s list.';
}

// ===================================================================== app screen (Settings > Employees and their leads)
function ownersOverview_() {
  ownerMapCache_ = null; employeesCache_ = null;
  var emps = employees_(), map = ownerMap_(), count = {}, dup = {}, names = {};
  Object.keys(emps).forEach(function (k) { names[k] = emps[k].name; });
  Object.keys(map).forEach(function (p) {
    var k = map[p].employee.toLowerCase();
    count[k] = (count[k] || 0) + 1;
    if (map[p].also) dup[k] = (dup[k] || 0) + 1;
    if (!names[k]) names[k] = map[p].employee;
  });
  return Object.keys(names).map(function (k) {
    return { name: names[k], phone: emps[k] ? emps[k].phone : '', numbers: count[k] || 0, duplicates: dup[k] || 0 };
  });
}

// ===================================================================== replies by employee (report)
/** Wording of a business auto-responder or away message (the customer's WhatsApp Business app writing, not a person). */
var AUTO_REPLY_RE = new RegExp([
  'thank(s| you) for (contacting|reaching|messaging|your message|writing|getting in touch)',
  'we(\'ll| will) (get back|respond|reply|revert)', 'get back to you (shortly|soon|as soon)', 'will (respond|reply|revert) (shortly|soon)',
  'auto[- ]?(reply|response|responder)', 'automated (message|reply|response)', 'this is an automat',
  '(working|business|office) hours', 'currently (unavailable|away|closed|not available)', 'we are (currently )?(away|closed|unavailable)',
  'out of (the )?office', 'संपर्क करने के लिए धन्यवाद'
].join('|'), 'i');

function replyKey_(text) { return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 160); }

/** What the customer wrote is "auto" (a likely auto-reply) or "real". Same long text from 3+ different numbers counts as auto too. */
function replyKind_(text, sameFrom) {
  if (AUTO_REPLY_RE.test(String(text || ''))) return 'auto';
  return sameFrom >= 3 ? 'auto' : 'real';
}

/** Per employee: leads, messages sent, real customer replies, likely auto-replies, our bot's replies; plus the messages of one kind. */
function repliesReport_(a) {
  var days = Number(a.days) || 0, wantEmp = String(a.employee || '').toLowerCase().trim(), kind = a.kind === 'auto' ? 'auto' : 'real';
  var since = days ? new Date(Date.now() - days * 86400000) : null;
  var owners = ownerMap_(), leads = allLeadsCached_(), byPhone = {};
  var ownerName = function (phone) { var o = owners[normPhone_(phone)]; return o ? o.employee : 'Unassigned'; };
  var stats = {};
  var stat = function (name) {
    return stats[name] || (stats[name] = { name: name, leads: 0, hot: 0, optedOut: 0, sent: 0, real: 0, auto: 0, bot: 0, repliedLeads: {} });
  };
  Object.keys(employees_()).forEach(function (k) { stat(employees_()[k].name); });
  leads.forEach(function (l) {
    byPhone[String(l['Phone'])] = l;
    var s = stat(ownerName(l['Phone']));
    s.leads++;
    if (l['Status'] === 'Hot') s.hot++;
    if (l['Status'] === 'Opted out') s.optedOut++;
  });

  var sh = sheet_(SHEETS.messages), last = sh.getLastRow();
  var rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, 5).getValues();   // Time, Phone, Direction, Sender, Body
  var sameFrom = {};   // text -> how many different numbers sent it
  rows.forEach(function (r) {
    if (r[2] !== 'in' || r[3] !== 'lead') return;
    var k = replyKey_(r[4]);
    if (k.length < 20) return;
    var seen = sameFrom[k] || (sameFrom[k] = { n: 0, by: {} });
    if (!seen.by[r[1]]) { seen.by[r[1]] = 1; seen.n++; }
  });

  var listed = [];
  rows.forEach(function (r) {
    var when = asDate_(r[0]);
    if (since && (!when || when < since)) return;
    var phone = String(r[1]), s = stat(ownerName(phone));
    if (r[2] === 'out') {
      if (r[3] === 'campaign') s.sent++;
      else if (r[3] === 'bot') s.bot++;
      return;
    }
    if (r[2] !== 'in' || r[3] !== 'lead') return;
    var k = replyKey_(r[4]), what = replyKind_(r[4], k.length >= 20 && sameFrom[k] ? sameFrom[k].n : 0);
    if (what === 'auto') s.auto++; else { s.real++; s.repliedLeads[phone] = 1; }
    if (what === kind && (!wantEmp || s.name.toLowerCase() === wantEmp)) listed.push({ r: r, when: when, name: s.name });
  });

  var employees = Object.keys(stats).map(function (k) {
    var s = stats[k];
    return { name: s.name, leads: s.leads, hot: s.hot, optedOut: s.optedOut, sent: s.sent, real: s.real, auto: s.auto, bot: s.bot,
             repliedLeads: Object.keys(s.repliedLeads).length };
  }).filter(function (s) { return s.name !== 'Unassigned' || s.leads || s.real || s.auto || s.sent || s.bot; })
    .sort(function (x, y) { return y.real - x.real || y.leads - x.leads || x.name.localeCompare(y.name); });
  var total = { name: 'All', leads: 0, hot: 0, optedOut: 0, sent: 0, real: 0, auto: 0, bot: 0, repliedLeads: 0 };
  employees.forEach(function (e) { Object.keys(total).forEach(function (k) { if (k !== 'name') total[k] += e[k]; }); });

  listed.sort(function (x, y) { return (y.when || 0) - (x.when || 0); });
  var messages = listed.slice(0, 60).map(function (x) {
    var l = byPhone[String(x.r[1])] || {};
    return { phone: String(x.r[1]), name: l['Name'] || l['Business'] || 'Lead', employee: x.name, time: iso_(x.when), text: String(x.r[4]).slice(0, 300) };
  });
  return { days: days, kind: kind, employees: employees, total: total, count: listed.length, messages: messages };
}

var OWNER_ACTIONS = {
  repliesReport: function (a) { return repliesReport_(a || {}); },
  ownersStatus: function () { return { employees: ownersOverview_() }; },
  /** Saves an employee (name + their own WhatsApp) and adds the pasted numbers to their list, in any format. */
  ownersSave: function (a) {
    ownerMapCache_ = null; employeesCache_ = null;
    var name = String(a.name || '').replace(/[\s,:]+$/, '').trim(), phone = String(a.phone || '').trim();
    if (!name || /[\d+]/.test(name)) return { error: 'Type the employee name (letters only)' };
    var out = [];
    if (phone) {
      var p = normPhone_(phone);
      if (!MOBILE_RE.test(p)) return { error: 'The employee WhatsApp number does not look right' };
      var say = saveEmployee_(name, p);
      if (say.charAt(0) !== '✅') return { error: say };
      out.push(say.split('\n')[0]);
    }
    if (String(a.numbers || '').trim()) out.push(assignNumbers_(name, String(a.numbers), 'app'));
    else if (!phone) return { error: 'Paste the numbers, or add the employee WhatsApp number' };
    return { message: out.join('\n\n'), employees: ownersOverview_() };
  },
  ownersRemove: function (a) {
    ownerMapCache_ = null; employeesCache_ = null;
    return { message: removeNumbers_(String(a.numbers || '')), employees: ownersOverview_() };
  }
};

// ===================================================================== incoming customer messages
/** Called by handleInbound_ for every customer message: the lead's "Assigned To" becomes its owner's name. Alerts then
 *  reach the owner through recipientsFor_. Returns the (possibly updated) lead. */
function ownerAssign_(lead) {
  var owner = ownerOf_(String(lead['Phone'] || ''));
  if (!owner || lead['Assigned To'] === owner.name) return lead;
  return upsertLead_(String(lead['Phone']), { 'Assigned To': owner.name }, 'owners');
}
