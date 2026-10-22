# Phase 1 — The golden set

## Goal

You have about 270 support tickets with the correct category and priority written down by you, split into dev and test by a fixed rule, versioned, and committed.

## Where this starts

An empty repository with `AGENTS.md` and `docs/`, Node 22 or newer, pnpm, a TypeScript project with Vitest and tsx set up. No API keys are needed in this phase. Nothing else exists yet.

## Build

- **The labelling guide**, committed as `evals/LABELLING.md`, copied from the priority rules in the project specs. Written before any labelling.
- **An import command** that downloads the Bitext customer-support dataset from Hugging Face and samples about 240 tickets with a fixed seed, roughly the same number per category. It keeps the ticket text and Bitext's category, and gives each ticket a stable id.
- **Check the category list.** Use the categories the dataset actually has, lowercase, and write them in one place that the schema, the prompt and the grader will all read.
- **About 30 messy tickets written by you** in a separate file: typos, Roman Urdu mixed with English, two problems in one message, very angry, very long. Each with its category. They're merged into the golden set by the same command.
- **`pnpm label`**: shows one unlabelled ticket at a time with its category, and takes `1` (low), `2` (medium) or `3` (high), `n` to add a one-line note, `b` to go back, `q` to save and quit. It resumes where you stopped. A progress line shows how many are left.
- **The split**: a hash of each ticket's id puts it in dev (~75%) or test (~25%). The same id always lands on the same side.
- **`evals/golden.jsonl`** with the dataset version (`v1`) and a hash of its contents, and `evals/CHANGELOG.md` with its first line. Loading the set checks the hash.
- **`pnpm golden:stats`**: prints counts per category, per priority and per split, so you can see the set is balanced.

## Constraints

- **Every value read from the dataset or the file is validated with Zod.** A bad row stops the import with the row number.
- **The split is decided by the rule, never by hand.** No moving a ticket to the other side.
- **Priority is labelled by you, not by a model.** A model-labelled answer key would just measure how much the model agrees with itself.
- The messy tickets are written from the labelling guide, not from anything a model got wrong.
- The import is repeatable: run it twice with the same seed and the same tickets come out.

## Acceptance check

1. Run the import twice. The two outputs are identical.
2. Run `pnpm label`, label five tickets, quit, run it again. It continues from ticket six.
3. Finish labelling. `pnpm golden:stats` shows every category in both splits, all three priorities in both splits, and about 75/25 dev/test.
4. Open `evals/golden.jsonl`. Every row has an id, text, category, priority, split and (where you wrote one) a note. The file says `v1`.
5. Edit one ticket's text by hand and run any command that loads the set. It refuses because the content changed without a version bump.

## Not in this phase

Any model call, prompts, grading, the service. Making the set bigger.

## When you're done

Give me a 2 to 3 line summary of what was built in this phase.
