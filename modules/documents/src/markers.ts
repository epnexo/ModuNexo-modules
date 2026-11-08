/**
 * The marker engine: pure functions over a template body. A marker is `{{NAME}}` with NAME in upper case,
 * digits and underscores, the syntax of the NDA template this platform ported. There are no conditionals,
 * loops or expressions: a marker is replaced by a text value and nothing else.
 */

const MARKER = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;
/** Any closed double-brace group; the ones that are not valid markers are reported as malformed. */
const BRACE_GROUP = /\{\{[^{}]*\}\}/g;
const VALID_GROUP = /^\{\{[A-Z_][A-Z0-9_]*\}\}$/;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/** The distinct markers of a body, in order of first appearance. */
export function listMarkers(body: string): string[] {
  return [...new Set([...body.matchAll(MARKER)].map((match) => match[1]!))];
}

/** Every valid marker in a text, with where it sits, in order. Nothing is replaced: for callers that fill a value themselves. */
export function markerSpans(text: string): Array<{ name: string; start: number; end: number }> {
  return [...text.matchAll(MARKER)].map((match) => ({ name: match[1]!, start: match.index, end: match.index + match[0].length }));
}

/** Double-brace groups that look like markers but are not valid (`{{ NAME }}`, `{{name}}`, `{{}}`), once each. */
export function malformedMarkers(body: string): string[] {
  return [...new Set([...body.matchAll(BRACE_GROUP)].map((match) => match[0]).filter((group) => !VALID_GROUP.test(group)))];
}

export interface Substitution {
  html: string;
  /** Markers that had no value, once each, in order of first appearance. They stay in `html` as written. */
  missing: string[];
}

/**
 * Replace every marker with its HTML-escaped value in one pass, so a value that contains `{{X}}` is never
 * expanded again. A marker without a string value is reported in `missing` and left visible in the output.
 */
export function substitute(body: string, values: Record<string, string>): Substitution {
  const missing = new Set<string>();
  const html = body.replace(MARKER, (marker, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (typeof value !== "string") {
      missing.add(name);
      return marker;
    }
    return escapeHtml(value);
  });
  return { html, missing: [...missing] };
}

/** Markers the platform fills itself, so they are never asked for: REF is the document's number. */
export const PLATFORM_MARKERS: readonly string[] = ["REF"];

export interface MarkerGroups {
  fromProfile: string[];
  perDocument: string[];
}

/** Markers the owner profile has a value for, and the ones that have to be asked for each document (not the platform's own). */
export function splitMarkers(markers: string[], profile: Record<string, string>): MarkerGroups {
  const inProfile = (name: string) => Object.hasOwn(profile, name) && typeof profile[name] === "string";
  return { fromProfile: markers.filter(inProfile), perDocument: markers.filter((name) => !inProfile(name) && !PLATFORM_MARKERS.includes(name)) };
}
