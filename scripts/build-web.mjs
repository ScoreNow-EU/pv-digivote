import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(scriptDir, "../apps/web/vite.config.ts");

for (const mode of ["dashboard", "graphics", "public"]) {
  await build({ configFile, mode });
}
