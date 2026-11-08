create table if not exists public.inscription_evenements (
  id uuid primary key default gen_random_uuid(),
  inscription_id uuid not null,
  session_id text not null,
  session_nom text,
  session_debut_date timestamptz,
  session_horaires text,
  prenom text not null,
  nom text not null,
  est_invite boolean not null default false,
  invite_par_nom text,
  est_abonne boolean not null default false,
  type_evenement text not null check (type_evenement in ('vote', 'annulation')),
  statut text check (statut is null or statut in ('confirmed', 'waitlisted')),
  date_demande bigint,
  acteur text,
  created_at timestamptz not null default now()
);

create index if not exists inscription_evenements_session_created_idx
  on public.inscription_evenements (session_id, created_at desc);
create index if not exists inscription_evenements_inscription_idx
  on public.inscription_evenements (inscription_id, created_at desc);

alter table public.inscription_evenements enable row level security;
revoke all on table public.inscription_evenements from anon, authenticated;
grant select, insert on table public.inscription_evenements to service_role;
