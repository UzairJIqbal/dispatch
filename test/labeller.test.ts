import { describe, expect, it } from "vitest";
import { currentId, goBack, progress, setNote, setPriority, startLabelling } from "../src/golden/labeller.js";

const ids = ["a", "b", "c", "d", "e", "f", "g"];

describe("labeller", () => {
  it("resumes at the first ticket without a priority", () => {
    let s = startLabelling(ids, {});
    for (let i = 0; i < 5; i++) s = setPriority(s, "low");
    // Quit and start again with what was saved.
    const resumed = startLabelling(ids, s.labels);
    expect(currentId(resumed)).toBe("f");
    expect(progress(resumed)).toEqual({ labelled: 5, total: 7, left: 2 });
  });

  it("goes back and relabels, then moves on to the next unlabelled", () => {
    let s = startLabelling(ids, {});
    s = setPriority(s, "low");
    s = setPriority(s, "medium");
    s = goBack(s);
    expect(currentId(s)).toBe("b");
    s = setPriority(s, "high");
    expect(s.labels.b?.priority).toBe("high");
    expect(currentId(s)).toBe("c");
  });

  it("keeps a note typed before the priority and saves it with it", () => {
    let s = startLabelling(ids, {});
    s = setNote(s, "  between medium and high  ");
    expect(s.labels.a).toBeUndefined();
    s = setPriority(s, "high");
    expect(s.labels.a).toEqual({ priority: "high", note: "between medium and high" });
  });

  it("adds a note to an already labelled ticket", () => {
    let s = startLabelling(ids, { a: { priority: "low" } });
    s = goBack(setPriority(s, "low"));
    s = setNote(s, "checked again");
    expect(s.labels.b).toEqual({ priority: "low", note: "checked again" });
  });

  it("fills earlier gaps, then finishes", () => {
    let s = startLabelling(["a", "b", "c"], { b: { priority: "low" } });
    s = setPriority(s, "low");
    expect(currentId(s)).toBe("c");
    s = setPriority(s, "low");
    expect(s.done).toBe(true);
    expect(startLabelling(["a", "b", "c"], s.labels).done).toBe(true);
  });

  it("doesn't go back past the first ticket", () => {
    const s = goBack(startLabelling(ids, {}));
    expect(currentId(s)).toBe("a");
  });
});
