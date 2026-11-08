import { now } from "../lib/clock.ts";
import { refuse } from "../lib/form.ts";
import { loadSettings } from "../lib/settings.ts";
import { freeSlots } from "../lib/slots.ts";

const DAY = 86_400_000;
const MAX_SLOTS = 500;

/** Service API: the free slots, optionally only those within the next `days` days. Needs the scope `availability.read`. */
export async function GET(request: Request): Promise<Response> {
  const asked = new URL(request.url).searchParams.get("days");
  let days: number | null = null;
  if (asked !== null) {
    days = /^\d{1,2}$/.test(asked) ? Number(asked) : Number.NaN;
    if (!(days >= 1 && days <= 90)) return refuse('"days" must be a whole number from 1 to 90.', 400);
  }
  const at = now();
  const settings = await loadSettings();
  const cutoff = days === null ? Number.POSITIVE_INFINITY : at.getTime() + days * DAY;
  const slots = (await freeSlots(at)).filter((slot) => slot.startsAt.getTime() < cutoff).slice(0, MAX_SLOTS);
  return Response.json({ timezone: settings.timezone, slotMinutes: settings.slotMinutes, slots: slots.map((slot) => ({ startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() })) });
}
