import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Mirrors apps/console/vite.config.ts — same stack (react + tailwind v4 vite plugin). A production
// build without the Cal.com settings ships the booking flow in PREVIEW mode, where buyers complete
// a flow that books nothing (the dialog says so) — so the build says so too, loudly.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "VITE_");
  if (
    command === "build" &&
    mode === "production" &&
    !(env.VITE_CALCOM_USERNAME && env.VITE_CALCOM_EVENT_SLUG)
  ) {
    console.warn(
      "\n[www] VITE_CALCOM_USERNAME / VITE_CALCOM_EVENT_SLUG are not set: the booking flow ships in PREVIEW mode and books nothing.\n",
    );
  }
  // The pages: the landing page, and the legal pages beside it with no script (README → Legal pages). Bun's
  // coverage never sees these lines run: only vite reads this file, in the child process test/build.test.ts starts.
  // coverage gap: only vite's build runs it, in test/build.test.ts's child process
  const input = ["index", "privacy", "terms"].map(
    // coverage gap: only vite's build runs it, in test/build.test.ts's child process
    (page) => `${import.meta.dirname}/${page}.html`,
  );
  // 5174, strict: 5173 belongs to the console (auth redirects and CORS name it).
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 5174, strictPort: true },
    // coverage gap: only vite's build runs it, in test/build.test.ts's child process
    build: { rolldownOptions: { input } },
  };
});
