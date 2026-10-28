import { describe, expect, it } from "vitest";
import { checkAnswer, parseSmokeArgs, pick, readyOn } from "../src/smoke/smoke.js";

const answer = (git_sha = "abc1234") => ({
  category: "payment",
  priority: "high",
  summary: "Charged twice for one order.",
  meta: { prompt_version: "v1", model: "m", provider: "mock", fallback: false, git_sha, request_id: "r1", latency_ms: 12 },
});

describe("parseSmokeArgs", () => {
  it("has defaults and trims the trailing slash", () => {
    expect(parseSmokeArgs(["--url", "https://x.onrender.com/"])).toEqual({ url: "https://x.onrender.com", sha: undefined, count: 3, waitS: 600 });
  });
  it("reads every option", () => {
    expect(parseSmokeArgs(["--url", "http://localhost:3000", "--sha", "abc1234", "--count", "0", "--wait", "60"])).toEqual({
      url: "http://localhost:3000",
      sha: "abc1234",
      count: 0,
      waitS: 60,
    });
  });
  it.each([
    [[]],
    [["--url", "ftp://x"]],
    [["--url", "https://x", "--sha", "main"]],
    [["--url", "https://x", "--count", "50"]],
    [["--url", "https://x", "--nope", "1"]],
  ])("refuses %j with the usage line", (argv) => {
    expect(() => parseSmokeArgs(argv)).toThrow(/Usage: pnpm smoke/);
  });
});

describe("readyOn", () => {
  const ready = { status: "ready", git_sha: "abc1234" };
  it("needs 200 and ready", () => {
    expect(readyOn(ready, 200, undefined)).toBe(true);
    expect(readyOn(ready, 503, undefined)).toBe(false);
    expect(readyOn({ ...ready, status: "not_ready" }, 200, undefined)).toBe(false);
  });
  it("matches short and full shas by prefix, and nothing else", () => {
    expect(readyOn(ready, 200, "abc1234")).toBe(true);
    expect(readyOn(ready, 200, "abc1234def5678")).toBe(true);
    expect(readyOn({ ...ready, git_sha: "abc1234def5678" }, 200, "abc1234")).toBe(true);
    // The old instance answering while the new one starts.
    expect(readyOn({ ...ready, git_sha: "0000000" }, 200, "abc1234")).toBe(false);
  });
});

describe("checkAnswer", () => {
  it("accepts a whole answer on the right commit", () => {
    const r = checkAnswer(200, answer(), "abc1234");
    expect(r.ok && r.answer.category).toBe("payment");
  });
  it("names the error class of a failed request", () => {
    expect(checkAnswer(503, { error: { class: "circuit_open", message: "x" } }, undefined)).toEqual({ ok: false, problem: "HTTP 503 circuit_open" });
    expect(checkAnswer(502, "Bad Gateway", undefined)).toEqual({ ok: false, problem: "HTTP 502" });
  });
  it("fails a 200 with the wrong shape", () => {
    expect(checkAnswer(200, { ...answer(), meta: undefined }, undefined).ok).toBe(false);
    expect(checkAnswer(200, { ...answer(), extra: 1 }, undefined).ok).toBe(false);
    expect(checkAnswer(200, { ...answer(), priority: "urgent" }, undefined).ok).toBe(false);
  });
  it("fails an answer from another commit", () => {
    expect(checkAnswer(200, answer("0000000"), "abc1234")).toEqual({ ok: false, problem: "served by 0000000, expected abc1234" });
  });
});

describe("pick", () => {
  it("picks different rows, never more than there are", () => {
    const rows = ["a", "b", "c", "d"];
    const three = pick(rows, 3);
    expect(new Set(three).size).toBe(3);
    expect(pick(rows, 10)).toHaveLength(4);
    expect(pick(rows, 0)).toEqual([]);
    expect(rows).toEqual(["a", "b", "c", "d"]);
  });
  it("is driven by the random source", () => {
    expect(pick(["a", "b", "c"], 2, () => 0)).toEqual(["a", "b"]);
  });
});
