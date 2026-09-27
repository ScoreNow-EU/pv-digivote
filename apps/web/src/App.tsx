import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { DEFAULT_POINT_SCALE, validateEscBallot, type Act, type EventConfig, type ShowPhase, type ShowState } from "@pv/domain";
import { demoActs, demoJurors, demoScores } from "./demo-data";
import { CountryFlag } from "./CountryFlag";
import { useShowState, type ShowCommand } from "./nodecg-client";
import {
  ensurePublicSession,
  fetchAdminConfig,
  fetchBootstrap,
  fetchMyBallot,
  loginJury,
  runDemoVote,
  saveAdminActs,
  saveAdminJurors,
  saveBallot,
  useLiveBackend,
  type AdminActInput,
  type AdminConfigResponse,
  type AdminJurorInput,
  type BootstrapResponse,
  type JuryBulkAwardEntry,
  type PublicJuror
} from "./api-client";

const phaseLabels: Record<ShowPhase, string> = {
  SETUP: "Einrichtung",
  BEREIT: "Show bereit",
  AUFTRITT: "Auftritt",
  VOTING_BEREIT: "Voting bereit",
  VOTING_OFFEN: "Voting geöffnet",
  VOTING_GESCHLOSSEN: "Voting geschlossen",
  VALIDIERUNG: "Validierung",
  JURY_REVEAL: "Jurywertung",
  PUBLIC_REVEAL: "Publikumsvoting",
  STICHWAHL: "Stichwahl bereit",
  STICHWAHL_OFFEN: "Stichwahl geöffnet",
  STICHWAHL_GESCHLOSSEN: "Stichwahl geschlossen",
  FINALE: "Finale",
  ARCHIVIERT: "Archiviert"
};

interface AppProps {
  surface: string;
}

type DisplayAct = Act & { artistNames?: string[] };
type ControllerSection = "show" | "participants" | "jury" | "settings";

interface DisplayScore {
  actId: string;
  rank?: number;
  juryPoints: number;
  publicPoints: number;
}

export function App({ surface }: AppProps) {
  const [showState, send, connected] = useShowState();
  const live = useLiveBackend(!["vote", "jury"].includes(surface));
  const acts: DisplayAct[] = live.bootstrap?.acts ?? demoActs;
  const jurors = live.bootstrap?.jurors ?? demoJurors;
  const scores: DisplayScore[] = live.scores?.rows.map((row) => ({
    actId: row.actId,
    rank: row.rank,
    juryPoints: row.juryPoints,
    publicPoints: row.publicPoints
  })) ?? demoScores;
  const revealedJuryPoints = live.scores?.revealProgress;
  const currentBulkAward = live.scores?.currentBulkAward ?? [];

  if (surface === "vote") return <VoteSurface />;
  if (surface === "jury") return <JurySurface />;
  if (surface === "tablet") return (
    <TabletSurface
      state={showState}
      connected={connected}
      jurors={jurors}
      acts={acts}
      scores={scores}
      revealedJuryPoints={revealedJuryPoints}
    />
  );
  if (surface === "beamer-a") return (
    <BeamerASurface
      state={showState}
      acts={acts}
      jurors={jurors}
      scores={scores}
      revealedJuryPoints={revealedJuryPoints}
      currentBulkAward={currentBulkAward}
    />
  );
  if (surface === "beamer-b") return (
    <BeamerBSurface state={showState} acts={acts} scores={scores} revealedJuryPoints={revealedJuryPoints} />
  );
  return (
    <ControllerSurface
      state={showState}
      send={send}
      connected={connected}
      backendConnected={live.backendConnected}
      acts={acts}
      jurors={jurors}
      scores={scores}
      config={live.bootstrap?.event.config}
      requiresRunoff={live.scores?.requiresRunoff ?? false}
      runoff={live.bootstrap?.runoff ?? null}
    />
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "brand brand--compact" : "brand"} aria-label="PastEurovision DigiVote">
      <span className="brand__past">Past</span>
      <span className="brand__eurovision">Eurovision</span>
      {!compact && <span className="brand__system">DigiVote 2026</span>}
    </div>
  );
}

