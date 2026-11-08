import { loadHours, loadSettings } from "../lib/settings.ts";
import { BUTTON, INPUT, clock } from "./ui.ts";

export const metadata = { title: "Agenda settings" };

const DAYS: [number, string][] = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"], [6, "Saturday"], [0, "Sunday"]];

function NumberField({ name, label, value, min, max }: { name: string; label: string; value: number; min: number; max: number }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`s-${name}`} className="text-sm font-medium">
        {label}
      </label>
      <input id={`s-${name}`} name={name} type="number" min={min} max={max} defaultValue={value} required className={`w-32 ${INPUT}`} />
    </div>
  );
}

export default async function Page() {
  const [settings, hours] = await Promise.all([loadSettings(), loadHours()]);
  const first = (weekday: number) => hours.find((window) => window.weekday === weekday);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Agenda settings</h1>
        <a href="/agenda" className="text-sm underline-offset-4 hover:underline">
          Back to the agenda
        </a>
      </div>
      <form method="post" action="/agenda/settings/save" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="s-timezone" className="text-sm font-medium">
            Time zone
          </label>
          <input id="s-timezone" name="timezone" defaultValue={settings.timezone} required maxLength={64} className={`max-w-sm ${INPUT}`} />
          <p className="text-xs text-muted">An IANA name such as America/Bogota or Europe/Madrid. Hours below are read in this zone.</p>
        </div>
        <div className="flex flex-wrap gap-4">
          <NumberField name="slotMinutes" label="Appointment length (minutes)" value={settings.slotMinutes} min={5} max={480} />
          <NumberField name="bufferMinutes" label="Gap between appointments (minutes)" value={settings.bufferMinutes} min={0} max={240} />
          <NumberField name="horizonDays" label="Days offered ahead" value={settings.horizonDays} min={1} max={90} />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Opening hours</legend>
          <p className="text-xs text-muted">Leave both times empty for a closed day. Bookings already made stay as they are.</p>
          {DAYS.map(([weekday, name]) => {
            const window = first(weekday);
            return (
              <div key={weekday} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-24">{name}</span>
                <input name={`d${weekday}_start`} type="time" defaultValue={window === undefined ? "" : clock(window.startMinute)} aria-label={`${name} opens`} className={INPUT} />
                <span aria-hidden="true">–</span>
                <input name={`d${weekday}_end`} type="time" defaultValue={window === undefined ? "" : clock(window.endMinute)} aria-label={`${name} closes`} className={INPUT} />
              </div>
            );
          })}
        </fieldset>
        <button type="submit" className={BUTTON}>
          Save
        </button>
      </form>
    </div>
  );
}
