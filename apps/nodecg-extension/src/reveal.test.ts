import { describe, expect, it } from "vitest";
import type { Act, BallotEntry, Juror } from "@pv/domain";
import type { EventBundle } from "@pv/database";
import { computeJuryRevealProgress, computeNextJuryStep, findLinkedAct, publicBundle, revealedPointValues } from "./reveal";

function makeAct(overrides: Partial<Act & { artistNames: string[] }>): Act & { artistNames: string[] } {
  return {
    id: "act-1",
    startNumber: 1,
    country: { id: "country-de", isoCode: "DE", displayName: "Deutschland", flag: "DE" },
    pseudonym: "Act 01",
    songTitle: "Songtitel 01",
    artistIds: ["artist-1"],
    identityRevealed: false,
    artistNames: ["Klarname 01"],
    ...overrides
  };
}

function makeJuror(overrides: Partial<Juror>): Juror {
  return {
    id: "juror-1",
    displayName: "Klarname 01",
    type: "ARTIST",
    artistIds: [],
    linkedActIds: [],
    enabled: true,
    revealOrder: 1,
    ...overrides
  };
}

describe("findLinkedAct", () => {
  const act = makeAct({ id: "act-1", artistIds: ["artist-1"] });

  it("findet den Act über linkedActIds", () => {
    const juror = makeJuror({ linkedActIds: ["act-1"] });
    expect(findLinkedAct(juror, [act])).toBe(act);
  });

  it("findet den Act über gemeinsame Artist-IDs, wenn keine linkedActIds gesetzt sind", () => {
    const juror = makeJuror({ artistIds: ["artist-1"] });
    expect(findLinkedAct(juror, [act])).toBe(act);
  });

  it("liefert undefined, wenn keine Verknüpfung besteht", () => {
    const juror = makeJuror({ artistIds: ["artist-99"] });
    expect(findLinkedAct(juror, [act])).toBeUndefined();
  });
});

describe("publicBundle", () => {
  const bundle: EventBundle = {
    event: {
      id: "event-1",
      name: "PastEurovision 2026",
      year: 2026,
      status: "LIVE",
      config: {
        locale: "de-DE",
        pointScale: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12],
        requireCompleteBallot: true,
        selfVotePolicy: "BLOCK_LINKED_ACTS",
        weights: { jury: 0.5, public: 0.5 },
        juryReveal: { bulkPoints: [1, 2, 3, 4, 5, 6, 7], individualPoints: [8, 10, 12] },
        timecode: { frameRate: 25, manualFallback: true }
      },
      updatedAt: new Date(0).toISOString()
    },
    acts: [
      makeAct({ id: "act-1", pseudonym: "Act 01", artistIds: ["artist-1"], identityRevealed: false, artistNames: ["Klarname 01"] }),
      makeAct({ id: "act-2", pseudonym: "Act 02", artistIds: ["artist-2"], identityRevealed: true, artistNames: ["Klarname 02"] })
    ],
    artists: [
      { id: "artist-1", realName: "Klarname 01", actIds: ["act-1"] },
      { id: "artist-2", realName: "Klarname 02", actIds: ["act-2"] }
    ],
    jurors: [
      makeJuror({ id: "juror-1", displayName: "Klarname 01", type: "ARTIST", artistIds: ["artist-1"], linkedActIds: ["act-1"] }),
      makeJuror({ id: "juror-2", displayName: "Klarname 02", type: "ARTIST", artistIds: ["artist-2"], linkedActIds: ["act-2"] }),
      makeJuror({ id: "juror-3", displayName: "Regie-Gast", type: "REGIE", enabled: false })
    ]
  };

  it("versteckt Klarnamen von Acts vor dem Reveal", () => {
    const result = publicBundle(bundle);
    expect(result.acts.find((act) => act.id === "act-1")?.artistNames).toEqual([]);
    expect(result.acts.find((act) => act.id === "act-2")?.artistNames).toEqual(["Klarname 02"]);
  });

  it("zeigt für einen nicht enthüllten Artist-Juror das Pseudonym des verknüpften Acts statt des Klarnamens", () => {
    const result = publicBundle(bundle);
    expect(result.jurors.find((juror) => juror.id === "juror-1")?.displayName).toBe("Act 01");
  });

  it("zeigt für einen bereits enthüllten Artist-Juror den echten Namen", () => {
    const result = publicBundle(bundle);
    expect(result.jurors.find((juror) => juror.id === "juror-2")?.displayName).toBe("Klarname 02");
  });

  it("filtert deaktivierte Jurys heraus", () => {
    const result = publicBundle(bundle);
    expect(result.jurors.some((juror) => juror.id === "juror-3")).toBe(false);
  });
});

