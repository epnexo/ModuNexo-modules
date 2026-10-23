import { getDb, type DbQueryable } from "@modunexo/sdk";
import { hasNul, type Checked } from "./check.ts";

export type Config = { enabled: boolean; instructions: string; waitSeconds: number; historyMessages: number; maxRepliesPerHour: number };

export const MAX_INSTRUCTIONS_CHARS = 8000;

export async function loadConfig(db: DbQueryable = getDb("assistant")): Promise<Config> {
  const found = await db.query<{ enabled: boolean; instructions: string; wait_seconds: number; history_messages: number; max_replies_per_hour: number }>(
    "select enabled, instructions, wait_seconds, history_messages, max_replies_per_hour from config where id = 1",
  );
  const row = found.rows[0]!;
  return { enabled: row.enabled, instructions: row.instructions, waitSeconds: row.wait_seconds, historyMessages: row.history_messages, maxRepliesPerHour: row.max_replies_per_hour };
}

export async function saveConfig(config: Config): Promise<void> {
  await getDb("assistant").query(
    "update config set enabled = $1, instructions = $2, wait_seconds = $3, history_messages = $4, max_replies_per_hour = $5, updated_at = now() where id = 1",
    [config.enabled, config.instructions, config.waitSeconds, config.historyMessages, config.maxRepliesPerHour],
  );
}

const whole = (raw: string | undefined, field: string, min: number, max: number): Checked<number> => {
  const text = raw?.trim() ?? "";
  const value = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN;
  return value >= min && value <= max ? { ok: true, value } : { ok: false, error: `"${field}" must be a whole number from ${min} to ${max}.` };
};

/** Reads the settings form. A checked box sends `on`; an absent one means off. */
export function configInput(raw: Record<string, string | undefined>): Checked<Config> {
  const flag = raw.enabled?.trim().toLowerCase() ?? "";
  if (!["", "on", "true", "off", "false"].includes(flag)) return { ok: false, error: '"enabled" must be on or off.' };
  const instructions = raw.instructions?.trim() ?? "";
  if (hasNul(instructions) || instructions.length > MAX_INSTRUCTIONS_CHARS) return { ok: false, error: `"instructions" must be at most ${MAX_INSTRUCTIONS_CHARS} characters of plain text.` };
  const wait = whole(raw.waitSeconds, "waitSeconds", 0, 60);
  if (!wait.ok) return wait;
  const history = whole(raw.historyMessages, "historyMessages", 1, 50);
  if (!history.ok) return history;
  const limit = whole(raw.maxRepliesPerHour, "maxRepliesPerHour", 1, 100);
  if (!limit.ok) return limit;
  return { ok: true, value: { enabled: flag === "on" || flag === "true", instructions, waitSeconds: wait.value, historyMessages: history.value, maxRepliesPerHour: limit.value } };
}
