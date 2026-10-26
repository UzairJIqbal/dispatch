# Dispatch

A small AI service that reads a customer-support ticket and returns its category, priority and a one-line summary as JSON, run the way a production team runs an LLM feature. See `docs/project-specs.md`.

## Golden set

```sh
pnpm install
pnpm golden:import   # downloads Bitext (pinned), samples 242 tickets + 30 messy → evals/tickets.jsonl
pnpm label           # label priority one ticket at a time; resumes where you stopped
pnpm golden:stats    # counts per category, priority and split
```

Priority rules: `evals/LABELLING.md`. Dataset versions: `evals/CHANGELOG.md`.
