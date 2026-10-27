import { hashKey, newClientKey } from "../src/server/clients.js";
import { run } from "./run.js";

// `pnpm client-key <name>`: makes a new client key. The key is printed once,
// for the client; only its hash goes into DISPATCH_CLIENT_KEYS.
run(() => {
  const name = process.argv[2];
  if (!name || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
    return Promise.reject(new Error("Usage: pnpm client-key <name>   (lowercase a-z, 0-9, - or _, e.g. acme)"));
  }
  const key = newClientKey();
  console.log(`Key for ${name}. Give it to the client; it isn't stored anywhere:\n\n  ${key}\n`);
  console.log(`Add this to DISPATCH_CLIENT_KEYS in .env (comma-separate several clients):\n\n  ${name}:${hashKey(key)}\n`);
  return Promise.resolve();
});
