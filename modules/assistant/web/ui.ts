export const INPUT = "rounded-md border border-border-strong bg-surface px-3 py-2 outline-none focus-visible:border-accent";
export const BUTTON = "h-10 self-start rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover";
export const BUTTON_QUIET = "h-9 self-start rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-accent-soft";

export const when = (date: Date): string => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date) + " UTC";
