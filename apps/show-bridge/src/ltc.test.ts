import { describe, expect, it } from "vitest";
import { formatTimecode, incrementTimecode, parseTimecode } from "./ltc";

describe("LTC", () => {
  it("parst und formatiert 25-fps-Timecode", () => {
    const frame = parseTimecode("01:02:03:24", 25);
    expect(formatTimecode(frame)).toBe("01:02:03:24");
  });

  it("rollt korrekt in die nächste Sekunde", () => {
    expect(formatTimecode(incrementTimecode(parseTimecode("00:00:59:24", 25)))).toBe("00:01:00:00");
  });

  it("weist Frames außerhalb der Framerate zurück", () => {
    expect(() => parseTimecode("00:00:00:25", 25)).toThrow(/außerhalb/);
  });
});
