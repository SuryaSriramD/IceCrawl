create table monitors (
  id uuid primary key,
  api_key_id uuid references api_keys(id),
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  cron text not null,
  timezone text not null default 'UTC',
  targets jsonb not null,
  webhook jsonb,
  notification jsonb,
  retention_days int not null default 30,
  goal text,
  judge_enabled boolean not null default false,
  next_run_at timestamptz,
  last_run_at timestamptz,
  current_check_id uuid,
  last_check_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index monitors_key_idx on monitors (api_key_id, created_at);
create index monitors_due_idx on monitors (next_run_at) where status = 'active';

create table monitor_checks (
  id uuid primary key,
  monitor_id uuid not null references monitors(id) on delete cascade,
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'partial', 'skipped_overlap', 'skipped_no_credits')),
  trigger text not null check (trigger in ('scheduled', 'manual')),
  scheduled_for timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  summary jsonb,
  target_results jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index monitor_checks_monitor_idx on monitor_checks (monitor_id, created_at desc);

create table monitor_pages (
  id uuid primary key,
  check_id uuid not null references monitor_checks(id) on delete cascade,
  seq bigserial,
  target_id text not null,
  url text not null,
  status text not null check (status in ('same', 'new', 'changed', 'removed', 'error')),
  previous_scrape_id uuid,
  current_scrape_id uuid,
  status_code int,
  error text,
  metadata jsonb,
  diff jsonb,
  created_at timestamptz not null default now()
);
create index monitor_pages_check_idx on monitor_pages (check_id, seq);

create table monitor_baselines (
  monitor_id uuid not null references monitors(id) on delete cascade,
  url text not null,
  target_id text not null,
  content_hash text not null,
  markdown text not null,
  scrape_id uuid,
  seen_at timestamptz not null default now(),
  primary key (monitor_id, url)
);
