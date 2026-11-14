import { ago, formatDuration } from "../lib/format.ts";
import type { GuestRow } from "../lib/queries.ts";

export const guestKind = (kind: GuestRow["kind"]): string => (kind === "qemu" ? "VM" : "Container");

export function GuestState({ running }: { running: boolean }) {
  return running ? <span className="badge badge-success">Running</span> : <span className="badge">Stopped</span>;
}

const percent = (value: number | null): string => (value === null ? "—" : `${value.toFixed(1)}%`);

/** The guests of a hypervisor: state, how long each has been up, its availability over 30 days and whether a backup covers it. */
export default function GuestsTable({ guests, now }: { guests: GuestRow[]; now: number }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Guest</th>
              <th scope="col">Type</th>
              <th scope="col">State</th>
              <th scope="col">Last up</th>
              <th scope="col" className="right">Up in 7 d</th>
              <th scope="col" className="right">Availability 30 d</th>
              <th scope="col">Backup</th>
            </tr>
          </thead>
          <tbody>
            {guests.map((guest) => (
              <tr key={guest.id}>
                <th scope="row"><a href={`/observability/guest/${guest.id}`}>{guest.name}</a><br /><span className="obs-foot">{guest.vmid} · {guest.node}</span></th>
                <td>{guestKind(guest.kind)}</td>
                <td><GuestState running={guest.running} /></td>
                <td className="num">{guest.running ? "now" : ago(guest.lastUpAt === null ? null : Math.max(0, (now - guest.lastUpAt.getTime()) / 60_000))}</td>
                <td className="right num">{formatDuration(guest.upSeconds["7d"])}</td>
                <td className="right num">{percent(guest.availability["30d"])}</td>
                <td>{guest.backedUp === false ? <span className="badge badge-warning">Not backed up</span> : guest.backedUp === true ? "Covered" : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
