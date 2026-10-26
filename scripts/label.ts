import { emitKeypressEvents, createInterface } from "node:readline";
import { paths, rel } from "../src/paths.js";
import { readLabels, readTickets, writeLabels } from "../src/golden/files.js";
import { writeGolden } from "../src/golden/golden.js";
import {
  PRIORITY_KEYS,
  currentId,
  goBack,
  progress,
  setNote,
  setPriority,
  startLabelling,
  type LabellerState,
} from "../src/golden/labeller.js";
import type { Ticket } from "../src/golden/schema.js";
import { run } from "./run.js";

type Key = { name?: string; ctrl?: boolean; sequence?: string };

function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    process.stdin.once("keypress", (_str: string | undefined, key: Key | undefined) => {
      resolve(key ?? {});
    });
  });
}

async function askNote(): Promise<string> {
  process.stdin.setRawMode(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const note = await new Promise<string>((resolve) => {
    rl.question("Note (one line, Enter to save): ", resolve);
  });
  rl.close();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return note;
}

function render(state: LabellerState, byId: ReadonlyMap<string, Ticket>): void {
  const id = currentId(state);
  const ticket = byId.get(id);
  const { labelled, total, left } = progress(state);
  const label = state.labels[id];
  console.clear();
  console.log(`Labelled ${String(labelled)} of ${String(total)} · ${String(left)} left · ticket ${String(state.index + 1)}/${String(total)} · ${id}`);
  console.log("─".repeat(72));
  console.log(`Category: ${ticket?.category ?? "?"}\n`);
  console.log(ticket?.text ?? "");
  console.log("─".repeat(72));
  if (label) console.log(`Current priority: ${label.priority}${label.note ? ` · note: ${label.note}` : ""}`);
  if (state.draftNote) console.log(`Note (unsaved until you pick a priority): ${state.draftNote}`);
  if (state.message) console.log(state.message);
  console.log(`\n1 low · 2 medium · 3 high · n note · b back · q save and quit   (rules: ${rel(paths.labellingGuide)})`);
}

async function finish(): Promise<void> {
  const { header, written } = await writeGolden();
  console.log(
    `All tickets labelled. ${rel(paths.golden)} ${written ? "written" : "unchanged"}: ` +
      `${header.dataset_version}, ${String(header.rows)} rows, sha256 ${header.sha256.slice(0, 12)}.\n` +
      "Next: `pnpm golden:stats`.",
  );
}

run(async () => {
  const tickets = await readTickets();
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const saved = await readLabels();
  const unknown = Object.keys(saved).filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`${rel(paths.labels)} has labels for tickets that aren't in ${rel(paths.tickets)}: ${unknown.join(", ")}`);
  }

  let state = startLabelling(tickets.map((t) => t.id), saved);
  if (state.done) return finish();

  if (!process.stdin.isTTY) throw new Error("`pnpm label` needs an interactive terminal.");
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    for (;;) {
      render(state, byId);
      const key = await readKey();
      const name = key.name ?? key.sequence ?? "";
      if (name === "q" || (key.ctrl === true && name === "c")) break;
      const priority = PRIORITY_KEYS[name];
      if (priority) state = setPriority(state, priority);
      else if (name === "n") state = setNote(state, await askNote());
      else if (name === "b") state = goBack(state);
      else continue;
      // Saved after every change, so closing the terminal loses nothing.
      await writeLabels(state.labels);
      if (state.done) break;
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  await writeLabels(state.labels);
  console.clear();
  if (state.done) return finish();
  const { labelled, left } = progress(state);
  console.log(`Saved ${String(labelled)} labels to ${rel(paths.labels)}. ${String(left)} left; run \`pnpm label\` to continue.`);
});
