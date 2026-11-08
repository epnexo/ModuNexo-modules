/**
 * What a form in the browser runs when it is submitted: it posts the fields to the module's route and hands the
 * answer back as the next state of the form, so errors show without leaving the page. A redirect or a reload that
 * the route asks for is done here. Runs in the browser only.
 */
export type FormAction<S> = (previous: S, formData: FormData) => Promise<S>;

/** Only a path on this site: never an address that another site could use to take the person away. */
export function safeTarget(target: unknown): string | null {
  return typeof target === "string" && target.startsWith("/") && !target.startsWith("//") && !target.includes("\\") ? target : null;
}

export function postAction<S extends object>(url: string): FormAction<S> {
  return async (previous, formData) => {
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", body: formData, credentials: "same-origin" });
    } catch {
      return { ...previous, message: "The server could not be reached. Check your connection and try again." };
    }
    let body: { state?: S; redirectTo?: unknown; reload?: boolean; error?: unknown } = {};
    try {
      body = await response.json();
    } catch {
      // not JSON: handled below by the status
    }
    const target = safeTarget(body.redirectTo);
    if (target !== null) {
      window.location.assign(target);
      return previous;
    }
    if (response.status === 403) return { ...previous, message: "Your session cannot do this. Sign in again or ask for the permission." };
    if (!response.ok) return { ...previous, message: typeof body.error === "string" ? body.error : `The request failed (${response.status}).` };
    if (body.reload === true) window.location.reload();
    return body.state ?? previous;
  };
}
