import pg from "pg";
import type { Act, Artist, Ballot, BallotEntry, EventConfig, Juror } from "@pv/domain";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getDatabasePool(connectionString = process.env.DATABASE_URL): pg.Pool | undefined {
  if (!connectionString) return undefined;
  pool ??= new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  return pool;
}

export async function pingDatabase(): Promise<"configured" | "unconfigured"> {
  const database = getDatabasePool();
  if (!database) return "unconfigured";
  await database.query("select 1 as ok");
  return "configured";
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

export interface EventRecord {
  id: string;
  name: string;
  year: number;
  status: "DRAFT" | "READY" | "LIVE" | "ARCHIVED";
  config: EventConfig;
  updatedAt: string;
}

export interface EventBundle {
  event: EventRecord;
  acts: Array<Act & { artistNames: string[] }>;
  artists: Artist[];
  jurors: Juror[];
}

export interface VoterSessionRecord {
  id: string;
  eventId: string;
  kind: "PUBLIC" | "JURY";
  jurorId?: string;
  status: "ACTIVE" | "REVOKED" | "BLOCKED";
}

export interface TimecodeCueRecord {
  id: string;
  eventId: string;
  actId: string | null;
  timecode: string;
  frameRate: number;
  eventType: string;
  payload: Record<string, unknown>;
  catchUpPolicy: "SKIP" | "TRIGGER";
}

export interface RunoffRecord {
  roundId: string;
  sequenceNumber: number;
  status: "DRAFT" | "OPEN" | "CLOSED" | "VALIDATED" | "REVEALED";
  candidateActIds: string[];
  voteCount: number;
}

function requireDatabase(): pg.Pool {
  const database = getDatabasePool();
  if (!database) throw new Error("DATABASE_URL ist nicht gesetzt.");
  return database;
}

export async function getActiveEventBundle(): Promise<EventBundle | undefined> {
  const database = requireDatabase();
  const eventResult = await database.query<{
    id: string;
    name: string;
    year: number;
    status: EventRecord["status"];
    config_json: EventConfig;
    updated_at: Date;
  }>(`
    select id, name, year, status, config_json, updated_at
    from events
    where status <> 'ARCHIVED'
    order by case status when 'LIVE' then 0 when 'READY' then 1 else 2 end, updated_at desc
    limit 1
  `);
  const eventRow = eventResult.rows[0];
  if (!eventRow) return undefined;

  const [actsResult, artistsResult, jurorsResult] = await Promise.all([
    database.query<{
      id: string;
      start_number: number;
      country_id: string;
      iso_code: string;
      display_name: string;
      flag_asset_path: string | null;
      pseudonym: string;
      song_title: string;
      identity_revealed: boolean;
      artist_ids: string[];
      artist_names: string[];
    }>(`
      select
        a.id,
        a.start_number,
        c.id as country_id,
        c.iso_code,
        c.display_name,
        c.flag_asset_path,
        a.pseudonym,
        a.song_title,
        a.identity_revealed,
        coalesce(array_agg(ar.id order by aa.sort_order) filter (where ar.id is not null), '{}') as artist_ids,
        coalesce(array_agg(ar.real_name order by aa.sort_order) filter (where ar.id is not null), '{}') as artist_names
      from acts a
      join countries c on c.id = a.country_id
      left join act_artists aa on aa.act_id = a.id
      left join artists ar on ar.id = aa.artist_id
      where a.event_id = $1 and a.active = true
      group by a.id, c.id
      order by a.start_number
    `, [eventRow.id]),
    database.query<{
      id: string;
      real_name: string;
      act_ids: string[];
    }>(`
      select ar.id, ar.real_name,
        coalesce(array_agg(aa.act_id order by a.start_number) filter (where aa.act_id is not null), '{}') as act_ids
      from artists ar
      left join act_artists aa on aa.artist_id = ar.id
      left join acts a on a.id = aa.act_id
      where ar.event_id = $1 and ar.active = true
      group by ar.id
      order by ar.real_name
    `, [eventRow.id]),
    database.query<{
      id: string;
      display_name: string;
      type: Juror["type"];
      self_vote_policy_override: Juror["selfVotePolicyOverride"] | null;
      reveal_order: number;
      enabled: boolean;
      artist_ids: string[];
      linked_act_ids: string[];
    }>(`
      select
        j.id,
        j.display_name,
        j.type,
        j.self_vote_policy_override,
        j.reveal_order,
        j.enabled,
        coalesce(array_agg(distinct ja.artist_id) filter (where ja.artist_id is not null), '{}') as artist_ids,
        coalesce(array_agg(distinct aa.act_id) filter (where aa.act_id is not null), '{}') as linked_act_ids
      from jurors j
      left join juror_artists ja on ja.juror_id = j.id
      left join act_artists aa on aa.artist_id = ja.artist_id
      where j.event_id = $1
      group by j.id
      order by j.reveal_order, j.display_name
    `, [eventRow.id])
  ]);

  return {
    event: {
      id: eventRow.id,
      name: eventRow.name,
      year: eventRow.year,
      status: eventRow.status,
      config: eventRow.config_json,
      updatedAt: eventRow.updated_at.toISOString()
    },
    acts: actsResult.rows.map((row) => ({
      id: row.id,
      startNumber: row.start_number,
      country: {
        id: row.country_id,
        isoCode: row.iso_code,
        displayName: row.display_name,
        flag: row.flag_asset_path ?? row.iso_code
      },
      pseudonym: row.pseudonym,
      songTitle: row.song_title,
      artistIds: row.artist_ids,
      artistNames: row.artist_names,
      identityRevealed: row.identity_revealed
    })),
    artists: artistsResult.rows.map((row) => ({ id: row.id, realName: row.real_name, actIds: row.act_ids })),
    jurors: jurorsResult.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      type: row.type,
      artistIds: row.artist_ids,
      linkedActIds: row.linked_act_ids,
      ...(row.self_vote_policy_override ? { selfVotePolicyOverride: row.self_vote_policy_override } : {}),
      enabled: row.enabled,
      revealOrder: row.reveal_order
    }))
  };
}

