import pg from "pg";

const { Pool } = pg;
const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:9090/pv-digivote/api";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL ist für den Smoke-Test erforderlich.");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path, options = {}, cookie = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body.message ?? body.error ?? "Fehler"}`);
  return { body, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie };
}

const pool = new Pool({ connectionString: databaseUrl });
const createdSessionIds = [];
let createdRunoffRoundId;

try {
  const { body: bootstrap } = await json("/bootstrap");
  assert(bootstrap.acts.length >= bootstrap.event.config.pointScale.length, "Zu wenige Acts im Testevent.");
  assert(bootstrap.jurors.length > 0, "Keine Jury im Testevent.");

  const { body: adminConfig } = await json("/admin/config");
  assert(adminConfig.acts.length === bootstrap.acts.length, "Admin-Konfiguration enthält nicht alle Acts.");
  assert(adminConfig.jurors.every((entry) => !("pin" in entry) && !("pinHash" in entry)), "Admin-API gibt sensible PIN-Daten aus.");
  await json("/admin/acts", {
    method: "PUT",
    body: JSON.stringify({ acts: adminConfig.acts.map((act) => ({
      id: act.id,
      startNumber: act.startNumber,
      countryIsoCode: act.country.isoCode,
      countryName: act.country.displayName,
      pseudonym: act.pseudonym,
      songTitle: act.songTitle,
      artistNames: act.artistNames
    })) })
  });
  await json("/admin/jurors", {
    method: "PUT",
    body: JSON.stringify({ jurors: adminConfig.jurors.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      type: entry.type,
      enabled: entry.enabled,
      revealOrder: entry.revealOrder,
      linkedActId: entry.linkedActId
    })) })
  });

  const juror = bootstrap.jurors[0];
  const juryLogin = await json("/sessions/jury", {
    method: "POST",
    body: JSON.stringify({ jurorId: juror.id, pin: "1001" })
  });
  createdSessionIds.push(juryLogin.body.sessionId);
  const allowedJuryActs = bootstrap.acts.filter((act) => !juryLogin.body.blockedActIds.includes(act.id));
  const juryEntries = bootstrap.event.config.pointScale.map((points, index) => ({
    actId: allowedJuryActs[index].id,
    points
  }));
  const juryFirst = await json("/ballots", {
    method: "POST",
    body: JSON.stringify({ group: "JURY", entries: juryEntries })
  }, juryLogin.cookie);
  assert(juryFirst.body.ballot.revision === 1, "Erste Juryrevision ist nicht 1.");

  const jurySecond = await json("/ballots", {
    method: "POST",
    body: JSON.stringify({ group: "JURY", entries: juryEntries.map((entry, index) => ({
      actId: entry.actId,
      points: bootstrap.event.config.pointScale.at(-index - 1)
    })) })
  }, juryLogin.cookie);
  assert(jurySecond.body.ballot.revision === 2, "Juryänderung erzeugt keine zweite Revision.");

  const publicSession = await json("/sessions/public", { method: "POST", body: "{}" });
  createdSessionIds.push(publicSession.body.sessionId);
  await pool.query(`
    update ballot_rounds set status = 'OPEN', opened_at = now(), closed_at = null
    where event_id = $1 and type = 'PUBLIC' and sequence_number = 1
  `, [bootstrap.event.id]);
  const publicEntries = bootstrap.event.config.pointScale.map((points, index) => ({
    actId: bootstrap.acts[index].id,
    points
  }));
  await json("/ballots", {
    method: "POST",
    body: JSON.stringify({ group: "PUBLIC", entries: publicEntries })
  }, publicSession.cookie);

  const { body: scores } = await json("/scores");
  const pointTotal = bootstrap.event.config.pointScale.reduce((sum, points) => sum + points, 0);
  assert(scores.juryTotal === pointTotal, "Jurygesamtpunktzahl stimmt nicht.");
  assert(scores.publicTarget === pointTotal, "Publikum wurde bei 50/50 nicht exakt auf die Jury normiert.");
  assert(scores.publicAllocatedTotal === scores.publicTarget, "Largest-Remainder-Zuteilung ist nicht exakt.");

  const runoffRound = await pool.query(`
    insert into ballot_rounds(event_id, type, status, sequence_number, point_scale_json, opened_at)
    values ($1, 'RUNOFF', 'OPEN', 9999, '[1]'::jsonb, now()) returning id
  `, [bootstrap.event.id]);
  createdRunoffRoundId = runoffRound.rows[0].id;
  await pool.query("insert into runoff_candidates(round_id, act_id) values ($1, $2), ($1, $3)", [
    createdRunoffRoundId,
    bootstrap.acts[0].id,
    bootstrap.acts[1].id
  ]);
  const runoffVote = await json("/ballots", {
    method: "POST",
    body: JSON.stringify({ group: "RUNOFF", entries: [{ actId: bootstrap.acts[0].id, points: 1 }] })
  }, publicSession.cookie);
  assert(runoffVote.body.ballot.group === "RUNOFF", "Stichwahlstimme wurde nicht gespeichert.");
  process.stdout.write(`Smoke-Test bestanden: Adminspeicherung ohne PIN-Leak, Login, 2 Juryrevisionen, Publikumsvote, ${scores.publicAllocatedTotal} normierte Punkte und Stichwahlstimme.\n`);
} finally {
  if (createdSessionIds.filter(Boolean).length > 0) {
    const ids = createdSessionIds.filter(Boolean);
    await pool.query("delete from ballot_entries where ballot_id in (select id from ballots where voter_session_id = any($1::uuid[]))", [ids]);
    await pool.query("delete from ballots where voter_session_id = any($1::uuid[])", [ids]);
    await pool.query("delete from voter_sessions where id = any($1::uuid[])", [ids]);
  }
  if (createdRunoffRoundId) await pool.query("delete from ballot_rounds where id = $1", [createdRunoffRoundId]);
  await pool.query("update ballot_rounds set status = 'DRAFT', opened_at = null, closed_at = null where type = 'PUBLIC'");
  await pool.end();
}
