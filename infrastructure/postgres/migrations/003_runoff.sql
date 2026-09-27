create table runoff_candidates (
  round_id uuid not null references ballot_rounds(id) on delete cascade,
  act_id uuid not null references acts(id),
  primary key (round_id, act_id)
);

create index runoff_candidates_act_idx on runoff_candidates(act_id);
