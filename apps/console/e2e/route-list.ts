// Prints the console's route list (src/routes.tsx, the one manifest the sidebar and the router read) as JSON, for
// every-screen.e2e.ts. It runs under Bun because the console's modules read import.meta.env, which Node, the runner
// Playwright uses, can't load. Run: bun apps/console/e2e/route-list.ts
import { routes } from "../src/routes";

console.log(JSON.stringify(routes.map(({ path, label }) => ({ path, label }))));