function StatusDot({ tone, children }: { tone: "live" | "warn" | "idle"; children: ReactNode }) {
  return (
    <span className={`status-dot status-dot--${tone}`}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}

function ControllerSurface({
  state,
  send,
  connected,
  backendConnected,
  acts,
  jurors,
  scores,
  config,
  requiresRunoff,
  runoff
}: {
  state: ShowState;
  send: (command: ShowCommand) => void;
  connected: boolean;
  backendConnected: boolean;
  acts: DisplayAct[];
  jurors: Array<{ id: string; displayName: string }>;
  scores: DisplayScore[];
  config: EventConfig | undefined;
  requiresRunoff: boolean;
  runoff: BootstrapResponse["runoff"];
}) {
  const [activeSection, setActiveSection] = useState<ControllerSection>("show");
  const [adminConfig, setAdminConfig] = useState<AdminConfigResponse>();
  const [adminError, setAdminError] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [demoPublicCount, setDemoPublicCount] = useState(20);
  const [demoVoteState, setDemoVoteState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [demoVoteMessage, setDemoVoteMessage] = useState("");

  const refreshAdminConfig = async () => {
    setAdminLoading(true);
    setAdminError("");
    try {
      setAdminConfig(await fetchAdminConfig());
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Die Konfiguration konnte nicht geladen werden.");
    } finally {
      setAdminLoading(false);
    }
  };

  // Die Regie braucht jederzeit die echten Klarnamen (auch vor dem Bühnen-Reveal),
  // deshalb wird hier – anders als bei Beamer/Tablet/Vote/Jury – die ungefilterte
  // Admin-Quelle statt des öffentlichen Bootstraps verwendet.
  useEffect(() => {
    void refreshAdminConfig();
    const timer = window.setInterval(() => void refreshAdminConfig(), 4_000);
    return () => window.clearInterval(timer);
  }, []);

  const navigate = (section: ControllerSection) => setActiveSection(section);

  const triggerDemoVote = async () => {
    setDemoVoteState("loading");
    setDemoVoteMessage("");
    try {
      const result = await runDemoVote(demoPublicCount);
      if (!result.juryOpen && !result.publicOpen) {
        setDemoVoteState("error");
        setDemoVoteMessage("Weder Jury- noch Publikumsvoting sind geöffnet.");
        return;
      }
      setDemoVoteState("done");
      const parts: string[] = [];
      if (result.juryOpen) parts.push(`${result.jurorsFilled} Jury-Stimmzettel`);
      if (result.publicOpen) parts.push(`${result.publicBallotsCreated} Publikumsstimmen`);
      setDemoVoteMessage(`Erzeugt: ${parts.join(" · ")}.`);
    } catch (error) {
      setDemoVoteState("error");
      setDemoVoteMessage(error instanceof Error ? error.message : "Demo-Voting fehlgeschlagen.");
    }
  };

  const regieActs: DisplayAct[] = adminConfig?.acts ?? acts;
  const regieJurors = adminConfig ? adminConfig.jurors.filter((juror) => juror.enabled) : jurors;
  const currentJuror = regieJurors[state.currentJurorIndex % regieJurors.length] ?? demoJurors[0]!;
  const nextJuror = regieJurors[(state.currentJurorIndex + 1) % regieJurors.length] ?? demoJurors[1]!;
  const currentAct: DisplayAct = regieActs.find((act) => act.id === state.currentActId) ?? regieActs[0] ?? demoActs[0]!;

  return (
    <div className="controller-shell">
      <header className="topbar topbar--controller">
        <Brand />
        <nav className="admin-nav" aria-label="Regiebereiche">
          {([
            ["show", "Show"],
            ["participants", "Teilnehmer"],
            ["jury", "Jury"],
            ["settings", "Einstellungen"]
          ] as const).map(([section, label]) => (
            <button
              key={section}
              type="button"
              className="admin-nav__item"
              aria-current={activeSection === section ? "page" : undefined}
              onClick={() => navigate(section)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="topbar__actions">
          <div className="topbar__signals" aria-label="Systemstatus">
            <StatusDot tone={state.timecode.signal ? "live" : "warn"}>LTC {state.timecode.signal ? "stabil" : "fehlt"}</StatusDot>
            <StatusDot tone={connected ? "live" : "idle"}>{connected ? "NodeCG live" : "Simulation"}</StatusDot>
            <StatusDot tone={backendConnected ? "live" : "warn"}>{backendConnected ? "DB live" : "DB fehlt"}</StatusDot>
          </div>
          {activeSection === "show" && (
            <button className="button button--danger" type="button" onClick={() => send({ type: "toggle-pause" })}>
              {state.paused ? "Fortsetzen" : "Pausieren"}
            </button>
          )}
        </div>
      </header>

      {activeSection === "show" ? <main className="controller-main">
        <section className="show-heading" aria-labelledby="show-title">
          <div>
            <p className="show-heading__context">PastEurovision 2026 · Live-Regie</p>
            <h1 id="show-title">{phaseLabels[state.phase]}</h1>
            <div className="phase-control">
              <label htmlFor="phase">Showphase</label>
              <select id="phase" value={state.phase} onChange={(event) => send({ type: "set-phase", phase: event.target.value as ShowPhase })}>
                {Object.entries(phaseLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          </div>
          <div className="timecode" aria-label={`Timecode ${state.timecode.value}`}>
            <span>LTC · {state.timecode.frameRate} FPS</span>
            <strong>{state.timecode.value}</strong>
          </div>
        </section>

        {state.paused && (
          <div className="alert alert--warning" role="status">
            <strong>Show pausiert.</strong> Automatische Timecode-Marken und externe Cues sind angehalten.
          </div>
        )}

        <div className="controller-grid">
          <div className="control-stack">
            <section className="panel act-control" aria-labelledby="act-control-title">
              <div>
                <p className="panel__label">Auftritt · Klarname</p>
                <h2 id="act-control-title">{String(currentAct.startNumber).padStart(2, "0")} · {currentAct.country.displayName}</h2>
                <p>{currentAct.pseudonym} · {currentAct.identityRevealed ? (currentAct.artistNames?.join(", ") || "enthüllt") : "noch verborgen"}</p>
              </div>
              <button className="button button--quiet" type="button" disabled={state.paused} onClick={() => send({ type: "reveal-next-act" })}>
                Klarname manuell enthüllen
              </button>
            </section>
            <section className="panel panel--primary" aria-labelledby="next-step-title">
              <div className="panel__head">
                <div>
                  <p className="panel__label">Aktueller Reveal</p>
                  <h2 id="next-step-title">{currentJuror.displayName}</h2>
                </div>
                <span className="point-medallion">
                  {state.currentRevealPoint === 0 ? "1–7" : state.currentRevealPoint}
                </span>
              </div>
              <p className="panel__copy">
                {state.currentRevealPoint === 0
                  ? "Die kleinen Punkte werden gesammelt eingebucht."
                  : `${state.currentRevealPoint} Punkte werden einzeln auf Beamer A enthüllt.`}
              </p>
              <div className="button-row">
                <button
                  className="button button--accent"
                  type="button"
                  disabled={state.paused}
                  onClick={() => send({ type: "advance-jury-reveal" })}
                >
                  Nächsten Punkt zeigen
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  disabled={state.paused}
                  onClick={() => send({ type: "rewind-jury-reveal" })}
                >
                  Schritt zurück
                </button>
              </div>
            </section>

            <section className="panel jury-preview" aria-labelledby="moderator-preview-title">
              <div>
                <p className="panel__label">Moderatorvorschau</p>
                <h2 id="moderator-preview-title">{state.currentRevealPoint === 12 ? nextJuror.displayName : currentJuror.displayName}</h2>
                <p>Auf dem iPad freigegeben, auf dem Beamer noch verborgen.</p>
              </div>
              <span className="visibility-sequence" aria-label="Moderator sichtbar, Beamer verborgen">
                <b>Tablet</b><i aria-hidden="true" /><span>Beamer</span>
              </span>
            </section>

            <section className="panel voting-control" aria-labelledby="voting-title">
              <div className="panel__head panel__head--compact">
                <div>
                  <p className="panel__label">Abstimmung</p>
                  <h2 id="voting-title">Publikum</h2>
                </div>
                <StatusDot tone={state.voting.publicOpen ? "live" : "idle"}>
                  {state.voting.publicOpen ? "geöffnet" : "geschlossen"}
                </StatusDot>
              </div>
              <dl className="compact-stats">
                <div><dt>Publikum</dt><dd>{state.voting.validPublicBallots}</dd></div>
                <div><dt>Jury</dt><dd>{state.voting.validJuryBallots}/{regieJurors.length || 10}</dd></div>
              </dl>
              <button
                className="button button--wide"
                type="button"
                onClick={() => send({ type: "toggle-public-voting" })}
              >
                Voting {state.voting.publicOpen ? "schließen" : "öffnen"}
              </button>
              <button
                className="button button--quiet button--wide"
                type="button"
                onClick={() => send({ type: "toggle-jury-voting" })}
              >
                Jury-Voting {state.voting.juryOpen ? "schließen" : "öffnen"}
              </button>
              <button
                className="button button--accent button--wide"
                type="button"
                disabled={state.paused || state.voting.publicOpen}
                onClick={() => send({ type: "advance-public-reveal" })}
              >
                Nächste Publikumswertung zeigen
              </button>
              {state.currentPublicRevealIndex > 0 && (
                <button
                  className="button button--quiet button--wide"
                  type="button"
                  onClick={() => send({ type: "reset-public-reveal" })}
                >
                  Publikums-Reveal zurücksetzen
                </button>
              )}
            </section>

            <section className="panel demo-vote-control" aria-labelledby="demo-vote-title">
              <div className="panel__head panel__head--compact">
                <div>
                  <p className="panel__label">Probe</p>
                  <h2 id="demo-vote-title">Demo-Voting</h2>
                </div>
              </div>
              <p className="panel__copy">
                Vergibt zufällige, gültige Stimmzettel über die echte Abstimmung – für Proben und Technik-Checks.
                Wirkt nur auf geöffnete Abstimmungen.
              </p>
              <label className="demo-vote-control__count">
                Publikumsstimmen
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={demoPublicCount}
                  onChange={(event) => setDemoPublicCount(Math.max(0, Math.min(500, Number(event.target.value))))}
                />
              </label>
              <button
                className="button button--quiet button--wide"
                type="button"
                disabled={demoVoteState === "loading" || (!state.voting.publicOpen && !state.voting.juryOpen)}
                onClick={() => void triggerDemoVote()}
              >
                {demoVoteState === "loading" ? "Wird abgestimmt …" : "Zufällig abstimmen"}
              </button>
              {(!state.voting.publicOpen && !state.voting.juryOpen) && (
                <p className="form-message">Öffne zuerst Jury- oder Publikumsvoting.</p>
              )}
              {demoVoteMessage && (
                <p className={demoVoteState === "error" ? "form-message form-message--error" : "form-message form-message--success"} role="status">
                  {demoVoteMessage}
                </p>
              )}
            </section>

            {(requiresRunoff || runoff) && (
              <section className="panel runoff-control" aria-labelledby="runoff-control-title">
                <p className="panel__label">Gleichstand</p>
                <h2 id="runoff-control-title">Stichwahl</h2>
                <p>{runoff?.open ? `${runoff.voteCount} Stimmen · Runde ${runoff.sequenceNumber} offen` : "Die Tie-Break-Kette ergibt keinen eindeutigen Sieger."}</p>
                <button
                  className="button button--accent button--wide"
                  type="button"
                  onClick={() => send({ type: runoff?.open ? "close-runoff" : "start-runoff" })}
                >
                  {runoff?.open ? "Stichwahl schließen" : "Stichwahl starten"}
                </button>
              </section>
            )}
          </div>

          <Scoreboard phase={state.phase} acts={regieActs} scores={scores} showAllPublic />
        </div>
      </main> : (
        <main className="controller-main admin-main">
          <AdminHeading section={activeSection} {...(adminConfig?.event.name ? { eventName: adminConfig.event.name } : {})} />
          {adminError && <div className="alert alert--warning" role="alert"><strong>Konfiguration nicht erreichbar.</strong> {adminError}</div>}
          {adminLoading && !adminConfig && <div className="panel admin-loading" role="status">Konfiguration wird geladen …</div>}
          {activeSection === "participants" && adminConfig && (
            <ParticipantsAdmin config={adminConfig} onSaved={refreshAdminConfig} />
          )}
          {activeSection === "jury" && adminConfig && (
            <JuryAdmin config={adminConfig} onSaved={refreshAdminConfig} />
          )}
          {activeSection === "settings" && (
            <ConfigurationPanel config={config} onSave={(nextConfig) => send({ type: "update-event-config", config: nextConfig })} />
          )}
        </main>
      )}

      <footer className="system-footer">
        <span>Revision {state.revision}</span>
        <span>Beamer A · {state.screens.a}</span>
        <span>Beamer B · {state.screens.b}</span>
        <span>Bridge · {state.bridgeStatus.toLowerCase()}</span>
        <span className="system-footer__end">Letzte Änderung · {new Date(state.updatedAt).toLocaleTimeString("de-DE")}</span>
      </footer>
    </div>
  );
}

function AdminHeading({ section, eventName }: { section: Exclude<ControllerSection, "show">; eventName?: string }) {
  const copy = {
    participants: {
      eyebrow: "Eventdaten · Startfeld",
      title: "Teilnehmer verwalten",
      description: "Länder, Songs und Identitäten für Voting, Regie, Tablet und Beamer pflegen."
    },
    jury: {
      eyebrow: "Zugänge · Wertungsreihenfolge",
      title: "Jury verwalten",
      description: "Jurykonten verknüpfen, freigeben und mit eigenen vierstelligen PINs absichern."
    },
    settings: {
      eyebrow: "Event · Wertungslogik",
      title: "Einstellungen",
      description: "Punkteskala, Gewichtung, Selbstwahl-Regel und Timecode-Basis konfigurieren."
    }
  }[section];
  return (
    <section className="admin-heading" aria-labelledby="admin-page-title">
      <div>
        <p className="show-heading__context">{copy.eyebrow}</p>
        <h1 id="admin-page-title">{copy.title}</h1>
        <p>{copy.description}</p>
      </div>
      {eventName && <span className="event-stamp">{eventName}</span>}
    </section>
  );
}

type EditableActRow = Omit<AdminActInput, "artistNames"> & { artistNamesText: string };

function toEditableActs(config: AdminConfigResponse): EditableActRow[] {
  return config.acts.map((act) => ({
    id: act.id,
    startNumber: act.startNumber,
    countryIsoCode: act.country.isoCode,
    countryName: act.country.displayName,
    pseudonym: act.pseudonym,
    songTitle: act.songTitle,
    artistNamesText: act.artistNames.join(", ")
  }));
}

function ParticipantsAdmin({ config, onSaved }: { config: AdminConfigResponse; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<EditableActRow[]>(() => toEditableActs(config));
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setRows(toEditableActs(config)), [config.event.updatedAt]);

  const update = <K extends keyof EditableActRow>(index: number, key: K, value: EditableActRow[K]) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
    setMessage("");
  };

  const add = () => {
    const nextStart = Math.max(0, ...rows.map((row) => row.startNumber)) + 1;
    setRows((current) => [...current, {
      startNumber: nextStart,
      countryIsoCode: "",
      countryName: "",
      pseudonym: "",
      songTitle: "",
      artistNamesText: ""
    }]);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const payload: AdminActInput[] = rows.map((row) => ({
        ...(row.id ? { id: row.id } : {}),
        startNumber: row.startNumber,
        countryIsoCode: row.countryIsoCode.trim().toUpperCase(),
        countryName: row.countryName.trim(),
        pseudonym: row.pseudonym.trim(),
        songTitle: row.songTitle.trim(),
        artistNames: row.artistNamesText.split(",").map((name) => name.trim()).filter(Boolean)
      }));
      await saveAdminActs(payload);
      await onSaved();
      setMessage("Teilnehmerdaten gespeichert.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Die Teilnehmerdaten konnten nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="admin-editor" onSubmit={save}>
      <div className="editor-toolbar">
        <div>
          <strong>{rows.length} Acts</strong>
          <span>Erlaubt sind 12 bis 15. Die Flagge folgt automatisch dem ISO-Ländercode.</span>
        </div>
        <button className="button button--quiet" type="button" disabled={rows.length >= 15} onClick={add}>Act hinzufügen</button>
      </div>
      <div className="editor-list">
        {rows.map((row, index) => (
          <fieldset className="editor-card act-editor" key={row.id ?? `new-${index}`}>
            <legend>Startplatz {String(row.startNumber || index + 1).padStart(2, "0")}</legend>
            <div className="act-editor__identity" aria-hidden="true">
              <span>{String(row.startNumber || index + 1).padStart(2, "0")}</span>
              <CountryFlag
                code={row.countryIsoCode}
                label={row.countryName || "noch nicht gewählt"}
                className="admin-flag"
                fallback={row.countryIsoCode || "—"}
              />
            </div>
            <label className="editor-field editor-field--short">Startnummer
              <input type="number" min="1" max="99" required value={row.startNumber} onChange={(event) => update(index, "startNumber", Number(event.target.value))} />
            </label>
            <label className="editor-field editor-field--short">ISO
              <input maxLength={2} required value={row.countryIsoCode} onChange={(event) => update(index, "countryIsoCode", event.target.value.toUpperCase())} placeholder="DE" />
            </label>
            <label className="editor-field">Land
              <input required value={row.countryName} onChange={(event) => update(index, "countryName", event.target.value)} placeholder="Deutschland" />
            </label>
            <label className="editor-field">Songtitel
              <input required value={row.songTitle} onChange={(event) => update(index, "songTitle", event.target.value)} placeholder="Titel des Songs" />
            </label>
            <label className="editor-field">Pseudonym
              <input required value={row.pseudonym} onChange={(event) => update(index, "pseudonym", event.target.value)} placeholder="Name vor dem Reveal" />
            </label>
            <label className="editor-field editor-field--wide">Klarname(n)
              <input required value={row.artistNamesText} onChange={(event) => update(index, "artistNamesText", event.target.value)} placeholder="Marie, Alex" />
              <small>Mehrere Artists mit Komma trennen.</small>
            </label>
            <button
              className="button button--quiet editor-card__remove"
              type="button"
              disabled={rows.length <= 12}
              onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}
            >
              Entfernen
            </button>
          </fieldset>
        ))}
      </div>
      <div className="editor-savebar">
        <p className="form-message" role="status">{message || "Änderungen werden erst mit Speichern live übernommen."}</p>
        <button className="button button--accent" type="submit" disabled={saving}>{saving ? "Speichert …" : "Teilnehmer speichern"}</button>
      </div>
    </form>
  );
}

type EditableJurorRow = Omit<AdminJurorInput, "pin" | "linkedActId"> & { pin: string; linkedActId: string };

function toEditableJurors(config: AdminConfigResponse): EditableJurorRow[] {
  return config.jurors.map((juror) => ({ ...juror, pin: "", linkedActId: juror.linkedActId }));
}

function JuryAdmin({ config, onSaved }: { config: AdminConfigResponse; onSaved: () => Promise<void> }) {
  const [rows, setRows] = useState<EditableJurorRow[]>(() => toEditableJurors(config));
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setRows(toEditableJurors(config)), [config.event.updatedAt]);

  const update = <K extends keyof EditableJurorRow>(index: number, key: K, value: EditableJurorRow[K]) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: value } : row));
    setMessage("");
  };

  const add = () => setRows((current) => [...current, {
    displayName: "Neue Jury",
    type: "GAST",
    pin: "",
    enabled: true,
    revealOrder: Math.max(0, ...current.map((row) => row.revealOrder)) + 1,
    linkedActId: ""
  }]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      const payload: AdminJurorInput[] = rows.map((row) => ({
        ...(row.id ? { id: row.id } : {}),
        displayName: row.displayName.trim(),
        type: row.type,
        ...(row.pin ? { pin: row.pin } : {}),
        enabled: row.enabled,
        revealOrder: row.revealOrder,
        ...(row.linkedActId ? { linkedActId: row.linkedActId } : {})
      }));
      await saveAdminJurors(payload);
      await onSaved();
      setMessage("Jurydaten gespeichert. Neu gesetzte PINs sind jetzt aktiv.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Die Jurydaten konnten nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="admin-editor" onSubmit={save}>
      <div className="editor-toolbar">
        <div>
          <strong>{rows.filter((row) => row.enabled).length} aktive Jurys</strong>
          <span>PINs werden nie angezeigt. Leer lassen behält den bisherigen PIN.</span>
        </div>
        <button className="button button--quiet" type="button" onClick={add}>Jury hinzufügen</button>
      </div>
      <div className="editor-list">
        {rows.map((row, index) => (
          <fieldset className="editor-card juror-editor" key={row.id ?? `new-juror-${index}`}>
            <legend>{row.displayName || `Jury ${index + 1}`}</legend>
            <label className="editor-field">Anzeigename
              <input required value={row.displayName} onChange={(event) => update(index, "displayName", event.target.value)} />
            </label>
            <label className="editor-field">Typ
              <select value={row.type} onChange={(event) => update(index, "type", event.target.value as EditableJurorRow["type"])}>
                <option value="ARTIST">Artist</option>
                <option value="REGIE">Regie</option>
                <option value="GAST">Gast</option>
              </select>
            </label>
            <label className="editor-field">Verknüpfter Act
              <select value={row.linkedActId} onChange={(event) => update(index, "linkedActId", event.target.value)}>
                <option value="">Keine Verknüpfung</option>
                {config.acts.map((act) => <option key={act.id} value={act.id}>{act.startNumber}. {act.country.displayName}</option>)}
              </select>
            </label>
            <label className="editor-field editor-field--short">Reihenfolge
              <input type="number" min="1" max="999" required value={row.revealOrder} onChange={(event) => update(index, "revealOrder", Number(event.target.value))} />
            </label>
            <label className="editor-field editor-field--short">Neuer PIN
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                required={!row.id}
                value={row.pin}
                onChange={(event) => update(index, "pin", event.target.value.replace(/\D/g, ""))}
                placeholder={row.id ? "••••" : "4 Ziffern"}
                autoComplete="new-password"
              />
            </label>
            <label className="enabled-toggle">
              <input type="checkbox" checked={row.enabled} onChange={(event) => update(index, "enabled", event.target.checked)} />
              <span>{row.enabled ? "Aktiv" : "Gesperrt"}</span>
            </label>
            {!row.id && (
              <button className="button button--quiet editor-card__remove" type="button" onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}>Verwerfen</button>
            )}
          </fieldset>
        ))}
      </div>
      <div className="editor-savebar">
        <p className="form-message" role="status">{message || "Ein neuer PIN beendet bestehende Sitzungen dieses Jurykontos."}</p>
        <button className="button button--accent" type="submit" disabled={saving}>{saving ? "Speichert …" : "Jury speichern"}</button>
      </div>
    </form>
  );
}

function ConfigurationPanel({ config, onSave }: { config: EventConfig | undefined; onSave: (config: EventConfig) => void }) {
  const fallback: EventConfig = {
    locale: "de-DE",
    pointScale: [...DEFAULT_POINT_SCALE],
    requireCompleteBallot: true,
    selfVotePolicy: "BLOCK_LINKED_ACTS",
    weights: { jury: 0.5, public: 0.5 },
    juryReveal: { bulkPoints: [1, 2, 3, 4, 5, 6, 7], individualPoints: [8, 10, 12] },
    timecode: { frameRate: 25, manualFallback: true }
  };
  const active = config ?? fallback;
  const [pointScale, setPointScale] = useState(active.pointScale.join(", "));
  const [juryPercent, setJuryPercent] = useState(Math.round(active.weights.jury * 100));
  const [selfVotePolicy, setSelfVotePolicy] = useState(active.selfVotePolicy);
  const [frameRate, setFrameRate] = useState(active.timecode.frameRate);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setPointScale(active.pointScale.join(", "));
    setJuryPercent(Math.round(active.weights.jury * 100));
    setSelfVotePolicy(active.selfVotePolicy);
    setFrameRate(active.timecode.frameRate);
  }, [config]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const points = pointScale.split(/[ ,;]+/).filter(Boolean).map(Number);
    if (points.length === 0 || points.some((value) => !Number.isInteger(value) || value <= 0) || new Set(points).size !== points.length) {
      setMessage("Die Punkteskala muss aus eindeutigen positiven Ganzzahlen bestehen.");
      return;
    }
    if (juryPercent <= 0 || juryPercent >= 100) {
      setMessage("Der Juryanteil muss zwischen 1 und 99 Prozent liegen.");
      return;
    }
    onSave({
      ...active,
      pointScale: points,
      selfVotePolicy,
      weights: { jury: juryPercent / 100, public: (100 - juryPercent) / 100 },
      timecode: { ...active.timecode, frameRate }
    });
    setMessage("Konfiguration wird gespeichert …");
  };

  return (
    <section className="panel config-panel">
      <div className="config-panel__head">
        <p className="panel__label">Allgemein</p>
        <h2>Wertungslogik &amp; Timecode</h2>
        <p>Diese Werte wirken auf Berechnung, Stimmzettel und die LTC-Verarbeitung.</p>
      </div>
      <form onSubmit={save}>
        <label>Punkteskala<input value={pointScale} onChange={(event) => setPointScale(event.target.value)} /></label>
        <label>Juryanteil (%)<input type="number" min="1" max="99" value={juryPercent} onChange={(event) => setJuryPercent(Number(event.target.value))} /></label>
        <label>Selbstwahl
          <select value={selfVotePolicy} onChange={(event) => setSelfVotePolicy(event.target.value as EventConfig["selfVotePolicy"])}>
            <option value="BLOCK_LINKED_ACTS">Eigene Acts sperren</option>
            <option value="ALLOW">Erlauben</option>
          </select>
        </label>
        <label>LTC-Framerate<input type="number" min="1" max="60" step="1" value={frameRate} onChange={(event) => setFrameRate(Number(event.target.value))} /></label>
        <button className="button button--quiet button--wide" type="submit">Konfiguration speichern</button>
        {message && <p className="form-message" role="status">{message}</p>}
      </form>
    </section>
  );
}

