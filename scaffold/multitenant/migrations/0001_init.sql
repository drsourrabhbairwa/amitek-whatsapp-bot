-- Draft schema for the multi-tenant AI sales agent platform.
-- Not applied anywhere yet. Review before running against any real database.
-- Every table carries tenant_id and has row-level security enabled, so a
-- query that forgets a tenant filter fails closed rather than leaking data.

create table tenants (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    plan text not null default 'starter',  -- starter | growth | scale
    whatsapp_categories text[] not null default array['applicator','contractor','builder','architect'],
    created_at timestamptz not null default now()
);

create table users (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    role text not null default 'member',  -- owner | admin | member
    name text not null,
    whatsapp_number text,                 -- for team members who get handoffs
    email text,
    created_at timestamptz not null default now()
);

create table whatsapp_numbers (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    phone_number_id text not null,        -- BlueTick/Meta phone number id
    display_number text,
    bluetick_token_ref text,              -- reference to secret storage, never the token itself
    created_at timestamptz not null default now()
);

create table documents (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    filename text not null,
    kind text not null,                   -- pdf | xlsx | docx
    storage_path text not null,           -- Supabase Storage path
    uploaded_by uuid references users(id),
    created_at timestamptz not null default now()
);

create table knowledge_chunks (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    source text not null,                 -- 'document' | 'chat'
    document_id uuid references documents(id) on delete cascade,
    content text not null,
    embedding vector(1536),
    created_at timestamptz not null default now()
);
create index on knowledge_chunks using hnsw (embedding vector_cosine_ops);

create table leads (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    phone text not null,
    name text,
    category text,                        -- applicator | contractor | builder | architect | dealer | manufacturer
    city text,
    stage text not null default 'new',    -- new | discover | diagnose | recommend | quote | close | won | lost
    owner_id uuid references users(id),
    opted_out boolean not null default false,
    follow_up_at timestamptz,
    created_at timestamptz not null default now(),
    unique (tenant_id, phone)
);

create table messages (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    lead_id uuid not null references leads(id) on delete cascade,
    direction text not null,              -- inbound | outbound
    body text not null,
    sent_by text,                         -- 'agent' | 'human:<user_id>'
    created_at timestamptz not null default now()
);

create table campaigns (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    name text not null,
    template_name text,
    lead_filter jsonb,                    -- e.g. {"category": "applicator", "city": "Jaipur"}
    scheduled_at timestamptz,
    created_by uuid references users(id),
    created_at timestamptz not null default now()
);

-- Row-level security: every table is scoped to the caller's tenant.
-- (Policy predicate shown once; apply the same pattern to each table above.)
alter table leads enable row level security;
create policy tenant_isolation on leads
    using (tenant_id = current_setting('app.current_tenant_id')::uuid);
-- Repeat `alter table ... enable row level security;` + an equivalent policy
-- for users, whatsapp_numbers, documents, knowledge_chunks, messages, campaigns
-- before this schema is applied anywhere real.
