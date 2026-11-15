"use client";

import { useEffect, useState } from "react";

type Token = { id: number; name: string; prefix: string; scopes: string[]; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null };

/** Creates, lists and revokes the tokens a collector or the forwarder sends its data with. Each one carries only the collectors.write scope. */
export default function CollectorTokens() {
  const [name, setName] = useState("forwarder");
  const [token, setToken] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`/api/settings/modules/observability${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    if (!response.ok) throw new Error("The platform could not complete this token request.");
    return response.json() as Promise<any>;
  };
  const load = async () => { try { const result = await request("/tokens"); setTokens(result.tokens); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not load tokens."); } };
  useEffect(() => { void load(); }, []);
  const create = async () => {
    try {
      const result = await request("/tokens", { method: "POST", body: JSON.stringify({ name: name.trim(), scopes: ["collectors.write"] }) });
      setToken(result.token);
      setTokens((current) => [result.record, ...current]);
      setMessage("Copy the token now. It will not be shown again.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not create the token."); }
  };
  const revoke = async (id: number) => {
    try {
      await request(`/tokens/${id}`, { method: "DELETE" });
      setTokens((current) => current.map((item) => item.id === id ? { ...item, revokedAt: new Date().toISOString() } : item));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not revoke the token."); }
  };
  return (
    <div className="flex flex-col gap-4">
      <section className="card">
        <h2 className="text-lg font-semibold">Create a token</h2>
        <p className="mt-1 text-sm text-muted">Give each sender its own token, with only the collectors.write scope, so one can be revoked without touching the others.</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm font-medium">Name
            <input value={name} onChange={(event) => setName((event.target as unknown as { value: string }).value)} className="rounded-md border border-border bg-background px-3 py-2" />
          </label>
          <button type="button" onClick={create} disabled={name.trim() === ""} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">Create token</button>
        </div>
        {token === null ? null : <div className="mt-3 rounded-md bg-warning-soft p-3 text-sm"><p className="font-medium">Copy this token now</p><code className="mt-2 block break-all select-all">{token}</code></div>}
      </section>
      {message === null ? null : <p role="status" className="rounded-md bg-surface px-3 py-2 text-sm">{message}</p>}
      {tokens.length === 0 ? null : (
        <section className="rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-4 py-3"><h2 className="font-semibold">Issued tokens</h2></div>
          <ul className="divide-y divide-border">
            {tokens.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span><strong>{item.name}</strong><span className="ml-2 text-muted">{item.prefix}… · {item.scopes.join(", ")}{item.lastUsedAt === null ? " · never used" : ` · last used ${item.lastUsedAt.slice(0, 16).replace("T", " ")} UTC`}</span></span>
                {item.revokedAt ? <span className="text-muted">Revoked</span> : <button type="button" onClick={() => revoke(item.id)} className="text-sm underline-offset-4 hover:underline">Revoke</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
