import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentDetail } from "../src/document-store.ts";
import { renderDocumentPage } from "../web/document-page.tsx";
import { ClearSendForm, RefreshForm, SignatureForm } from "../web/forms.tsx";

const html = (element: ReactElement) => renderToStaticMarkup(createElement("div", null, element));

const detail = (extra: Partial<DocumentDetail> = {}): DocumentDetail => ({
  id: 9,
  ref: "NDA-2026-001",
  title: "Mutual NDA — Beta Ltd",
  counterpartyName: "Beta Ltd",
  templateName: "Mutual NDA",
  status: "generated",
  createdAt: new Date("2026-10-09T12:34:00Z"),
  pages: 3,
  values: { B_NOMBRE: "Beta Ltd" },
  profile: { A_NOMBRE: "Acme" },
  hasPdf: true,
  pdfName: "NDA-2026-001-beta-ltd.pdf",
  completedAt: null,
  hasSubmission: false,
  templateVariables: {},
  sendStartedAt: null,
  signers: [],
  signature: { ready: true },
  ...extra,
});

const SIGNERS = [
  { role: "Acme", name: "Ana <b>Gómez</b>", email: "ana@acme.test", link: "https://sign.example.test/s/AAA-link", status: "completed", at: "2026-10-12T10:00:00.000Z" },
  { role: "Beta Ltd", name: "Ben Ruiz", email: "ben@beta.test", link: "http://192.0.2.10:3000/s/BBB-link", status: "opened", at: "2026-10-12T09:30:00.000Z" },
];

interface Options {
  document?: DocumentDetail | null;
  configured?: boolean;
  sent?: string | undefined;
  refreshed?: string | undefined;
  owner?: () => Promise<{ name: string; email: string }>;
}

async function page(options: Options = {}) {
  const calls = { owner: 0 };
  const markup = html(
    await renderDocumentPage({
      idParam: "9",
      created: false,
      sent: options.sent,
      refreshed: options.refreshed,
      configured: options.configured ?? true,
      loadOwner: async () => {
        calls.owner += 1;
        return (options.owner ?? (async () => ({ name: "Ana Gómez", email: "ana@acme.test" })))();
      },
      load: async () => (options.document === undefined ? detail() : options.document),
    }),
  );
  return { markup, calls };
}

