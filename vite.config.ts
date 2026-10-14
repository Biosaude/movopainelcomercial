// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv } from "vite";

export default defineConfig({
  vite: {
    plugins: [
      {
        name: "dashboard-local-supabase-config",
        config(_config, { command, mode }) {
          if (command !== "serve") return;
          // Vite does not inject non-VITE dotenv variables into Node's process.
          // Load only the two public bindings for the development backend.
          const local = loadEnv(mode, process.cwd(), "SUPABASE_");
          for (const name of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]) {
            if (!process.env[name] && local[name]) process.env[name] = local[name];
          }
        },
      },
    ],
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
