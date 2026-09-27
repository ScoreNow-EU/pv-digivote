import { describe, expect, it } from "vitest";
import { DEFAULT_POINT_SCALE, type Ballot } from "@pv/domain";
import { computeScoreboard, normalizePublicPoints } from "./index";

const actIds = Array.from({ length: 12 }, (_, index) => `act-${index + 1}`);

function createBallot(group: "JURY" | "PUBLIC", voterIndex: number, rotation = 0): Ballot {
  const selected = Array.from({ length: 10 }, (_, index) => actIds[(index + rotation) % actIds.length]!);
  return {
    id: `${group.toLowerCase()}-${voterIndex}`,
    voterId: `${group.toLowerCase()}-voter-${voterIndex}`,
    group,
    revision: 1,
    status: "SUBMITTED",
    entries: selected.map((actId, index) => ({ actId, points: DEFAULT_POINT_SCALE[index]! })),
    submittedAt: new Date(2026, 8, 26, 20, voterIndex).toISOString()
  };
}

describe("normalizePublicPoints", () => {
  it("verteilt den Rundungsrest deterministisch und erhält die Zielsumme", () => {
    const raw = new Map([
      ["act-a", 10],
      ["act-b", 10],
      ["act-c", 10]
    ]);
    const tieStats = {
      distinctVoters: new Map([["act-a", 1], ["act-b", 1], ["act-c", 1]]),
      highScoreCounts: new Map([["act-a", {}], ["act-b", {}], ["act-c", {}]])
    };

    const result = normalizePublicPoints(raw, 10, tieStats, DEFAULT_POINT_SCALE);
    expect([...result.values()].reduce((sum, value) => sum + value, 0)).toBe(10);
    expect(result.get("act-a")).toBe(4);
  });
});

describe("computeScoreboard", () => {
  it.each([15, 30, 50])(
    "normalisiert %i Publikumsstimmen bei 50:50 exakt auf 580 Punkte",
    (publicCount) => {
      const juryBallots = Array.from({ length: 10 }, (_, index) => createBallot("JURY", index, index % 3));
      const publicBallots = Array.from({ length: publicCount }, (_, index) =>
        createBallot("PUBLIC", index, index % actIds.length)
      );

      const result = computeScoreboard({
        actIds,
        juryBallots,
        publicBallots,
        pointScale: DEFAULT_POINT_SCALE,
        juryWeight: 0.5,
        publicWeight: 0.5
      });

      expect(result.juryTotal).toBe(580);
      expect(result.publicTarget).toBe(580);
      expect(result.publicAllocatedTotal).toBe(580);
      expect(result.rows.reduce((sum, row) => sum + row.juryPoints, 0)).toBe(580);
    }
  );

  it("ignoriert gesperrte Stimmzettel", () => {
    const valid = createBallot("JURY", 1);
    const blocked = { ...createBallot("JURY", 2), status: "BLOCKED" as const };
    const result = computeScoreboard({
      actIds,
      juryBallots: [valid, blocked],
      publicBallots: [],
      pointScale: DEFAULT_POINT_SCALE,
      juryWeight: 0.5,
      publicWeight: 0.5
    });

    expect(result.juryTotal).toBe(58);
  });

  it("fordert bei vollständigem Gleichstand an der Spitze eine Stichwahl", () => {
    const tiedActIds = ["act-a", "act-b"];
    const result = computeScoreboard({
      actIds: tiedActIds,
      juryBallots: [],
      publicBallots: [],
      pointScale: [1],
      juryWeight: 0.5,
      publicWeight: 0.5
    });

    expect(result.requiresRunoff).toBe(true);
    expect(result.runoffActIds).toEqual(tiedActIds);
  });
});
