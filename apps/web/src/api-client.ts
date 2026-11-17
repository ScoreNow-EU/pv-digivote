import { useEffect, useState } from "react";
import type { Act, Ballot, EventConfig, JurorType } from "@pv/domain";
import type { ScoreRow } from "@pv/scoring";

const API_BASE = "/pv-digivote/api";

export interface PublicAct extends Act {
  artistNames: string[];
}

export interface PublicJuror {
  id: string;
  displayName: string;
  type: JurorType;
  revealOrder: number;
}

export interface BootstrapResponse {
  ok: true;
  event: {
    id: string;
    name: string;
    year: number;
    status: "DRAFT" | "READY" | "LIVE" | "ARCHIVED";
    config: EventConfig;
    updatedAt: string;
  };
  acts: PublicAct[];
  jurors: PublicJuror[];
  voting: {
    publicOpen: boolean;
    juryOpen: boolean;
    validPublicBallots: number;
    validJuryBallots: number;
  };
  runoff: null | {
    open: boolean;
    sequenceNumber: number;
    candidateActIds: string[];
    voteCount: number;
  };
  sessions: {
    public: boolean;
    jury: { authenticated: boolean; jurorId?: string; blockedActIds?: string[] };
  };
}

export interface JuryBulkAwardEntry {
  actId: string;
  points: number;
}

export interface JuryRevealStep {
  currentJurorIndex: number;
  currentRevealPoint: -1 | 0 | 8 | 10 | 12;
  actId: string | null;
}

export interface ScoreResponse {
  ok: true;
  rows: ScoreRow[];
  juryTotal: number;
  publicRawTotal: number;
  publicTarget: number;
  publicAllocatedTotal: number;
  requiresRunoff: boolean;
  runoffActIds: string[];
  revealProgress: Record<string, number>;
  currentBulkAward: JuryBulkAwardEntry[];
  nextJuryPreview: JuryRevealStep | null;
}

export interface AdminActInput {
  id?: string;
  startNumber: number;
  countryIsoCode: string;
  countryName: string;
  pseudonym: string;
  songTitle: string;
  realSongTitle: string;
  artistNames: string[];
}

export interface AdminJurorInput {
  id?: string;
  displayName: string;
  type: JurorType;
  pin?: string;
  enabled: boolean;
  revealOrder: number;
  linkedActId?: string;
}

export interface AdminConfigResponse {
  ok: true;
  event: BootstrapResponse["event"];
  acts: PublicAct[];
  jurors: Array<{
    id: string;
    displayName: string;
    type: JurorType;
    enabled: boolean;
    revealOrder: number;
    linkedActId: string;
    // Leer, wenn der PIN nur als Hash bekannt ist (vor der Klartext-Speicherung gesetzt).
    pin: string;
  }>;
}

interface ApiErrorPayload {
  message?: string;
  error?: string;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init
  });
  const payload = await response.json() as T & ApiErrorPayload;
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`);
  return payload;
}

export function fetchBootstrap(): Promise<BootstrapResponse> {
  return requestJson<BootstrapResponse>("/bootstrap");
}

export async function ensurePublicSession(): Promise<void> {
  const bootstrap = await fetchBootstrap();
  if (bootstrap.sessions.public) return;
  await requestJson("/sessions/public", { method: "POST", body: "{}" });
}

export function loginJury(jurorId: string, pin: string): Promise<{
  ok: true;
  juror: { id: string; displayName: string; type: JurorType };
  blockedActIds: string[];
}> {
  return requestJson("/sessions/jury", {
    method: "POST",
    body: JSON.stringify({ jurorId, pin })
  });
}

export function fetchMyBallot(group: "JURY" | "PUBLIC" | "RUNOFF"): Promise<{ ok: true; ballot: Ballot | null }> {
  return requestJson(`/ballots/me?group=${group}`);
}

export function saveBallot(group: "JURY" | "PUBLIC" | "RUNOFF", entries: Array<{ actId: string; points: number }>): Promise<{ ok: true; ballot: Ballot }> {
  return requestJson("/ballots", {
    method: "POST",
    body: JSON.stringify({ group, entries })
  });
}

export function fetchScores(): Promise<ScoreResponse> {
  return requestJson("/scores");
}

export function fetchAdminConfig(): Promise<AdminConfigResponse> {
  return requestJson<AdminConfigResponse>("/admin/config");
}

export function saveAdminActs(acts: AdminActInput[]): Promise<{ ok: true }> {
  return requestJson("/admin/acts", { method: "PUT", body: JSON.stringify({ acts }) });
}

export function saveAdminJurors(jurors: AdminJurorInput[]): Promise<{ ok: true }> {
  return requestJson("/admin/jurors", { method: "PUT", body: JSON.stringify({ jurors }) });
}

export interface DemoVoteResult {
  ok: true;
  jurorsFilled: number;
  publicBallotsCreated: number;
  juryOpen: boolean;
  publicOpen: boolean;
}

export function runDemoVote(publicCount: number): Promise<DemoVoteResult> {
  return requestJson("/admin/demo-vote", { method: "POST", body: JSON.stringify({ publicCount }) });
}

export interface DataImportResult {
  ok: true;
  acts: number;
  jurors: number;
}

// Lädt den Export als Datei herunter (Regie, gleiche Herkunft, daher mit Passwort-Session).
export async function downloadDataExport(): Promise<string> {
  const response = await fetch(`${API_BASE}/admin/export`, { credentials: "same-origin" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as ApiErrorPayload;
    throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "pv-digivote-export.json";
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return filename;
}

export function importData(data: unknown): Promise<DataImportResult> {
  return requestJson("/admin/import", { method: "POST", body: JSON.stringify(data) });
}

export function resetShowProgress(): Promise<{ ok: true }> {
  return requestJson("/admin/reset-progress", { method: "POST", body: "{}" });
}

export function useLiveBackend(enabled: boolean) {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [scores, setScores] = useState<ScoreResponse>();
  const [backendConnected, setBackendConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refresh = async () => {
      try {
        const [nextBootstrap, nextScores] = await Promise.all([fetchBootstrap(), fetchScores()]);
        if (!active) return;
        setBootstrap(nextBootstrap);
        setScores(nextScores);
        setBackendConnected(true);
      } catch {
        if (active) setBackendConnected(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return { bootstrap, scores, backendConnected };
}