function getRankedScores(
  phase: ShowPhase,
  acts: DisplayAct[],
  scores: DisplayScore[],
  revealedPublicActIds: readonly string[],
  showAllPublic: boolean,
  juryPointsByAct: Record<string, number> | undefined
) {
  const revealSet = new Set(revealedPublicActIds);
  const allPublicVisible = showAllPublic || ["FINALE", "STICHWAHL", "STICHWAHL_OFFEN", "STICHWAHL_GESCHLOSSEN"].includes(phase);
  return scores
    .map((score) => {
      const publicVisible = allPublicVisible || (phase === "PUBLIC_REVEAL" && revealSet.has(score.actId));
      const visibleJuryPoints = juryPointsByAct?.[score.actId] ?? score.juryPoints;
      return {
        ...score,
        act: acts.find((act) => act.id === score.actId)!,
        visibleJuryPoints,
        visiblePublicPoints: publicVisible ? score.publicPoints : 0,
        total: visibleJuryPoints + (publicVisible ? score.publicPoints : 0)
      };
    })
    .filter((row) => Boolean(row.act))
    .sort((left, right) => {
      if (allPublicVisible && !juryPointsByAct && left.rank !== undefined && right.rank !== undefined) return left.rank - right.rank;
      return right.total - left.total
        || right.visiblePublicPoints - left.visiblePublicPoints
        || right.visibleJuryPoints - left.visibleJuryPoints
        || left.actId.localeCompare(right.actId, "de");
    });
}

