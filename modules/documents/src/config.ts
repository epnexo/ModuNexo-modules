import { getSetting } from "@modunexo/sdk";

export type Env = Record<string, string | undefined>;

/** Module setting key -> the name the pure builders (`docusealFromEnv`, `pdfEngineFromEnv`) read. */
const SETTING_TO_NAME = {
  "docuseal.url": "DOCUSEAL_URL",
  "docuseal.token": "DOCUSEAL_API_TOKEN",
  "engine.python": "DOCUMENTS_PYTHON",
  "engine.assets_dir": "DOCUMENTS_ASSETS_DIR",
  "engine.timeout_ms": "DOCUMENTS_RENDER_TIMEOUT_MS",
} as const;

type Reader = (moduleId: string, key: string) => Promise<string | number | boolean | null>;

/** The module's settings in the shape the builders take. A setting that is not set is left out. Needs a request: `getSetting` throws elsewhere. */
export async function loadConfig(read: Reader = getSetting): Promise<Env> {
  const env: Env = {};
  for (const [key, name] of Object.entries(SETTING_TO_NAME)) {
    const value = await read("documents", key);
    if (value !== null && value !== undefined) env[name] = String(value);
  }
  return env;
}
