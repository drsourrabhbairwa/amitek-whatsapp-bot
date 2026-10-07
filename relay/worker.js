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
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const to = url.searchParams.get('to') || '';
    // only forward to Google Apps Script web apps, so this cannot be used as an open proxy
    if (!/^https:\/\/script\.google\.com\/(macros|a\/macros\/[\w.-]+)\/s\/[\w-]+\/exec$/.test(to)) {
      return new Response('Amitek relay is running', { status: 200 });
    }
    const forward = new URL(to);
    url.searchParams.forEach((v, k) => { if (k !== 'to') forward.searchParams.set(k, v); });

    if (request.method === 'GET' || request.method === 'HEAD') {
      // webhook verification: echo the challenge (Meta style) or just say ok
      const challenge = url.searchParams.get('hub.challenge') || url.searchParams.get('challenge');
      return new Response(challenge || 'ok', { status: 200 });
    }

    const body = await request.text();
    // answer BlueTick immediately; deliver to Apps Script in the background (it follows Google's redirect)
    ctx.waitUntil(fetch(forward.toString(), {
      method: 'POST', body, redirect: 'follow',
      headers: { 'Content-Type': request.headers.get('Content-Type') || 'application/json' }
    }).catch(() => {}));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};
