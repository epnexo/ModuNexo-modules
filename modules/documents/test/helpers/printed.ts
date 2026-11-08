import { format } from "node:util";

/**
 * What a console would print for each captured call, as one string: the arguments formatted the way `console.error`
 * formats them, so an error object contributes its message and its stack. `JSON.stringify` would not: it turns an
 * error into `{}` plus its own enumerable fields and hides the message, so a test built on it passes when the whole
 * error is logged.
 */
export function printed(lines: readonly (readonly unknown[])[]): string {
  return lines.map((args) => format(...args)).join("\n");
}