function Scoreboard({
  phase,
  acts,
  scores,
  projector = false,
  revealedPublicActIds = [],
  showAllPublic = false,
  juryPointsByAct
}: {
  phase: ShowPhase;
  acts: DisplayAct[];
  scores: DisplayScore[];
  projector?: boolean;
  revealedPublicActIds?: readonly string[];
  showAllPublic?: boolean;
  juryPointsByAct?: Record<string, number> | undefined;
}) {
  const rows = useMemo(
    () => getRankedScores(phase, acts, scores, revealedPublicActIds, showAllPublic, juryPointsByAct),
    [phase, acts, scores, revealedPublicActIds, showAllPublic, juryPointsByAct]
  );
  return (
    <section className={projector ? "scoreboard scoreboard--projector" : "scoreboard panel"} aria-labelledby="scoreboard-title">
      <header className="scoreboard__head">
        <div>
          {!projector && <p className="panel__label">Live berechnet</p>}
          <h2 id="scoreboard-title">Rangliste</h2>
        </div>
        <span>{rows.length} Acts</span>
      </header>
      <ol className="score-list">
        {rows.map((row, index) => (
          <li key={row.actId} className={index < 3 ? `score-row score-row--top-${index + 1}` : "score-row"}>
            <span className="score-row__rank">{index + 1}</span>
            <CountryFlag
              className="score-row__flag"
              code={row.act.country.isoCode}
              label={row.act.country.displayName}
              fallback={row.act.country.flag}
            />
            <span className="score-row__country">{row.act.country.displayName}</span>
            <span className="score-row__jury"><small>Jury</small>{row.visibleJuryPoints}</span>
            {row.visiblePublicPoints > 0 && <span className="score-row__public"><small>Public</small>{row.visiblePublicPoints}</span>}
            <strong className="score-row__total">{row.total}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MobileHeader({ title, status }: { title: string; status: string }) {
  return (
    <header className="mobile-head">
      <Brand compact />
      <div>
        <span>{title}</span>
        <StatusDot tone="live">{status}</StatusDot>
      </div>
    </header>
  );
}

function VoteSurface() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    const refresh = () => fetchBootstrap().then((data) => {
      if (active) {
        setBootstrap(data);
        setLoadError("");
      }
    });
    void ensurePublicSession().then(refresh).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : "Backend nicht erreichbar.");
    });
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const acts = bootstrap?.acts ?? demoActs;
  const pointScale = bootstrap?.event.config.pointScale ?? [...DEFAULT_POINT_SCALE];
  const backendReady = Boolean(bootstrap);
  const votingOpen = bootstrap?.voting.publicOpen ?? true;

  return (
    <div className="mobile-shell">
      <MobileHeader title="Publikum" status={backendReady ? (votingOpen ? "geöffnet" : "geschlossen") : "Demo"} />
      <main className="ballot-main">
        <div className="mobile-intro">
          <p>{bootstrap?.event.name ?? "PastEurovision 2026"}</p>
          <h1>Deine Punkte.</h1>
          <span>Vergib jeden Wert von 1–8, 10 und 12 genau einmal.</span>
        </div>
        {loadError && <div className="alert alert--warning" role="status">{loadError} – lokaler Demomodus aktiv.</div>}
        {bootstrap?.runoff?.open ? <RunoffBallot acts={acts} runoff={bootstrap.runoff} /> : <BallotForm
          acts={acts}
          pointScale={pointScale}
          group="PUBLIC"
          persist={backendReady}
          votingOpen={votingOpen}
        />}
      </main>
    </div>
  );
}

function JurySurface() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [pin, setPin] = useState("");
  const [juror, setJuror] = useState("");
  const [loginError, setLoginError] = useState("");
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [blockedActIds, setBlockedActIds] = useState<ReadonlySet<string>>(new Set());
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => fetchBootstrap().then((data) => {
      if (!active) return;
      setBootstrap(data);
      if (data.sessions.jury.authenticated && data.sessions.jury.jurorId) {
        setJuror(data.sessions.jury.jurorId);
        setBlockedActIds(new Set(data.sessions.jury.blockedActIds ?? []));
        setLoggedIn(true);
      }
    });
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const jurors: Array<PublicJuror | { id: string; displayName: string }> = bootstrap?.jurors ?? demoJurors;
  const acts = bootstrap?.acts ?? demoActs;
  const pointScale = bootstrap?.event.config.pointScale ?? [...DEFAULT_POINT_SCALE];

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (!juror || !/^\d{4}$/.test(pin)) {
      setLoginError("Wähle deinen Namen und gib den vierstelligen PIN ein.");
      return;
    }
    setLoggingIn(true);
    try {
      if (bootstrap) {
        const result = await loginJury(juror, pin);
        setBlockedActIds(new Set(result.blockedActIds));
      } else {
        setBlockedActIds(new Set([demoActs[0]!.id]));
      }
      setLoginError("");
      setLoggedIn(true);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Anmeldung fehlgeschlagen.");
    } finally {
      setLoggingIn(false);
    }
  };

  if (loggedIn) {
    return (
      <div className="mobile-shell">
        <MobileHeader title="Jury" status="Angemeldet" />
        <main className="ballot-main">
          <div className="mobile-intro">
            <p>Jury-Stimmzettel</p>
            <h1>{jurors.find((entry) => entry.id === juror)?.displayName}</h1>
            <span>Eigene oder von der Regie gesperrte Acts können nicht bewertet werden.</span>
          </div>
          {bootstrap?.runoff?.open ? <RunoffBallot acts={acts} runoff={bootstrap.runoff} /> : <BallotForm
            acts={acts}
            pointScale={pointScale}
            group="JURY"
            persist={Boolean(bootstrap)}
            votingOpen={bootstrap?.voting.juryOpen ?? true}
            blockedActIds={blockedActIds}
          />}
        </main>
      </div>
    );
  }

  return (
    <div className="mobile-shell mobile-shell--login">
      <MobileHeader title="Jury" status="Login" />
      <main className="login-main">
        <div className="mobile-intro">
          <p>Geschützter Zugang</p>
          <h1>Wer stimmt ab?</h1>
          <span>Wähle deinen Klarnamen und gib den vierstelligen PIN der Regie ein.</span>
        </div>
        <form className="login-form" onSubmit={submitLogin} noValidate>
          <label htmlFor="juror">Klarname</label>
          <select id="juror" value={juror} onChange={(event) => setJuror(event.target.value)} aria-invalid={loginError ? "true" : "false"}>
            <option value="">Namen auswählen</option>
            {jurors.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}
          </select>
          <span className="field-help">Dein Name wird später für die Punktevergabe angezeigt.</span>

          <label htmlFor="pin">Vierstelliger PIN</label>
          <input
            id="pin"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="0000"
            aria-describedby="login-help"
            aria-invalid={loginError ? "true" : "false"}
          />
          <span id="login-help" className={loginError ? "field-help field-help--error" : "field-help"}>
            {loginError || "Den PIN erhältst du von der Regie."}
          </span>
          <button className="button button--accent button--wide" type="submit" disabled={loggingIn} data-state={loggingIn ? "loading" : "idle"}>
            {loggingIn ? "PIN wird geprüft …" : "Jury-Voting öffnen"}
          </button>
        </form>
      </main>
    </div>
  );
}

