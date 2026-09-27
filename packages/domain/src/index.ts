import { z } from "zod";

export const DEFAULT_POINT_SCALE = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12] as const;

export const entityIdSchema = z.string().min(1).max(128);
export type EntityId = z.infer<typeof entityIdSchema>;

export const countrySchema = z.object({
  id: entityIdSchema,
  isoCode: z.string().regex(/^[A-Z]{2}$/),
  displayName: z.string().min(1).max(80),
  flag: z.string().min(1).max(512)
});
export type Country = z.infer<typeof countrySchema>;

export const artistSchema = z.object({
  id: entityIdSchema,
  realName: z.string().min(1).max(120),
  actIds: z.array(entityIdSchema).default([])
});
export type Artist = z.infer<typeof artistSchema>;

export const actSchema = z.object({
  id: entityIdSchema,
  startNumber: z.number().int().positive().max(99),
  country: countrySchema,
  pseudonym: z.string().min(1).max(120),
  songTitle: z.string().min(1).max(160),
  artistIds: z.array(entityIdSchema).min(1),
  identityRevealed: z.boolean().default(false)
});
export type Act = z.infer<typeof actSchema>;

export const jurorTypeSchema = z.enum(["ARTIST", "REGIE", "GAST"]);
export type JurorType = z.infer<typeof jurorTypeSchema>;

export const selfVotePolicySchema = z.enum(["BLOCK_LINKED_ACTS", "ALLOW"]);
export type SelfVotePolicy = z.infer<typeof selfVotePolicySchema>;

export const jurorSchema = z.object({
  id: entityIdSchema,
  displayName: z.string().min(1).max(120),
  type: jurorTypeSchema,
  artistIds: z.array(entityIdSchema).default([]),
  linkedActIds: z.array(entityIdSchema).default([]),
  selfVotePolicyOverride: selfVotePolicySchema.optional(),
  enabled: z.boolean().default(true),
  revealOrder: z.number().int().nonnegative()
});
export type Juror = z.infer<typeof jurorSchema>;

export const ballotGroupSchema = z.enum(["JURY", "PUBLIC", "RUNOFF"]);
export type BallotGroup = z.infer<typeof ballotGroupSchema>;

export const ballotStatusSchema = z.enum([
  "DRAFT",
  "SUBMITTED",
  "LOCKED",
  "BLOCKED",
  "SUPERSEDED"
]);
export type BallotStatus = z.infer<typeof ballotStatusSchema>;

export const ballotEntrySchema = z.object({
  actId: entityIdSchema,
  points: z.number().int().positive()
});
export type BallotEntry = z.infer<typeof ballotEntrySchema>;

export const ballotSchema = z.object({
  id: entityIdSchema,
  voterId: entityIdSchema,
  group: ballotGroupSchema,
  revision: z.number().int().positive(),
  status: ballotStatusSchema,
  entries: z.array(ballotEntrySchema),
  submittedAt: z.string().datetime().optional()
});
export type Ballot = z.infer<typeof ballotSchema>;

export const showPhaseSchema = z.enum([
  "SETUP",
  "BEREIT",
  "AUFTRITT",
  "VOTING_BEREIT",
  "VOTING_OFFEN",
  "VOTING_GESCHLOSSEN",
  "VALIDIERUNG",
  "JURY_REVEAL",
  "PUBLIC_REVEAL",
  "STICHWAHL",
  "STICHWAHL_OFFEN",
  "STICHWAHL_GESCHLOSSEN",
  "FINALE",
  "ARCHIVIERT"
]);
export type ShowPhase = z.infer<typeof showPhaseSchema>;

export const bridgeStatusSchema = z.enum(["VERBUNDEN", "GETRENNT", "SIMULATION"]);
export type BridgeStatus = z.infer<typeof bridgeStatusSchema>;

