# Error analysis: prompt v1 → v2

Read from the **dev split only** (n = 198, golden set v2), on Gemini
`gemini-3.5-flash-lite` with prompt v1:
`results/2026-10-26T20-13-04Z-v1-dev.json`. The test split was not opened.

v1 on dev: both correct 49.5% (98/198) · category 76.3% (151/198) · priority
67.2% (133/198) · dangerous misses 6 · schema-valid 96.0% (190/198).

## Five mistakes

1. **"I am trying to find shipping periods"**: expected `delivery`, got
   `shipping`. Seven dev tickets went delivery → shipping, the most common
   confusion. In this dataset `shipping` means the shipping *address*, and
   `delivery` means delivery options and times. v1 gave only the category
   names, so the model read them in their everyday sense.
2. **"i try to see the withdrawal fees"**: expected `cancel`, got `account`.
   Four like it. `cancel` here means cancellation *fees*, nothing else; the
   model guessed it meant cancelling an account.
3. **"i want help to cancel order {{Order Number}}"**: expected `order`, got
   `cancel`. Four like it, the mirror image of mistake 2: cancelling an order
   is an `order` ticket.
4. **"ohw to contact a person?"**: the answer was a JSON *array* holding the
   right object, so it failed the schema. Seven of the eight schema failures
   were arrays; the eighth used `"medium"` as a key instead of `"priority"`.
5. **"I do not know what I need to do to download invoice #37777"**: expected
   `medium`, got `low`. medium → low was the biggest priority error (25 of 57).
   The model read "how do I…" as a question for information, but the customer
   needs a task done. The opposite also happened: "I want assistance seeing the
   bloody cancellation fee" came back `medium` instead of `low`, raised by the
   swearing, not by the need.

## What v2 changed because of them

- Every category gets a one-line meaning, and the overlapping ones
  (`cancel`/`order`/`subscription`, `delivery`/`shipping`/`order`) say which is
  which. Fixes 1–3. The meanings come from the dataset's own intents, not from
  individual tickets.
- The answer must be exactly one JSON object, never an array, with exactly
  three keys. Fixes 4.
- Priority follows the need, not the tone; "how do I do X" is the task X; cost
  and policy questions are information. Fixes 5. These are the labelling
  guide's rules made explicit, not new ones.

Nothing else changed: same model alias, temperature and `max_tokens`.

## Result

Same model, same dev split (n = 198), golden v2. v2:
`results/2026-10-26T21-08-32Z-v2-dev.json`.

|                     | v1 (baseline)  | v2              |
|---------------------|----------------|-----------------|
| both correct        | 49.5% (98/198) | 70.2% (139/198) |
| category            | 76.3% (151/198)| 95.5% (189/198) |
| priority            | 67.2% (133/198)| 71.7% (142/198) |
| dangerous misses    | 6              | **9**           |
| schema-valid        | 96.0% (190/198)| 99.0% (196/198) |
| bitext, both        | 49.4% (88/178) | 68.5% (122/178) |
| messy, both         | 50.0% (10/20)  | 85.0% (17/20)   |

Latency p50/p95/p99 on v2: 1.13 s / 1.71 s / 2.01 s (n = 198 uncached; the v1
run was fully cached, so it has no latency to compare).

What worked: category confusions fell from 47 to 9 (six delivery → order and
one refund → feedback are left), and no answer was an array any more.

What got worse: dangerous misses went from 6 to 9. Eight of the nine are
`feedback` tickets labelled `high` (a customer filing a complaint or claim)
that v2 called `low`. v2's "tone doesn't raise priority" rule, plus `feedback`
under `low`, pushed real complaints down. The two schema failures left both
used `"medium"` as a key, like v1's eighth.

Not fixed here: changing the prompt again would be v3, from these dev
mistakes, in a later round.
