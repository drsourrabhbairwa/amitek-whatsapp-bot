/**
 * Amitek webhook relay (Cloudflare Worker, free plan).
 *
 * Why: Google Apps Script web apps always answer with a redirect, and BlueTick's webhook check
 * ("failed to verify channel") needs a plain 200 answer. This relay answers BlueTick at once and passes
 * every message on to your Apps Script.
 *
 * Setup: Cloudflare dashboard > Workers & Pages > Create > Create Worker > Deploy > Edit code,
 * replace everything with this file, Deploy. Paste the worker link (https://….workers.dev) into the
 * Amitek app's Setup screen; the app then gives you the webhook link for BlueTick.
 * Nothing needs editing here: the webhook link itself tells the relay where your script is (?to=…).
 *
 * Every verification attempt is also copied to the sheet's "Webhook Log" tab (as "_relay_probe"),
 * so you can see exactly what BlueTick sent.
 */
const SCRIPT_RE = /^https:\/\/script\.google\.com\/(macros|a\/macros\/[\w.-]+)\/s\/[\w-]+\/exec$/;

// Find a challenge anywhere: hub.challenge / challenge / hub_challenge, even when the sender glued
// its own "?…" onto our link (which hides it inside the previous parameter).
function findChallenge(text) {
  const m = /(?:^|[?&])(?:hub[._])?chall[ae]nge=([^&#]*)/i.exec(text || '');  // BlueTick spells it "challange"
  if (!m) return '';
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return m[1]; }
}

function bodyChallenge(body) {
  if (!body) return '';
  try {
    const j = JSON.parse(body);
    const c = j && (j.challenge || j.challange || j['hub.challenge'] || j.hub_challenge || (j.hub && j.hub.challenge) ||
      (j.data && j.data.challenge));
    if (c !== undefined && c !== null && typeof c !== 'object') return String(c);
  } catch (e) { /* not JSON */ }
  return findChallenge(body);  // form-encoded
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const rawQuery = url.search.slice(1);
    const to = url.searchParams.get('to') || '';
    const body = (request.method === 'GET' || request.method === 'HEAD') ? '' : await request.text();
    const challenge = findChallenge(rawQuery) || bodyChallenge(body);

    let forward = null;
    if (SCRIPT_RE.test(to)) {
      forward = new URL(to);
      url.searchParams.forEach((v, k) => {
        if (k !== 'to') forward.searchParams.set(k, k === 'key' ? v.split('?')[0] : v);  // drop glued "?…"
      });
    }
    const send = (payload) => {
      if (forward) ctx.waitUntil(fetch(forward.toString(), {
        method: 'POST', body: payload, redirect: 'follow',
        headers: { 'Content-Type': 'application/json' }
      }).then(async (r) => console.log('script answered', r.status, (await r.text()).slice(0, 200)))
        .catch((e) => console.log('script unreachable', String(e))));
    };

    // any POST without a challenge is passed on as is (the sheet's Webhook Log keeps a copy)
    const isMessage = request.method === 'POST' && !challenge;
    if (!isMessage) {
      // a verification or test call: record it so we can see what the sender expects
      const headers = {};
      request.headers.forEach((v, k) => { if (!/^(cf-|x-forwarded|x-real-ip|cookie|authorization)/i.test(k)) headers[k] = v; });
      const probe = JSON.stringify({ _relay_probe: { method: request.method, query: rawQuery.replace(/key=[^&?]*/g, 'key=…'),
        headers, body: body.slice(0, 4000), answered: challenge || 'ok' } });
      console.log(probe);  // visible in Cloudflare: Worker > Logs > Live
      send(probe);
      if (challenge) return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      if (!forward) return new Response('Amitek relay is running', { status: 200 });
      if (request.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('ok', { status: 200 });
    }

    // a real WhatsApp event: answer at once, deliver to Apps Script in the background
    console.log('event', body.slice(0, 500));
    send(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};
