import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import tls from "node:tls";

/** What `--setup` remembers so the next run needs no exports. The token is a secret: the file is readable by its owner only. */
export interface SavedConfig {
  url?: string;
  token?: string;
  /** A certificate authority file to trust, for a platform whose HTTPS certificate comes from a private CA. */
  caFile?: string;
}

export const defaultConfigPath = (home: string = homedir()): string => join(home, ".config", "ai-usage", "config.json");

/** The shape of a service token: mdnx_, eight hex digits, an underscore, then the secret. */
export const looksLikeToken = (value: string): boolean => /^mdnx_[0-9a-f]{8}_\S{20,}$/.test(value);

export function loadConfig(path: string): SavedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const pick = (key: string) => (typeof parsed[key] === "string" && parsed[key] !== "" ? (parsed[key] as string) : undefined);
    const config: SavedConfig = {};
    if (pick("url") !== undefined) config.url = pick("url");
    if (pick("token") !== undefined) config.token = pick("token");
    if (pick("caFile") !== undefined) config.caFile = pick("caFile");
    return config;
  } catch {
    // The content is never shown: it may hold the token.
    throw new Error(`${path} is not valid JSON; run the command again with --setup to write it anew`);
  }
}

export function saveConfig(path: string, config: SavedConfig): void {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export interface Sending {
  url: string | undefined;
  token: string | undefined;
  caFile: string | undefined;
}

/** A flag or an environment variable wins over what was saved. A certificate is added only when the environment names none. */
export function resolveSending(args: { url: string | undefined }, env: Record<string, string | undefined>, saved: SavedConfig): Sending {
  return {
    url: args.url ?? saved.url,
    token: env.AI_USAGE_TOKEN || saved.token,
    caFile: env.NODE_EXTRA_CA_CERTS ? undefined : saved.caFile,
  };
}

/** Makes this process trust one more certificate authority. Needs Node 24.5 or later. */
export function trustCertificateAuthority(file: string): void {
  if (typeof tls.setDefaultCACertificates !== "function") {
    throw new Error("trusting a certificate authority needs Node 24.5 or later; export NODE_EXTRA_CA_CERTS=<file> instead");
  }
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), readFileSync(file, "utf8")]);
}
