// Offline tests for Code.gs. Run: node apps-script/test/test.js
const assert = require('assert');
const { load } = require('./harness');

const BUSINESS = '910000000001';
const SALES = '919800000001';
const CUST = '919811112222';
const SECRET = 'testsecret';
const BASE = { props: { WEBHOOK_SECRET: SECRET, ANTHROPIC_API_KEY: 'k', WA_ACCESS_TOKEN: 't', WA_PHONE_NUMBER_ID: 'phone-id-test' },
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
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).split('\n').slice(0, 3).join('\n     ')); }
}
console.log(`\n${Object.keys(tests).length - failed}/${Object.keys(tests).length} passed`);
process.exit(failed ? 1 : 0);
