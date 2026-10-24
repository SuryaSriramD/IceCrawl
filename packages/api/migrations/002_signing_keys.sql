create table signing_keys (
  key_id text primary key,
  public_key text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