export async function verifyJurorPin(jurorId: string, pin: string): Promise<boolean> {
  const result = await requireDatabase().query<{ valid: boolean }>(`
    select exists(
      select 1 from jurors
      where id = $1 and enabled = true and pin_hash = crypt($2, pin_hash)
    ) as valid
  `, [jurorId, pin]);
  return result.rows[0]?.valid ?? false;
}

export async function getOrCreatePublicSession(eventId: string, tokenHash: string): Promise<VoterSessionRecord> {
  const result = await requireDatabase().query<{
    id: string;
    event_id: string;
    kind: "PUBLIC";
    status: VoterSessionRecord["status"];
  }>(`
    insert into voter_sessions(event_id, kind, cookie_token_hash)
    values ($1, 'PUBLIC', $2)
    on conflict (event_id, cookie_token_hash)
      where kind = 'PUBLIC' and cookie_token_hash is not null and status = 'ACTIVE'
    do update set last_seen_at = now()
    returning id, event_id, kind, status
  `, [eventId, tokenHash]);
  const row = result.rows[0]!;
  return { id: row.id, eventId: row.event_id, kind: row.kind, status: row.status };
}

export async function getOrCreateJurySession(eventId: string, jurorId: string): Promise<VoterSessionRecord> {
  const result = await requireDatabase().query<{
    id: string;
    event_id: string;
    kind: "JURY";
    juror_id: string;
    status: VoterSessionRecord["status"];
  }>(`
    insert into voter_sessions(event_id, kind, juror_id)
    values ($1, 'JURY', $2)
    on conflict (event_id, juror_id)
      where kind = 'JURY' and juror_id is not null and status = 'ACTIVE'
    do update set last_seen_at = now()
    returning id, event_id, kind, juror_id, status
  `, [eventId, jurorId]);
  const row = result.rows[0]!;
  return { id: row.id, eventId: row.event_id, kind: row.kind, jurorId: row.juror_id, status: row.status };
}

