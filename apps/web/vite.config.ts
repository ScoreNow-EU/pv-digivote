import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

const targets = {
  dashboard: {
    outDir: path.resolve(root, "../../dashboard"),
    input: { controller: path.resolve(root, "controller.html") }
  },
  graphics: {
    outDir: path.resolve(root, "../../graphics"),
    input: {
      "beamer-a": path.resolve(root, "beamer-a.html"),
      "beamer-b": path.resolve(root, "beamer-b.html"),
      tablet: path.resolve(root, "tablet.html")
    }
  },
  public: {
    outDir: path.resolve(root, "../../public"),
    input: {
      vote: path.resolve(root, "vote.html"),
      jury: path.resolve(root, "jury.html")
    }
  }
} as const;

export default defineConfig(({ command, mode }) => {
  const target = mode in targets ? targets[mode as keyof typeof targets] : undefined;
  return {
    root,
    base: "./",
    plugins: react(),
    resolve: {
      alias: {
        "@pv/domain": path.resolve(root, "../../packages/domain/src/index.ts"),
        "@pv/scoring": path.resolve(root, "../../packages/scoring/src/index.ts")
      }
    },
    ...(target
      ? { build: {
          outDir: target.outDir,
          emptyOutDir: true,
          sourcemap: true,
          rollupOptions: { input: target.input as Record<string, string> }
        } }
      : {}),
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true
    },
    define: {
      __PV_BUILD_MODE__: JSON.stringify(command === "build" ? mode : "development")
    }
  };
});
