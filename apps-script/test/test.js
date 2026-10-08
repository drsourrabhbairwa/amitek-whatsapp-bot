// Offline tests for Code.gs. Run: node apps-script/test/test.js
const assert = require('assert');
const { load } = require('./harness');

const BUSINESS = '910000000001';
const SALES = '919800000001';
const CUST = '919811112222';
const SECRET = 'testsecret';
const BASE = { props: { WEBHOOK_SECRET: SECRET, ANTHROPIC_API_KEY: 'k', WA_ACCESS_TOKEN: 't', WA_PHONE_NUMBER_ID: 'phone-id-test', APP_PIN: '123456' },
               settings: { SEND_ENABLED: 'true', SALES_WHATSAPP: SALES } };

let n = 0;
function payload(msgs, contacts) {
  return { entry: [{ id: 'waba-test', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: BUSINESS, phone_number_id: 'phone-id-test' },
    contacts: contacts || [], messages: msgs } }] }] };
}
function text(from, body, extra) {
  return Object.assign({ from, id: 'wamid.in' + (++n), timestamp: '1', type: 'text', text: { body } }, extra || {});
}
function post(env, body, key = SECRET) {
  return env.ctx.doPost({ parameter: { key }, postData: { contents: JSON.stringify(body) } });
}
const say = t => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const tool = (name, input, id = 'tu1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
function lead(env, phone) {
  const sh = env.sheets['Leads']; const h = sh.rows[0];
  const r = sh.rows.find(x => String(x[0]) === phone);
  if (!r) return null; const o = {}; h.forEach((c, i) => { o[c] = r[i]; }); return o;
}
const upsert = (env, phone, f) => env.ctx.upsertLead_(phone, f || {}, 'test');
const texts = env => env.sent.filter(s => s.body.type === 'text').map(s => ({ to: s.body.to, text: s.body.text.body }));

const tests = {
  'setup creates tabs, settings, secret and triggers'() {
    const env = load({ props: {} });
    ['Leads', 'Messages', 'Log', 'Knowledge', 'Settings', 'Board', 'Webhook Log'].forEach(t => assert(env.sheets[t], t));
    assert(env.props.WEBHOOK_SECRET && env.props.WEBHOOK_SECRET.length > 8);
    assert.deepStrictEqual(env.triggers.map(t => t.getHandlerFunction()).sort(), ['dailySummary', 'hourlyCheck']);
    env.ctx.setup();  // re-running does not duplicate triggers or settings
    assert.strictEqual(env.triggers.length, 2);
    assert.strictEqual(env.sheets['Settings'].rows.filter(r => r[0] === 'BOT_MODE').length, 1);
  },
  'wrong webhook key does nothing'() {
    const env = load(BASE);
    post(env, payload([text(CUST, 'hi')]), 'wrong');
    assert.strictEqual(env.sheets['Messages'].rows.length, 1);
    assert.strictEqual(env.sent.length, 0);
  },
  'new customer gets a gentle reply and a lead row'() {
    const env = load(Object.assign({}, BASE, { claude: [
      tool('update_lead', { category: 'Applicator', city: 'Jaipur', language: 'Hinglish' }), say('Namaste ji 🙏 Kaunsa kaam hai?')] }));
    post(env, payload([text(CUST, 'Namaste, main applicator hoon Jaipur se')], [{ wa_id: CUST, profile: { name: 'Ramesh' } }]));
    const l = lead(env, CUST);
    assert.strictEqual(l.Name, 'Ramesh'); assert.strictEqual(l.Category, 'Applicator'); assert.strictEqual(l.City, 'Jaipur');
    assert.strictEqual(l.Status, 'Replied'); assert.strictEqual(l['Opt-in'], 'Opted in');
    assert.deepStrictEqual(texts(env), [{ to: CUST, text: 'Namaste ji 🙏 Kaunsa kaam hai?' }]);
    // the system prompt is gentle and the request shape is right
    const c = env.claudeCalls[0];
    assert(c.body.system[0].text.includes('phase 1'));
    assert.strictEqual(c.body.model, 'claude-sonnet-5-5');
    assert.strictEqual(c.headers['anthropic-version'], '2023-06-01');
    assert(c.body.messages[0].content.includes('<lead_record>'));
    // tool result went back in the second call
    assert.strictEqual(env.claudeCalls[1].body.messages[2].content[0].type, 'tool_result');
    // a read receipt went out
    assert(env.sent.some(s => s.body.status === 'read'));
    // messages are logged both ways
    assert.deepStrictEqual(env.sheets['Messages'].rows.slice(1).map(r => r[2]), ['in', 'out']);
  },
  'duplicate delivery is ignored'() {
    const env = load(Object.assign({}, BASE, { claude: [say('Ji 🙏')] }));
    const m = text(CUST, 'hello');
    post(env, payload([m])); post(env, payload([m]));
    assert.strictEqual(texts(env).length, 1);
  },
  'imported lead keeps its data and campaign'() {
    const env = load(Object.assign({}, BASE, { claude: [say('Ji 🙏')] }));
    const sh = env.sheets['Leads']; const row = sh.rows[0].map(() => '');
    row[0] = 919811112222; row[1] = 'AMT-0001'; row[3] = 'Shree Waterproofing'; row[4] = 'Applicator'; row[9] = 'New'; row[15] = 'C1';
    sh.rows.push(row);
    post(env, payload([text(CUST, 'Interested')]));
    const l = lead(env, CUST);
    assert.strictEqual(l['Lead ID'], 'AMT-0001'); assert.strictEqual(l.Campaign, 'C1'); assert.strictEqual(l.Status, 'Replied');
    assert.strictEqual(sh.rows.length, 2, 'no duplicate row');
    assert(env.claudeCalls[0].body.messages[0].content.includes('Shree Waterproofing'));
  },
  'handoff marks hot, alerts the salesperson and sets SLA follow-up'() {
    const env = load(Object.assign({}, BASE, { claude: [
      tool('handoff_to_sales', { reason: 'Asked for price', summary: 'Applicator, Jaipur, 2000 sqft terrace', priority: 'hot' }),
      say('Ji, hamari team aapko jaldi call karegi 🙏')] }));
    post(env, payload([text(CUST, 'rate kya hai 2000 sqft terrace ka')]));
    const l = lead(env, CUST);
    assert.strictEqual(l.Status, 'Hot'); assert(l['Handoff At'] instanceof Date); assert.strictEqual(l['Assigned To'], 'Sales team');
    const t = texts(env);
    assert.strictEqual(t.length, 2);
    assert.strictEqual(t[1].to, SALES); assert(t[1].text.includes('HOT LEAD')); assert(t[1].text.includes('DONE 9811112222'));
    assert(env.sheets['Log'].rows.some(r => String(r[3]).includes('Status: Replied -> Hot')));
  },
  'STOP opts out without AI and further messages are ignored; START brings back'() {
    const env = load(BASE);
    post(env, payload([text(CUST, 'STOP')]));
    assert.strictEqual(lead(env, CUST)['Opt-in'], 'Opted out');
    assert.strictEqual(env.claudeCalls.length, 0);
    assert(texts(env)[0].text.startsWith('Theek hai ji'));
    post(env, payload([text(CUST, 'hello?')]));
    assert.strictEqual(texts(env).length, 1);
    post(env, payload([text(CUST, 'start')]));
    assert.strictEqual(lead(env, CUST)['Opt-in'], 'Opted in');
    assert.strictEqual(texts(env).length, 2);
  },
  'Call me button is a hot handoff without AI'() {
    const env = load(BASE);
    post(env, payload([{ from: CUST, id: 'wamid.btn1', type: 'button', button: { text: 'Call me', payload: 'x' } }]));
    assert.strictEqual(lead(env, CUST).Status, 'Hot');
    assert.strictEqual(env.claudeCalls.length, 0);
    assert.strictEqual(texts(env).length, 2);
  },
  'human reply from the business phone pauses the bot'() {
    const env = load(Object.assign({}, BASE, { claude: [say('Ji 🙏')] }));
    post(env, payload([text(CUST, 'hi')]));
    post(env, payload([{ from: BUSINESS, to: CUST, id: 'wamid.human1', type: 'text', text: { body: 'Main Sunil, Amitek se' } }]));
    let l = lead(env, CUST);
    assert(l['Bot Paused Until'] > new Date()); assert(l['Last Human Contact'] instanceof Date);
    post(env, payload([text(CUST, 'ok Sunil ji')]));
    assert.strictEqual(env.claudeCalls.length, 1, 'bot stays quiet while paused');
    assert.strictEqual(texts(env).length, 1);
  },
  "echo of the bot's own reply does not pause it"() {
    const env = load(Object.assign({}, BASE, { claude: [say('Ji 🙏'), say('Zaroor')] }));
    post(env, payload([text(CUST, 'hi')]));
    post(env, payload([{ from: BUSINESS, to: CUST, id: 'wamid.other', type: 'text', text: { body: 'Ji 🙏' } }]));
    post(env, payload([{ from: BUSINESS, to: CUST, id: 'wamid.out2', type: 'text', text: { body: 'Ji 🙏' } }]));
    assert(!lead(env, CUST)['Bot Paused Until']);
    post(env, payload([text(CUST, 'aur?')]));
    assert.strictEqual(env.claudeCalls.length, 2);
  },
  'dry run writes replies but sends nothing'() {
    const env = load(Object.assign({}, BASE, { settings: { SEND_ENABLED: 'false', SALES_WHATSAPP: SALES }, claude: [say('Ji 🙏')] }));
    post(env, payload([text(CUST, 'hi')]));
    assert.strictEqual(env.sent.length, 0);
    assert.strictEqual(env.sheets['Messages'].rows[2][4], 'Ji 🙏');
  },
  'Claude error hands off to a human instead of going silent'() {
    const env = load(Object.assign({}, BASE, { claude: [{ http: 529 }] }));
    post(env, payload([text(CUST, 'hi')]));
    assert.strictEqual(lead(env, CUST).Status, 'Qualified');
    assert(texts(env).some(t => t.to === SALES));
  },
  'follow_up_in_days sets the next follow-up date'() {
    const env = load(Object.assign({}, BASE, { claude: [tool('update_lead', { follow_up_in_days: 7 }), say('Theek hai ji 🙏')] }));
    post(env, payload([text(CUST, 'next week baat karte hain')]));
    const d = lead(env, CUST)['Next Follow-up'];
    assert(Math.abs(d - Date.now() - 7 * 86400000) < 60000);
  },
  'hourly check: unanswered, hot SLA, follow-up due, quiet leads'() {
    const env = load(BASE);
    const sh = env.sheets['Leads']; const H = sh.rows[0];
    const mk = (phone, o) => { const r = H.map(c => (c in o ? o[c] : '')); r[0] = phone; sh.rows.push(r); };
    const ago = h => new Date(Date.now() - h * 3600000);
    mk('919800000011', { Status: 'Replied', 'Last Inbound': ago(1) });
    mk('919800000012', { Status: 'Hot', 'Handoff At': ago(3), 'Last Inbound': ago(3), 'Last Outbound': ago(3), 'SLA Alerts': 0 });
    mk('919800000013', { Status: 'Contacted', 'Next Follow-up': ago(1), 'Follow-up Note': 'call back' });
    mk('919800000014', { Status: 'Replied', 'Last Inbound': ago(100), 'Last Outbound': ago(99) });
    mk('919800000015', { Status: 'New' });
    const r = env.ctx.hourlyCheck();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { unanswered: 1, hot_overdue: 1, follow_ups_due: 1 });
    assert(lead(env, '919800000014')['Next Follow-up'] instanceof Date, 'quiet lead got a follow-up date');
    const alert = texts(env).find(t => t.to === SALES).text;
    assert(alert.includes('Waiting for a reply') && alert.includes('Hot leads') && alert.includes('call back'));
    // second run does not repeat the same alerts
    const r2 = env.ctx.hourlyCheck();
    assert.strictEqual(r2.unanswered + r2.hot_overdue, 0);
    // Board lists engaged leads, hot first
    assert.strictEqual(env.sheets['Board'].rows[1][0], 'Hot');
    assert(!env.sheets['Board'].rows.some(r => r[2] === '+919800000015'));
  },
  'salesperson commands'() {
    const env = load(Object.assign({}, BASE, { claude: [
      tool('handoff_to_sales', { reason: 'r', summary: 's', priority: 'hot' }), say('Ji 🙏')] }));
    post(env, payload([text(CUST, 'price?')]));
    post(env, payload([text(SALES, 'DONE 9811112222 called, sending catalog')]));
    let l = lead(env, CUST);
    assert.strictEqual(l.Status, 'Contacted'); assert.strictEqual(l['Follow-up Note'], 'called, sending catalog');
    assert(texts(env).pop().text.startsWith('✅'));
    post(env, payload([text(SALES, 'LATER 9811112222 5 site visit')]));
    l = lead(env, CUST);
    assert(Math.abs(l['Next Follow-up'] - Date.now() - 5 * 86400000) < 60000); assert.strictEqual(l['Follow-up Note'], 'site visit');
    post(env, payload([text(SALES, 'WON 9811112222 50 buckets')]));
    assert.strictEqual(lead(env, CUST).Status, 'Won');
    post(env, payload([text(SALES, 'LIST')]));
    assert(texts(env).pop().text.includes('Amitek leads'));
    post(env, payload([text(SALES, 'DONE 9999999999')]));
    assert(texts(env).pop().text.startsWith('No lead found'));
    post(env, payload([text(SALES, 'hello')]));
    assert(texts(env).pop().text.includes('Command not understood'));
    assert.strictEqual(env.claudeCalls.length, 2, 'salesperson messages never go to the AI');
    assert(!lead(env, SALES), 'salesperson is not a lead');
  },
  'alert echoes to the salesperson are ignored'() {
    const env = load(BASE);
    post(env, payload([{ from: BUSINESS, to: SALES, id: 'wamid.alert', type: 'text', text: { body: 'HOT LEAD' } }]));
    assert(!lead(env, SALES));
  },
  'media and interactive messages become readable text'() {
    const env = load(BASE);
    const p = env.ctx.parseWebhook_(payload([
      { from: CUST, id: 'a', type: 'image', image: { caption: 'leak photo' } },
      { from: CUST, id: 'b', type: 'interactive', interactive: { type: 'button_reply', button_reply: { title: 'Yes' } } }]));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.inbound.map(m => m.text))), ['[sent a image] leak photo', 'Yes']);
  },
  'payload wrapped by the provider is still found'() {
    const env = load(BASE);
    const p = env.ctx.parseWebhook_({ data: payload([text(CUST, 'hi')]) });
    assert.strictEqual(p.inbound.length, 1);
  },
  'sales mode uses the sales head prompt'() {
    const env = load(Object.assign({}, BASE, { settings: { SEND_ENABLED: 'true', SALES_WHATSAPP: SALES, BOT_MODE: 'sales' }, claude: [say('Ji')] }));
    post(env, payload([text(CUST, 'hi')]));
    assert(env.claudeCalls[0].body.system[0].text.includes('senior sales head'));
  }
  ,
  'app: first connection chooses the PIN and installs; then PIN required, wrong PINs lock out'() {
    const fresh = load({ props: {} });
    fresh.triggers.splice(0);  // as if setup() never ran
    assert.strictEqual(JSON.parse(fresh.ctx.api('', 'dashboard', '{}')).error, 'NOPIN');
    assert(JSON.parse(fresh.ctx.api('', 'claim', '{"newPin":"12"}')).error.includes('4 to 8'));
    assert.strictEqual(JSON.parse(fresh.ctx.api('', 'claim', '{"newPin":"4321"}')).message, 'Connected');
    assert.strictEqual(fresh.props.APP_PIN, '4321');
    assert.strictEqual(fresh.triggers.length, 2, 'claim installed the timers');
    assert.strictEqual(JSON.parse(fresh.ctx.api('9999', 'claim', '{"newPin":"9999"}')).error, 'PIN', 'cannot re-claim');
    const env = load(BASE);
    assert.strictEqual(JSON.parse(env.ctx.api('nope', 'dashboard', '{}')).error, 'PIN');
    for (let i = 0; i < 10; i++) env.ctx.api('nope', 'dashboard', '{}');
    assert(JSON.parse(env.ctx.api(env.props.APP_PIN, 'dashboard', '{}')).error.includes('Too many'));
  },
  'app: dashboard, search, lead detail, actions, reply, settings'() {
    const env = load(Object.assign({}, BASE, { claude: [
      tool('handoff_to_sales', { reason: 'price', summary: 'Applicator Jaipur 2000 sqft', priority: 'hot' }), say('Ji 🙏 team call karegi')] }));
    const api = (a, x) => JSON.parse(env.ctx.api(env.props.APP_PIN, a, JSON.stringify(x || {})));
    post(env, payload([text(CUST, 'rate batao')], [{ wa_id: CUST, profile: { name: 'Ramesh' } }]));
    let d = api('dashboard');
    assert.strictEqual(d.counts.hot, 1); assert.strictEqual(d.hot[0].name, 'Ramesh'); assert.strictEqual(d.bot.sendEnabled, true);
    assert.strictEqual(api('search', { q: '1111' }).total, 1);
    assert.strictEqual(api('search', { q: 'ramesh' }).leads[0].phone, CUST);
    assert.strictEqual(api('search', { status: 'Won' }).total, 0);
    let l = api('lead', { phone: '9811112222' });
    assert.strictEqual(l.messages.length, 2); assert(l.messages[0].time); assert.strictEqual(l.canReply, true);
    assert(l.log.some(x => x.change.includes('Hot')));
    assert(l.lead['Handoff At'].endsWith('Z'));
    // team reply from the app: sent, recorded, bot paused, echo ignored
    const before = env.sent.length;
    assert.strictEqual(api('reply', { phone: CUST, text: 'Namaste, main Sunil' }).message, 'Sent');
    assert.strictEqual(env.sent.length, before + 1);
    l = api('lead', { phone: CUST });
    assert.strictEqual(l.messages[2].sender, 'human'); assert.strictEqual(l.botPaused, true);
    const id = env.sent[env.sent.length - 1].body.to && env.sheets['Messages'].rows.slice(-1)[0][5];
    post(env, payload([{ from: BUSINESS, to: CUST, id, type: 'text', text: { body: 'Namaste, main Sunil' } }]));
    assert.strictEqual(api('lead', { phone: CUST }).messages.length, 3, 'echo not duplicated');
    // actions
    assert(api('act', { phone: CUST, cmd: 'DONE', note: 'spoke' }).message.startsWith('✅'));
    assert.strictEqual(api('lead', { phone: CUST }).lead.Status, 'Contacted');
    api('act', { phone: CUST, cmd: 'LATER', days: 7, note: 'site visit' });
    assert(Math.abs(new Date(api('lead', { phone: CUST }).card.next) - Date.now() - 7 * 86400000) < 60000);
    api('edit', { phone: CUST, fields: { City: 'Ajmer', Category: 'Contractor', Phone: '1', 'Area sqft': '1500' } });
    l = api('lead', { phone: CUST });
    assert.strictEqual(l.lead.City, 'Ajmer'); assert.strictEqual(l.lead.Category, 'Contractor'); assert.strictEqual(l.lead.Phone, CUST);
    assert.strictEqual(l.lead['Area sqft'], '1500');
    api('pause', { phone: CUST, resume: true });
    assert.strictEqual(api('lead', { phone: CUST }).botPaused, false);
    api('act', { phone: CUST, cmd: 'WON', note: '40 buckets' });
    assert.strictEqual(api('dashboard').counts.won, 1);
    // add lead
    assert.strictEqual(api('addLead', { phone: '98111 33333', name: 'Walk-in', category: 'Builder', city: 'Jaipur' }).phone, '919811133333');
    assert(api('addLead', { phone: '9811133333' }).error.includes('already'));
    assert(api('addLead', { phone: '123' }).error);
    // settings: bot off means no AI reply, and alerts still work
    let st = api('saveSettings', { BOT_ENABLED: 'false', SALES_WHATSAPP: '98000 00001', BOT_MODE: 'weird' });
    assert.strictEqual(st.bot.botEnabled, false); assert.strictEqual(st.bot.salesWhatsapp, SALES); assert.strictEqual(st.bot.mode, 'gentle');
    post(env, payload([text('919822223333', 'hello')]));
    assert.strictEqual(env.claudeCalls.length, 2, 'no AI call while bot is off');
    // test mode blocks team replies with a clear message
    api('saveSettings', { SEND_ENABLED: 'false' });
    assert(api('reply', { phone: '919822223333', text: 'hi' }).error.includes('Test mode'));
  },
  'app: reply outside 24h window explains why'() {
    const env = load(BASE);
    const api = (a, x) => JSON.parse(env.ctx.api(env.props.APP_PIN, a, JSON.stringify(x || {})));
    api('addLead', { phone: '9811112222' });
    const fetch = env.ctx.UrlFetchApp.fetch;
    env.ctx.UrlFetchApp.fetch = () => ({ getResponseCode: () => 400, getContentText: () => '{"error":{"code":131047,"message":"Re-engagement message"}}' });
    assert(api('reply', { phone: CUST, text: 'hi' }).error.includes('24 hours'));
    env.ctx.UrlFetchApp.fetch = fetch;
  },
  'doGet serves the app and answers webhook verification'() {
    const env = load(BASE);
    assert.strictEqual(env.ctx.doGet({ parameter: {} }).file, 'App');
    assert.strictEqual(env.ctx.doGet({ parameter: { 'hub.challenge': '42' } }).text, '42');
  },
  'app over HTTP (Android app): status, keys, tests'() {
    const env = load(Object.assign({}, BASE, { props: { WEBHOOK_SECRET: SECRET, APP_PIN: '123456' }, claude: [say('Ji, main ready hoon!')] }));
    const http = (action, args, pin = '123456') => JSON.parse(env.ctx.doPost({ parameter: {}, postData: {
      contents: JSON.stringify({ _app: 1, pin, action, args }) } }).text);
    assert.strictEqual(http('dashboard', {}, '000').error, 'PIN');
    let st = http('status');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(st.keys)), { claude: false, ai: false, waToken: false, waPhoneId: false });
    assert.strictEqual(st.webhookKey, SECRET); assert.strictEqual(st.installed, true);
    assert.strictEqual(http('testClaude').error, 'Add the Claude API key first');
    http('saveKeys', { claude: 'sk-test', waToken: 'tok', waPhoneId: '123', waApiVersion: 'v20.0' });
    st = http('status');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(st.keys)), { claude: true, ai: true, waToken: true, waPhoneId: true });
    assert.strictEqual(st.waApiVersion, 'v20.0');
    assert(!JSON.stringify(st).includes('sk-test'), 'secrets are never sent back');
    http('saveKeys', { claude: '' });
    assert.strictEqual(env.props.ANTHROPIC_API_KEY, 'sk-test', 'blank field keeps the old key');
    assert(http('testClaude').message.includes('main ready'));
    http('saveSettings', { SEND_ENABLED: 'false' });
    assert(http('testWhatsApp').message.includes(SALES), 'WhatsApp test works even in test mode');
    assert.strictEqual(env.sent.pop().url, 'https://crmapi.bluetickapi.com/api/meta/v20.0/123/messages');
    assert.strictEqual(http('changePin', { newPin: '7777' }).message, 'PIN changed');
    assert.strictEqual(http('status', {}, '7777').bot.sendEnabled, false);
    const r = env.ctx.doPost({ parameter: { key: SECRET }, postData: { contents: JSON.stringify(payload([text(CUST, 'what is "_app"')])) } });
    assert.strictEqual(r.text, 'ok', 'a WhatsApp webhook mentioning _app is still a webhook');
  },
  'other AI provider (Gemini) works through the same tools'() {
    const env = load(Object.assign({}, BASE, { props: Object.assign({}, BASE.props, { ANTHROPIC_API_KEY: '' }) }));
    const api = (a, x) => JSON.parse(env.ctx.api('123456', a, JSON.stringify(x || {})));
    api('saveKeys', { provider: 'gemini', aiKey: 'AIza-test' });
    assert.strictEqual(env.props.GEMINI_API_KEY, 'AIza-test'); assert.strictEqual(env.props.ANTHROPIC_API_KEY, '');
    let st = api('status');
    assert.strictEqual(st.ai.provider, 'gemini'); assert.strictEqual(st.keys.ai, true); assert.strictEqual(st.ai.model, 'gemini-flash-latest');
    const calls = [];
    const answers = [
      { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function',
        function: { name: 'update_lead', arguments: '{"category":"Builder","city":"Ajmer"}' } }] } }] },
      { choices: [{ message: { content: 'Namaste ji 🙏 kitna area hai?' } }] }];
    const orig = env.ctx.UrlFetchApp.fetch;
    env.ctx.UrlFetchApp.fetch = (url, opt) => {
      if (url.includes('generativelanguage')) {
        calls.push({ url, auth: opt.headers.Authorization, body: JSON.parse(opt.payload) });
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(answers.shift()) };
      }
      return orig(url, opt);
    };
    post(env, payload([text(CUST, 'hum builder hain Ajmer se')]));
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].auth, 'Bearer AIza-test');
    assert.strictEqual(calls[0].body.messages[0].role, 'system');
    assert.strictEqual(calls[0].body.tools[0].function.name, 'update_lead');
    const m2 = calls[1].body.messages;
    assert.strictEqual(m2[m2.length - 2].tool_calls[0].function.name, 'update_lead');
    assert.deepStrictEqual(Object.assign({}, m2[m2.length - 1], { content: '' }), { role: 'tool', tool_call_id: 'c1', content: '' });
    const l = lead(env, CUST);
    assert.strictEqual(l.Category, 'Builder'); assert.strictEqual(l.City, 'Ajmer');
    assert.strictEqual(texts(env).pop().text, 'Namaste ji 🙏 kitna area hai?');
    // custom model, then back to Claude keeps both keys
    api('saveKeys', { provider: 'groq', model: 'my-model', aiKey: 'gsk' });
    st = api('status'); assert.strictEqual(st.ai.model, 'my-model'); assert.strictEqual(env.props.GROQ_API_KEY, 'gsk');
    api('saveKeys', { provider: 'claude', aiKey: 'sk-ant' });
    st = api('status'); assert.strictEqual(st.ai.provider, 'claude'); assert.strictEqual(env.props.ANTHROPIC_API_KEY, 'sk-ant');
    assert.strictEqual(env.props.GEMINI_API_KEY, 'AIza-test');
    assert(api('saveKeys', { provider: 'hack' }).error);
    // optional webhook relay link
    api('saveKeys', { relayUrl: 'https://amitek-relay.me.workers.dev/?x=1' });
    assert.strictEqual(api('status').relayUrl, 'https://amitek-relay.me.workers.dev');
    assert(api('saveKeys', { relayUrl: 'http://bad' }).error);
    api('saveKeys', { relayUrl: '' });
    assert.strictEqual(api('status').relayUrl, '');
  }
  ,
  'campaign sends an approved template to the right leads, in batches, within the daily limit'() {
    const env = load(Object.assign({}, BASE, { settings: { SEND_ENABLED: 'false', SALES_WHATSAPP: SALES, CAMPAIGN_DAILY_LIMIT: '3', CAMPAIGN_BATCH: '2' } }));
    const api = (a, x) => JSON.parse(env.ctx.api('123456', a, JSON.stringify(x || {})));
    const sh = env.sheets['Leads'];
    sh.rows[0] = sh.rows[0].concat(['Can Message']);
    const row = (phone, f) => { const h = sh.rows[0]; sh.rows.push(h.map(c => c === 'Phone' ? phone : (f[c] !== undefined ? f[c] : (c === 'Status' ? 'New' : ''))));};
    row('919811110001', { Name: 'Ramesh Kumar', City: 'Jaipur', Category: 'Applicator', 'Can Message': 'Yes' });
    row('919811110002', { Business: 'Shree Builders', City: 'Jaipur', Category: 'Builder' });
    row('919811110003', { City: 'Jaipur', Category: 'Dealer' });
    row('919811110004', { City: 'Jaipur', 'Can Message': 'No' });                 // skipped: marked do not message
    row('919811110005', { City: 'Jaipur', 'Opt-in': 'Opted out' });               // skipped: said STOP
    row('919811110006', { City: 'Jaipur', Status: 'Won' });                       // skipped: closed
    row('91141234567', { City: 'Jaipur' });                                       // skipped: not a mobile number
    row('919811110008', { City: 'Ajmer' });                                       // other city
    row('919811110009', { City: 'Jaipur', 'Last Inbound': new Date() });          // skipped: already talking to us
    row(SALES, { City: 'Jaipur' });                                               // skipped: salesperson
    const filter = { cities: 'jaipur' };
    const pv = api('campaignPreview', { filter }); assert.strictEqual(pv.count, 3, JSON.stringify(env.ctx.audience_(filter).map(l => [l.Phone, l['Can Message'], l.Status, l['Opt-in']])));
    assert(api('campaignSave', { name: 'Jaipur test', template: 'Bad Name', filter }).error);
    const id = api('campaignSave', { name: 'Jaipur test', template: 'amitek_intro', language: 'hi', usesName: true,
                                     text: 'Namaste {{1}} ji, Amitek se...', filter }).id;
    assert(api('campaignStart', { id }).error.includes('Test mode'), 'never sends in test mode');
    assert(api('campaignTest', { id }).message.includes(SALES), 'test goes to the salesperson even in test mode');
    const t = env.sent.pop().body;
    assert.strictEqual(t.type, 'template'); assert.strictEqual(t.template.name, 'amitek_intro');
    assert.strictEqual(t.template.language.code, 'hi');
    assert.strictEqual(env.sent.length, 0);
    api('saveSettings', { SEND_ENABLED: 'true' });
    assert(api('campaignStart', { id }).message.includes('2 sent'));
    assert(env.triggers.some(x => x.getHandlerFunction() === 'campaignTick'), 'timer added');
    let tos = env.sent.map(s => s.body.to);
    assert.deepStrictEqual(tos, ['919811110001', '919811110002']);
    assert.strictEqual(env.sent[0].body.template.components[0].parameters[0].text, 'Ramesh');
    assert.strictEqual(env.sent[1].body.template.components[0].parameters[0].text, 'Shree');
    assert.strictEqual(lead(env, '919811110001').Status, 'Contacted');
    assert.strictEqual(lead(env, '919811110001').Campaign, 'Jaipur test');
    assert(env.sheets['Messages'].rows.some(r => r[1] === '919811110001' && r[3] === 'campaign' && r[4].includes('Namaste Ramesh ji')));
    env.ctx.campaignTick();   // daily limit 3: only one more today
    assert.strictEqual(env.sent.length, 3);
    env.ctx.campaignTick();
    assert.strictEqual(env.sent.length, 3, 'stops at the daily limit');
    env.sheets['Campaign Log'].rows.slice(1).forEach(r => { r[0] = new Date(Date.now() - 25 * 3600000); });  // a day later
    env.ctx.campaignTick();
    assert.strictEqual(env.sent.filter(s => s.body.type === 'template').length, 3, 'nobody left, nobody gets it twice');
    assert(texts(env).some(m => m.to === SALES && m.text.includes('finished')));
    const c = api('campaigns').campaigns[0];
    assert.strictEqual(c.status, 'Done'); assert.strictEqual(c.sent, 3);
    assert(!env.triggers.some(x => x.getHandlerFunction() === 'campaignTick'), 'timer removed when done');
    // a reply to the campaign is counted and the bot answers it like any chat
    env.claude.push(say('Ji, bataiye kaunsa kaam hai?'));
    post(env, payload([text('919811110002', 'haan batao')]));
    assert.strictEqual(api('campaigns').campaigns[0].replied, 1);
  },
  'campaign pauses itself when WhatsApp refuses the template'() {
    const env = load(BASE);
    const api = (a, x) => JSON.parse(env.ctx.api('123456', a, JSON.stringify(x || {})));
    upsert(env, '919811110001'); upsert(env, '919811110002');
    const orig = env.ctx.UrlFetchApp.fetch;
    env.ctx.UrlFetchApp.fetch = (url, opt) => JSON.parse(opt.payload).type === 'template' ?
      { getResponseCode: () => 404, getContentText: () => '{"error":{"code":132001,"message":"Template name does not exist"}}' } : orig(url, opt);
    const id = api('campaignSave', { name: 'X', template: 'wrong_name', filter: {} }).id;
    api('campaignStart', { id });
    const c = api('campaigns').campaigns[0];
    assert.strictEqual(c.status, 'Paused'); assert(c.error.includes('132001'));
    assert.strictEqual(c.failed, 1, 'stopped after the first refusal');
    assert(texts(env).some(m => m.to === SALES && m.text.includes('paused')));
  },
  'welcome campaign greets leads added in the app'() {
    const env = load(BASE);
    const api = (a, x) => JSON.parse(env.ctx.api('123456', a, JSON.stringify(x || {})));
    const id = api('campaignSave', { name: 'Welcome', template: 'amitek_welcome', filter: { keepOn: true } }).id;
    const other = api('campaignSave', { name: 'Other', template: 'other_one', filter: {} }).id;
    assert.notStrictEqual(other, id, 'campaigns saved in the same minute get different IDs');
    upsert(env, '919811110001', { Created: new Date(Date.now() - 86400000) });  // the existing list
    assert(api('campaignStart', { id }).message.includes('Welcome'));
    env.ctx.campaignTick();
    assert.strictEqual(env.sent.length, 0, 'existing leads are never messaged by a welcome campaign');
    assert.strictEqual(api('campaigns').campaigns.find(c => c.id === id).status, 'Running', 'keeps waiting for new leads');
    const r = api('addLead', { phone: '9811110002', name: 'Suresh' });
    assert(r.message.includes('welcome'));
    assert.deepStrictEqual(env.sent.map(s => s.body.to), ['919811110002']);
    env.ctx.campaignTick();
    assert.strictEqual(env.sent.length, 1, 'nobody greeted twice');
  },
  'learning: suggestions from chats and taught text need approval before the bot uses them'() {
    const env = load(BASE);
    const api = (a, x) => JSON.parse(env.ctx.api('123456', a, JSON.stringify(x || {})));
    const notes = JSON.stringify([{ title: 'Terrace leak answer', content: 'Team recommends Amitek terrace coat, 2 coats.', why: 'chat 1' }]);
    env.claude.push(say('Ji bataiye'));
    post(env, payload([text(CUST, 'terrace leak ke liye kya lagau?')]));
    env.claude.push(say('Here you go:\n' + notes));
    let r = api('learnChats', { days: 7 });
    assert.strictEqual(r.added, 1);
    const prompt = env.claudeCalls[env.claudeCalls.length - 1].body.messages[0].content;
    assert(prompt.includes('terrace leak ke liye') && prompt.includes('<recent_chats'));
    let k = api('knowledge');
    assert.strictEqual(k.suggestions.length, 1);
    const before = env.sheets['Knowledge'].rows.length;
    assert.strictEqual(api('learnDecide', { row: k.suggestions[0].row, approve: true, content: 'Edited: 2 coats.' }).message, 'The bot knows this now');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(env.sheets['Knowledge'].rows[before])), ['Learned: Terrace leak answer', 'Edited: 2 coats.']);
    assert(api('learnDecide', { row: k.suggestions[0].row, approve: true }).error, 'cannot approve twice');
    // teach from pasted text: straight in, or through the AI
    api('learnText', { title: 'Company profile', text: 'Amitek, Jaipur. Open 10-7.', direct: true });
    assert(env.sheets['Knowledge'].rows.some(x => x[0] === 'Company profile'));
    env.claude.push(say('[]'));
    assert(api('learnText', { title: 'Old campaign export', text: 'name,replied\nA,yes' }).message.includes('nothing new'));
    // the bot's next reply includes approved knowledge
    env.claude.push(say('Ji'));
    post(env, payload([text(CUST, 'aur?')]));
    assert(env.claudeCalls[env.claudeCalls.length - 1].body.system[0].text.includes('Edited: 2 coats.'));
    k = api('knowledge');
    const doc = k.docs.find(d => d.title === 'Company profile');
    api('knowledgeDelete', { row: doc.row });
    assert(!api('knowledge').docs.some(d => d.title === 'Company profile'));
  }
  ,
  'team by category: each member gets alerts for their leads, commands work from any team number'() {
    const APP = '919700000001', DEAL = '919700000002';
    const env = load(Object.assign({}, BASE, { claude: [
      tool('update_lead', { category: 'Applicator', city: 'Jaipur' }),
      tool('handoff_to_sales', { reason: 'Wants rate', summary: '2000 sqft terrace', priority: 'hot' }, 'tu2'), say('Ji, team call karegi 🙏')] }));
    const api = (a, x) => JSON.parse(env.ctx.api('123456', a, JSON.stringify(x || {})));
    assert(api('saveSettings', { TEAM_ROUTING: JSON.stringify({ Applicator: '9700000001', Dealer: '97000 00002, 123' }) }).error.includes('123'));
    api('saveSettings', { TEAM_ROUTING: JSON.stringify({ Applicator: '9700000001', Dealer: '9700000002', Hacker: '9711111111' }) });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(api('settings').bot.team)), { Applicator: APP, Dealer: DEAL });
    post(env, payload([text(CUST, 'main applicator hoon, rate batao')]));
    const hot = texts(env).filter(m => m.text.includes('HOT LEAD')).map(m => m.to).sort();
    assert.deepStrictEqual(hot, [SALES, APP].sort(), 'applicator lead goes to the main salesperson and the applicator person only');
    // a team member's message is a command, not a new lead
    post(env, payload([text(DEAL, 'LIST')]));
    assert(!lead(env, DEAL), 'team numbers never become leads');
    const list = texts(env).filter(m => m.to === DEAL).pop().text;
    assert(!list.includes('+' + CUST), 'dealer person does not see applicator leads');
    post(env, payload([text(APP, 'LIST')]));
    assert(texts(env).filter(m => m.to === APP).pop().text.includes('+' + CUST));
    post(env, payload([text(APP, 'DONE ' + CUST.slice(-10) + ' called')]));
    assert.strictEqual(lead(env, CUST).Status, 'Contacted');
    // daily summary: one per team member
    env.sent.length = 0; env.ctx.dailySummary();
    assert.deepStrictEqual(texts(env).map(m => m.to).sort(), [SALES, APP, DEAL].sort());
  }
};




let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
}
console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
