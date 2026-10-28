# Amitek WhatsApp bot

Start with `HANDOFF.md` (current state, pending tasks, gotchas), then `service/README.md`.

- User replies: Hinglish, short, one step at a time. Do the work yourself; ask him only for steps that need a human (passwords, keys, approvals, UI clicks).
- The live code is `service/` (FastAPI + Supabase Postgres). `apps-script/` is the old bot, still deployed — leave it alone.
- Repo is public: never commit `.env`, tokens, the webhook secret, tunnel addresses, or lead data.
- `SEND_ENABLED` stays `false` until the user explicitly says to start sending.
