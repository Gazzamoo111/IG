-- MOVA demo identity, challenge and analytics-ready extensions.
-- Normal driver use remains anonymous. participant_id is optional.

alter table public.mova_fleets
  add column if not exists driver_population integer
  check (driver_population is null or driver_population >= 0);

alter table public.mova_sites
  add column if not exists driver_population integer
  check (driver_population is null or driver_population >= 0);

create table if not exists public.mova_participants (
  id uuid primary key default gen_random_uuid(),
  fleet_id uuid not null references public.mova_fleets(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  member_ref text,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fleet_id, member_ref)
);

create table if not exists public.mova_participant_devices (
  participant_id uuid not null references public.mova_participants(id) on delete cascade,
  device_id uuid not null references public.mova_devices(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (participant_id, device_id)
);

create table if not exists public.mova_challenges (
  id uuid primary key default gen_random_uuid(),
  owner_fleet_id uuid references public.mova_fleets(id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  scope text not null default 'fleet' check (scope in ('fleet','site','participant')),
  metric text not null default 'movement_minutes'
    check (metric in ('completed_sessions','movement_minutes','active_days')),
  status text not null default 'draft'
    check (status in ('draft','active','completed','cancelled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reward_description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.mova_challenge_fleets (
  challenge_id uuid not null references public.mova_challenges(id) on delete cascade,
  fleet_id uuid not null references public.mova_fleets(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (challenge_id, fleet_id)
);

create table if not exists public.mova_challenge_participants (
  challenge_id uuid not null references public.mova_challenges(id) on delete cascade,
  participant_id uuid not null references public.mova_participants(id) on delete cascade,
  display_name_override text,
  joined_at timestamptz not null default now(),
  primary key (challenge_id, participant_id)
);

alter table public.mova_session_runs
  add column if not exists participant_id uuid
  references public.mova_participants(id) on delete set null;

create index if not exists mova_session_runs_participant_idx
  on public.mova_session_runs(participant_id)
  where participant_id is not null;

create index if not exists mova_participants_fleet_idx
  on public.mova_participants(fleet_id);

create index if not exists mova_challenges_status_dates_idx
  on public.mova_challenges(status, starts_at, ends_at);

alter table public.mova_participants enable row level security;
alter table public.mova_participant_devices enable row level security;
alter table public.mova_challenges enable row level security;
alter table public.mova_challenge_fleets enable row level security;
alter table public.mova_challenge_participants enable row level security;

revoke all on table public.mova_participants from anon, authenticated;
revoke all on table public.mova_participant_devices from anon, authenticated;
revoke all on table public.mova_challenges from anon, authenticated;
revoke all on table public.mova_challenge_fleets from anon, authenticated;
revoke all on table public.mova_challenge_participants from anon, authenticated;

grant select, insert, update, delete on table public.mova_participants to service_role;
grant select, insert, update, delete on table public.mova_participant_devices to service_role;
grant select, insert, update, delete on table public.mova_challenges to service_role;
grant select, insert, update, delete on table public.mova_challenge_fleets to service_role;
grant select, insert, update, delete on table public.mova_challenge_participants to service_role;
