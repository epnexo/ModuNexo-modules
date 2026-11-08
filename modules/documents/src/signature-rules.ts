import type { SigningOrder } from "./docuseal-client.ts";
import { isEmailAddress } from "./profile.ts";

/** The two signers of a document and how they sign. Pure; the values go to DocuSeal as JSON and are never interpreted. */

export const SIGNER_NAME_MAX = 200;
export const SIGNING_ORDERS: readonly SigningOrder[] = ["random", "preserved"];

export interface SignerInput {
  owner: { name: string; email: string };
  counterparty: { name: string; email: string };
  order: SigningOrder;
}

export type SignerValidation = { ok: true; value: SignerInput } | { ok: false; errors: Record<string, string>; values: Record<string, string> };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const EMAIL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const FIELDS = ["ownerName", "ownerEmail", "counterpartyName", "counterpartyEmail", "order"] as const;

export function validateSigners(raw: Record<string, string | undefined>): SignerValidation {
  const values: Record<string, string> = {};
  for (const name of FIELDS) {
    const given = Object.hasOwn(raw, name) ? raw[name] : undefined;
    values[name] = typeof given === "string" ? given.trim() : "";
  }
  const errors: Record<string, string> = {};
  const checkName = (field: "ownerName" | "counterpartyName", label: string) => {
    const value = values[field]!;
    if (value === "") errors[field] = `Enter ${label}.`;
    else if (value.length > SIGNER_NAME_MAX) errors[field] = `Use at most ${SIGNER_NAME_MAX} characters.`;
    else if (CONTROL.test(value)) errors[field] = "Use a single line without control characters.";
  };
  const checkEmail = (field: "ownerEmail" | "counterpartyEmail", label: string) => {
    const value = values[field]!;
    if (value === "") errors[field] = `Enter ${label}.`;
    else if (EMAIL_CONTROL.test(value) || !isEmailAddress(value)) errors[field] = "Enter an email address like name@example.com.";
  };
  checkName("ownerName", "your name");
  checkEmail("ownerEmail", "your email address");
  checkName("counterpartyName", "the counterparty signer's name");
  checkEmail("counterpartyEmail", "the counterparty signer's email address");
  if (!errors.counterpartyEmail && !errors.ownerEmail && values.ownerEmail!.toLowerCase() === values.counterpartyEmail!.toLowerCase()) {
    errors.counterpartyEmail = "Use a different email address from yours: each signer gets their own link.";
  }
  if (!(SIGNING_ORDERS as readonly string[]).includes(values.order!)) errors.order = "Choose how the signers sign.";

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };
  return {
    ok: true,
    value: {
      owner: { name: values.ownerName!, email: values.ownerEmail! },
      counterparty: { name: values.counterpartyName!, email: values.counterpartyEmail! },
      order: values.order as SigningOrder,
    },
  };
}

/** What the form shows for the owner's side: the skill's rule, the representative or else the company, and the company email. */
export function ownerSignerDefaults(profile: Record<string, string>): { name: string; email: string } {
  return { name: profile.A_REPRESENTANTE || profile.A_NOMBRE || "", email: profile.A_EMAIL || "" };
}
