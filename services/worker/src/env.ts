// Zod-parsed process env (docs/tech-stack.md T11) — the worker refuses to boot half-configured.
import { z } from "zod";

export const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL missing — app_service connection string"),
  SUPABASE_URL: z.string().url(),
  // Listen port — one number shared with the console's VITE_API_URL (the local wrapper sets both).
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  // Comma-separated browser origins allowed to call this API (docs/security.md S3/S4:
  // explicit allowlist, never "*"). Default = the local console; staging/prod set their own.
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((s) =>
      s
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  // OPTIONAL: the worker boots WITHOUT it — a missing key just means no LLM turns until one
  // is set (makeProvider gates on it). Env-provisioned in prod, absent in tests/local. Never logged.
  ANTHROPIC_API_KEY: z.string().optional(),
  // Bearer token for GET /ready and GET /release (docs/security.md S5.9, as the decisions on /ready's token and the
  // release endpoint in docs/decisions-in-force/ amend it): the container's health check, the deploy gate and the
  // uptime monitor send it. OPTIONAL:
  // unset means /ready answers 401 to everyone (fail closed). `openssl rand -hex 32`.
  READY_TOKEN: z
    .string()
    .min(32, "READY_TOKEN too short — openssl rand -hex 32")
    .optional(),
  // The commit this build came from (docker/Dockerfile's RELEASE build argument), shown by GET /release. Only a
  // commit id is accepted, so nothing else, a secret pasted in by mistake included, can ever be shown there.
  RELEASE: z
    .string()
    .regex(
      /^[0-9a-f]{7,40}$/,
      "RELEASE must be a commit id (7 to 40 hex characters)",
    )
    .optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export const env = EnvSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  PORT: process.env.PORT,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  READY_TOKEN: process.env.READY_TOKEN || undefined, // blank (copied .env.example) = unset
  RELEASE: process.env.RELEASE || undefined, // blank (an image built without it) = unknown
});
