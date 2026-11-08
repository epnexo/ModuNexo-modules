import { MULTI_LINE_MAX, SINGLE_LINE_MAX } from "./document-rules.ts";
import { PLATFORM_MARKERS, listMarkers, markerSpans } from "./markers.ts";
import { PROFILE_FIELDS, type Profile } from "./profile.ts";

/**
 * Values that use other fields. A value (typed, or a default the form started with) may contain markers of the
 * template's own syntax; they are filled when the document is created. Pure.
 *
 * What a marker in a value can refer to: the owner profile (a key it has a value for), `REF`, or another marker the
 * template asks per document. Anything else is not a reference: a group that names none of these, and a malformed
 * group, stays exactly as typed.
 *
 * Each value is built in a single pass over its own text, so text that was substituted in is never scanned again, and a
 * field is resolved once however many fields use it, after the fields it uses (a cycle is refused). The length is
 * summed before a value is built, so a value that expands is refused before it is used by the fields after it.
 * Resolution works on plain text; the body engine escapes each value once when it puts it into the document.
 *
 * A profile marker the platform knows (`PROFILE_FIELDS`) but the profile has no value for is a field error, not text
 * left as typed: leaving `{{A_REPRESENTANTE}}` in place would print a raw marker in a document that gets signed.
 */

export interface ValueField {
  name: string;
  label: string;
  multiline: boolean;
}

export type ResolveResult = { ok: true; values: Record<string, string> } | { ok: false; errors: Record<string, string> };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const PROFILE_KEYS: ReadonlySet<string> = new Set(PROFILE_FIELDS.map((field) => field.key));
const hasProfileValue = (profile: Profile, name: string) => Object.hasOwn(profile, name) && typeof profile[name] === "string";

/** The fields among `fieldNames` that a text uses, once each, in order of first appearance. */
export function referencedFields(text: string, fieldNames: string[]): string[] {
  const known = new Set(fieldNames);
  return listMarkers(text).filter((name) => known.has(name));
}

/** Names that sit on a cycle of the graph (field to the fields it uses), each with the other members of its cycle in graph order. */
function cycles(graph: Map<string, string[]>): Map<string, string[]> {
  // Tarjan's strongly connected components; a component of two or more fields, or a field that uses itself, is a cycle.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found = new Map<string, string[]>();
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter++);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const members: string[] = [];
    for (let member = ""; member !== node; ) {
      member = stack.pop()!;
      onStack.delete(member);
      members.push(member);
    }
    if (members.length > 1 || (graph.get(node) ?? []).includes(node)) {
      const ordered = [...graph.keys()].filter((name) => members.includes(name));
      for (const member of members) found.set(member, ordered);
    }
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return found;
}

function cycleMessage(name: string, members: string[], labels: Map<string, string>): string {
  const others = members.filter((member) => member !== name).map((member) => labels.get(member) ?? member);
  return others.length === 0 ? "This value refers to itself." : `This value and ${others.join(", ")} refer to each other.`;
}

const unsetMessage = (names: string[]) => `Uses ${names.map((name) => `{{${name}}}`).join(", ")}, which ${names.length === 1 ? "is" : "are"} not set in the owner profile.`;

/**
 * Check the references of the starting values a template keeps (its defaults), without resolving anything: every marker
 * must be another field, `REF` or a profile marker with a value, and the fields must not depend on each other in a
 * circle. `text` is what the owner wrote for the field, empty when there is nothing. Errors are keyed by field name.
 */
