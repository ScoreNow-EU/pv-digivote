import type NodeCG from "nodecg/types";
import { createHash, randomBytes } from "node:crypto";
import express from "express";
import {
  ballotEntrySchema,
  defaultShowState,
  eventConfigSchema,
  getBlockedActIds,
  showPhaseSchema,
  showStateSchema,
  validateEscBallot,
  type BallotEntry,
  type ShowState
} from "@pv/domain";
import {
  getActiveEventBundle,
  getBallotCounts,
  getCountingBallots,
  getCurrentBallot,
  getJuryAward,
  getJuryBallotsByJuror,
  getOrCreateJurySession,
  getOrCreatePublicSession,
  getLatestRunoff,
  getRoundStatuses,
  getRunoffResults,
  getSessionByTokenHash,
  getTimecodeCues,
  pingDatabase,
  closeRunoffRound,
  openRunoffRound,
  replaceEventActs,
  replaceEventJurors,
  resetEventProgress,
  revealActIdentity,
  setRoundOpen,
  setSessionTokenHash,
  submitBallot,
  updateEventConfig,
  verifyJurorPin,
  type EventBundle,
  type VoterSessionRecord
} from "@pv/database";
import { computeScoreboard } from "@pv/scoring";
import { z } from "zod";
import { computeJuryRevealProgress, publicBundle } from "./reveal";

const ltcFrameSchema = z.object({
  value: z.string().regex(/^\d{2}:\d{2}:\d{2}:\d{2}$/),
  frameRate: z.number().positive(),
  receivedAt: z.string().datetime()
});

const juryLoginSchema = z.object({
  jurorId: z.string().min(1).max(128),
  pin: z.string().regex(/^\d{4}$/)
});

const ballotRequestSchema = z.object({
  group: z.enum(["JURY", "PUBLIC", "RUNOFF"]),
  entries: z.array(ballotEntrySchema)
});

const editableActSchema = z.object({
  id: z.string().uuid().optional(),
  startNumber: z.number().int().min(1).max(99),
  countryIsoCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  countryName: z.string().trim().min(1).max(80),
  pseudonym: z.string().trim().min(1).max(120),
  songTitle: z.string().trim().min(1).max(160),
  artistNames: z.array(z.string().trim().min(1).max(120)).min(1).max(8)
});

const actsAdminSchema = z.object({
  acts: z.array(editableActSchema).min(12).max(15)
}).superRefine(({ acts }, context) => {
  const startNumbers = acts.map((act) => act.startNumber);
  if (new Set(startNumbers).size !== startNumbers.length) {
    context.addIssue({ code: "custom", message: "Startnummern müssen eindeutig sein.", path: ["acts"] });
  }
  const countries = acts.map((act) => act.countryIsoCode);
  if (new Set(countries).size !== countries.length) {
    context.addIssue({ code: "custom", message: "Jedes Land darf nur einmal teilnehmen.", path: ["acts"] });
  }
});

const editableJurorSchema = z.object({
  id: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(120),
  type: z.enum(["ARTIST", "REGIE", "GAST"]),
  pin: z.union([z.literal(""), z.string().regex(/^\d{4}$/)]).optional(),
  enabled: z.boolean(),
  revealOrder: z.number().int().min(0).max(999),
  linkedActId: z.union([z.literal(""), z.string().uuid()]).optional()
});

const jurorsAdminSchema = z.object({
  jurors: z.array(editableJurorSchema).min(1).max(80)
});

const PUBLIC_COOKIE = "pv_public_session";
const JURY_COOKIE = "pv_jury_session";
const COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) return [];
    return [[decodeURIComponent(rawName), decodeURIComponent(rawValue.join("="))]];
  }));
}

function nextRevision(state: ShowState, patch: Partial<ShowState>): ShowState {
  return showStateSchema.parse({
    ...state,
    ...patch,
    revision: state.revision + 1,
    updatedAt: new Date().toISOString()
  });
}