function RunoffBallot({ acts, runoff }: { acts: DisplayAct[]; runoff: NonNullable<BootstrapResponse["runoff"]> }) {
  const candidates = acts.filter((act) => runoff.candidateActIds.includes(act.id));
  const [selectedActId, setSelectedActId] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchMyBallot("RUNOFF").then(({ ballot }) => {
      if (active && ballot?.entries[0]) {
        setSelectedActId(ballot.entries[0].actId);
        setMessage(`Stichwahlstimme gespeichert · Revision ${ballot.revision}`);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [runoff.sequenceNumber]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedActId) return;
    setSaving(true);
    try {
      const saved = await saveBallot("RUNOFF", [{ actId: selectedActId, points: 1 }]);
      setMessage(`Stichwahlstimme gespeichert · Revision ${saved.ballot.revision}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Stichwahlstimme konnte nicht gespeichert werden.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="ballot runoff-ballot" onSubmit={submit}>
      <div className="mobile-intro"><p>Runde {runoff.sequenceNumber}</p><h1>Stichwahl.</h1><span>Eine Stimme, alle Stimmen zählen gleich.</span></div>
      <div className="act-list">
        {candidates.map((act) => (
          <label className="act-choice" key={act.id}>
            <input type="radio" name="runoff" value={act.id} checked={selectedActId === act.id} onChange={() => setSelectedActId(act.id)} />
            <CountryFlag className="act-choice__flag" code={act.country.isoCode} label={act.country.displayName} fallback={act.country.flag} />
            <span className="act-choice__identity"><strong>{act.country.displayName}</strong><small>{act.pseudonym} · {act.songTitle}</small></span>
          </label>
        ))}
      </div>
      <div className="ballot__submit">
        <p className="form-message" role="status">{message || "Deine Auswahl kann bis zum Schließen geändert werden."}</p>
        <button className="button button--accent button--wide" type="submit" disabled={!selectedActId || saving}>{saving ? "Wird gespeichert …" : "Stichwahlstimme abgeben"}</button>
      </div>
    </form>
  );
}

function BallotForm({
  acts,
  pointScale,
  group,
  persist,
  votingOpen,
  blockedActIds = new Set<string>()
}: {
  acts: DisplayAct[];
  pointScale: number[];
  group: "JURY" | "PUBLIC";
  persist: boolean;
  votingOpen: boolean;
  blockedActIds?: ReadonlySet<string>;
}) {
  const [assignments, setAssignments] = useState<Record<string, number>>({});
  const [submitState, setSubmitState] = useState<"idle" | "loading" | "error" | "success">("idle");
  const [message, setMessage] = useState("");
  const selectedCount = Object.keys(assignments).length;

  useEffect(() => {
    if (!persist) return;
    let active = true;
    void fetchMyBallot(group)
      .then(({ ballot }) => {
        if (active && ballot) {
          setAssignments(Object.fromEntries(ballot.entries.map((entry) => [entry.actId, entry.points])));
          setMessage(`Gespeicherter Stimmzettel · Revision ${ballot.revision}`);
          setSubmitState("success");
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [group, persist]);

  const assign = (actId: string, rawValue: string) => {
    const points = Number(rawValue);
    setAssignments((current) => {
      const next = { ...current };
      for (const [assignedActId, assignedPoints] of Object.entries(next)) {
        if (assignedPoints === points && assignedActId !== actId) delete next[assignedActId];
      }
      if (points === 0) delete next[actId];
      else next[actId] = points;
      return next;
    });
    setSubmitState("idle");
    setMessage("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const entries = Object.entries(assignments).map(([actId, points]) => ({ actId, points }));
    const result = validateEscBallot(entries, pointScale, blockedActIds);
    if (!result.valid) {
      setSubmitState("error");
      setMessage(result.errors[0] ?? "Der Stimmzettel ist noch nicht vollständig.");
      return;
    }
    if (!persist) {
      setSubmitState("success");
      setMessage("Der Stimmzettel ist im Demomodus lokal validiert.");
      return;
    }
    setSubmitState("loading");
    setMessage("Stimmzettel wird sicher gespeichert …");
    try {
      const saved = await saveBallot(group, entries);
      setSubmitState("success");
      setMessage(`Stimmzettel gespeichert · Revision ${saved.ballot.revision}`);
    } catch (error) {
      setSubmitState("error");
      setMessage(error instanceof Error ? error.message : "Die Abgabe konnte nicht gespeichert werden.");
    }
  };

  return (
    <form className="ballot" onSubmit={submit}>
      <div className="ballot__progress" aria-live="polite">
        <span>{selectedCount} von {pointScale.length} vergeben</span>
        <progress value={selectedCount} max={pointScale.length} />
      </div>
      <div className="act-list">
        {acts.map((act) => {
          const blocked = blockedActIds.has(act.id);
          return (
            <label className={blocked ? "act-choice act-choice--blocked" : "act-choice"} key={act.id}>
              <span className="act-choice__number">{String(act.startNumber).padStart(2, "0")}</span>
              <CountryFlag
                className="act-choice__flag"
                code={act.country.isoCode}
                label={act.country.displayName}
                fallback={act.country.flag}
              />
              <span className="act-choice__identity">
                <strong>{act.pseudonym}</strong>
                <small>{act.songTitle} · {act.identityRevealed ? (act.artistNames?.join(", ") || "Klarname freigegeben") : "Klarname verborgen"}</small>
              </span>
              {blocked ? (
                <span className="act-choice__locked">Eigener Act</span>
              ) : (
                <select
                  value={assignments[act.id] ?? 0}
                  onChange={(event) => assign(act.id, event.target.value)}
                  aria-label={`Punkte für ${act.pseudonym}`}
                  disabled={!votingOpen || submitState === "loading"}
                >
                  <option value={0}>—</option>
                  {[...pointScale].reverse().map((points) => (
                    <option key={points} value={points}>{points}</option>
                  ))}
                </select>
              )}
            </label>
          );
        })}
      </div>
      <div className="ballot__submit">
        <p className={submitState === "error" ? "form-message form-message--error" : submitState === "success" ? "form-message form-message--success" : "form-message"} aria-live="polite">
          {message || (votingOpen ? "Du kannst deine Auswahl bis zum Voting-Schluss ändern." : "Die Abstimmung ist derzeit geschlossen.")}
        </p>
        <button
          className="button button--accent button--wide"
          type="submit"
          data-state={submitState}
          disabled={!votingOpen || submitState === "loading" || selectedCount !== pointScale.length}
        >
          {submitState === "loading" ? "Wird gespeichert …" : submitState === "success" ? "Stimmzettel ändern" : "Stimme abgeben"}
        </button>
      </div>
    </form>
  );
}

function TabletSurface({
  state,
  connected,
  jurors,
  acts,
  scores,
  revealedJuryPoints
}: {
  state: ShowState;
  connected: boolean;
  jurors: Array<{ id: string; displayName: string }>;
  acts: DisplayAct[];
  scores: DisplayScore[];
  revealedJuryPoints?: Record<string, number> | undefined;
}) {
  const juryList = jurors.length > 0 ? jurors : demoJurors;
  const currentJuror = juryList[state.currentJurorIndex % juryList.length]!;
  const nextJuror = juryList[(state.currentJurorIndex + 1) % juryList.length]!;
  const previewJuror = state.currentRevealPoint === 12 ? nextJuror : currentJuror;
  const publicOrder = [...scores].sort((left, right) =>
    left.juryPoints - right.juryPoints
    || (right.rank ?? 0) - (left.rank ?? 0)
    || left.actId.localeCompare(right.actId, "de")
  );
  const nextPublic = publicOrder[state.currentPublicRevealIndex];
  const nextPublicAct = acts.find((act) => act.id === nextPublic?.actId);
  const publicMode = state.phase === "PUBLIC_REVEAL";
  return (
    <div className="tablet-shell">
      <header className="tablet-head">
        <Brand />
        <StatusDot tone={connected ? "live" : "idle"}>{connected ? "Live" : "Simulation"}</StatusDot>
      </header>
      <main className="tablet-main">
        <div className="tablet-now">
          <span>Auf dem Beamer</span>
          <strong>{currentJuror.displayName}</strong>
        </div>
        <section className="tablet-next" aria-labelledby="tablet-next-title">
          <p>Als Nächstes vorlesen</p>
          <h1 id="tablet-next-title">{publicMode ? (nextPublicAct?.country.displayName ?? "Finale") : previewJuror.displayName}</h1>
          <div className="tablet-points">
            <span>Nächster Schritt</span>
            <strong>{publicMode ? (nextPublic?.publicPoints ?? "—") : state.currentRevealPoint === 12 ? "1–7" : state.currentRevealPoint === 10 ? "12" : state.currentRevealPoint === 8 ? "10" : "8"}</strong>
            <small>Punkte</small>
          </div>
        </section>
        <div className="tablet-scoreboard">
          <Scoreboard
            phase={state.phase}
            acts={acts}
            scores={scores}
            projector
            revealedPublicActIds={state.revealedPublicActIds}
            juryPointsByAct={revealedJuryPoints}
          />
        </div>
      </main>
      <footer className="tablet-foot">Die Regie schaltet den nächsten Schritt frei.</footer>
    </div>
  );
}

function BeamerFrame({ children }: { children: ReactNode }) {
  return (
    <div className="beamer-shell">
      <div className="beamer-shell__spectral" aria-hidden="true"><i /><i /><i /><i /></div>
      {children}
      <footer className="beamer-footer"><Brand compact /><span>Colour your voice</span></footer>
    </div>
  );
}

function BeamerASurface({
  state,
  acts,
  jurors,
  scores,
  revealedJuryPoints,
  currentBulkAward = []
}: {
  state: ShowState;
  acts: DisplayAct[];
  jurors: Array<{ id: string; displayName: string }>;
  scores: DisplayScore[];
  revealedJuryPoints?: Record<string, number> | undefined;
  currentBulkAward?: JuryBulkAwardEntry[] | undefined;
}) {
  const juryList = jurors.length > 0 ? jurors : demoJurors;
  const juror = juryList[state.currentJurorIndex % juryList.length]!;
  const act = acts.find((entry) => entry.id === state.currentActId) ?? acts[0] ?? demoActs[0]!;
  if (state.phase === "PUBLIC_REVEAL" || state.phase === "FINALE") {
    return (
      <BeamerFrame>
        <main className="beamer-ranking">
          <div className="beamer-ranking__head">
            <div><p>PastEurovision 2026</p><h1>{phaseLabels[state.phase]}</h1></div>
            <span>Live-Rangliste</span>
          </div>
          <Scoreboard
            phase={state.phase}
            acts={acts}
            scores={scores}
            projector
            revealedPublicActIds={state.revealedPublicActIds}
            juryPointsByAct={revealedJuryPoints}
          />
        </main>
      </BeamerFrame>
    );
  }
  if (state.phase === "JURY_REVEAL" && state.currentRevealPoint === 0) {
    return (
      <BeamerFrame>
        <main className="beamer-bulk">
          <p>Die Punkte von</p>
          <h1>{juror.displayName}</h1>
          <ol className="beamer-bulk__list">
            {[1, 2, 3, 4, 5, 6, 7].map((points) => {
              const award = currentBulkAward.find((entry) => entry.points === points);
              const bulkAct = award ? acts.find((entry) => entry.id === award.actId) : undefined;
              return (
                <li key={points} className="beamer-bulk__row">
                  <strong className="beamer-bulk__points">{points}</strong>
                  {bulkAct ? (
                    <>
                      <CountryFlag
                        className="beamer-bulk__flag"
                        code={bulkAct.country.isoCode}
                        label={bulkAct.country.displayName}
                        fallback={bulkAct.country.flag}
                      />
                      <span className="beamer-bulk__country">{bulkAct.country.displayName}</span>
                    </>
                  ) : <span className="beamer-bulk__pending">Wird vorbereitet …</span>}
                </li>
              );
            })}
          </ol>
        </main>
      </BeamerFrame>
    );
  }
  return (
    <BeamerFrame>
      <main className="beamer-reveal">
        <p>Die Punkte von</p>
        <h1>{juror.displayName}</h1>
        <div className="beamer-award">
          <CountryFlag
            className="beamer-award__flag"
            code={act.country.isoCode}
            label={act.country.displayName}
            fallback={act.country.flag}
          />
          <span className="beamer-award__country">{act.country.displayName}</span>
          <strong>{state.currentRevealPoint}</strong>
          <small>Punkte</small>
        </div>
      </main>
    </BeamerFrame>
  );
}

function BeamerBSurface({
  state,
  acts,
  scores,
  revealedJuryPoints
}: {
  state: ShowState;
  acts: DisplayAct[];
  scores: DisplayScore[];
  revealedJuryPoints?: Record<string, number> | undefined;
}) {
  return (
    <BeamerFrame>
      <main className="beamer-ranking">
        <div className="beamer-ranking__head">
          <div><p>PastEurovision 2026</p><h1>{phaseLabels[state.phase]}</h1></div>
          <span>Zwischenstand</span>
        </div>
        <Scoreboard
          phase={state.phase}
          acts={acts}
          scores={scores}
          projector
          revealedPublicActIds={state.revealedPublicActIds}
          juryPointsByAct={revealedJuryPoints}
        />
      </main>
    </BeamerFrame>
  );
}