export async function setSessionTokenHash(sessionId: string, tokenHash: string): Promise<void> {
  await requireDatabase().query(
    "update voter_sessions set cookie_token_hash = $2, last_seen_at = now() where id = $1",
    [sessionId, tokenHash]
  );
}

export async function getSessionByTokenHash(
  eventId: string,
  tokenHash: string,
  kind: "PUBLIC" | "JURY"
): Promise<VoterSessionRecord | undefined> {
  const result = await requireDatabase().query<{
    id: string;
    event_id: string;
    kind: "PUBLIC" | "JURY";
    juror_id: string | null;
    status: VoterSessionRecord["status"];
  }>(`
    update voter_sessions
    set last_seen_at = now()
    where id = (
      select id from voter_sessions
      where event_id = $1 and cookie_token_hash = $2 and kind = $3 and status = 'ACTIVE'
      limit 1
    )
    returning id, event_id, kind, juror_id, status
  `, [eventId, tokenHash, kind]);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    eventId: row.event_id,
    kind: row.kind,
    ...(row.juror_id ? { jurorId: row.juror_id } : {}),
    status: row.status
  };
}

export async function submitBallot(input: {
  eventId: string;
  group: "JURY" | "PUBLIC" | "RUNOFF";
  voterSessionId: string;
  entries: BallotEntry[];
}): Promise<Ballot> {
  const database = requireDatabase();
  const client = await database.connect();
  try {
    await client.query("begin");
    await client.query("select id from voter_sessions where id = $1 for update", [input.voterSessionId]);
    const roundResult = await client.query<{ id: string }>(`
      select id from ballot_rounds
      where event_id = $1 and type = $2 and status = 'OPEN'
      order by sequence_number desc
      limit 1
    `, [input.eventId, input.group]);
    const roundId = roundResult.rows[0]?.id;
    if (!roundId) throw new Error("Diese Abstimmung ist geschlossen.");

    const revisionResult = await client.query<{ next_revision: number }>(`
      select coalesce(max(revision), 0) + 1 as next_revision
      from ballots where round_id = $1 and voter_session_id = $2
    `, [roundId, input.voterSessionId]);
    const revision = Number(revisionResult.rows[0]?.next_revision ?? 1);

    const previousResult = await client.query<{ id: string }>(`
      update ballots set status = 'SUPERSEDED'
      where round_id = $1 and voter_session_id = $2 and status in ('SUBMITTED', 'LOCKED')
      returning id
    `, [roundId, input.voterSessionId]);
    const previousId = previousResult.rows[0]?.id;

    const ballotResult = await client.query<{ id: string; submitted_at: Date }>(`
      insert into ballots(round_id, voter_session_id, revision, status, submitted_at, supersedes_ballot_id)
      values ($1, $2, $3, 'SUBMITTED', now(), $4)
      returning id, submitted_at
    `, [roundId, input.voterSessionId, revision, previousId ?? null]);
    const ballotRow = ballotResult.rows[0]!;
    for (const entry of input.entries) {
      await client.query(
        "insert into ballot_entries(ballot_id, act_id, points) values ($1, $2, $3)",
        [ballotRow.id, entry.actId, entry.points]
      );
    }
    await client.query("commit");
    return {
      id: ballotRow.id,
      voterId: input.voterSessionId,
      group: input.group,
      revision,
      status: "SUBMITTED",
      entries: input.entries,
      submittedAt: ballotRow.submitted_at.toISOString()
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getCurrentBallot(voterSessionId: string, group: "JURY" | "PUBLIC" | "RUNOFF"): Promise<Ballot | undefined> {
  const result = await requireDatabase().query<{
    id: string;
    voter_session_id: string;
    revision: number;
    status: Ballot["status"];
    submitted_at: Date | null;
    entries: BallotEntry[];
  }>(`
    select b.id, b.voter_session_id, b.revision, b.status, b.submitted_at,
      coalesce(jsonb_agg(jsonb_build_object('actId', be.act_id, 'points', be.points) order by be.points)
        filter (where be.act_id is not null), '[]'::jsonb) as entries
    from ballots b
    join ballot_rounds br on br.id = b.round_id
    left join ballot_entries be on be.ballot_id = b.id
    where b.voter_session_id = $1 and br.type = $2 and b.status in ('SUBMITTED', 'LOCKED')
    group by b.id
    order by b.revision desc
    limit 1
  `, [voterSessionId, group]);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    voterId: row.voter_session_id,
    group,
    revision: row.revision,
    status: row.status,
    entries: row.entries,
    ...(row.submitted_at ? { submittedAt: row.submitted_at.toISOString() } : {})
  };
}

export async function getBallotCounts(eventId: string): Promise<{ jury: number; public: number }> {
  const result = await requireDatabase().query<{ type: "JURY" | "PUBLIC"; count: string }>(`
    select br.type, count(*)::text as count
    from ballots b
    join ballot_rounds br on br.id = b.round_id
    where br.event_id = $1 and b.status in ('SUBMITTED', 'LOCKED') and br.type in ('JURY', 'PUBLIC')
    group by br.type
  `, [eventId]);
  return {
    jury: Number(result.rows.find((row) => row.type === "JURY")?.count ?? 0),
    public: Number(result.rows.find((row) => row.type === "PUBLIC")?.count ?? 0)
  };
}

export async function getRoundStatuses(eventId: string): Promise<{ juryOpen: boolean; publicOpen: boolean }> {
  const result = await requireDatabase().query<{ type: "JURY" | "PUBLIC"; status: string }>(`
    select distinct on (type) type, status
    from ballot_rounds
    where event_id = $1 and type in ('JURY', 'PUBLIC')
    order by type, sequence_number desc
  `, [eventId]);
  return {
    juryOpen: result.rows.find((row) => row.type === "JURY")?.status === "OPEN",
    publicOpen: result.rows.find((row) => row.type === "PUBLIC")?.status === "OPEN"
  };
}

export async function getCountingBallots(eventId: string): Promise<{ jury: Ballot[]; public: Ballot[] }> {
  const result = await requireDatabase().query<{
    id: string;
    voter_session_id: string;
    type: "JURY" | "PUBLIC";
    revision: number;
    status: Ballot["status"];
    submitted_at: Date | null;
    entries: BallotEntry[];
  }>(`
    select b.id, b.voter_session_id, br.type, b.revision, b.status, b.submitted_at,
      jsonb_agg(jsonb_build_object('actId', be.act_id, 'points', be.points) order by be.points) as entries
    from ballots b
    join ballot_rounds br on br.id = b.round_id
    join ballot_entries be on be.ballot_id = b.id
    where br.event_id = $1 and b.status in ('SUBMITTED', 'LOCKED') and br.type in ('JURY', 'PUBLIC')
    group by b.id, br.type
  `, [eventId]);
  const ballots = result.rows.map((row): Ballot => ({
    id: row.id,
    voterId: row.voter_session_id,
    group: row.type,
    revision: row.revision,
    status: row.status,
    entries: row.entries,
    ...(row.submitted_at ? { submittedAt: row.submitted_at.toISOString() } : {})
  }));
  return {
    jury: ballots.filter((ballot) => ballot.group === "JURY"),
    public: ballots.filter((ballot) => ballot.group === "PUBLIC")
  };
}

export async function getJuryAward(eventId: string, jurorId: string, points: number): Promise<string | undefined> {
  const result = await requireDatabase().query<{ act_id: string }>(`
    select be.act_id
    from ballots b
    join ballot_rounds br on br.id = b.round_id
    join voter_sessions vs on vs.id = b.voter_session_id
    join ballot_entries be on be.ballot_id = b.id
    where br.event_id = $1
      and br.type = 'JURY'
      and vs.juror_id = $2
      and b.status in ('SUBMITTED', 'LOCKED')
      and be.points = $3
    order by b.revision desc
    limit 1
  `, [eventId, jurorId, points]);
  return result.rows[0]?.act_id;
}

export async function setRoundOpen(eventId: string, group: "JURY" | "PUBLIC", open: boolean): Promise<void> {
  await requireDatabase().query(`
    update ballot_rounds
    set status = $3::round_status,
        opened_at = case when $3 = 'OPEN' then coalesce(opened_at, now()) else opened_at end,
        closed_at = case when $3 = 'CLOSED' then now() else null end
    where id = (
      select id from ballot_rounds where event_id = $1 and type = $2 order by sequence_number desc limit 1
    )
  `, [eventId, group, open ? "OPEN" : "CLOSED"]);
}

export async function revealActIdentity(actId: string): Promise<void> {
  await requireDatabase().query("update acts set identity_revealed = true where id = $1", [actId]);
}

export async function updateEventConfig(eventId: string, config: EventConfig): Promise<void> {
  await requireDatabase().query(
    "update events set config_json = $2::jsonb, updated_at = now() where id = $1",
    [eventId, JSON.stringify(config)]
  );
}

export interface EditableActInput {
  id?: string;
  startNumber: number;
  countryIsoCode: string;
  countryName: string;
  pseudonym: string;
  songTitle: string;
  artistNames: string[];
}

export interface EditableJurorInput {
  id?: string;
  displayName: string;
  type: Juror["type"];
  pin?: string;
  enabled: boolean;
  revealOrder: number;
  linkedActId?: string;
}

export async function replaceEventActs(eventId: string, inputs: readonly EditableActInput[]): Promise<void> {
  const database = requireDatabase();
  const client = await database.connect();
  try {
    await client.query("begin");
    await client.query("update acts set start_number = start_number + 1000 where event_id = $1", [eventId]);
    const retainedIds: string[] = [];
    for (const input of inputs) {
      const country = await client.query<{ id: string }>(`
        insert into countries(iso_code, display_name, flag_asset_path)
        values ($1, $2, null)
        on conflict (iso_code) do update set display_name = excluded.display_name
        returning id
      `, [input.countryIsoCode, input.countryName]);
      const existing = input.id
        ? await client.query<{ id: string }>("select id from acts where id = $1 and event_id = $2", [input.id, eventId])
        : { rows: [] };
      const act = existing.rows[0]
        ? await client.query<{ id: string }>(`
            update acts set country_id = $2, start_number = $3, pseudonym = $4, song_title = $5, active = true
            where id = $1 returning id
          `, [input.id, country.rows[0]!.id, input.startNumber, input.pseudonym, input.songTitle])
        : await client.query<{ id: string }>(`
            insert into acts(event_id, country_id, start_number, pseudonym, song_title)
            values ($1, $2, $3, $4, $5) returning id
          `, [eventId, country.rows[0]!.id, input.startNumber, input.pseudonym, input.songTitle]);
      const actId = act.rows[0]!.id;
      retainedIds.push(actId);
      const currentArtists = await client.query<{ id: string }>(`
        select ar.id from act_artists aa join artists ar on ar.id = aa.artist_id
        where aa.act_id = $1 order by aa.sort_order
      `, [actId]);
      const retainedArtistIds: string[] = [];
      for (let index = 0; index < input.artistNames.length; index += 1) {
        const currentArtist = currentArtists.rows[index];
        const artist = currentArtist
          ? await client.query<{ id: string }>(
              "update artists set real_name = $2, active = true where id = $1 returning id",
              [currentArtist.id, input.artistNames[index]]
            )
          : await client.query<{ id: string }>(
              "insert into artists(event_id, real_name) values ($1, $2) returning id",
              [eventId, input.artistNames[index]]
            );
        const artistId = artist.rows[0]!.id;
        retainedArtistIds.push(artistId);
        await client.query(`
          insert into act_artists(act_id, artist_id, sort_order) values ($1, $2, $3)
          on conflict (act_id, artist_id) do update set sort_order = excluded.sort_order
        `, [actId, artistId, index]);
      }
      await client.query(
        "delete from act_artists where act_id = $1 and not (artist_id = any($2::uuid[]))",
        [actId, retainedArtistIds]
      );
      await client.query(
        "update artists set active = false where event_id = $1 and id = any($2::uuid[]) and not (id = any($3::uuid[]))",
        [eventId, currentArtists.rows.map((row) => row.id), retainedArtistIds]
      );
    }
    await client.query(
      "update acts set active = false where event_id = $1 and not (id = any($2::uuid[]))",
      [eventId, retainedIds]
    );
    await client.query("update events set updated_at = now() where id = $1", [eventId]);
    await client.query(`
      insert into audit_log(event_id, actor_type, action, entity_type, after_json)
      values ($1, 'ADMIN', 'REPLACE_ACTS', 'EVENT', $2::jsonb)
    `, [eventId, JSON.stringify({ count: inputs.length })]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceEventJurors(eventId: string, inputs: readonly EditableJurorInput[]): Promise<void> {
  const database = requireDatabase();
  const client = await database.connect();
  try {
    await client.query("begin");
    const retainedIds: string[] = [];
    for (const input of inputs) {
      const existing = input.id
        ? await client.query<{ id: string }>("select id from jurors where id = $1 and event_id = $2", [input.id, eventId])
        : { rows: [] };
      if (!existing.rows[0] && !input.pin) throw new Error(`Für ${input.displayName} fehlt ein PIN.`);
      const juror = existing.rows[0]
        ? await client.query<{ id: string }>(`
            update jurors set display_name = $2, type = $3, enabled = $4, reveal_order = $5,
              pin_hash = case when $6::text is null then pin_hash else crypt($6, gen_salt('bf', 10)) end
            where id = $1 returning id
          `, [input.id, input.displayName, input.type, input.enabled, input.revealOrder, input.pin ?? null])
        : await client.query<{ id: string }>(`
            insert into jurors(event_id, display_name, type, pin_hash, enabled, reveal_order)
            values ($1, $2, $3, crypt($4, gen_salt('bf', 10)), $5, $6) returning id
          `, [eventId, input.displayName, input.type, input.pin, input.enabled, input.revealOrder]);
      const jurorId = juror.rows[0]!.id;
      retainedIds.push(jurorId);
      if (input.pin) {
        await client.query("update voter_sessions set status = 'REVOKED' where juror_id = $1 and status = 'ACTIVE'", [jurorId]);
      }
      await client.query("delete from juror_artists where juror_id = $1", [jurorId]);
      if (input.linkedActId) {
        const artists = await client.query<{ artist_id: string }>(
          "select artist_id from act_artists where act_id = $1 order by sort_order",
          [input.linkedActId]
        );
        for (const artist of artists.rows) {
          await client.query("insert into juror_artists(juror_id, artist_id) values ($1, $2) on conflict do nothing", [jurorId, artist.artist_id]);
        }
      }
    }
    await client.query(
      "update jurors set enabled = false where event_id = $1 and not (id = any($2::uuid[]))",
      [eventId, retainedIds]
    );
    await client.query("update events set updated_at = now() where id = $1", [eventId]);
    await client.query(`
      insert into audit_log(event_id, actor_type, action, entity_type, after_json)
      values ($1, 'ADMIN', 'REPLACE_JURORS', 'EVENT', $2::jsonb)
    `, [eventId, JSON.stringify({ count: inputs.length, changedPins: inputs.filter((input) => input.pin).length })]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getLatestRunoff(eventId: string): Promise<RunoffRecord | undefined> {
  const result = await requireDatabase().query<{
    id: string;
    sequence_number: number;
    status: RunoffRecord["status"];
    candidate_act_ids: string[];
    vote_count: string;
  }>(`
    select br.id, br.sequence_number, br.status,
      coalesce(array_agg(distinct rc.act_id) filter (where rc.act_id is not null), '{}') as candidate_act_ids,
      count(distinct b.id)::text as vote_count
    from ballot_rounds br
    left join runoff_candidates rc on rc.round_id = br.id
    left join ballots b on b.round_id = br.id and b.status in ('SUBMITTED', 'LOCKED')
    where br.event_id = $1 and br.type = 'RUNOFF'
    group by br.id
    order by br.sequence_number desc
    limit 1
  `, [eventId]);
  const row = result.rows[0];
  return row ? {
    roundId: row.id,
    sequenceNumber: row.sequence_number,
    status: row.status,
    candidateActIds: row.candidate_act_ids,
    voteCount: Number(row.vote_count)
  } : undefined;
}

export async function openRunoffRound(eventId: string, candidateActIds: readonly string[]): Promise<RunoffRecord> {
  if (candidateActIds.length < 2) throw new Error("Eine Stichwahl benötigt mindestens zwei Acts.");
  const database = requireDatabase();
  const client = await database.connect();
  try {
    await client.query("begin");
    await client.query("update ballot_rounds set status = 'CLOSED', closed_at = now() where event_id = $1 and type = 'RUNOFF' and status = 'OPEN'", [eventId]);
    const next = await client.query<{ sequence_number: number }>(
      "select coalesce(max(sequence_number), 0) + 1 as sequence_number from ballot_rounds where event_id = $1 and type = 'RUNOFF'",
      [eventId]
    );
    const sequenceNumber = Number(next.rows[0]?.sequence_number ?? 1);
    const round = await client.query<{ id: string }>(`
      insert into ballot_rounds(event_id, type, status, sequence_number, point_scale_json, opened_at)
      values ($1, 'RUNOFF', 'OPEN', $2, '[1]'::jsonb, now()) returning id
    `, [eventId, sequenceNumber]);
    const roundId = round.rows[0]!.id;
    for (const actId of [...new Set(candidateActIds)]) {
      await client.query("insert into runoff_candidates(round_id, act_id) values ($1, $2)", [roundId, actId]);
    }
    await client.query("commit");
    return { roundId, sequenceNumber, status: "OPEN", candidateActIds: [...new Set(candidateActIds)], voteCount: 0 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeRunoffRound(eventId: string): Promise<void> {
  await requireDatabase().query(`
    update ballot_rounds set status = 'CLOSED', closed_at = now()
    where id = (select id from ballot_rounds where event_id = $1 and type = 'RUNOFF' order by sequence_number desc limit 1)
  `, [eventId]);
}

export async function getRunoffResults(eventId: string): Promise<Array<{ actId: string; votes: number }>> {
  const result = await requireDatabase().query<{ act_id: string; votes: string }>(`
    select rc.act_id, count(be.ballot_id)::text as votes
    from ballot_rounds br
    join runoff_candidates rc on rc.round_id = br.id
    left join ballot_entries be on be.act_id = rc.act_id
      and be.ballot_id in (select id from ballots where round_id = br.id and status in ('SUBMITTED', 'LOCKED'))
    where br.id = (select id from ballot_rounds where event_id = $1 and type = 'RUNOFF' order by sequence_number desc limit 1)
    group by rc.act_id
    order by count(be.ballot_id) desc, rc.act_id
  `, [eventId]);
  return result.rows.map((row) => ({ actId: row.act_id, votes: Number(row.votes) }));
}

export async function getTimecodeCues(eventId: string): Promise<TimecodeCueRecord[]> {
  const result = await requireDatabase().query<{
    id: string;
    event_id: string;
    act_id: string | null;
    timecode: string;
    frame_rate: string;
    event_type: string;
    payload_json: Record<string, unknown>;
    catch_up_policy: "SKIP" | "TRIGGER";
  }>(`
    select id, event_id, act_id, timecode, frame_rate, event_type, payload_json, catch_up_policy
    from timecode_cues where event_id = $1 and enabled = true order by timecode
  `, [eventId]);
  return result.rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    actId: row.act_id,
    timecode: row.timecode,
    frameRate: Number(row.frame_rate),
    eventType: row.event_type,
    payload: row.payload_json,
    catchUpPolicy: row.catch_up_policy
  }));
}
