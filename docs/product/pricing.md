# Pricing & Subscription Model (draft — all costs are estimates)

## Tiers

| | Starter | Growth | Scale |
|---|---|---|---|
| Price | ₹4,999/mo | ₹14,999/mo | ₹39,999/mo |
| Seats (team members) | 2 | 5 | 15 |
| Leads tracked | 1,000 | 5,000 | 25,000 |
| WhatsApp conversations/mo | 1,000 | 5,000 | 25,000 |
| Documents (for teaching) | 20 | 100 | Unlimited |
| AI messages/mo (soft cap, throttled after) | 3,000 | 15,000 | 75,000 |
| WhatsApp numbers | 1 | 1 | 3 |
| Support | email | email + WhatsApp | priority |

Overage beyond a tier's limits is billed per-unit (leads, conversations, AI
messages) rather than hard-blocked, so a campaign never silently fails — but the
admin is warned before overage starts and can cap spend.

These numbers are a starting point for Amitek's own usage pattern (per
[[whatsapp-agent-scope]] memory: ~500 leads, ₹7k–10k/month at that volume on the
single-tenant build) scaled up with per-tenant isolation overhead. They should be
revisited once 2–3 real tenants are running.

## Rough monthly cost per tier (estimates, not quotes)

Three cost drivers scale with usage: the Claude API, WhatsApp conversation fees
(via BlueTick), and hosting.

### Claude API (Claude Sonnet 5.5 pricing, assuming short conversational turns
with retrieved context, ~1.5k input + 300 output tokens/message average)

| Tier | AI messages/mo | Est. Claude cost |
|---|---|---|
| Starter | 3,000 | ~₹1,200–1,800 |
| Growth | 15,000 | ~₹6,000–9,000 |
| Scale | 75,000 | ~₹30,000–45,000 |

### WhatsApp conversation fees (BlueTick/Meta, India business-initiated +
user-initiated conversations blended; Meta's per-conversation fee varies by
category and changes periodically — treat this row as the most likely to need
correction before quoting a customer)

| Tier | Conversations/mo | Est. WhatsApp fee |
|---|---|---|
| Starter | 1,000 | ~₹800–1,500 |
| Growth | 5,000 | ~₹4,000–7,500 |
| Scale | 25,000 | ~₹20,000–37,500 |

### Hosting (shared across all tenants on a tier, not per-tenant; see
architecture note — Supabase + a small Render service)

- Supabase Pro: ~$25/mo (~₹2,100) covers Postgres + pgvector + auth + storage up
  to several tenants; scales to Supabase's next plan as tenant count grows.
- Render web service (API + agent worker): ~$25–85/mo (~₹2,100–7,100) depending
  on load.
- Blended hosting cost per tenant drops as more tenants share the same
  infrastructure — this is the core SaaS margin lever.

### Gross margin sanity check (rough, per tenant, before platform overhead)

- Starter: ₹4,999 revenue vs. ~₹2,000–3,300 AI+WhatsApp cost + a small hosting
  share → plausible margin once 10+ tenants share hosting.
- Growth: ₹14,999 revenue vs. ~₹10,000–16,500 AI+WhatsApp cost → tight; the
  per-message AI cost needs to come down (shorter context, caching) or this tier
  needs to be repriced before selling it to outside customers.
- Scale: ₹39,999 revenue vs. ~₹50,000–82,500 AI+WhatsApp cost → **loses money as
  priced**; either the price is too low for this tier's usage, or large
  customers need a custom/negotiated plan instead of a flat tier. Flag this to
  the owner before offering Scale to anyone outside Amitek.

These are first-pass estimates meant to catch pricing mistakes early (the Scale
tier above), not numbers to quote a customer. Before selling to a second tenant,
re-derive them from Amitek's first month of real usage.

## What needs the owner's decision

- Whether Scale tier's price or limits change before it is ever offered externally.
- Whether WhatsApp conversation fees are passed through at cost, marked up, or
  bundled flat (bundling is simpler to sell but riskier on margin).
- Billing automation (Stripe) timing — manual invoicing is fine while Amitek is
  the only tenant.
