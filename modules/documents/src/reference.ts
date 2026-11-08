/** The human number of a document: `PREFIX-YYYY-NNN`, three digits at least, growing past 999. Pure. */
export function formatReference(prefix: string, year: number, number: number): string {
  // The reference becomes part of a file name, so a prefix or year that could not be one is refused here.
  if (!/^[A-Z0-9]{1,10}$/.test(prefix)) throw new RangeError("The numbering prefix must be 1 to 10 uppercase letters or digits.");
  if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new RangeError("The year must have four digits.");
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError("The number must be a positive integer.");
  return `${prefix}-${year}-${String(number).padStart(3, "0")}`;
}
