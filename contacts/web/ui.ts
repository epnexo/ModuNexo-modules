export const INPUT = "rounded-md border border-border-strong bg-surface px-3 py-2 outline-none focus-visible:border-accent";
export const BUTTON = "h-10 self-start rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover";
export const BUTTON_QUIET = "h-9 self-start rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-accent-soft";
export const BUTTON_DANGER = "h-9 self-start rounded-md border border-border-strong px-3 text-sm text-danger transition-colors duration-150 hover:bg-accent-soft";

const MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (value: number): string => MONEY.format(value);
export const when = (date: Date): string => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