describe("revealedPointValues", () => {
  it("enthält bei 0 nur die Sammelpunkte 1-7", () => {
    expect([...revealedPointValues(0)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("kommt bei 12 kumulativ auf alle Punktwerte", () => {
    expect([...revealedPointValues(12)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 12]);
  });
});

describe("computeJuryRevealProgress", () => {
  const actIds = ["act-1", "act-2"];
  const orderedJurors = [{ id: "juror-1" }, { id: "juror-2" }];
  const ballotsByJuror = new Map<string, BallotEntry[]>([
    ["juror-1", [{ actId: "act-1", points: 12 }, { actId: "act-2", points: 1 }]],
    ["juror-2", [{ actId: "act-2", points: 12 }, { actId: "act-1", points: 1 }]]
  ]);

  it("zählt für den aktuellen Juror nur bereits enthüllte Punktwerte", () => {
    const progress = computeJuryRevealProgress(actIds, orderedJurors, ballotsByJuror, 0, 0);
    expect(progress).toEqual({ "act-1": 0, "act-2": 1 });
  });

  it("zählt frühere Jurys vollständig, den laufenden Juror nur bis zum aktuellen Punktwert", () => {
    const progress = computeJuryRevealProgress(actIds, orderedJurors, ballotsByJuror, 1, 8);
    expect(progress).toEqual({ "act-1": 13, "act-2": 1 });
  });

  it("zählt nach dem letzten Juror die volle Summe", () => {
    const progress = computeJuryRevealProgress(actIds, orderedJurors, ballotsByJuror, 2, 0);
    expect(progress).toEqual({ "act-1": 13, "act-2": 13 });
  });
});

describe("computeNextJuryStep", () => {
  const orderedJurors = [{ id: "juror-1" }, { id: "juror-2" }];
  const ballotsByJuror = new Map<string, BallotEntry[]>([
    ["juror-1", [{ actId: "act-1", points: 12 }, { actId: "act-2", points: 8 }]],
    ["juror-2", [{ actId: "act-2", points: 12 }, { actId: "act-1", points: 8 }]]
  ]);

  it("kündigt für die Sammelpunkte keinen einzelnen Act an", () => {
    const next = computeNextJuryStep(orderedJurors, ballotsByJuror, 0, -1);
    expect(next).toEqual({ currentJurorIndex: 0, currentRevealPoint: 0, actId: null });
  });

  it("löst für einen Punktwert den passenden Act aus dem Stimmzettel des Jurors auf", () => {
    const next = computeNextJuryStep(orderedJurors, ballotsByJuror, 0, 0);
    expect(next).toEqual({ currentJurorIndex: 0, currentRevealPoint: 8, actId: "act-2" });
  });

  it("wechselt nach dem letzten Punktwert zur Ankündigung des nächsten Jurors", () => {
    const next = computeNextJuryStep(orderedJurors, ballotsByJuror, 0, 12);
    expect(next).toEqual({ currentJurorIndex: 1, currentRevealPoint: -1, actId: null });
  });

  it("wickelt nach dem letzten Juror wieder zum ersten", () => {
    const next = computeNextJuryStep(orderedJurors, ballotsByJuror, 1, 12);
    expect(next).toEqual({ currentJurorIndex: 2, currentRevealPoint: -1, actId: null });
  });
});
