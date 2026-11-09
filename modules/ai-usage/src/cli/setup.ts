import { readFileSync } from "node:fs";
import { cleanAddress } from "../../lib/connect.ts";
import { looksLikeToken, saveConfig, type SavedConfig } from "./config.ts";

/** The two ways to ask a question; the terminal one hides what is typed for a secret. */
export interface Prompter {
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
}

const ATTEMPTS = 3;

/** Asks until `accept` gives a value, at most ATTEMPTS times; an empty answer keeps `current` when there is one. */
async function until<T>(what: string, ask: () => Promise<string>, current: T | undefined, accept: (answer: string) => T | undefined, log: (line: string) => void): Promise<T> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const answer = (await ask()).trim();
    if (answer === "" && current !== undefined) return current;
    const value = accept(answer);
    if (value !== undefined) return value;
    log(`That is not a valid ${what}.`);
  }
  throw new Error(`no valid ${what} after ${ATTEMPTS} tries; nothing was saved`);
}

const readsAsCertificate = (file: string): boolean => {
  try {
    return readFileSync(file, "utf8").includes("BEGIN CERTIFICATE");
  } catch {
    return false;
  }
};

/** Asks for the platform address, the token and, optionally, a certificate authority, then saves them. Nothing is written until all are valid, and the token is never printed. */
export async function runSetup(options: { path: string; prompter: Prompter; current: SavedConfig; log: (line: string) => void }): Promise<SavedConfig> {
  const { path, prompter, current, log } = options;
  const url = await until(
    "web address",
    () => prompter.ask(`Platform address, for example https://modunexo.home.arpa${current.url ? ` [${current.url}]` : ""}: `),
    current.url,
    (answer) => cleanAddress(answer) ?? undefined,
    log,
  );
  const token = await until(
    "service token (it starts with mdnx_)",
    () => prompter.askSecret(`Service token with the scope ai_usage.write${current.token ? " [keep the saved one]" : ""} (hidden): `),
    current.token,
    (answer) => (looksLikeToken(answer) ? answer : undefined),
    log,
  );
  const caAnswer = await until<string>(
    "certificate file",
    () => prompter.ask(`Certificate authority file, only if the platform uses a private one${current.caFile ? ` [${current.caFile}]` : " (Enter to skip)"}: `),
    current.caFile ?? "",
    (answer) => (answer === "" || readsAsCertificate(answer) ? answer : undefined),
    log,
  );
  const config: SavedConfig = { url, token };
  if (caAnswer !== "") config.caFile = caAnswer;
  saveConfig(path, config);
  log(`Saved to ${path}. Only you can read it.`);
  log("Check what would be sent with --dry-run, then send it by running the command with no options.");
  return config;
}
