# Scripts

Offline entry points. Every one runs with `npx tsx`; none takes credentials or calls a model.

| Script              | What it does                                                          | Cost |
| ------------------- | --------------------------------------------------------------------- | ---- |
| `paper-validate.ts` | replays the design corpus through the decision table, all three modes | none |
| `alignment-diff.ts` | compares the shared policy core to the table on ideal labels          | none |
| `reflow-prompt.py`  | reflows the prompt prose literals (whitespace-only, checked)          | none |

Data and shared inputs live beside them: `review-corpus.ts` and `review-corpus-impact.ts` (the 212-case design set, with blind impact records and per-case expectations), `lib/review-labels.ts` (the ideal axis labels), and `lib/ideal-run.ts` (the fixed command-facts context and case list both offline runs share).
