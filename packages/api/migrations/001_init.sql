create table api_keys (
  id uuid primary key,
  hash text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table scrapes (
  id uuid primary key,
  api_key_id uuid references api_keys(id),
  url text not null,
  final_url text,
  verdict text not null,
  confidence real not null,
  engine text,
  status_code int,
  markdown text,
  metadata jsonb not null default '{}',
  response jsonb not null,
  created_at timestamptz not null default now()
);

create table snapshots (
  id uuid primary key default gen_random_uuid(),
  scrape_id uuid not null references scrapes(id) on delete cascade,
  html_sha256 text not null,
  storage_key text not null,
  bytes bigint not null
);
create index snapshots_html_sha256_idx on snapshots (html_sha256);

create table receipts (
  id uuid primary key references scrapes(id) on delete cascade,
  body jsonb not null,
  signature text,
  key_id text
);
