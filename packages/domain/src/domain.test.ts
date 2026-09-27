import { describe, expect, it } from "vitest";
import {
  DEFAULT_POINT_SCALE,
  getBlockedActIds,
  validateEscBallot,
  type Artist,
  type Juror
} from "./index";

describe("validateEscBallot", () => {
  const entries = DEFAULT_POINT_SCALE.map((points, index) => ({
    actId: `act-${index + 1}`,
    points
  }));

  it("akzeptiert einen vollständigen ESC-Stimmzettel", () => {
    expect(validateEscBallot(entries, DEFAULT_POINT_SCALE)).toEqual({ valid: true });
  });

  it("lehnt doppelte Acts und fehlende Punktwerte ab", () => {
    const invalid = entries.map((entry) => ({ ...entry }));
    invalid[9] = { actId: invalid[0]!.actId, points: 12 };

    const result = validateEscBallot(invalid, DEFAULT_POINT_SCALE);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toContain("Jeder Act darf nur einen Punktwert erhalten.");
  });

  it("lehnt Punkte für verknüpfte eigene Acts ab", () => {
    const result = validateEscBallot(entries, DEFAULT_POINT_SCALE, new Set(["act-10"]));
    expect(result.valid).toBe(false);
  });
});

describe("getBlockedActIds", () => {
  const artists: Artist[] = [
    { id: "artist-1", realName: "Mara", actIds: ["act-1", "act-3"] }
  ];
  const juror: Juror = {
    id: "juror-1",
    displayName: "Mara",
    type: "ARTIST",
    artistIds: ["artist-1"],
    linkedActIds: [],
    enabled: true,
    revealOrder: 1
  };

  it("sperrt alle Acts eines Artists", () => {
    expect([...getBlockedActIds(juror, artists, "BLOCK_LINKED_ACTS")]).toEqual(["act-1", "act-3"]);
  });

  it("lässt eine Regie-Jury ohne Zuordnung frei abstimmen", () => {
    const direction: Juror = { ...juror, id: "direction", type: "REGIE", artistIds: [] };
    expect(getBlockedActIds(direction, artists, "BLOCK_LINKED_ACTS").size).toBe(0);
  });
});
