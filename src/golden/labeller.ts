import type { Labels, Priority } from "./schema.js";

// The labelling session as plain state and pure steps, so it can be tested
// without a terminal. scripts/label.ts only draws it and reads keys.
export type LabellerState = {
  readonly ids: readonly string[];
  readonly index: number;
  readonly labels: Labels;
  /** A note typed before the ticket has a priority; saved with the priority. */
  readonly draftNote: string | null;
  readonly message: string | null;
  readonly done: boolean;
};

export const PRIORITY_KEYS: Readonly<Record<string, Priority>> = { "1": "low", "2": "medium", "3": "high" };

function firstUnlabelled(ids: readonly string[], labels: Labels, from = 0): number {
  for (let i = from; i < ids.length; i++) if (!((ids[i] ?? "") in labels)) return i;
  return -1;
}

/** Resumes at the first ticket without a priority. */
export function startLabelling(ids: readonly string[], labels: Labels): LabellerState {
  const index = firstUnlabelled(ids, labels);
  return { ids, index: Math.max(index, 0), labels, draftNote: null, message: null, done: index === -1 };
}

export function currentId(state: LabellerState): string {
  const id = state.ids[state.index];
  if (id === undefined) throw new Error("No ticket at the current position.");
  return id;
}

export function progress(state: LabellerState): { labelled: number; total: number; left: number } {
  const labelled = state.ids.filter((id) => id in state.labels).length;
  return { labelled, total: state.ids.length, left: state.ids.length - labelled };
}

export function setPriority(state: LabellerState, priority: Priority): LabellerState {
  const id = currentId(state);
  const note = state.draftNote ?? state.labels[id]?.note;
  const labels: Labels = { ...state.labels, [id]: note ? { priority, note } : { priority } };
  // Next unlabelled after this one; then any earlier gap; then finished.
  let next = firstUnlabelled(state.ids, labels, state.index + 1);
  if (next === -1) next = firstUnlabelled(state.ids, labels);
  return {
    ...state,
    labels,
    index: next === -1 ? state.index : next,
    draftNote: null,
    message: null,
    done: next === -1,
  };
}

export function setNote(state: LabellerState, note: string): LabellerState {
  const trimmed = note.trim();
  if (trimmed === "") return { ...state, message: "Empty note, nothing saved." };
  const id = currentId(state);
  const label = state.labels[id];
  if (label) {
    return { ...state, labels: { ...state.labels, [id]: { ...label, note: trimmed } }, message: "Note saved." };
  }
  return { ...state, draftNote: trimmed, message: "Note kept; it's saved when you pick a priority." };
}

export function goBack(state: LabellerState): LabellerState {
  if (state.index === 0) return { ...state, message: "Already at the first ticket." };
  return {
    ...state,
    index: state.index - 1,
    draftNote: null,
    message: state.draftNote ? "Went back; the unsaved note on that ticket was dropped." : null,
  };
}
