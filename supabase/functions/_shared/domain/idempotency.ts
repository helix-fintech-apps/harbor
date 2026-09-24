// Idempotency for mutating endpoints. Same key + same request => first stored response.
// Same key + different request body => conflict (422), never a second execution.

export interface IdemRecord { key: string; requestHash: string; status: number; body: unknown }

export interface IdemStore {
  get(key: string): Promise<IdemRecord | undefined>;
  put(rec: IdemRecord): Promise<void>;
}

export class IdempotencyConflict extends Error {
  constructor(key: string) { super(`idempotency key ${key} reused with a different request`); }
}

export function stableHash(v: unknown): string {
  const s = JSON.stringify(sortKeys(v));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0") + ":" + s.length;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export async function withIdempotency<T>(store: IdemStore, key: string | undefined, request: unknown, fn: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!key) {
    const r = await fn();
    return { ...r, replayed: false };
  }
  const requestHash = stableHash(request);
  const prev = await store.get(key);
  if (prev) {
    if (prev.requestHash !== requestHash) throw new IdempotencyConflict(key);
    return { status: prev.status, body: prev.body as T, replayed: true };
  }
  const r = await fn();
  if (r.status < 500) await store.put({ key, requestHash, status: r.status, body: r.body });
  return { ...r, replayed: false };
}

export class MemoryIdemStore implements IdemStore {
  private m = new Map<string, IdemRecord>();
  async get(key: string) { return this.m.get(key); }
  async put(rec: IdemRecord) { this.m.set(rec.key, rec); }
}
