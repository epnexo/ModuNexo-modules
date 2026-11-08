import { type SubmissionSigner, toIsoTime } from "./docuseal-client.ts";

/** How a DocuSeal submission status becomes a document status, and how reported signers are folded into the stored ones. Pure. */

export type SignatureStatus = "sent" | "completed" | "declined" | "expired";

/**
 * A submission is `pending` until every signer has signed, then `completed`; DocuSeal also reports `declined` and
 * `expired`. The /nda skill's code acts on `completed` only, the rest are the values DocuSeal documents. Anything
 * else is null: the caller changes nothing and says so.
 */
const BY_REPORTED: Record<string, SignatureStatus> = { pending: "sent", completed: "completed", declined: "declined", expired: "expired" };

export function mapSubmissionStatus(reported: string): SignatureStatus | null {
  return Object.hasOwn(BY_REPORTED, reported) ? BY_REPORTED[reported]! : null;
}

/** A reported value shown in a note: letters, digits, `_` and `-`, at most 40. It comes from another server, so it is cut down to that. */
export function safeReported(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}

const PLAIN_STATUS = /^[a-z_]{1,20}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Fold what DocuSeal reports into the stored signers, matched by role, else by email. Only the `status` and `at` keys of
 * a matched entry are touched; every other entry and every other key comes back exactly as stored, in place, so a refresh
 * never drops anything it did not understand. A reported status that is not a plain word, or a time that is not an ISO
 * date-time, leaves what was stored. A stored value that is not a list is returned alone. `changed` says whether any
 * signer's status or time differs from what was stored.
 */
export function mergeStoredSigners(stored: unknown, reported: SubmissionSigner[]): { value: unknown; changed: boolean } {
  if (!Array.isArray(stored)) return { value: stored, changed: false };
  let changed = false;
  const value = stored.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.role !== "string") return entry;
    const email = typeof entry.email === "string" ? entry.email.toLowerCase() : null;
    const match = reported.find((signer) => signer.role === entry.role) ?? (email === null ? undefined : reported.find((signer) => signer.email !== null && signer.email.toLowerCase() === email));
    if (!match) return entry;
    const status = match.status !== null && PLAIN_STATUS.test(match.status) ? match.status : undefined;
    const at = toIsoTime(match.at) ?? undefined;
    const next = { ...entry, ...(status === undefined ? {} : { status }), ...(at === undefined ? {} : { at }) };
    if (next.status !== entry.status || next.at !== entry.at) changed = true;
    return next;
  });
  return { value, changed };
}

/** When the document was completed: DocuSeal's time for the submission, else the latest time of a signer who completed. */
export function completionTime(completedAt: string | null, signers: SubmissionSigner[]): Date | null {
  const own = toIsoTime(completedAt);
  if (own !== null) return new Date(own);
  const times = signers.flatMap((signer) => {
    const at = signer.status === "completed" ? toIsoTime(signer.at) : null;
    return at === null ? [] : [new Date(at).getTime()];
  });
  return times.length === 0 ? null : new Date(Math.max(...times));
}
