import process from "node:process";
import { io, type Socket } from "socket.io-client";
import { formatTimecode, incrementTimecode, parseTimecode } from "./ltc.js";
import { sendOscMessage, type OscArgument } from "./osc.js";

const simulate = process.argv.includes("--simulate");
const frameRate = Number(process.env.LTC_FRAME_RATE ?? 25);
const serverUrl = process.env.SHOW_BRIDGE_URL;
const bridgeToken = process.env.BRIDGE_TOKEN;
const magicQHost = process.env.MAGICQ_OSC_HOST;
const magicQPort = Number(process.env.MAGICQ_OSC_PORT ?? 8000);
const magicQAddress = process.env.MAGICQ_OSC_ADDRESS ?? "/pastvision/cue";

interface BridgeCue {
  eventType?: string;
  points?: number;
  countryIsoCode?: string;
  actId?: string;
}

async function outputCue(cue: BridgeCue): Promise<void> {
  process.stdout.write(`Cue empfangen: ${JSON.stringify(cue)}\n`);
  if (!magicQHost) return;
  const args: OscArgument[] = [
    cue.eventType ?? "UNKNOWN",
    cue.points ?? 0,
    cue.countryIsoCode ?? "",
    cue.actId ?? ""
  ];
  await sendOscMessage({ host: magicQHost, port: magicQPort, address: magicQAddress, args });
  process.stdout.write(`OSC gesendet: ${magicQAddress} → ${magicQHost}:${magicQPort}\n`);
}

if (!simulate) {
  process.stderr.write("Ein realer LTC-Decoder ist noch nicht konfiguriert. Starte mit --simulate.\n");
  process.exitCode = 1;
} else {
  let socket: Socket | undefined;
  if (serverUrl) {
    socket = io(serverUrl, {
      auth: {
        token: bridgeToken
      },
      reconnection: true,
      reconnectionDelay: 500,
      timeout: 5_000
    });
    socket.on("connect", () => process.stdout.write(`Bridge verbunden: ${serverUrl}\n`));
    socket.on("disconnect", () => process.stdout.write("Bridge-Verbindung geschlossen.\n"));
    socket.on("connect_error", (error) => process.stderr.write(`Bridge-Fehler: ${error.message}\n`));
    socket.on("cue", (cue: BridgeCue) => {
      void outputCue(cue).catch((error: unknown) => {
        process.stderr.write(`OSC-Ausgabe fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    });
  }

  let frame = parseTimecode("00:00:00:00", frameRate);
  let lastLoggedSecond = -1;
  const interval = setInterval(() => {
    const value = formatTimecode(frame);
    if (frame.seconds !== lastLoggedSecond) {
      process.stdout.write(`LTC ${value} @ ${frameRate} fps\n`);
      lastLoggedSecond = frame.seconds;
    }
    socket?.emit("ltc:frame", { value, frameRate, receivedAt: new Date().toISOString() });
    frame = incrementTimecode(frame);
  }, 1000 / frameRate);

  const stop = () => {
    clearInterval(interval);
    socket?.disconnect();
    process.stdout.write("Show-Bridge beendet.\n");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
