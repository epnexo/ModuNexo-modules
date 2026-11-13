/**
 * Posts one alert to the configured webhook. It fails with a fixed phrase or the HTTP status, never with the address,
 * the secret or what the receiver answered, so the retry and the Status screen show nothing private. Redirects are
 * refused: the address is the one the administrator typed.
 */
export async function deliver(url: string, secret: string | null, body: unknown, signal: AbortSignal): Promise<void> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error("The alert webhook address is not a valid URL.");
  }
  if (protocol !== "http:" && protocol !== "https:") throw new Error("The alert webhook address must start with http:// or https://.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers.authorization = `Bearer ${secret}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal });
  } catch {
    throw new Error("The alert webhook could not be reached.");
  }
  if (!response.ok) throw new Error(`The alert webhook answered HTTP ${response.status}.`);
}
