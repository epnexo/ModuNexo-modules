let fixed: Date | null = null;

/** The current time. Tests fix it so that "the next free slot" does not depend on the day they run. */
export const now = (): Date => fixed ?? new Date();

export function setNowForTests(date: Date | null): void {
  fixed = date;
}
