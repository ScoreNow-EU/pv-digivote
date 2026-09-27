import dgram from "node:dgram";

export type OscArgument = string | number | boolean;

function pad4(buffer: Buffer): Buffer {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding)]);
}

function oscString(value: string): Buffer {
  return pad4(Buffer.from(`${value}\0`, "utf8"));
}

export function encodeOscMessage(address: string, args: readonly OscArgument[] = []): Buffer {
  if (!address.startsWith("/")) throw new Error("Eine OSC-Adresse muss mit / beginnen.");
  const tags = args.map((value) => {
    if (typeof value === "string") return "s";
    if (typeof value === "boolean") return value ? "T" : "F";
    return Number.isInteger(value) ? "i" : "f";
  }).join("");
  const values = args.flatMap((value) => {
    if (typeof value === "string") return [oscString(value)];
    if (typeof value === "boolean") return [];
    const buffer = Buffer.alloc(4);
    if (Number.isInteger(value)) buffer.writeInt32BE(value);
    else buffer.writeFloatBE(value);
    return [buffer];
  });
  return Buffer.concat([oscString(address), oscString(`,${tags}`), ...values]);
}

export async function sendOscMessage(input: {
  host: string;
  port: number;
  address: string;
  args?: readonly OscArgument[];
}): Promise<void> {
  const packet = encodeOscMessage(input.address, input.args);
  const socket = dgram.createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.send(packet, input.port, input.host, (error) => error ? reject(error) : resolve());
    });
  } finally {
    socket.close();
  }
}