describe("document page: a generated document", () => {
  it("tells the owner to upload the PDF to DocuSeal without renaming it, with the exact file name and the download link", async () => {
    const { markup } = await page();
    assert.match(markup, /Send for signature/);
    assert.match(markup, /without renaming it/i);
    assert.match(markup, /<code[^>]*>NDA-2026-001-beta-ltd\.pdf<\/code>/);
    assert.match(markup, /<a [^>]*href="\/documents\/9\/pdf"[^>]*>Download PDF<\/a>/);
  });

  it("shows the signer form with the owner pre-filled from the profile, the counterparty name from the document, and the signing order", async () => {
    const { markup, calls } = await page();
    assert.equal(calls.owner, 1);
    assert.match(markup, /<form[^>]*aria-label="Send for signature"/);
    assert.match(markup, /<input type="hidden" name="documentId" value="9"\/>/);
    assert.match(markup, /<input[^>]*name="ownerName"[^>]*value="Ana Gómez"/);
    assert.match(markup, /<input[^>]*name="ownerEmail"[^>]*value="ana@acme.test"/);
    assert.match(markup, /<input[^>]*name="counterpartyName"[^>]*value="Beta Ltd"/);
    assert.match(markup, /<input[^>]*name="counterpartyEmail"/);
    assert.match(markup, /<select[^>]*name="order"[^>]*>\s*<option value="random" selected="">/);
    assert.match(markup, /<option value="preserved"/);
    assert.match(markup, /<button[^>]*type="submit"[^>]*>Send for signature<\/button>/);
    assert.match(markup, /sends no email/i);
  });

  it("falls back to empty owner fields when the profile cannot be read", async (t) => {
    t.mock.method(console, "error", () => {});
    const { markup } = await page({ owner: async () => Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" })) });
    assert.match(markup, /<form[^>]*aria-label="Send for signature"/);
    assert.doesNotMatch(markup, /name="ownerName"[^>]*value="Ana/);
  });

  it("says signing is not configured and names the variables, instead of the form, and does not load the profile", async () => {
    const { markup, calls } = await page({ configured: false });
    assert.match(markup, /Signing is not configured/);
    assert.match(markup, /DocuSeal address/);
    assert.match(markup, /API token/);
    assert.doesNotMatch(markup, /aria-label="Send for signature"/);
    assert.equal(calls.owner, 0);
    assert.match(markup, /Download PDF/, "the rest of the page still works");
  });

  it("says the document is not ready for signature, with the reason, instead of the form", async () => {
    const { markup, calls } = await page({ document: detail({ signature: { ready: false, reason: "The layout has 3 signature boxes; signing needs exactly four." } }) });
    assert.match(markup, /Not ready for signature/);
    assert.match(markup, /3 signature boxes/);
    assert.doesNotMatch(markup, /<form[^>]*aria-label="Send for signature"/);
    assert.equal(calls.owner, 0);
  });

  it("escapes the file name", async () => {
    const { markup } = await page({ document: detail({ pdfName: "<img src=x>.pdf" }) });
    assert.doesNotMatch(markup, /<img/);
  });
});

describe("document page: an unfinished send", () => {
  const unfinished = (extra: Partial<DocumentDetail> = {}) => detail({ sendStartedAt: new Date("2026-10-11T10:30:00Z"), ...extra });

  it("says the send did not finish, when it started, and what to check in DocuSeal: the template name", async () => {
    const { markup } = await page({ document: unfinished() });
    assert.match(markup, /A send did not finish/);
    assert.match(markup, /2026-10-11 10:30/);
    assert.match(markup, /<code[^>]*>NDA-2026-001-beta-ltd<\/code>/, "the template name to look for in DocuSeal");
    assert.match(markup, /second signature request|sending again could create/i);
    assert.match(markup, /may still be running/i);
  });

  it("replaces the send form with an explicit, separate clear action that does not send", async () => {
    const { markup, calls } = await page({ document: unfinished() });
    assert.doesNotMatch(markup, /aria-label="Send for signature"/);
    assert.doesNotMatch(markup, /name="ownerName"/);
    assert.equal(calls.owner, 0, "the owner details are not loaded for a form that is not shown");
    assert.match(markup, /<form[^>]*aria-label="Clear unfinished send"/);
    assert.match(markup, /<input type="hidden" name="documentId" value="9"\/>/);
    assert.match(markup, />Clear unfinished send<\/button>/);
    assert.doesNotMatch(markup, />Send for signature<\/button>/);
  });

  it("is shown even when signing is not configured or the layout is not ready, because the mark is about DocuSeal's state", async () => {
    assert.match((await page({ document: unfinished(), configured: false })).markup, /A send did not finish/);
    assert.match((await page({ document: unfinished({ signature: { ready: false, reason: "The layout has 3 signature boxes." } }) })).markup, /A send did not finish/);
  });

  it("is not shown for a document that was recorded as sent, or has no mark", async () => {
    assert.doesNotMatch((await page({ document: detail() })).markup, /A send did not finish/);
    assert.doesNotMatch((await page({ document: unfinished({ status: "sent", hasSubmission: true, signers: SIGNERS }) })).markup, /A send did not finish/);
  });

  it("confirms a cleared mark after the redirect and offers the send form again", async () => {
    const { markup } = await page({ document: detail(), sent: "cleared" });
    assert.match(markup, /Unfinished send cleared/);
    assert.match(markup, /aria-label="Send for signature"/);
    assert.doesNotMatch((await page({ document: detail(), sent: "<b>" })).markup, /Unfinished send cleared/);
  });
});

describe("ClearSendForm", () => {
  const render = (state: { message?: string }) => renderToStaticMarkup(createElement(ClearSendForm, { endpoint: "/documents/test", initial: state, documentId: 9 }));

  it("has a hidden document id and one button, and shows an error as an alert", () => {
    const markup = render({});
    assert.match(markup, /<input type="hidden" name="documentId" value="9"\/>/);
    assert.match(markup, />Clear unfinished send<\/button>/);
    assert.match(render({ message: "Nothing to clear." }), /role="alert"[\s\S]*Nothing to clear\./);
  });
});

describe("document page: a sent document", () => {
  const sent = (extra: Partial<DocumentDetail> = {}) => detail({ status: "sent", hasSubmission: true, signers: SIGNERS, ...extra });

  it("lists each signer with their status and time, a plain link that opens in a new tab, and a readable copy of the URL", async () => {
    const { markup, calls } = await page({ document: sent() });
    assert.equal(calls.owner, 0);
    assert.match(markup, /<span class="badge badge-warning">Sent<\/span>/);
    for (const text of ["Acme", "Beta Ltd", "ana@acme.test", "ben@beta.test", "Signed", "2026-10-12 10:00", "Opened", "2026-10-12 09:30"]) assert.ok(markup.includes(text), text);
    assert.match(markup, /<a [^>]*href="https:\/\/sign\.example\.test\/s\/AAA-link"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>/);
    assert.match(markup, /<code[^>]*>https:\/\/sign\.example\.test\/s\/AAA-link<\/code>/);
    assert.match(markup, /href="http:\/\/192\.0\.2\.10:3000\/s\/BBB-link"/);
    assert.doesNotMatch(markup, /aria-label="Send for signature"/);
  });

  it("offers the refresh button and says the platform sent no email", async () => {
    const { markup } = await page({ document: sent() });
    assert.match(markup, /<form[^>]*aria-label="Refresh status"/);
    assert.match(markup, /<input type="hidden" name="documentId" value="9"\/>/);
    assert.match(markup, />Refresh status<\/button>/);
    assert.match(markup, /anyone with a link can sign/i);
  });

  it("confirms a send after the redirect, and says when the document was already sent", async () => {
    assert.match((await page({ document: sent(), sent: "1" })).markup, /Sent for signature\.[\s\S]*no email/i);
    assert.match((await page({ document: sent(), sent: "already" })).markup, /already sent/i);
    assert.doesNotMatch((await page({ document: sent() })).markup, /Sent for signature\./);
    assert.doesNotMatch((await page({ document: sent(), sent: "<b>" })).markup, /Sent for signature\.|already sent/i);
  });

  it("keeps the links but not the refresh button when signing is not configured", async () => {
    const { markup } = await page({ document: sent(), configured: false });
    assert.match(markup, /Signing is not configured/);
    assert.match(markup, /AAA-link/);
    assert.doesNotMatch(markup, /aria-label="Refresh status"/);
  });

  it("shows a signer without a refreshed status as waiting", async () => {
    const { markup } = await page({ document: sent({ signers: [{ role: "Acme", name: "Ana", email: "ana@acme.test", link: "https://sign.example.test/s/x" }] }) });
    assert.match(markup, /Not refreshed yet/);
  });

  it("never renders names as markup or a link that is not http or https as a link", async () => {
    const { markup } = await page({ document: sent({ signers: [{ ...SIGNERS[0]!, link: "javascript:alert(1)" }, SIGNERS[0]!] }) });
    assert.doesNotMatch(markup, /<b>Gómez/);
    assert.match(markup, /Ana &lt;b&gt;Gómez&lt;\/b&gt;/);
    assert.doesNotMatch(markup, /href="javascript:/);
  });
});

describe("document page: a signed or closed document", () => {
  it("offers the signed PDF for a completed document, with the completion time, and no refresh", async () => {
    const { markup } = await page({ document: detail({ status: "completed", hasSubmission: true, signers: SIGNERS, completedAt: new Date("2026-10-12T11:00:00Z") }) });
    assert.match(markup, /<span class="badge badge-success">Completed<\/span>/);
    assert.match(markup, /<a [^>]*href="\/documents\/9\/signed-pdf"[^>]*>Download signed PDF<\/a>/);
    assert.match(markup, /Completed \(UTC\)/);
    assert.match(markup, /2026-10-12 11:00/);
    assert.match(markup, /AAA-link/);
    assert.doesNotMatch(markup, /aria-label="Refresh status"/);
  });

  it("keeps the confirmation of the refresh that moved the document out of sent visible, whichever status it reached", async () => {
    for (const status of ["completed", "declined", "expired"]) {
      const { markup } = await page({ document: detail({ status, hasSubmission: true, signers: SIGNERS }), refreshed: status });
      assert.match(markup, new RegExp(`class="notice notice-success"[\\s\\S]*Status updated: the document is ${status}\\.`), status);
    }
  });

  it("shows no refresh confirmation for a value that is not a status the refresh can reach, or without the parameter", async () => {
    for (const refreshed of [undefined, "sent", "<b>", "draft", "completed<script>", ""]) {
      const { markup } = await page({ document: detail({ status: "completed", hasSubmission: true, signers: SIGNERS }), refreshed });
      assert.doesNotMatch(markup, /Status updated/, String(refreshed));
    }
  });

  it("shows the signers of a declined or expired document without a refresh or a signed PDF", async () => {
    for (const status of ["declined", "expired"]) {
      const { markup } = await page({ document: detail({ status, hasSubmission: true, signers: SIGNERS }) });
      assert.match(markup, /AAA-link/, status);
      assert.doesNotMatch(markup, /aria-label="Refresh status"|signed-pdf/, status);
    }
  });

  it("shows nothing about signing for a draft", async () => {
    const { markup } = await page({ document: detail({ status: "draft" }) });
    assert.doesNotMatch(markup, /Send for signature|Signing is not configured/);
  });
});

describe("SignatureForm", () => {
  const render = (state: { values?: Record<string, string>; errors?: Record<string, string>; message?: string }) =>
    renderToStaticMarkup(createElement(SignatureForm, { endpoint: "/documents/test", initial: { values: {}, errors: {}, ...state }, documentId: 9 }));

  it("keeps the entered values, escaped, and selects the chosen order", () => {
    const markup = render({ values: { ownerName: `A "q" <b>`, counterpartyEmail: "</textarea><script>1</script>", order: "preserved" } });
    assert.match(markup, /value="A &quot;q&quot; &lt;b&gt;"/);
    assert.doesNotMatch(markup, /<script>1<\/script>/);
    assert.match(markup, /<option value="preserved" selected="">/);
  });

  it("shows each error next to its field, marks it invalid, and announces it", () => {
    const markup = render({ errors: { counterpartyEmail: "Enter an email address like name@example.com.", order: "Choose how the signers sign." } });
    assert.match(markup, /<p id="f-counterpartyEmail-error" class="field-error">Enter an email address/);
    assert.match(markup, /<input[^>]*aria-invalid="true"[^>]*name="counterpartyEmail"/);
    assert.match(markup, /<select[^>]*name="order"[^>]*aria-invalid="true"/);
    assert.doesNotMatch(markup, /<input[^>]*aria-invalid="true"[^>]*name="ownerEmail"/);
    assert.match(markup, /role="alert"[^>]*>\s*<strong>Check the highlighted fields\./);
  });

  it("shows a form-level message as an alert", () => {
    assert.match(render({ message: "The PDF NDA-1.pdf is not in DocuSeal yet." }), /role="alert"[\s\S]*is not in DocuSeal yet\./);
  });
});

describe("RefreshForm", () => {
  const render = (state: { message?: string; done?: string; note?: string }) => renderToStaticMarkup(createElement(RefreshForm, { endpoint: "/documents/test", initial: state, documentId: 9 }));

  it("shows an error as an alert, a confirmation as ok, and the note about an unknown status as a warning", () => {
    assert.match(render({ message: "DocuSeal refused the API token." }), /role="alert"[\s\S]*refused the API token/);
    assert.match(render({ done: "Still waiting for signatures." }), /class="notice notice-success"[\s\S]*Still waiting/);
    const note = render({ note: 'DocuSeal reported the status "archived".' });
    assert.match(note, /class="notice"[\s\S]*archived/);
    assert.doesNotMatch(note, /role="alert"/);
  });
});
