# Multi-tenant scaffold (draft, not deployed)

This is a folder layout and schema draft for the product described in
`docs/product/spec.md` and `docs/product/architecture.md`. Nothing here is
wired up, deployed, or connected to any real credentials. It exists so the
schema and layout can be reviewed before any infrastructure is created.

```
scaffold/multitenant/
├── migrations/        # SQL schema (Supabase/Postgres), applied with `supabase db push`
│   └── 0001_init.sql
├── api/                # FastAPI app: webhook, admin endpoints, auth — empty stubs
├── agent/              # RAG retrieval + Claude call + handoff decision — empty module
├── web/                # admin web app (upload docs, chat to teach, review leads) — not started
└── scripts/            # one-off scripts (e.g. importing Amitek's existing lead sheet)
```

Nothing here replaces `app/` or `apps-script/`, which keep running for Amitek on
the existing single-tenant setup until this product is ready to take over.

## Next steps (need the owner's go-ahead, not yet done)

1. Create a Supabase project (owner sign-up required — this is a new account/cost).
2. Apply `migrations/0001_init.sql` to it.
3. Build out `api/` and `agent/` against that schema, starting with Amitek as
   tenant #1, reusing the WhatsApp send/receive logic from `app/whatsapp.py` and
   the lead-tracking logic from `app/tracker.py`, made tenant-aware.
4. Only after that works end-to-end for Amitek does a second tenant get onboarded.
