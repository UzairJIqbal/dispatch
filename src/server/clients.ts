import { createHash, randomBytes } from "node:crypto";

// Client keys. The environment holds only `name:sha256(key)` pairs, so a
// leaked env file or log can't be replayed as a key. The name is what logs
// (and later metrics and traces) show; the key itself is never written down.

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Hash → client name. */
export type ClientKeys = ReadonlyMap<string, string>;

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function newClientKey(): string {
  return `dsp_${randomBytes(32).toString("base64url")}`;
}

/** Parses `name:hash,name:hash`. Throws with what's wrong, never echoing a hash back. */
export function parseClientKeys(value: string): ClientKeys {
  const keys = new Map<string, string>();
  const names = new Set<string>();
  const entries = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (entries.length === 0) throw new Error("no clients listed.");
  for (const [i, entry] of entries.entries()) {
    const [name = "", hash = "", ...rest] = entry.split(":");
    const where = `entry ${String(i + 1)}`;
    if (rest.length > 0 || !NAME.test(name)) {
      throw new Error(`${where} should be name:hash with a lowercase name (a-z, 0-9, - or _, up to 32 characters).`);
    }
    if (!HASH.test(hash.toLowerCase())) throw new Error(`${where} (${name}): the hash must be 64 hex characters (a SHA-256 of the key).`);
    if (names.has(name)) throw new Error(`client ${name} is listed twice.`);
    if (keys.has(hash.toLowerCase())) throw new Error(`client ${name} has the same key as ${keys.get(hash.toLowerCase()) ?? "another client"}.`);
    names.add(name);
    keys.set(hash.toLowerCase(), name);
  }
  return keys;
}

/**
 * The client a key belongs to, or undefined. Looking up the key's hash, not
 * the key, means timing can at most leak a prefix of a hash, which doesn't
 * help anyone find a key.
 */
export function clientForKey(clients: ClientKeys, key: string): string | undefined {
  return clients.get(hashKey(key));
}
