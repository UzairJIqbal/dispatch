import { describe, expect, it } from "vitest";
import { Tally, keysNeeded, parseTrafficArgs, parseTrafficKeys, pickTicket } from "../src/traffic/traffic.js";

const KEY = "dsp_a";

describe("pnpm traffic arguments", () => {
  it("defaults to 1 RPS, until Ctrl-C, on the mock, at the compose port", () => {
    expect(parseTrafficArgs([], {})).toEqual({ rate: 1, duration: undefined, url: "http://localhost:3000", mix: "all", real: false });
    expect(parseTrafficArgs([], { DISPATCH_HOST_PORT: "3100" }).url).toBe("http://localhost:3100");
  });

  it("reads the flags", () => {
    expect(parseTrafficArgs(["--rate", "2.5", "--duration", "300", "--url", "https://x.example/", "--mix", "messy", "--real"], {})).toEqual({
      rate: 2.5,
      duration: 300,
      url: "https://x.example",
      mix: "messy",
      real: true,
    });
  });

  it("rejects what it can't use, with the usage line", () => {
    expect(() => parseTrafficArgs(["--rate", "0"], {})).toThrow(/Usage: pnpm traffic/);
    expect(() => parseTrafficArgs(["--rate", "50"], {})).toThrow(/at most 20/);
    expect(() => parseTrafficArgs(["--rate", "fast"], {})).toThrow(/Usage/);
    expect(() => parseTrafficArgs(["--nope"], {})).toThrow(/Usage/);
  });
});

describe("DISPATCH_TRAFFIC_KEYS", () => {
  it("one key per 45 requests a minute", () => {
    expect(keysNeeded(0.5)).toBe(1);
    expect(keysNeeded(1)).toBe(2);
    expect(keysNeeded(5)).toBe(7);
  });

  it("says where to get keys when they're missing or too few", () => {
    expect(() => parseTrafficKeys(undefined, 1)).toThrow(/DISPATCH_TRAFFIC_KEYS is not set.*pnpm client-key/);
    expect(() => parseTrafficKeys(KEY, 1)).toThrow(/needs 2 keys/);
    expect(() => parseTrafficKeys("traffic:abc123", 0.5)).toThrow(/raw keys/);
    expect(parseTrafficKeys(` ${KEY}, dsp_b ,`, 1)).toEqual([KEY, "dsp_b"]);
  });
});

it("the tally lists outcomes, most common first", () => {
  const t = new Tally();
  for (const o of ["200", "503 provider_5xx", "200", "200 fallback"]) t.add(o);
  expect(t.toString()).toBe("n=4  200: 2  503 provider_5xx: 1  200 fallback: 1");
});

describe("pnpm traffic --mix", () => {
  const rows = [...Array.from({ length: 18 }, () => ({ source: "bitext" })), { source: "messy" }, { source: "messy" }];
  const share = (mix: "all" | "messy") => {
    let messy = 0;
    for (let i = 0; i < 4000; i++) if (pickTicket(rows, mix)?.source === "messy") messy++;
    return messy / 4000;
  };
  it("sends tickets as they come by default, and half messy with --mix messy", () => {
    expect(share("all")).toBeLessThan(0.15);
    expect(share("messy")).toBeGreaterThan(0.45);
    expect(share("messy")).toBeLessThan(0.55);
  });
  it("refuses an unknown mix", () => {
    expect(() => parseTrafficArgs(["--mix", "rude"], {})).toThrow(/Usage/);
  });
});
