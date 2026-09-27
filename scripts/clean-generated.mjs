import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

for (const directory of ["dashboard", "graphics", "public", "extension"]) {
  await rm(path.join(projectRoot, directory), { recursive: true, force: true });
}
