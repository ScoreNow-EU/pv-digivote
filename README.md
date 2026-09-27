# PastEurovision DigiVote

NodeCG-basiertes Voting-, Ergebnis- und Präsentationssystem für PastEurovision.

## Aktueller Stand

Der lokale Produktionsstand enthält:

- NodeCG 2.8.0 als projektlokale Laufzeit,
- React-/TypeScript-Oberflächen für Controller, Publikum, Jury, Moderator und zwei Beamer,
- gemeinsame Domänenmodelle und Stimmzettelvalidierung,
- testbare Jury- und Publikums-Scoring-Engine,
- exakte 50:50-Normalisierung mit Largest Remainder,
- PostgreSQL-Persistenz mit automatisch angelegtem Testevent,
- echte öffentliche Cookie-Sitzungen und Jury-Login per vierstelligem PIN,
- änderbare Stimmzettel mit Revisionshistorie,
- NodeCG-Replicant für den Showzustand,
- getrennt steuerbares Jury-/Publikumsvoting mit Live-Zählern,
- Regie-Navigation mit persistenten Editoren für Teilnehmer, Juryzugänge und Eventeinstellungen,
- schrittweise Jury- und Publikumsenthüllung sowie Stichwahl-Erkennung,
- LTC-Simulator, automatische Klarname-Reveals und OSC-Ausgabe für MagicQ,
- lokal gebündelte SVG-Länderflaggen statt plattformabhängiger Emoji-Flaggen,
- Docker Compose für NodeCG, PostgreSQL und Redis.

Ohne erreichbare Datenbank fallen die Oberflächen für reine Layout-Entwicklung auf Simulationsdaten zurück. Mit PostgreSQL verwenden alle Oberflächen dieselben Live-Daten. Die Docker-Laufzeit wendet alle Migrationen vor dem NodeCG-Start automatisch an.

## Voraussetzungen

- Node.js 22
- pnpm 11
- optional Docker mit Docker Compose

## Lokale UI-Entwicklung

```powershell
pnpm install
pnpm dev
```

Danach stehen die Testoberflächen unter folgenden URLs bereit:

- Controller: `http://127.0.0.1:5173/controller.html`
- Publikum: `http://127.0.0.1:5173/vote.html`
- Jury: `http://127.0.0.1:5173/jury.html`
- Moderator: `http://127.0.0.1:5173/tablet.html`
- Beamer A: `http://127.0.0.1:5173/beamer-a.html`
- Beamer B: `http://127.0.0.1:5173/beamer-b.html`

## NodeCG lokal starten

```powershell
docker compose up -d postgres redis
$env:DATABASE_URL="postgres://pastvision:pastvision-local@localhost:55432/pastvision"
$env:REDIS_URL="redis://localhost:6379"
$env:BRIDGE_TOKEN="dev-bridge-token"
pnpm db:migrate
pnpm build
pnpm start
```

NodeCG läuft anschließend unter `http://localhost:9090`. Die öffentliche Testseite liegt unter:

```text
http://localhost:9090/bundles/pv-digivote/app/vote.html
```

Weitere NodeCG-URLs:

- Regie: `http://localhost:9090/dashboard/#fullbleed/controller`
- Jury: `http://localhost:9090/bundles/pv-digivote/app/jury.html`
- Moderator: `http://localhost:9090/bundles/pv-digivote/graphics/tablet.html`
- Beamer A: `http://localhost:9090/bundles/pv-digivote/graphics/beamer-a.html`
- Beamer B: `http://localhost:9090/bundles/pv-digivote/graphics/beamer-b.html`

Das lokale Testevent enthält zehn Juryzugänge. Die PINs lauten passend zur Reihenfolge `1001` bis `1010`; `1010` gehört der Regie. Diese Zugangsdaten sind ausschließlich Seed-Daten und müssen für eine echte Veranstaltung ersetzt werden.

### Eventdaten in der Regie pflegen

Die Regie enthält die Bereiche **Show**, **Teilnehmer**, **Jury** und **Einstellungen**:

- Unter **Teilnehmer** werden 12 bis 15 Acts mit Startnummer, ISO-Ländercode, Ländernamen, Songtitel, Pseudonym und einem oder mehreren Klarnamen gepflegt. Mehrere Klarnamen werden mit Komma getrennt. Die Flagge wird aus dem zweistelligen ISO-Code erzeugt.
- Unter **Jury** lassen sich Anzeigename, Typ, verknüpfter Act, Reveal-Reihenfolge, Freigabe und ein eigener vierstelliger PIN einstellen. Bestehende PINs werden aus Sicherheitsgründen nie angezeigt; ein leeres Feld behält den vorhandenen PIN. Ein neuer PIN beendet bestehende Sitzungen dieses Jurykontos.
- Unter **Einstellungen** liegen Punkteskala, Jury-/Publikumsgewichtung, Selbstwahl-Regel und LTC-Framerate.

Die Änderungen werden in PostgreSQL gespeichert und nach dem Speichern von allen Oberflächen übernommen.

## Tests und Typprüfung

```powershell
pnpm test
pnpm typecheck
pnpm build
$env:DATABASE_URL="postgres://pastvision:pastvision-local@localhost:55432/pastvision"
pnpm test:smoke
```

## Datenbank

PostgreSQL starten und Migration anwenden:

```powershell
docker compose up -d postgres redis
$env:DATABASE_URL="postgres://pastvision:pastvision-local@localhost:55432/pastvision"
pnpm db:migrate
```

## LTC-Simulation

Ohne Serververbindung:

```powershell
pnpm bridge:simulate
```

OSC an MagicQ senden:

```powershell
$env:MAGICQ_OSC_HOST="127.0.0.1"
$env:MAGICQ_OSC_PORT="8000"
$env:MAGICQ_OSC_ADDRESS="/pastvision/cue"
pnpm bridge:simulate
```

Jeder Cue sendet als OSC-Argumente Ereignistyp, Punktzahl, ISO-Ländercode und Act-ID. Ohne `MAGICQ_OSC_HOST` protokolliert die Bridge die Cues nur; das eignet sich für Proben ohne Lichtpult.

Mit laufendem NodeCG:

```powershell
$env:SHOW_BRIDGE_URL="http://localhost:9090/pv-digivote-bridge"
$env:BRIDGE_TOKEN="dev-bridge-token"
pnpm bridge:simulate
```

## Docker

```powershell
docker compose up --build
```

Vor einem öffentlich erreichbaren Deployment müssen mindestens `POSTGRES_PASSWORD`, `SESSION_SECRET` und `BRIDGE_TOKEN` auf zufällige produktive Werte gesetzt, die Seed-PINs ersetzt und TLS sowie Zugriffsschutz für das NodeCG-Dashboard über einen Reverse Proxy aktiviert werden.

Das vollständige fachliche und technische Konzept steht in [docs/TECHNISCHES_PFLICHTENHEFT.md](docs/TECHNISCHES_PFLICHTENHEFT.md).
