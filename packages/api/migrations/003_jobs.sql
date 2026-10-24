create table jobs (
  id uuid primary key,
  type text not null check (type in ('crawl', 'batch')),
  api_key_id uuid references api_keys(id),
  status text not null default 'scraping' check (status in ('scraping', 'completed', 'failed', 'cancelled')),
  request jsonb not null,
  webhook jsonb,
  page_limit int not null,
  total int not null default 0,
  completed int not null default 0,
  failed int not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null
);
create index jobs_api_key_status_idx on jobs (api_key_id, status);
create index jobs_expires_idx on jobs (expires_at);

alter table scrapes add column job_id uuid references jobs(id) on delete cascade;
alter table scrapes add column seq bigserial;
create index scrapes_job_seq_idx on scrapes (job_id, seq);

create table job_errors (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  url text not null,
  error text not null,
  code text,
  kind text not null check (kind in ('error', 'robots')),
  created_at timestamptz not null default now()
);
create index job_errors_job_idx on job_errors (job_id, created_at);
