import type { Act, ShowState } from "@pv/domain";

export interface DemoScore {
  actId: string;
  juryPoints: number;
  publicPoints: number;
}

const countries = [
  ["DE", "Deutschland", "🇩🇪"],
  ["SE", "Schweden", "🇸🇪"],
  ["FI", "Finnland", "🇫🇮"],
  ["IT", "Italien", "🇮🇹"],
  ["ES", "Spanien", "🇪🇸"],
  ["FR", "Frankreich", "🇫🇷"],
  ["NL", "Niederlande", "🇳🇱"],
  ["NO", "Norwegen", "🇳🇴"],
  ["AT", "Österreich", "🇦🇹"],
  ["IE", "Irland", "🇮🇪"],
  ["GB", "Vereinigtes Königreich", "🇬🇧"],
  ["CH", "Schweiz", "🇨🇭"]
] as const;

export const demoActs: Act[] = countries.map(([isoCode, displayName, flag], index) => ({
  id: `act-${index + 1}`,
  startNumber: index + 1,
  country: {
    id: `country-${isoCode.toLowerCase()}`,
    isoCode,
    displayName,
    flag
  },
  pseudonym: `Act ${String(index + 1).padStart(2, "0")}`,
  songTitle: `Songtitel ${String(index + 1).padStart(2, "0")}`,
  artistIds: [`artist-${index + 1}`],
  identityRevealed: index < 4
}));

const juryPoints = [82, 72, 68, 61, 57, 53, 48, 44, 38, 26, 20, 11];
const publicPoints = [96, 54, 75, 45, 60, 50, 42, 58, 38, 27, 20, 15];

export const demoScores: DemoScore[] = demoActs.map((act, index) => ({
  actId: act.id,
  juryPoints: juryPoints[index]!,
  publicPoints: publicPoints[index]!
}));

export const demoJurors = Array.from({ length: 10 }, (_, index) => ({
  id: `juror-${index + 1}`,
  displayName: index === 9 ? "Regie" : `Artist ${String(index + 1).padStart(2, "0")}`,
  completed: index < 7
}));

export const demoShowState: ShowState = {
  revision: 14,
  phase: "JURY_REVEAL",
  paused: false,
  currentActId: "act-1",
  currentJurorIndex: 1,
  currentRevealPoint: 10,
  currentPublicRevealIndex: 0,
  revealedPublicActIds: [],
  pendingJuryReveal: null,
  voting: {
    publicOpen: false,
    juryOpen: false,
    validPublicBallots: 30,
    validJuryBallots: 10
  },
  screens: {
    a: "JURY_REVEAL",
    b: "RANGLISTE"
  },
  timecode: {
    value: "01:12:38:17",
    frameRate: 25,
    signal: true
  },
  bridgeStatus: "SIMULATION",
  updatedAt: new Date().toISOString()
};
