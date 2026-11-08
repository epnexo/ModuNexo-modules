export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** Postgres cannot store a NUL character in text, so it is refused here, as a bad request, instead of failing the write. */
export const hasNul = (value: string): boolean => value.includes("\u0000");
