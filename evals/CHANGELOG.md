# Golden set changelog

Any change to `evals/golden.jsonl` bumps the dataset version and adds a line here saying why.

- **v1** (2026-10-23): first set. 242 Bitext tickets (22 per category, seed 1) plus 30 hand-written messy tickets; priority labelled by hand with `pnpm label`.
- **v2** (2026-10-27): same 272 tickets and categories; every priority labelled again from `LABELLING.md`, without looking at any model output: 31 by hand, the other 241 by Claude (Opus 5.5) following the same guide, with a note on each tie-break; then 16 of the hand labels that broke the guide were brought in line with it, at the owner's request. The v1 priorities were typed in at random while trying out `pnpm label`, so they measured nothing (Gemini scored 35% on them, chance is ~33%). Kept for the record in `evals/labels-v1-random.json`; nothing reads it.
