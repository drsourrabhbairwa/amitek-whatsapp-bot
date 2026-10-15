# Architecture Note: Multi-Tenant AI Sales Agent

## Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Database | **Supabase** (managed Postgres) with **pgvector** | One managed database gives us: relational tables for tenants/leads/messages (strong consistency, the thing a sales team actually audits), row-level security keyed on `tenant_id` enforced *at the database*, built-in auth for the admin/team web app, built-in file storage for uploaded PDFs/sheets/docs, and pgvector for document search (embeddings for RAG) — all one bill, one connection, one backup policy, instead of stitching together a separate vector DB, a separate auth provider and a separate blob store. |
| Agent / LLM | **Claude API** (Claude Sonnet 5.5) | Already proven in `app/agent.py` for this exact use case (English/Hindi/Hinglish sales conversation, playbook-driven, never quoting ungrounded prices). RAG over the tenant's own documents replaces the single hard-coded `knowledge/*.md` folder with per-tenant retrieved chunks from Postgres/pgvector. |
| API / backend | **A small service on Render** (FastAPI, same language/framework as `app/`) | Keeps one runtime for the webhook handler, the admin API, and the background workers (campaign sends, hourly lead-SLA checks — reusing the proven logic in `app/scheduler.py` and `app/tracker.py`, made tenant-aware). Render over AWS/Lightsail for v1: less to operate, scales to zero cost drivers (autoscaling web service) while the product has one tenant, and the existing `render.yaml` in this repo is a direct template. |
| WhatsApp | **BlueTick API** (existing connection, per tenant) | Amitek already has a Meta Business number on BlueTick (per project memory); the new product keeps that integration pattern — each tenant connects their own BlueTick-backed number — rather than building a direct Meta Cloud API integration from scratch. The webhook handler and message-sending code in `app/whatsapp.py` are reused, parameterized by tenant. |
| Admin / team web app | **A thin web app** (served from the same Render service, or a static frontend) | Where an admin uploads documents, chats to teach the agent, and reviews leads; team members mostly work from WhatsApp directly (as today), so this web app is admin-facing first, not a full CRM UI, in v1. |

## Why not the alternatives raised

- **Hermes**: project memory already ruled Hermes out for the team Telegram bot
  ([[whatsapp-telegram-team]]: "no Hermes"); the same reasoning applies here — it
  adds a framework layer for agent orchestration the product doesn't need yet,
  since the orchestration (RAG retrieval → Claude call → send/handoff) is simple
  enough to write directly and keep debuggable.
- **GitHub-hosted agent frameworks** (LangChain, CrewAI, etc.): these earn their
  place when an agent needs many tools, multi-step planning, or multi-agent
  coordination. This agent has one job — converse with a lead using retrieved
  knowledge and either continue or hand off — which is a retrieval call plus one
  Claude call plus a database write. A framework here would add indirection
  (harder to see exactly what prompt Claude received, as `app/agent.py` makes
  easy today) without adding capability. Revisit if v2 adds autonomous research
  (the "research the applicator/contractor/builder/architect" ask from the
  original brief) with multiple tool calls per turn — that is a better fit for
  a lightweight tool-use loop (Claude's native tool use), still not a full
  framework.
- **AWS/Lightsail** (previously proposed in [[hosting-aws]] for internal tools):
  still the right call for Amitek's *other* internal tools (attendance,
  quotation) that aren't being sold. For this product specifically, Supabase +
  Render gets a multi-tenant SaaS to a sellable state with far less
  infrastructure to build and operate solo. If/when tenant count and volume
  justify it, the Render service can move to AWS without changing the data
  layer (Supabase is still managed Postgres underneath).

## Multi-tenancy approach

- Every table has a `tenant_id` foreign key (see
  `scaffold/multitenant/migrations/0001_init.sql`).
- Postgres Row-Level Security policies restrict every query to the calling
  tenant — enforced in the database, so an application bug can't leak one
  tenant's leads or documents to another.
- Document embeddings (pgvector) are filtered by `tenant_id` in the same query
  that does the similarity search — no cross-tenant retrieval is possible by
  construction.
- One Claude API key (platform-level), not per tenant — tenants don't manage
  their own AI provider keys; they manage their WhatsApp/BlueTick credentials
  (stored encrypted, per tenant, server-side only — never in the repo, matching
  the existing rule that the BlueTick token lives only in environment/secret
  storage).

## What this does not decide yet

- Whether the admin web app is server-rendered from the same Render service or
  a separate static frontend — either works with this backend; pick based on
  who builds it and how fast it needs to ship.
- Exact embedding model and chunking strategy for documents — a reasonable v1
  default (fixed-size chunks, Claude or a standard embedding model) is a
  scaffold decision, not an architecture one, and can change without touching
  the schema.