function extension(nodecg: NodeCG.ServerAPI): void {
  const firedCueIds = new Set<string>();
  let timecodeCues: Awaited<ReturnType<typeof getTimecodeCues>> = [];
  let emitBridgeCue: (cue: Record<string, unknown>) => void = () => undefined;
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const initialState: ShowState = {
    ...defaultShowState,
    updatedAt: new Date().toISOString()
  };
  const showState = nodecg.Replicant<ShowState>("show-state", {
    defaultValue: initialState,
    persistent: true
  });

  const readState = (): ShowState => {
    const raw = (showState.value ?? {}) as Partial<ShowState>;
    const defined = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
    return showStateSchema.parse({
      ...initialState,
      ...defined,
      voting: { ...initialState.voting, ...(raw.voting ?? {}) },
      screens: { ...initialState.screens, ...(raw.screens ?? {}) },
      timecode: { ...initialState.timecode, ...(raw.timecode ?? {}) }
    });
  };

  showState.value = readState();

  const update = (patch: Partial<ShowState>): ShowState => {
    const current = readState();
    const updated = nextRevision(current, patch);
    showState.value = updated;
    return updated;
  };

  const refreshVotingCounts = async (bundle?: EventBundle): Promise<void> => {
    const activeBundle = bundle ?? await getActiveEventBundle();
    if (!activeBundle) return;
    const [counts, rounds] = await Promise.all([
      getBallotCounts(activeBundle.event.id),
      getRoundStatuses(activeBundle.event.id)
    ]);
    const current = readState();
    update({
      currentActId: current.currentActId ?? activeBundle.acts[0]?.id ?? null,
      voting: {
        ...current.voting,
        juryOpen: rounds.juryOpen,
        publicOpen: rounds.publicOpen,
        validJuryBallots: counts.jury,
        validPublicBallots: counts.public
      }
    });
  };

  nodecg.listenFor("pv:set-phase", (payload: unknown) => {
    const phase = showPhaseSchema.parse(payload);
    update({ phase });
  });

  nodecg.listenFor("pv:toggle-pause", () => {
    const current = readState();
    update({ paused: !current.paused });
  });

  nodecg.listenFor("pv:update-event-config", (payload: unknown) => {
    const parsed = eventConfigSchema.safeParse(payload);
    if (!parsed.success) {
      nodecg.log.warn("Ungültige Event-Konfiguration verworfen.");
      return;
    }
    void getActiveEventBundle()
      .then((bundle) => bundle && updateEventConfig(bundle.event.id, parsed.data))
      .then(() => nodecg.log.info("Event-Konfiguration gespeichert."))
      .catch((error: unknown) => nodecg.log.error(`Event-Konfiguration konnte nicht gespeichert werden: ${String(error)}`));
  });

  nodecg.listenFor("pv:toggle-public-voting", () => {
    const current = readState();
    const publicOpen = !current.voting.publicOpen;
    update({
      phase: publicOpen ? "VOTING_OFFEN" : "VOTING_GESCHLOSSEN",
      voting: { ...current.voting, publicOpen }
    });
    void getActiveEventBundle()
      .then((bundle) => bundle && setRoundOpen(bundle.event.id, "PUBLIC", publicOpen))
      .catch((error: unknown) => nodecg.log.error(`Votingstatus konnte nicht gespeichert werden: ${String(error)}`));
  });

  nodecg.listenFor("pv:toggle-jury-voting", () => {
    const current = readState();
    const juryOpen = !current.voting.juryOpen;
    update({ voting: { ...current.voting, juryOpen } });
    void getActiveEventBundle()
      .then((bundle) => bundle && setRoundOpen(bundle.event.id, "JURY", juryOpen))
      .catch((error: unknown) => nodecg.log.error(`Jury-Votingstatus konnte nicht gespeichert werden: ${String(error)}`));
  });

  nodecg.listenFor("pv:reveal-next-act", () => {
    void getActiveEventBundle().then(async (bundle) => {
      if (!bundle || bundle.acts.length === 0) return;
      const current = readState();
      const currentIndex = Math.max(0, bundle.acts.findIndex((act) => act.id === current.currentActId));
      const currentAct = bundle.acts[currentIndex];
      const nextIndex = currentAct?.identityRevealed ? (currentIndex + 1) % bundle.acts.length : currentIndex;
      const act = bundle.acts[nextIndex]!;
      await revealActIdentity(act.id);
      update({ phase: "AUFTRITT", currentActId: act.id });
      emitBridgeCue({
        eventType: "ACT_IDENTITY_REVEAL",
        actId: act.id,
        countryIsoCode: act.country.isoCode,
        startNumber: act.startNumber,
        source: "MANUAL"
      });
    }).catch((error: unknown) => nodecg.log.error(`Manueller Klarname-Reveal fehlgeschlagen: ${String(error)}`));
  });

  nodecg.listenFor("pv:advance-jury-reveal", () => {
    const current = readState();
    const sequence = [0, 8, 10, 12] as const;
    const currentIndex = sequence.indexOf(current.currentRevealPoint);
    const atEnd = currentIndex === sequence.length - 1;
    const nextPoint = atEnd ? 0 : sequence[currentIndex + 1]!;
    const nextJurorIndex = atEnd ? current.currentJurorIndex + 1 : current.currentJurorIndex;
    void getActiveEventBundle().then(async (bundle) => {
      const jurors = bundle?.jurors.filter((juror) => juror.enabled) ?? [];
      const juror = jurors[nextJurorIndex % Math.max(jurors.length, 1)];
      const awardedActId = bundle && juror && nextPoint > 0
        ? await getJuryAward(bundle.event.id, juror.id, nextPoint)
        : undefined;
      update({
        phase: "JURY_REVEAL",
        currentRevealPoint: nextPoint,
        currentJurorIndex: nextJurorIndex,
        ...(awardedActId ? { currentActId: awardedActId } : {})
      });
      emitBridgeCue({
        eventType: "JURY_POINTS_REVEAL",
        jurorId: juror?.id ?? null,
        actId: awardedActId ?? null,
        points: nextPoint,
        countryIsoCode: bundle?.acts.find((act) => act.id === awardedActId)?.country.isoCode ?? null
      });
    }).catch((error: unknown) => nodecg.log.error(`Jury-Reveal fehlgeschlagen: ${String(error)}`));
  });

  nodecg.listenFor("pv:rewind-jury-reveal", () => {
    const current = readState();
    const sequence = [0, 8, 10, 12] as const;
    const currentIndex = sequence.indexOf(current.currentRevealPoint);
    const atStart = currentIndex <= 0;
    update({
      phase: "JURY_REVEAL",
      currentRevealPoint: atStart ? 12 : sequence[currentIndex - 1]!,
      currentJurorIndex: atStart ? Math.max(0, current.currentJurorIndex - 1) : current.currentJurorIndex
    });
  });

  nodecg.listenFor("pv:advance-public-reveal", () => {
    void getActiveEventBundle().then(async (bundle) => {
      if (!bundle) return;
      const config = eventConfigSchema.parse(bundle.event.config);
      const ballots = await getCountingBallots(bundle.event.id);
      const scoreboard = computeScoreboard({
        actIds: bundle.acts.map((act) => act.id),
        juryBallots: ballots.jury,
        publicBallots: ballots.public,
        pointScale: config.pointScale,
        juryWeight: config.weights.jury,
        publicWeight: config.weights.public
      });
      const revealOrder = [...scoreboard.rows].sort((left, right) =>
        left.juryPoints - right.juryPoints || right.rank - left.rank || left.actId.localeCompare(right.actId, "de")
      );
      const current = readState();
      const row = revealOrder[current.currentPublicRevealIndex];
      if (!row) {
        update({ phase: "FINALE" });
        return;
      }
      const act = bundle.acts.find((entry) => entry.id === row.actId);
      update({
        phase: "PUBLIC_REVEAL",
        currentActId: row.actId,
        currentPublicRevealIndex: current.currentPublicRevealIndex + 1,
        revealedPublicActIds: [...new Set([...current.revealedPublicActIds, row.actId])]
      });
      emitBridgeCue({
        eventType: "PUBLIC_POINTS_REVEAL",
        actId: row.actId,
        points: row.publicPoints,
        countryIsoCode: act?.country.isoCode ?? null
      });
    }).catch((error: unknown) => nodecg.log.error(`Publikums-Reveal fehlgeschlagen: ${String(error)}`));
  });

  nodecg.listenFor("pv:reset-public-reveal", () => {
    const current = readState();
    update({
      phase: "VOTING_GESCHLOSSEN",
      currentPublicRevealIndex: 0,
      revealedPublicActIds: [],
      currentActId: current.currentActId
    });
  });

  nodecg.listenFor("pv:start-runoff", () => {
    void getActiveEventBundle().then(async (bundle) => {
      if (!bundle) return;
      const config = eventConfigSchema.parse(bundle.event.config);
      const ballots = await getCountingBallots(bundle.event.id);
      const scoreboard = computeScoreboard({
        actIds: bundle.acts.map((act) => act.id),
        juryBallots: ballots.jury,
        publicBallots: ballots.public,
        pointScale: config.pointScale,
        juryWeight: config.weights.jury,
        publicWeight: config.weights.public
      });
      if (!scoreboard.requiresRunoff) throw new Error("Nach Tie-Break besteht kein Siegergleichstand.");
      await openRunoffRound(bundle.event.id, scoreboard.runoffActIds);
      update({ phase: "STICHWAHL_OFFEN" });
      emitBridgeCue({ eventType: "RUNOFF_OPEN", candidateActIds: scoreboard.runoffActIds });
    }).catch((error: unknown) => nodecg.log.error(`Stichwahl konnte nicht gestartet werden: ${String(error)}`));
  });

  nodecg.listenFor("pv:close-runoff", () => {
    void getActiveEventBundle().then(async (bundle) => {
      if (!bundle) return;
      await closeRunoffRound(bundle.event.id);
      const results = await getRunoffResults(bundle.event.id);
      const tied = results.length > 1 && results[0]!.votes === results[1]!.votes;
      update({ phase: tied ? "STICHWAHL" : "FINALE", currentActId: tied ? readState().currentActId : results[0]?.actId ?? readState().currentActId });
      emitBridgeCue({ eventType: tied ? "RUNOFF_TIED" : "RUNOFF_WINNER", actId: results[0]?.actId ?? null, votes: results[0]?.votes ?? 0 });
    }).catch((error: unknown) => nodecg.log.error(`Stichwahl konnte nicht geschlossen werden: ${String(error)}`));
  });

  const api = nodecg.Router();
  api.use(express.json({ limit: "32kb" }));

  const route = (
    handler: (request: express.Request, response: express.Response) => Promise<void>
  ) => (request: express.Request, response: express.Response): void => {
    void handler(request, response).catch((error: unknown) => {
      nodecg.log.error(`API-Fehler: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      if (!response.headersSent) {
        response.status(500).json({ ok: false, error: "INTERNAL_ERROR", message: "Interner Serverfehler." });
      }
    });
  };

  const resolveSession = async (
    request: express.Request,
    bundle: EventBundle,
    group: "JURY" | "PUBLIC" | "RUNOFF"
  ): Promise<VoterSessionRecord | undefined> => {
    if (group === "RUNOFF") {
      const cookies = parseCookies(request.headers.cookie);
      const juryToken = cookies[JURY_COOKIE];
      const publicToken = cookies[PUBLIC_COOKIE];
      if (juryToken) {
        const jury = await getSessionByTokenHash(bundle.event.id, hashToken(juryToken), "JURY");
        if (jury) return jury;
      }
      return publicToken ? getSessionByTokenHash(bundle.event.id, hashToken(publicToken), "PUBLIC") : undefined;
    }
    const cookieName = group === "JURY" ? JURY_COOKIE : PUBLIC_COOKIE;
    const token = parseCookies(request.headers.cookie)[cookieName];
    if (!token) return undefined;
    return getSessionByTokenHash(bundle.event.id, hashToken(token), group);
  };

  api.get("/bootstrap", route(async (request, response) => {
    const bundle = await getActiveEventBundle();
    if (!bundle) {
      response.status(503).json({ ok: false, error: "NO_EVENT", message: "Kein aktives Event konfiguriert." });
      return;
    }
    const [publicSession, jurySession] = await Promise.all([
      resolveSession(request, bundle, "PUBLIC"),
      resolveSession(request, bundle, "JURY")
    ]);
    const activeJuror = jurySession
      ? bundle.jurors.find((juror) => juror.id === jurySession.jurorId && juror.enabled)
      : undefined;
    const runoff = await getLatestRunoff(bundle.event.id);
    response.json({
      ok: true,
      ...publicBundle(bundle),
      voting: readState().voting,
      runoff: runoff ? {
        open: runoff.status === "OPEN",
        sequenceNumber: runoff.sequenceNumber,
        candidateActIds: runoff.candidateActIds,
        voteCount: runoff.voteCount
      } : null,
      sessions: {
        public: Boolean(publicSession),
        jury: jurySession && activeJuror ? {
          authenticated: true,
          jurorId: jurySession.jurorId,
          blockedActIds: [...getBlockedActIds(activeJuror, bundle.artists, bundle.event.config.selfVotePolicy)]
        } : { authenticated: false }
      }
    });
  }));

  api.get("/admin/config", route(async (_request, response) => {
    const bundle = await getActiveEventBundle();
    if (!bundle) {
      response.status(503).json({ ok: false, error: "NO_EVENT" });
      return;
    }
    response.json({
      ok: true,
      event: bundle.event,
      acts: bundle.acts,
      jurors: bundle.jurors.map((juror) => ({
        id: juror.id,
        displayName: juror.displayName,
        type: juror.type,
        enabled: juror.enabled,
        revealOrder: juror.revealOrder,
        linkedActId: juror.linkedActIds[0] ?? ""
      }))
    });
  }));

  api.put("/admin/acts", route(async (request, response) => {
    const parsed = actsAdminSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(422).json({ ok: false, error: "INVALID_ACTS", message: parsed.error.issues[0]?.message ?? "Teilnehmerdaten sind ungültig." });
      return;
    }
    const bundle = await getActiveEventBundle();
    if (!bundle) {
      response.status(503).json({ ok: false, error: "NO_EVENT" });
      return;
    }
    await replaceEventActs(bundle.event.id, parsed.data.acts.map((act) => ({
      ...(act.id ? { id: act.id } : {}),
      startNumber: act.startNumber,
      countryIsoCode: act.countryIsoCode,
      countryName: act.countryName,
      pseudonym: act.pseudonym,
      songTitle: act.songTitle,
      artistNames: act.artistNames
    })));
    response.json({ ok: true });
  }));

  api.put("/admin/jurors", route(async (request, response) => {
    const parsed = jurorsAdminSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(422).json({ ok: false, error: "INVALID_JURORS", message: parsed.error.issues[0]?.message ?? "Jurydaten sind ungültig." });
      return;
    }
    const bundle = await getActiveEventBundle();
    if (!bundle) {
      response.status(503).json({ ok: false, error: "NO_EVENT" });
      return;
    }
    await replaceEventJurors(bundle.event.id, parsed.data.jurors.map((juror) => ({
      ...(juror.id ? { id: juror.id } : {}),
      displayName: juror.displayName,
      type: juror.type,
      enabled: juror.enabled,
      revealOrder: juror.revealOrder,
      ...(juror.pin ? { pin: juror.pin } : {}),
      ...(juror.linkedActId ? { linkedActId: juror.linkedActId } : {})
    })));
    response.json({ ok: true });
  }));

  api.post("/sessions/public", route(async (_request, response) => {
    const bundle = await getActiveEventBundle();
    if (!bundle) {
      response.status(503).json({ ok: false, error: "NO_EVENT" });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const session = await getOrCreatePublicSession(bundle.event.id, hashToken(token));
    response.cookie(PUBLIC_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: COOKIE_MAX_AGE_MS,
      path: "/"
    });
    response.status(201).json({ ok: true, sessionId: session.id });
  }));

  api.post("/sessions/jury", route(async (request, response) => {
    const clientKey = request.ip || request.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempts = loginAttempts.get(clientKey);
    if (attempts && attempts.resetAt > now && attempts.count >= 5) {
      response.status(429).json({ ok: false, error: "RATE_LIMITED", message: "Zu viele Versuche. Bitte in 15 Minuten erneut probieren." });
      return;
    }
    if (attempts && attempts.resetAt <= now) loginAttempts.delete(clientKey);
    const parsed = juryLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "INVALID_LOGIN", message: "Name oder PIN ist ungültig." });
      return;
    }
    const bundle = await getActiveEventBundle();
    const juror = bundle?.jurors.find((entry) => entry.id === parsed.data.jurorId && entry.enabled);
    if (!bundle || !juror || !(await verifyJurorPin(juror.id, parsed.data.pin))) {
      const current = loginAttempts.get(clientKey);
      loginAttempts.set(clientKey, {
        count: (current?.resetAt ?? 0) > now ? current!.count + 1 : 1,
        resetAt: (current?.resetAt ?? 0) > now ? current!.resetAt : now + 15 * 60_000
      });
      response.status(401).json({ ok: false, error: "INVALID_LOGIN", message: "Name oder PIN ist ungültig." });
      return;
    }
    loginAttempts.delete(clientKey);
    const token = randomBytes(32).toString("base64url");
    const session = await getOrCreateJurySession(bundle.event.id, juror.id);
    await setSessionTokenHash(session.id, hashToken(token));
    response.cookie(JURY_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: COOKIE_MAX_AGE_MS,
      path: "/"
    });
    response.json({
      ok: true,
      sessionId: session.id,
      juror: { id: juror.id, displayName: juror.displayName, type: juror.type },
      blockedActIds: [...getBlockedActIds(juror, bundle.artists, bundle.event.config.selfVotePolicy)]
    });
  }));

  api.get("/ballots/me", route(async (request, response) => {
    const group = request.query.group === "JURY" ? "JURY" : request.query.group === "RUNOFF" ? "RUNOFF" : "PUBLIC";
    const bundle = await getActiveEventBundle();
    const session = bundle ? await resolveSession(request, bundle, group) : undefined;
    if (!bundle || !session) {
      response.status(401).json({ ok: false, error: "NO_SESSION" });
      return;
    }
    const ballot = await getCurrentBallot(session.id, group);
    response.json({ ok: true, ballot: ballot ?? null });
  }));

  api.post("/ballots", route(async (request, response) => {
    const parsed = ballotRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "INVALID_BALLOT", message: "Der Stimmzettel ist ungültig." });
      return;
    }
    const bundle = await getActiveEventBundle();
    const session = bundle ? await resolveSession(request, bundle, parsed.data.group) : undefined;
    if (!bundle || !session) {
      response.status(401).json({ ok: false, error: "NO_SESSION", message: "Die Sitzung ist nicht mehr gültig." });
      return;
    }
    let blockedActIds = new Set<string>();
    if (parsed.data.group === "JURY") {
      const juror = bundle.jurors.find((entry) => entry.id === session.jurorId);
      if (!juror) {
        response.status(403).json({ ok: false, error: "JUROR_DISABLED" });
        return;
      }
      blockedActIds = getBlockedActIds(juror, bundle.artists, bundle.event.config.selfVotePolicy);
    }
    const runoff = parsed.data.group === "RUNOFF" ? await getLatestRunoff(bundle.event.id) : undefined;
    const validation = parsed.data.group === "RUNOFF"
      ? parsed.data.entries.length === 1
        && parsed.data.entries[0]?.points === 1
        && runoff?.status === "OPEN"
        && runoff.candidateActIds.includes(parsed.data.entries[0].actId)
        ? { valid: true as const }
        : { valid: false as const, errors: ["Die Stichwahlstimme ist ungültig oder die Runde ist geschlossen."] }
      : validateEscBallot(parsed.data.entries, bundle.event.config.pointScale, blockedActIds);
    if (!validation.valid) {
      response.status(422).json({ ok: false, error: "INVALID_BALLOT", message: validation.errors[0], errors: validation.errors });
      return;
    }
    const knownActs = new Set(bundle.acts.map((act) => act.id));
    if (parsed.data.entries.some((entry) => !knownActs.has(entry.actId))) {
      response.status(422).json({ ok: false, error: "UNKNOWN_ACT", message: "Der Stimmzettel enthält einen unbekannten Act." });
      return;
    }
    try {
      const ballot = await submitBallot({
        eventId: bundle.event.id,
        group: parsed.data.group,
        voterSessionId: session.id,
        entries: parsed.data.entries
      });
      await refreshVotingCounts(bundle);
      response.status(201).json({ ok: true, ballot });
    } catch (error) {
      if (error instanceof Error && error.message.includes("geschlossen")) {
        response.status(409).json({ ok: false, error: "VOTING_CLOSED", message: error.message });
        return;
      }
      throw error;
    }
  }));

  api.get("/scores", route(async (_request, response) => {
    const bundle = await getActiveEventBundle();
    if (!bundle) {
      response.status(503).json({ ok: false, error: "NO_EVENT" });
      return;
    }
    const config = eventConfigSchema.parse(bundle.event.config);
    const [ballots, juryEntriesByJuror] = await Promise.all([
      getCountingBallots(bundle.event.id),
      getJuryBallotsByJuror(bundle.event.id)
    ]);
    const scoreboard = computeScoreboard({
      actIds: bundle.acts.map((act) => act.id),
      juryBallots: ballots.jury,
      publicBallots: ballots.public,
      pointScale: config.pointScale,
      juryWeight: config.weights.jury,
      publicWeight: config.weights.public
    });
    const state = readState();
    const orderedJurors = bundle.jurors.filter((juror) => juror.enabled);
    const revealProgress = computeJuryRevealProgress(
      bundle.acts.map((act) => act.id),
      orderedJurors,
      juryEntriesByJuror,
      state.currentJurorIndex,
      state.currentRevealPoint
    );
    const currentJuror = orderedJurors[state.currentJurorIndex];
    const currentBulkAward = currentJuror
      ? (juryEntriesByJuror.get(currentJuror.id) ?? [])
          .filter((entry) => entry.points >= 1 && entry.points <= 7)
          .sort((left, right) => left.points - right.points)
      : [];
    response.json({ ok: true, ...scoreboard, revealProgress, currentBulkAward });
  }));

  const demoVoteRequestSchema = z.object({
    publicCount: z.number().int().min(0).max(500).default(20)
  });

  api.post("/admin/demo-vote", route(async (request, response) => {
    const parsed = demoVoteRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({ ok: false, error: "INVALID_REQUEST", message: "Ungültige Demo-Voting-Anfrage." });
      return;
    }
    const bundle = await getActiveEventBundle();
    if (!bundle) {
      response.status(503).json({ ok: false, error: "NO_EVENT" });
      return;
    }
    const rounds = await getRoundStatuses(bundle.event.id);
    const actIds = bundle.acts.map((act) => act.id);
    const pointScale = eventConfigSchema.parse(bundle.event.config).pointScale;

    const randomBallotEntries = (blocked: ReadonlySet<string>): BallotEntry[] | undefined => {
      const eligible = actIds.filter((actId) => !blocked.has(actId));
      if (eligible.length < pointScale.length) return undefined;
      const shuffled = [...eligible].sort(() => Math.random() - 0.5).slice(0, pointScale.length);
      const scale = [...pointScale].sort(() => Math.random() - 0.5);
      return shuffled.map((actId, index) => ({ actId, points: scale[index]! }));
    };

    let jurorsFilled = 0;
    if (rounds.juryOpen) {
      for (const juror of bundle.jurors.filter((entry) => entry.enabled)) {
        const session = await getOrCreateJurySession(bundle.event.id, juror.id);
        const existing = await getCurrentBallot(session.id, "JURY");
        if (existing) continue;
        const blocked = getBlockedActIds(juror, bundle.artists, bundle.event.config.selfVotePolicy);
        const entries = randomBallotEntries(blocked);
        if (!entries) continue;
        await submitBallot({
          eventId: bundle.event.id,
          group: "JURY",
          voterSessionId: session.id,
          entries
        });
        jurorsFilled += 1;
      }
    }

    let publicBallotsCreated = 0;
    if (rounds.publicOpen && actIds.length >= pointScale.length) {
      for (let index = 0; index < parsed.data.publicCount; index += 1) {
        const session = await getOrCreatePublicSession(bundle.event.id, randomBytes(32).toString("hex"));
        await submitBallot({
          eventId: bundle.event.id,
          group: "PUBLIC",
          voterSessionId: session.id,
          entries: randomBallotEntries(new Set())!
        });
        publicBallotsCreated += 1;
      }
    }

    await refreshVotingCounts(bundle);
    response.json({
      ok: true,
      jurorsFilled,
      publicBallotsCreated,
      juryOpen: rounds.juryOpen,
      publicOpen: rounds.publicOpen
    });
  }));

  api.post("/admin/reset-progress", route(async (_request, response) => {
    const bundle = await getActiveEventBundle();
    if (!bundle) {
      response.status(503).json({ ok: false, error: "NO_EVENT" });
      return;
    }
    await resetEventProgress(bundle.event.id);
    update({
      phase: "SETUP",
      paused: false,
      currentActId: null,
      currentJurorIndex: 0,
      currentRevealPoint: 0,
      currentPublicRevealIndex: 0,
      revealedPublicActIds: [],
      screens: { a: "RUHE", b: "RANGLISTE" }
    });
    await refreshVotingCounts(bundle);
    response.json({ ok: true });
  }));

  api.get("/health", async (_request, response) => {
    try {
      const database = await pingDatabase();
      response.json({
        ok: true,
        service: "pv-digivote",
        database,
        revision: readState().revision,
        bridge: readState().bridgeStatus
      });
    } catch (error) {
      response.status(503).json({
        ok: false,
        database: "error",
        message: error instanceof Error ? error.message : "Unbekannter Datenbankfehler"
      });
    }
  });
  nodecg.mount("/pv-digivote/api", api);

  const bridgeToken = process.env.BRIDGE_TOKEN ?? (process.env.NODE_ENV === "production" ? undefined : "dev-bridge-token");
  if (!bridgeToken) {
    nodecg.log.error("BRIDGE_TOKEN fehlt. Die Show-Bridge bleibt in Produktion deaktiviert.");
  } else {
    const bridge = nodecg.getSocketIOServer().server.of("/pv-digivote-bridge");
    const emitUntyped = bridge.emit.bind(bridge) as unknown as (eventName: string, payload: unknown) => boolean;
    emitBridgeCue = (cue) => {
      emitUntyped("cue", cue);
    };
    bridge.use((socket, next) => {
      if (socket.handshake.auth.token !== bridgeToken) {
        next(new Error("Bridge-Token ungültig"));
        return;
      }
      next();
    });
    bridge.on("connection", (socket) => {
      update({ bridgeStatus: process.env.NODE_ENV === "production" ? "VERBUNDEN" : "SIMULATION" });
      nodecg.log.info(`Show-Bridge verbunden: ${socket.id}`);

      socket.onAny((eventName, payload: unknown) => {
        if (eventName !== "ltc:frame") {
          return;
        }
        const parsed = ltcFrameSchema.safeParse(payload);
        if (!parsed.success) {
          nodecg.log.warn("Ungültiger LTC-Frame von der Show-Bridge verworfen.");
          return;
        }
        const current = readState();
        showState.value = nextRevision(current, {
          bridgeStatus: process.env.NODE_ENV === "production" ? "VERBUNDEN" : "SIMULATION",
          timecode: {
            value: parsed.data.value,
            frameRate: parsed.data.frameRate,
            signal: true
          }
        });
        if (current.paused) return;
        const matchingCues = timecodeCues.filter((cue) =>
          cue.timecode === parsed.data.value
          && Math.abs(cue.frameRate - parsed.data.frameRate) < 0.01
          && !firedCueIds.has(cue.id)
        );
        for (const cue of matchingCues) {
          firedCueIds.add(cue.id);
          void (async () => {
            if (cue.eventType === "ACT_IDENTITY_REVEAL" && cue.actId) {
              await revealActIdentity(cue.actId);
              update({ phase: "AUFTRITT", currentActId: cue.actId });
            }
            emitBridgeCue({
              eventType: cue.eventType,
              actId: cue.actId,
              timecode: cue.timecode,
              ...cue.payload
            });
            nodecg.log.info(`Timecode-Cue ausgelöst: ${cue.eventType} @ ${cue.timecode}`);
          })().catch((error: unknown) => nodecg.log.error(`Timecode-Cue fehlgeschlagen: ${String(error)}`));
        }
      });

      socket.on("disconnect", () => {
        update({
          bridgeStatus: "GETRENNT",
          timecode: {
            ...readState().timecode,
            signal: false
          }
        });
        nodecg.log.warn("Show-Bridge getrennt.");
      });
    });
  }

  pingDatabase()
    .then(async (status) => {
      nodecg.log.info(`Datenbankstatus: ${status}`);
      if (status === "configured") {
        const bundle = await getActiveEventBundle();
        if (bundle) timecodeCues = await getTimecodeCues(bundle.event.id);
        await refreshVotingCounts(bundle);
      }
    })
    .catch((error: unknown) => nodecg.log.warn(`Datenbank nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`));

  nodecg.log.info("PastEurovision DigiVote Extension ist bereit.");
}

module.exports = extension;
