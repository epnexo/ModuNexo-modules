/**
 * Simulating a network that never answers. `AbortSignal.timeout` (which the DocuSeal client uses) does not keep node's
 * event loop alive, so a stub that only waits for the abort leaves the loop empty and node's test runner cancels the
 * test as "pending" (and, depending on what else is running, its neighbours). These helpers hold a live timer until
 * the request is aborted.
 */
export function keepAlive(): () => void {
  const timer = setInterval(() => {}, 20);
  return () => clearInterval(timer);
}

/** A fetch answer that never comes: it settles only when the request is aborted. */
export function hangUntilAbort(init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const stop = keepAlive();
    init.signal?.addEventListener("abort", () => {
      stop();
      reject(init.signal?.reason);
    });
  });
}

/** A response whose body never ends: it errors only when the request is aborted. */
export function stallBodyUntilAbort(init: RequestInit, status = 200): Response {
  const body = new ReadableStream({
    start(controller) {
      const stop = keepAlive();
      init.signal?.addEventListener("abort", () => {
        stop();
        controller.error(init.signal?.reason);
      });
    },
  });
  return new Response(body, { status });
}
