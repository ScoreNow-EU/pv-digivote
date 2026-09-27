insert into events (id, name, year, status, timezone, locale, config_json)
values (
  '00000000-0000-4000-8000-000000000001',
  'PastEurovision 2026',
  2026,
  'READY',
  'Europe/Berlin',
  'de-DE',
  '{
    "locale": "de-DE",
    "pointScale": [1, 2, 3, 4, 5, 6, 7, 8, 10, 12],
    "requireCompleteBallot": true,
    "selfVotePolicy": "BLOCK_LINKED_ACTS",
    "weights": { "jury": 0.5, "public": 0.5 },
    "juryReveal": { "bulkPoints": [1, 2, 3, 4, 5, 6, 7], "individualPoints": [8, 10, 12] },
    "timecode": { "frameRate": 25, "manualFallback": true }
  }'::jsonb
)
on conflict (id) do nothing;

insert into countries (id, iso_code, display_name, flag_asset_path)
values
  ('00000000-0000-4000-8100-000000000001', 'DE', 'Deutschland', null),
  ('00000000-0000-4000-8100-000000000002', 'SE', 'Schweden', null),
  ('00000000-0000-4000-8100-000000000003', 'FI', 'Finnland', null),
  ('00000000-0000-4000-8100-000000000004', 'IT', 'Italien', null),
  ('00000000-0000-4000-8100-000000000005', 'ES', 'Spanien', null),
  ('00000000-0000-4000-8100-000000000006', 'FR', 'Frankreich', null),
  ('00000000-0000-4000-8100-000000000007', 'NL', 'Niederlande', null),
  ('00000000-0000-4000-8100-000000000008', 'NO', 'Norwegen', null),
  ('00000000-0000-4000-8100-000000000009', 'AT', 'Österreich', null),
  ('00000000-0000-4000-8100-000000000010', 'IE', 'Irland', null),
  ('00000000-0000-4000-8100-000000000011', 'GB', 'Vereinigtes Königreich', null),
  ('00000000-0000-4000-8100-000000000012', 'CH', 'Schweiz', null)
on conflict (id) do nothing;

insert into acts (id, event_id, country_id, start_number, pseudonym, song_title, identity_revealed)
select
  format('00000000-0000-4000-8200-%s', lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  format('00000000-0000-4000-8100-%s', lpad(n::text, 12, '0'))::uuid,
  n,
  format('Act %s', lpad(n::text, 2, '0')),
  format('Songtitel %s', lpad(n::text, 2, '0')),
  n <= 4
from generate_series(1, 12) as n
on conflict (id) do nothing;

insert into artists (id, event_id, real_name)
select
  format('00000000-0000-4000-8300-%s', lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  format('Klarname %s', lpad(n::text, 2, '0'))
from generate_series(1, 12) as n
on conflict (id) do nothing;

insert into act_artists (act_id, artist_id, sort_order)
select
  format('00000000-0000-4000-8200-%s', lpad(n::text, 12, '0'))::uuid,
  format('00000000-0000-4000-8300-%s', lpad(n::text, 12, '0'))::uuid,
  0
from generate_series(1, 12) as n
on conflict (act_id, artist_id) do nothing;

insert into jurors (id, event_id, display_name, type, pin_hash, reveal_order)
select
  format('00000000-0000-4000-8400-%s', lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  format('Klarname %s', lpad(n::text, 2, '0')),
  'ARTIST'::juror_type,
  crypt((1000 + n)::text, gen_salt('bf', 10)),
  n
from generate_series(1, 9) as n
on conflict (id) do nothing;

insert into jurors (id, event_id, display_name, type, pin_hash, reveal_order)
values (
  '00000000-0000-4000-8400-000000000010',
  '00000000-0000-4000-8000-000000000001',
  'Regie',
  'REGIE',
  crypt('1010', gen_salt('bf', 10)),
  10
)
on conflict (id) do nothing;

insert into juror_artists (juror_id, artist_id)
select
  format('00000000-0000-4000-8400-%s', lpad(n::text, 12, '0'))::uuid,
  format('00000000-0000-4000-8300-%s', lpad(n::text, 12, '0'))::uuid
from generate_series(1, 9) as n
on conflict (juror_id, artist_id) do nothing;

insert into ballot_rounds (id, event_id, type, status, sequence_number, point_scale_json, opened_at)
values
  (
    '00000000-0000-4000-8500-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'JURY',
    'OPEN',
    1,
    '[1, 2, 3, 4, 5, 6, 7, 8, 10, 12]'::jsonb,
    now()
  ),
  (
    '00000000-0000-4000-8500-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'PUBLIC',
    'DRAFT',
    1,
    '[1, 2, 3, 4, 5, 6, 7, 8, 10, 12]'::jsonb,
    null
  )
on conflict (id) do nothing;

insert into timecode_cues (event_id, act_id, timecode, frame_rate, event_type, payload_json, catch_up_policy)
select
  '00000000-0000-4000-8000-000000000001'::uuid,
  format('00000000-0000-4000-8200-%s', lpad(n::text, 12, '0'))::uuid,
  format('00:%s:00:00', lpad((n - 1)::text, 2, '0')),
  25,
  'ACT_IDENTITY_REVEAL',
  jsonb_build_object('actId', format('00000000-0000-4000-8200-%s', lpad(n::text, 12, '0'))),
  'SKIP'
from generate_series(1, 12) as n;

create unique index if not exists one_public_session_per_cookie
  on voter_sessions(event_id, cookie_token_hash)
  where kind = 'PUBLIC' and cookie_token_hash is not null and status = 'ACTIVE';
