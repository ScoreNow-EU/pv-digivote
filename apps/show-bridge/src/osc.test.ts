import { describe, expect, it } from "vitest";
import { encodeOscMessage } from "./osc";

describe("OSC", () => {
  it("kodiert Adresse, Typen und Argumente im OSC-Format", () => {
    const packet = encodeOscMessage("/pastvision/cue", [12, "DE", true]);
    expect(packet.length % 4).toBe(0);
    expect(packet.subarray(0, 16).toString("utf8").replaceAll("\0", "")).toBe("/pastvision/cue");
    expect(packet.includes(Buffer.from(",isT\0"))).toBe(true);
    expect(packet.readInt32BE(packet.length - 8)).toBe(12);
  });

  it("weist ungültige Adressen zurück", () => {
    expect(() => encodeOscMessage("pastvision/cue")).toThrow(/beginnen/);
  });
});
