create extension if not exists pgcrypto;

create type event_status as enum ('DRAFT', 'READY', 'LIVE', 'ARCHIVED');
create type juror_type as enum ('ARTIST', 'REGIE', 'GAST');
create type round_type as enum ('JURY', 'PUBLIC', 'RUNOFF');
create type round_status as enum ('DRAFT', 'OPEN', 'CLOSED', 'VALIDATED', 'REVEALED');
create type session_kind as enum ('PUBLIC', 'JURY');
create type session_status as enum ('ACTIVE', 'REVOKED', 'BLOCKED');
create type ballot_status as enum ('DRAFT', 'SUBMITTED', 'LOCKED', 'BLOCKED', 'SUPERSEDED');

create table events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  year integer not null check (year between 2000 and 2200),
  status event_status not null default 'DRAFT',
  timezone text not null default 'Europe/Berlin',
  locale text not null default 'de-DE',
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table countries (
  id uuid primary key default gen_random_uuid(),
  iso_code char(2) not null unique,
  display_name text not null,
  flag_asset_path text
);

create table acts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  country_id uuid not null references countries(id),
  start_number integer not null check (start_number > 0),
  pseudonym text not null,
  song_title text not null,
  identity_revealed boolean not null default false,
  active boolean not null default true,
  unique(event_id, start_number)
);

create table artists (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  real_name text not null,
  active boolean not null default true
);

create table act_artists (
  act_id uuid not null references acts(id) on delete cascade,
  artist_id uuid not null references artists(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (act_id, artist_id)
);

create table jurors (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  display_name text not null,
  type juror_type not null,
  pin_hash text not null,
  enabled boolean not null default true,
  self_vote_policy_override text check (self_vote_policy_override in ('BLOCK_LINKED_ACTS', 'ALLOW')),
  reveal_order integer not null default 0,
  unique(event_id, display_name)
);

create table juror_artists (
  juror_id uuid not null references jurors(id) on delete cascade,
  artist_id uuid not null references artists(id) on delete cascade,
  primary key (juror_id, artist_id)
);

create table ballot_rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  type round_type not null,
  status round_status not null default 'DRAFT',
  sequence_number integer not null default 1,
  point_scale_json jsonb not null,
  opened_at timestamptz,
  closed_at timestamptz,
  unique(event_id, type, sequence_number)
);

create table voter_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  kind session_kind not null,
  juror_id uuid references jurors(id),
  cookie_token_hash text,
  status session_status not null default 'ACTIVE',
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create unique index one_jury_session_per_event
  on voter_sessions(event_id, juror_id)
  where kind = 'JURY' and juror_id is not null and status = 'ACTIVE';

create table ballots (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references ballot_rounds(id) on delete cascade,
  voter_session_id uuid not null references voter_sessions(id),
  revision integer not null check (revision > 0),
  status ballot_status not null default 'DRAFT',
  submitted_at timestamptz,
  supersedes_ballot_id uuid references ballots(id),
  administrative_reason text,
  created_at timestamptz not null default now(),
  unique(round_id, voter_session_id, revision)
);

create unique index one_active_ballot_revision
  on ballots(round_id, voter_session_id)
  where status in ('SUBMITTED', 'LOCKED');

create table ballot_entries (
  ballot_id uuid not null references ballots(id) on delete cascade,
  act_id uuid not null references acts(id),
  points integer,
  selected boolean,
  primary key (ballot_id, act_id),
  check ((points is not null and selected is null) or (points is null and selected is not null))
);

create table score_snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  revision bigint not null,
  reason text not null,
  scores_json jsonb not null,
  created_at timestamptz not null default now(),
  unique(event_id, revision)
);

create table show_state (
  event_id uuid primary key references events(id) on delete cascade,
  revision bigint not null default 0,
  phase text not null,
  substate text,
  current_act_id uuid references acts(id),
  current_step_id uuid,
  screen_a_view text not null default 'RUHE',
  screen_b_view text not null default 'RANGLISTE',
  paused boolean not null default false,
  state_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table presentation_steps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  phase text not null,
  sequence_number integer not null,
  payload_json jsonb not null,
  visibility_state text not null check (visibility_state in ('VERBORGEN', 'MODERATOR_FREIGEGEBEN', 'BEAMER_SICHTBAR', 'VERBUCHT')),
  committed_at timestamptz,
  unique(event_id, phase, sequence_number)
);

alter table show_state
  add constraint show_state_current_step_fk
  foreign key (current_step_id) references presentation_steps(id);

create table timecode_cues (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  act_id uuid references acts(id) on delete cascade,
  timecode text not null check (timecode ~ '^\d{2}:\d{2}:\d{2}:\d{2}$'),
  frame_rate numeric(6,3) not null,
  event_type text not null,
  payload_json jsonb not null default '{}'::jsonb,
  catch_up_policy text not null default 'SKIP' check (catch_up_policy in ('SKIP', 'TRIGGER')),
  enabled boolean not null default true
);

create table output_mappings (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  event_type text not null,
  condition_json jsonb not null default '{}'::jsonb,
  adapter_type text not null check (adapter_type in ('NONE', 'MIDI_NOTE', 'MIDI_CC', 'OSC')),
  output_payload_json jsonb not null default '{}'::jsonb,
  enabled boolean not null default true
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete set null,
  actor_type text not null,
  actor_id text,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_json jsonb,
  after_json jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index ballots_round_idx on ballots(round_id, status);
create index ballot_entries_act_idx on ballot_entries(act_id);
create index audit_event_created_idx on audit_log(event_id, created_at desc);
create index presentation_event_sequence_idx on presentation_steps(event_id, phase, sequence_number);
