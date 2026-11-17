import { AsyncLocalStorage } from "node:async_hooks";
import { MOCK_MODES, MockModeSchema, type MockMode, type MockSetup } from "../gateway/mock.js";
import type { Release } from "../metrics/metrics.js";

// MOCK_CANARY_MODE breaks the primary mock for canary requests only, so a
// drill can show the auto-rollback catching a bad canary while stable stays
// healthy, with zero real calls. The request's release rides along in
// AsyncLocalStorage, so the gateway doesn't need to know releases exist.

const releaseContext = new AsyncLocalStorage<Release>();

/** Runs one request's triage with its release known to the mock. */
export function withRelease<T>(release: Release, fn: () => Promise<T>): Promise<T> {
  return releaseContext.run(release, fn);
}

export function canaryModeFromEnv(env: NodeJS.ProcessEnv = process.env): MockMode | undefined {
  const raw = env.MOCK_CANARY_MODE;
  if (raw === undefined || raw === "") return undefined;
  const parsed = MockModeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`MOCK_CANARY_MODE is invalid: it must be one of ${MOCK_MODES.join(", ")}. Set it in .env or on the command line.`);
  return parsed.data;
}

/**
 * The mock setup with the primary's mode decided per call: `canaryMode` for
 * a canary request, its own mode otherwise. The mock reads `mode` on every
 * call, so a getter is enough. The fallback mock is left alone.
 */
export function canaryAwareMocks(setup: MockSetup, canaryMode: MockMode | undefined): MockSetup {
  if (!canaryMode) return setup;
  const base = setup.mock;
  return {
    ...setup,
    mock: {
      ...(base.retryAfterS !== undefined ? { retryAfterS: base.retryAfterS } : {}),
      ...(base.delayMs !== undefined ? { delayMs: base.delayMs } : {}),
      get mode() {
        return releaseContext.getStore() === "canary" ? canaryMode : (base.mode ?? "ok");
      },
    },
  };
}
