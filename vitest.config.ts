import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@pv/domain": `${root}packages/domain/src/index.ts`,
      "@pv/scoring": `${root}packages/scoring/src/index.ts`,
      "@pv/database": `${root}packages/database/src/index.ts`
    }
  },
  test: {
    environment: "node",
    include: ["{apps,packages}/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
