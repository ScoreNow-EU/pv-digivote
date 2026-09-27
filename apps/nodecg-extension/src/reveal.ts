import type { BallotEntry, ShowPhase, ShowState } from "@pv/domain";
import type { EventBundle } from "@pv/database";

export function findLinkedAct(juror: EventBundle["jurors"][number], acts: EventBundle["acts"]) {
  if (juror.linkedActIds.length > 0) {
    return acts.find((act) => juror.linkedActIds.includes(act.id));
  }
  return acts.find((act) => act.artistIds.some((artistId) => juror.artistIds.includes(artistId)));
}

export function publicBundle(bundle: EventBundle) {
  return {
    event: bundle.event,
    acts: bundle.acts.map((act) => ({
      ...act,
      artistNames: act.identityRevealed ? act.artistNames : []
    })),
    jurors: bundle.jurors
      .filter((juror) => juror.enabled)
      .map((juror) => {
        const linkedAct = juror.type === "ARTIST" ? findLinkedAct(juror, bundle.acts) : undefined;
        const displayName = linkedAct && !linkedAct.identityRevealed ? linkedAct.pseudonym : juror.displayName;
        return { id: juror.id, displayName, type: juror.type, revealOrder: juror.revealOrder };
      })
  };
}

// Reveal-Stufen pro Juror: -1 kündigt nur den Namen an (noch keine Punkte),
// 0 enthüllt die gesammelten Punkte 1-7, danach folgen 8, 10 und 12 einzeln.
export const JURY_REVEAL_SEQUENCE = [-1, 0, 8, 10, 12] as const;

export const PHASES_BEFORE_JURY_REVEAL: readonly ShowPhase[] = [
  "SETUP",
  "BEREIT",
  "AUFTRITT",
  "VOTING_BEREIT",
  "VOTING_OFFEN",
  "VOTING_GESCHLOSSEN",
  "VALIDIERUNG"
];

export function revealedPointValues(currentRevealPoint: ShowState["currentRevealPoint"]): ReadonlySet<number> {
  const stageIndex = JURY_REVEAL_SEQUENCE.indexOf(currentRevealPoint);
  const values = new Set<number>();
  if (stageIndex >= 1) for (let point = 1; point <= 7; point += 1) values.add(point);
  if (stageIndex >= 2) values.add(8);
  if (stageIndex >= 3) values.add(10);
  if (stageIndex >= 4) values.add(12);
  return values;
}

export interface JuryRevealStep {
  currentJurorIndex: number;
  currentRevealPoint: ShowState["currentRevealPoint"];
  actId: string | null;
}

// Berechnet, was der NÄCHSTE Klick auf "Nächsten Punkt zeigen" enthüllen
// würde, ohne den State zu verändern ("Peek"). Das Moderator-Tablet zeigt
// diesen Schritt permanent als Vorschau, bevor die Regie überhaupt klickt.
export function computeNextJuryStep(
  orderedJurors: readonly { id: string }[],
  ballotsByJuror: ReadonlyMap<string, BallotEntry[]>,
  currentJurorIndex: number,
  currentRevealPoint: ShowState["currentRevealPoint"]
): JuryRevealStep {
  const stageIndex = JURY_REVEAL_SEQUENCE.indexOf(currentRevealPoint);
  const atEnd = stageIndex === JURY_REVEAL_SEQUENCE.length - 1;
  const nextPoint = atEnd ? JURY_REVEAL_SEQUENCE[0]! : JURY_REVEAL_SEQUENCE[stageIndex + 1]!;
  const nextJurorIndex = atEnd ? currentJurorIndex + 1 : currentJurorIndex;
  const juror = orderedJurors[nextJurorIndex % Math.max(orderedJurors.length, 1)];
  const actId = juror && nextPoint > 0
    ? (ballotsByJuror.get(juror.id) ?? []).find((entry) => entry.points === nextPoint)?.actId ?? null
    : null;
  return { currentJurorIndex: nextJurorIndex, currentRevealPoint: nextPoint, actId };
}

export function computeJuryRevealProgress(
  actIds: readonly string[],
  orderedJurors: readonly { id: string }[],
  ballotsByJuror: ReadonlyMap<string, BallotEntry[]>,
  currentJurorIndex: number,
  currentRevealPoint: ShowState["currentRevealPoint"]
): Record<string, number> {
  const progress = new Map(actIds.map((actId) => [actId, 0]));
  const revealedValues = revealedPointValues(currentRevealPoint);
  orderedJurors.forEach((juror, index) => {
    if (index > currentJurorIndex) return;
    const fullyRevealed = index < currentJurorIndex;
    for (const entry of ballotsByJuror.get(juror.id) ?? []) {
      if (fullyRevealed || revealedValues.has(entry.points)) {
        progress.set(entry.actId, (progress.get(entry.actId) ?? 0) + entry.points);
      }
    }
  });
  return Object.fromEntries(progress);
}
