# Product Spec: Multi-Tenant AI Sales Agent (codename: "Amitek Agent Platform")

## What this is

A commercial, subscription SaaS product: a business teaches an AI agent about its
own company — by chatting with it and by uploading PDFs, spreadsheets and Word
documents — and the agent then works that business's leads over WhatsApp:
qualifying, answering questions from what it was taught, and handing hot leads to
a named person on the team. Amitek Waterproofing is the first customer (tenant),
not the only one. Every table and every record in the system carries a `tenant_id`
from day one.

This replaces further patching of the single-tenant Google Sheets + Apps Script
bot in `apps-script/` and the single-tenant Python app in `app/`. Those two stay
in the repo as the reference implementation for the WhatsApp message flow, the
lead data model, and the `BOT_MODE` (gentle/sales) rules — the new product reuses
those ideas, not that code, because neither was built to hold more than one
company's data.

## Users

- **Owner / admin** (e.g. sourabh for Amitek): signs the company up, connects a
  WhatsApp number, uploads documents, reviews the agent's answers, manages seats
  and billing.
- **Team member / salesperson**: receives hot-lead handoffs on WhatsApp, updates
  lead status (`DONE`, `LATER`, `WON`, `LOST`), sees their queue.
- **Lead**: the person messaging the business's WhatsApp number. Never logs into
  anything; only ever sees WhatsApp messages.
- **(v2, out of scope for this spec) Platform admin**: Amitek Agent Platform's own
  staff, managing tenants and billing across customers.

## Core flows

1. **Onboard a company** — admin signs up, names the company, picks a plan,
   connects (or is guided to connect) a WhatsApp Business number through the
   existing BlueTick API integration.
2. **Upload documents** — admin uploads PDFs, spreadsheets (price lists, catalogs,
   FAQs) and Word docs. Each file is parsed, chunked, embedded and stored against
   that tenant only (see Architecture note for pgvector detail).
3. **Chat to teach** — admin has a conversation with the agent (not a lead-facing
   chat) to state facts, correct mistakes, and set rules the agent should follow
   (e.g. "never quote a price that isn't in the price list"). This becomes
   structured knowledge, tagged by source (`chat` vs `document`) and tenant.
4. **Add leads** — admin imports a lead list (spreadsheet) or leads arrive by
   inbound WhatsApp message; each lead is tagged by category (the categories are
   configurable per tenant — Amitek's are applicator, contractor, builder,
   architect, dealer, manufacturer).
5. **Run campaigns** — admin picks a lead segment and template, the agent (via the
   tenant's connected WhatsApp number) sends the opening message; replies start
   the agent conversation.
6. **Converse and qualify** — the agent replies to leads using only that tenant's
   taught knowledge, in the lead's language (English, Hindi, Hinglish — more
   languages are a per-tenant config, not a code change), following the sales
   stages (Discover > Diagnose > Recommend > Quote > Close) only as far as the
   tenant's rules allow (e.g. never quoting a number that isn't in the uploaded
   price list).
7. **Hand off hot leads** — when a lead is ready to buy, is upset, or asks for a
   human, the agent hands off to a named person (or role, e.g. "whoever is free")
   on that tenant's team, by WhatsApp, with a summary — reusing the hand-off idea
   already proven in `app/tracker.py` and `apps-script/App.gs`.
8. **Reports** — admin sees per-tenant: leads by stage, response times, hot leads
   outstanding, campaign performance. No cross-tenant reporting in v1.

## Tenant model

Every table carries a `tenant_id` (see `scaffold/multitenant/migrations/` for the
schema draft). A tenant is one paying company. Within a tenant:

- one or more WhatsApp numbers (v1: one is enough, schema allows more),
- one or more team members (seats, limited by plan),
- its own documents, knowledge chunks, leads, messages and campaigns — never
  visible to another tenant, enforced at the database layer (Postgres row-level
  security keyed on `tenant_id`), not only in application code.

## Out of scope for v1

- Billing automation (Stripe or similar) beyond recording a plan and limits —
  v1 can track usage and limits, but charging is manual/invoiced until a tenant
  count justifies automating it.
- Platform-admin console for managing tenants across customers.
- Any language beyond what a tenant explicitly configures.
- Any channel beyond WhatsApp (SMS, email, web chat) — the architecture should
  not block adding them later, but none ship in v1.
- Migrating Amitek's existing Google Sheet data automatically — Amitek's lead
  sheet (`data/Amitek_Leads_Cleaned.xlsx`) is imported once, by hand, through the
  same "add leads" flow every tenant uses.
- Fine-tuning or training a custom model — the agent is Claude with per-tenant
  retrieved knowledge (RAG), not a trained model per tenant.