export function checkReferences(input: { fields: Array<{ name: string; label: string; text: string }>; profile: Profile }): Record<string, string> {
  const names = input.fields.map((field) => field.name);
  const errors: Record<string, string> = {};
  const graph = new Map<string, string[]>();
  for (const field of input.fields) {
    const unknown: string[] = [];
    const unset: string[] = [];
    for (const name of listMarkers(field.text)) {
      if (names.includes(name) || PLATFORM_MARKERS.includes(name) || hasProfileValue(input.profile, name)) continue;
      (PROFILE_KEYS.has(name) ? unset : unknown).push(name);
    }
    if (unknown.length > 0) errors[field.name] = `${unknown.map((name) => `{{${name}}}`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not a marker of this template. Use a marker asked per document, a profile marker or {{REF}}.`;
    else if (unset.length > 0) errors[field.name] = unsetMessage(unset);
    graph.set(field.name, referencedFields(field.text, names));
  }
  const labels = new Map(input.fields.map((field) => [field.name, field.label]));
  for (const [name, members] of cycles(graph)) if (errors[name] === undefined) errors[name] = cycleMessage(name, members, labels);
  return errors;
}

/**
 * Resolve the values entered for the fields a template asks per document. `values` are the checked entries (trimmed,
 * within the limits of what was typed). The result has the same keys with every reference filled, or the errors by field.
 */
export function resolveValues(input: { fields: ValueField[]; values: Record<string, string>; profile: Profile; ref: string }): ResolveResult {
  const byName = new Map(input.fields.map((field) => [field.name, field]));
  const names = input.fields.map((field) => field.name);
  const raw = (name: string) => (Object.hasOwn(input.values, name) ? input.values[name]! : "");
  const labels = new Map(input.fields.map((field) => [field.name, field.label]));

  const errors: Record<string, string> = {};
  const graph = new Map(names.map((name) => [name, referencedFields(raw(name), names)]));
  const cyclic = cycles(graph);
  for (const [name, members] of cyclic) errors[name] = cycleMessage(name, members, labels);

  const resolved = new Map<string, string>();
  /** Fields with no value to give to the ones that use them: in a cycle, refused, or using a field that is. */
  const failed = new Set<string>(cyclic.keys());

  const resolve = (name: string): void => {
    if (resolved.has(name) || failed.has(name)) return;
    const field = byName.get(name)!;
    const text = raw(name);
    const dependencies = graph.get(name)!;
    for (const dependency of dependencies) resolve(dependency);
    if (dependencies.some((dependency) => failed.has(dependency))) {
      failed.add(name);
      return;
    }

    const max = field.multiline ? MULTI_LINE_MAX : SINGLE_LINE_MAX;
    const pieces: string[] = [];
    const unset: string[] = [];
    let length = 0;
    let last = 0;
    const push = (piece: string) => {
      pieces.push(piece);
      length += piece.length;
    };
    for (const span of markerSpans(text)) {
      const token = span.name;
      let piece: string | undefined;
      if (token === "REF") piece = input.ref;
      else if (hasProfileValue(input.profile, token)) piece = input.profile[token]!;
      else if (byName.has(token)) piece = resolved.get(token)!;
      else if (PROFILE_KEYS.has(token)) unset.push(token);
      push(text.slice(last, span.start));
      push(piece ?? text.slice(span.start, span.end));
      last = span.end;
      // The sum is checked while it grows, so a value that expands is never built.
      if (length > max) break;
    }
    if (unset.length > 0) {
      errors[name] = unsetMessage([...new Set(unset)]);
      failed.add(name);
      return;
    }
    if (length <= max) push(text.slice(last));
    if (length > max) {
      errors[name] = `Once the fields it uses are filled in, this value is longer than ${max} characters.`;
      failed.add(name);
      return;
    }

    const value = pieces.join("");
    if (value.trim() === "") errors[name] = `Enter ${field.label.toLowerCase()}.`;
    else if (CONTROL.test(value)) errors[name] = "Remove the control characters.";
    else if (!field.multiline && value.includes("\n")) errors[name] = "Once the fields it uses are filled in, this value has line breaks. Use a single line.";
    if (errors[name] !== undefined) {
      failed.add(name);
      return;
    }
    resolved.set(name, value);
  };
  for (const name of names) resolve(name);

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, values: Object.fromEntries(names.map((name) => [name, resolved.get(name)!])) };
}
