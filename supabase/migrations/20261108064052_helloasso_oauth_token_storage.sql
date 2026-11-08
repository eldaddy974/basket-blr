create table if not exists public.helloasso_oauth_state (
  id text primary key check (id = 'main'),
  access_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.helloasso_oauth_state enable row level security;
revoke all on table public.helloasso_oauth_state from anon, authenticated;
grant select, insert, update, delete on table public.helloasso_oauth_state to service_role;