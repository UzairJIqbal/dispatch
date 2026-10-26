import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../src/categories.js";
import { parseBitextCsv } from "../src/golden/bitext.js";
import { buildGoldenRows, parseGolden, serializeGolden } from "../src/golden/golden.js";
import { sampleBitext, type BitextRow } from "../src/golden/sample.js";
import type { Labels, Ticket } from "../src/golden/schema.js";
import { splitFor } from "../src/golden/split.js";
import { goldenStats } from "../src/golden/stats.js";

const rows: BitextRow[] = CATEGORIES.flatMap((category) =>
  Array.from({ length: 40 }, (_, i) => ({ category, text: `${category} question number ${String(i)}` })),
);

describe("sampleBitext", () => {
  it("gives the same tickets for the same seed", () => {
    expect(sampleBitext(rows, 7, 5)).toEqual(sampleBitext(rows, 7, 5));
  });
  it("gives different tickets for a different seed", () => {
    expect(sampleBitext(rows, 7, 5)).not.toEqual(sampleBitext(rows, 8, 5));
  });
  it("takes the same number from every category", () => {
    const picked = sampleBitext(rows, 1, 5);
    for (const c of CATEGORIES) expect(picked.filter((t) => t.category === c)).toHaveLength(5);
  });
  it("never picks the same text twice", () => {
    const dupes = [...rows, ...rows];
    const picked = sampleBitext(dupes, 1, 40);
    expect(new Set(picked.map((t) => t.id)).size).toBe(picked.length);
  });
  it("stops when a category is too small", () => {
    expect(() => sampleBitext(rows.slice(1), 1, 40)).toThrow(/account/);
  });
});

describe("parseBitextCsv", () => {
  it("lowercases categories and keeps quoted multi-line text", () => {
    const csv = 'flags,instruction,category,intent,response\nB,"line one\nline two",REFUND,get_refund,ok\n';
    expect(parseBitextCsv(csv)).toEqual([{ category: "refund", text: "line one\nline two" }]);
  });
  it("stops on a bad row and names it", () => {
    const csv = "flags,instruction,category,intent,response\nB,fine,ORDER,x,y\nB,bad,WARRANTY,x,y\n";
    expect(() => parseBitextCsv(csv)).toThrow(/row 2/);
  });
});

describe("splitFor", () => {
  it("is decided by the id alone", () => {
    expect(splitFor("bitext-0123456789")).toBe(splitFor("bitext-0123456789"));
  });
  it("puts about 75% in dev", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `id-${String(i)}`);
    const dev = ids.filter((id) => splitFor(id) === "dev").length / ids.length;
    expect(dev).toBeGreaterThan(0.72);
    expect(dev).toBeLessThan(0.78);
  });
});

describe("golden file", () => {
  const tickets: Ticket[] = [
    { id: "bitext-aaaaaaaaaa", source: "bitext", category: "refund", text: "where is my refund" },
    { id: "messy-01", source: "messy", category: "order", text: "order kahan hai" },
  ];
  const labels: Labels = { "bitext-aaaaaaaaaa": { priority: "high" }, "messy-01": { priority: "medium", note: "unsure" } };
  const content = serializeGolden("v1", buildGoldenRows(tickets, labels));

  it("round-trips with version, split and note", () => {
    const { header, rows: loaded } = parseGolden(content);
    expect(header.dataset_version).toBe("v1");
    expect(loaded).toHaveLength(2);
    expect(loaded[1]).toMatchObject({ id: "messy-01", priority: "medium", note: "unsure", split: splitFor("messy-01") });
    expect(loaded[0]).not.toHaveProperty("note");
  });
  it("refuses a hand edit made without a version bump", () => {
    expect(() => parseGolden(content.replace("where is my refund", "where is my refund??"))).toThrow(/still says v1/);
  });
  it("refuses a deleted row", () => {
    const lines = content.trim().split("\n");
    expect(() => parseGolden(lines.slice(0, 2).join("\n"))).toThrow(/still says v1/);
  });
  it("won't build until every ticket has a priority", () => {
    expect(() => buildGoldenRows(tickets, { "messy-01": { priority: "low" } })).toThrow(/1 tickets have no priority/);
  });
});

describe("goldenStats", () => {
  it("counts per split and reports gaps", () => {
    const tickets: Ticket[] = [{ id: "messy-01", source: "messy", category: "order", text: "x" }];
    const stats = goldenStats(buildGoldenRows(tickets, { "messy-01": { priority: "low" } }));
    expect(stats.total).toBe(1);
    expect(stats.byCategory.order).toEqual(splitFor("messy-01") === "dev" ? { dev: 1, test: 0 } : { dev: 0, test: 1 });
    expect(stats.gaps).toContain("refund has no dev tickets");
  });
});
