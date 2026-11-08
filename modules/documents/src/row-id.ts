/** A row id from a form field or a URL segment: plain digits, positive, within a safe integer. */
export function parseRowId(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