export const showStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  phase: showPhaseSchema,
  paused: z.boolean(),
  currentActId: entityIdSchema.nullable(),
  currentJurorIndex: z.number().int().nonnegative(),
  currentRevealPoint: z.union([z.literal(-1), z.literal(0), z.literal(8), z.literal(10), z.literal(12)]),
  currentPublicRevealIndex: z.number().int().nonnegative().default(0),
  revealedPublicActIds: z.array(entityIdSchema).default([]),
  pendingJuryReveal: z.object({
    currentJurorIndex: z.number().int().nonnegative(),
    currentRevealPoint: z.union([z.literal(-1), z.literal(0), z.literal(8), z.literal(10), z.literal(12)]),
    actId: entityIdSchema.nullable(),
    revealAt: z.string().datetime()
  }).nullable().default(null),
  voting: z.object({
    publicOpen: z.boolean(),
    juryOpen: z.boolean(),
    validPublicBallots: z.number().int().nonnegative(),
    validJuryBallots: z.number().int().nonnegative()
  }),
  screens: z.object({
    a: z.string().min(1),
    b: z.string().min(1)
  }),
  timecode: z.object({
    value: z.string().regex(/^\d{2}:\d{2}:\d{2}:\d{2}$/),
    frameRate: z.number().positive(),
    signal: z.boolean()
  }),
  bridgeStatus: bridgeStatusSchema,
  updatedAt: z.string().datetime()
});
export type ShowState = z.infer<typeof showStateSchema>;

export const defaultShowState: ShowState = {
  revision: 0,
  phase: "SETUP",
  paused: false,
  currentActId: null,
  currentJurorIndex: 0,
  currentRevealPoint: -1,
  currentPublicRevealIndex: 0,
  revealedPublicActIds: [],
  pendingJuryReveal: null,
  voting: {
    publicOpen: false,
    juryOpen: false,
    validPublicBallots: 0,
    validJuryBallots: 0
  },
  screens: {
    a: "RUHE",
    b: "RANGLISTE"
  },
  timecode: {
    value: "00:00:00:00",
    frameRate: 25,
    signal: false
  },
  bridgeStatus: "GETRENNT",
  updatedAt: new Date(0).toISOString()
};

export const eventConfigSchema = z.object({
  locale: z.literal("de-DE").default("de-DE"),
  pointScale: z.array(z.number().int().positive()).min(1).default([...DEFAULT_POINT_SCALE]),
  requireCompleteBallot: z.boolean().default(true),
  selfVotePolicy: selfVotePolicySchema.default("BLOCK_LINKED_ACTS"),
  weights: z.object({
    jury: z.number().positive(),
    public: z.number().positive()
  }).default({ jury: 0.5, public: 0.5 }),
  juryReveal: z.object({
    bulkPoints: z.array(z.number().int().positive()).default([1, 2, 3, 4, 5, 6, 7]),
    individualPoints: z.array(z.number().int().positive()).default([8, 10, 12])
  }),
  timecode: z.object({
    frameRate: z.number().positive().default(25),
    manualFallback: z.boolean().default(true)
  })
});
export type EventConfig = z.infer<typeof eventConfigSchema>;

export function getBlockedActIds(
  juror: Juror,
  artists: readonly Artist[],
  eventPolicy: SelfVotePolicy
): Set<string> {
  const policy = juror.selfVotePolicyOverride ?? eventPolicy;
  if (policy === "ALLOW") return new Set();

  const linkedFromArtists = artists
    .filter((artist) => juror.artistIds.includes(artist.id))
    .flatMap((artist) => artist.actIds);

  return new Set([...juror.linkedActIds, ...linkedFromArtists]);
}

export function validateEscBallot(
  entries: readonly BallotEntry[],
  pointScale: readonly number[],
  blockedActIds: ReadonlySet<string> = new Set()
): { valid: true } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  const expected = [...pointScale].sort((a, b) => a - b);
  const actual = entries.map((entry) => entry.points).sort((a, b) => a - b);
  const uniqueActs = new Set(entries.map((entry) => entry.actId));

  if (entries.length !== pointScale.length) {
    errors.push(`Es müssen genau ${pointScale.length} Acts bewertet werden.`);
  }
  if (uniqueActs.size !== entries.length) {
    errors.push("Jeder Act darf nur einen Punktwert erhalten.");
  }
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    errors.push("Jeder konfigurierte Punktwert muss genau einmal vergeben werden.");
  }
  const blocked = entries.filter((entry) => blockedActIds.has(entry.actId));
  if (blocked.length > 0) {
    errors.push("Mindestens ein eigener oder gesperrter Act wurde bewertet.");
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
