import { weekBookings, type BookingRow } from "../lib/bookings.ts";
import { now } from "../lib/clock.ts";
import { loadSettings } from "../lib/settings.ts";
import { freeSlots, type Slot } from "../lib/slots.ts";
import { zonedParts } from "../lib/time.ts";
import { weekOf } from "../lib/week.ts";
import { BUTTON, BUTTON_DANGER, BUTTON_QUIET, INPUT, dayLabel, slotLabel, timeIn } from "./ui.ts";

export const metadata = { title: "Agenda" };

function SlotOptions({ slots, timeZone }: { slots: Slot[]; timeZone: string }) {
  return (
    <>
      {slots.map((slot) => (
        <option key={slot.startsAt.toISOString()} value={slot.startsAt.toISOString()}>
          {slotLabel(slot.startsAt, timeZone)}
        </option>
      ))}
    </>
  );
}

function Booking({ booking, slots, timeZone }: { booking: BookingRow; slots: Slot[]; timeZone: string }) {
  const cancelled = booking.status === "cancelled";
  return (
    <li className={`flex flex-col gap-2 rounded-md border border-border bg-surface p-3 text-sm ${cancelled ? "opacity-60" : ""}`}>
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className={`font-medium ${cancelled ? "line-through" : ""}`}>{booking.attendeeName}</span>
        <span className="text-muted">
          {`${timeIn(booking.startsAt, timeZone)}–${timeIn(booking.endsAt, timeZone)}`}
          {cancelled ? " · Cancelled" : ""}
        </span>
      </span>
      {booking.notes === null ? null : <span className="whitespace-pre-wrap break-words text-muted">{booking.notes}</span>}
      {booking.contactId === null ? null : <span className="text-xs text-muted">{`Contact #${booking.contactId}`}</span>}
      {cancelled ? null : (
        <div className="flex flex-wrap gap-2">
          {slots.length === 0 ? null : (
            <form method="post" action="/agenda/reschedule" className="flex gap-2">
              <input type="hidden" name="id" value={booking.id} />
              <select name="startsAt" aria-label={`New time for ${booking.attendeeName}`} className={`${INPUT} py-1`}>
                <SlotOptions slots={slots} timeZone={timeZone} />
              </select>
              <button type="submit" className={BUTTON_QUIET}>
                Move
              </button>
            </form>
          )}
          <form method="post" action="/agenda/cancel">
            <input type="hidden" name="id" value={booking.id} />
            <button type="submit" className={BUTTON_DANGER}>
              Cancel
            </button>
          </form>
        </div>
      )}
    </li>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<{ d?: string | string[] }> }) {
  const { d } = await searchParams;
  const at = now();
  const settings = await loadSettings();
  const week = weekOf(d, at, settings.timezone);
  const [bookings, every] = await Promise.all([weekBookings(week.from, week.to), freeSlots(at)]);
  const slots = every.filter((slot) => slot.startsAt >= week.from && slot.startsAt < week.to);
  const bookingsOf = (day: { year: number; month: number; day: number }) =>
    bookings.filter((booking) => {
      const p = zonedParts(booking.startsAt.getTime(), settings.timezone);
      return p.year === day.year && p.month === day.month && p.day === day.day;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
        <a href="/agenda/settings" className="text-sm underline-offset-4 hover:underline">
          Hours and settings
        </a>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <a href={`/agenda?d=${week.prev}`} className={BUTTON_QUIET.replace("h-9 self-start", "inline-flex h-9 items-center")}>
          Previous week
        </a>
        <p className="text-muted">{`${dayLabel(week.days[0]!)} – ${dayLabel(week.days[6]!)}. Times are in ${settings.timezone}.`}</p>
        <a href={`/agenda?d=${week.next}`} className={BUTTON_QUIET.replace("h-9 self-start", "inline-flex h-9 items-center")}>
          Next week
        </a>
      </div>

      <section aria-label="Book a slot" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-lg font-semibold tracking-tight">Book a slot</h2>
        {slots.length === 0 ? (
          <p className="text-sm text-muted">No free slot this week.</p>
        ) : (
          <form method="post" action="/agenda/book" className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="book-start" className="text-sm font-medium">
                Time
              </label>
              <select id="book-start" name="startsAt" className={INPUT}>
                <SlotOptions slots={slots} timeZone={settings.timezone} />
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="book-name" className="text-sm font-medium">
                Name
              </label>
              <input id="book-name" name="attendeeName" required maxLength={200} className={INPUT} />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="book-contact" className="text-sm font-medium">
                Contact id (optional)
              </label>
              <input id="book-contact" name="contactId" inputMode="numeric" className={`w-32 ${INPUT}`} />
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <label htmlFor="book-notes" className="text-sm font-medium">
                Notes
              </label>
              <input id="book-notes" name="notes" maxLength={2000} className={INPUT} />
            </div>
            <button type="submit" className={BUTTON}>
              Book
            </button>
          </form>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        {week.days.map((day) => {
          const todays = bookingsOf(day);
          return (
            <section key={`${day.year}-${day.month}-${day.day}`} aria-label={dayLabel(day)} className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
              <h2 className="font-semibold">{dayLabel(day)}</h2>
              {todays.length === 0 ? (
                <p className="text-sm text-muted">No booking.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {todays.map((booking) => (
                    <Booking key={booking.id} booking={booking} slots={slots} timeZone={settings.timezone} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
