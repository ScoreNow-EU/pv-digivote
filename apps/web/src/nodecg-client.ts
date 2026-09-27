import { useCallback, useEffect, useState } from "react";
import { showPhaseSchema, showStateSchema, type EventConfig, type ShowState } from "@pv/domain";
import { demoJurors, demoShowState } from "./demo-data";

interface BrowserReplicant<T> {
  value?: T;
  on(event: "change", listener: (newValue: T) => void): void;
  removeListener?(event: "change", listener: (newValue: T) => void): void;
}

interface BrowserNodeCg {
  Replicant<T>(name: string): BrowserReplicant<T>;
  sendMessage(name: string, payload?: unknown): Promise<unknown> | void;
}

declare global {
  interface Window {
    nodecg?: BrowserNodeCg;
  }
}

// Muss zur Wartezeit in apps/nodecg-extension/src/index.ts passen.
const JURY_REVEAL_DELAY_MS = 3_000;

export type ShowCommand =
  | { type: "set-phase"; phase: ShowState["phase"] }
  | { type: "toggle-pause" }
  | { type: "toggle-public-voting" }
  | { type: "toggle-jury-voting" }
  | { type: "reveal-next-act" }
  | { type: "advance-jury-reveal" }
  | { type: "rewind-jury-reveal" }
  | { type: "advance-public-reveal" }
  | { type: "reset-public-reveal" }
  | { type: "start-runoff" }
  | { type: "close-runoff" }
  | { type: "update-event-config"; config: EventConfig };

export function useShowState(): [ShowState, (command: ShowCommand) => void, boolean] {
  const [state, setState] = useState<ShowState>(demoShowState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!window.nodecg) return;
    const replicant = window.nodecg.Replicant<ShowState>("show-state");
    const listener = (value: ShowState) => {
      const parsed = showStateSchema.safeParse(value);
      if (parsed.success) {
        setState(parsed.data);
        setConnected(true);
      }
    };
    replicant.on("change", listener);
    if (replicant.value) listener(replicant.value);
    return () => replicant.removeListener?.("change", listener);
  }, []);

  const send = useCallback((command: ShowCommand) => {
    if (window.nodecg) {
      if (command.type === "set-phase") window.nodecg.sendMessage("pv:set-phase", command.phase);
      if (command.type === "toggle-pause") window.nodecg.sendMessage("pv:toggle-pause");
      if (command.type === "toggle-public-voting") window.nodecg.sendMessage("pv:toggle-public-voting");
      if (command.type === "toggle-jury-voting") window.nodecg.sendMessage("pv:toggle-jury-voting");
      if (command.type === "reveal-next-act") window.nodecg.sendMessage("pv:reveal-next-act");
      if (command.type === "advance-jury-reveal") window.nodecg.sendMessage("pv:advance-jury-reveal");
      if (command.type === "rewind-jury-reveal") window.nodecg.sendMessage("pv:rewind-jury-reveal");
      if (command.type === "advance-public-reveal") window.nodecg.sendMessage("pv:advance-public-reveal");
      if (command.type === "reset-public-reveal") window.nodecg.sendMessage("pv:reset-public-reveal");
      if (command.type === "start-runoff") window.nodecg.sendMessage("pv:start-runoff");
      if (command.type === "close-runoff") window.nodecg.sendMessage("pv:close-runoff");
      if (command.type === "update-event-config") window.nodecg.sendMessage("pv:update-event-config", command.config);
      return;
    }

    setState((current) => {
      if (command.type === "set-phase") {
        return { ...current, phase: showPhaseSchema.parse(command.phase), revision: current.revision + 1 };
      }
      if (command.type === "toggle-pause") {
        return { ...current, paused: !current.paused, revision: current.revision + 1 };
      }
      if (command.type === "toggle-public-voting") {
        const publicOpen = !current.voting.publicOpen;
        return {
          ...current,
          phase: publicOpen ? "VOTING_OFFEN" : "VOTING_GESCHLOSSEN",
          voting: { ...current.voting, publicOpen },
          revision: current.revision + 1
        };
      }
      if (command.type === "toggle-jury-voting") {
        return {
          ...current,
          voting: { ...current.voting, juryOpen: !current.voting.juryOpen },
          revision: current.revision + 1
        };
      }
      if (command.type === "reveal-next-act") {
        return { ...current, phase: "AUFTRITT", revision: current.revision + 1 };
      }
      if (command.type === "advance-public-reveal") {
        return {
          ...current,
          phase: "PUBLIC_REVEAL",
          currentPublicRevealIndex: current.currentPublicRevealIndex + 1,
          revision: current.revision + 1
        };
      }
      if (command.type === "reset-public-reveal") {
        return {
          ...current,
          phase: "VOTING_GESCHLOSSEN",
          currentPublicRevealIndex: 0,
          revealedPublicActIds: [],
          revision: current.revision + 1
        };
      }
      if (command.type === "update-event-config") return current;
      if (command.type === "start-runoff") return { ...current, phase: "STICHWAHL_OFFEN", revision: current.revision + 1 };
      if (command.type === "close-runoff") return { ...current, phase: "FINALE", revision: current.revision + 1 };
      const sequence = [-1, 0, 8, 10, 12] as const;
      const index = sequence.indexOf(current.currentRevealPoint);
      if (command.type === "rewind-jury-reveal") {
        const atStart = index <= 0;
        return {
          ...current,
          phase: "JURY_REVEAL",
          currentRevealPoint: atStart ? sequence[sequence.length - 1]! : sequence[index - 1]!,
          currentJurorIndex: atStart ? Math.max(0, current.currentJurorIndex - 1) : current.currentJurorIndex,
          pendingJuryReveal: null,
          revision: current.revision + 1
        };
      }
      // advance-jury-reveal: wie im Backend erst als Vorschau ankündigen,
      // der eigentliche Wechsel (den der Beamer zeigt) folgt verzögert.
      const atEnd = index === sequence.length - 1;
      const nextPoint = atEnd ? sequence[0]! : sequence[index + 1]!;
      const nextJurorIndex = atEnd ? current.currentJurorIndex + 1 : current.currentJurorIndex;
      if (nextJurorIndex >= demoJurors.length) {
        // Alle Jurys durchgeklickt: direkt weiter zum Publikums-Reveal.
        return { ...current, phase: "PUBLIC_REVEAL", pendingJuryReveal: null, revision: current.revision + 1 };
      }
      const revealAt = new Date(Date.now() + JURY_REVEAL_DELAY_MS).toISOString();
      window.setTimeout(() => {
        setState((latest) => (latest.paused ? latest : {
          ...latest,
          phase: "JURY_REVEAL",
          currentRevealPoint: nextPoint,
          currentJurorIndex: nextJurorIndex,
          pendingJuryReveal: null,
          revision: latest.revision + 1
        }));
      }, JURY_REVEAL_DELAY_MS);
      return {
        ...current,
        pendingJuryReveal: { currentJurorIndex: nextJurorIndex, currentRevealPoint: nextPoint, actId: null, revealAt },
        revision: current.revision + 1
      };
    });
  }, []);

  return [state, send, connected];
}
