# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small TypeScript CLI that batch-evaluates internship resumes (PDFs) with the Anthropic API and writes a scored CSV. No tests, no linter.

## Commands

```bash
npm install
npm run build     # tsc -> build/
npm run watch     # tsc --watch
npm start         # build, then node build/index.js
npm run jev:analyze   # Jev vs Claude agreement stats from jev-scored.csv -> jev-stats.json
npm run jev -- [--in <DIR_OUTPUT>/processed.csv] [--out jev-scored.csv] [--pdf-dir <DIR_OUTPUT>] [--limit N] [--concurrency 8] [--dry-run]
```

Configuration is via `.env` (see `.env.sample`): `DIR_INPUT` (folder of PDFs, defaults to `input`), `DIR_OUTPUT` (defaults to `output`, created if missing), `ANTHROPIC_API_KEY`, and `TYPESAFE_API_KEY` for the Jev re-scorer.

To debug extraction on a single PDF, uncomment the `checkResume("./test.pdf")` call at the bottom of `index.ts` and comment out `main()`.

## Pipeline (index.ts -> pdf-extract.ts -> anthropic.ts)

1. `index.ts` lists `*.pdf` in `DIR_INPUT` and processes them **sequentially**. Per-file errors are caught and logged; the run continues.
2. `pdf-extract.ts` extracts text with `pdf-parse`. Files whose trimmed text is under 100 chars are skipped (scanned/image PDFs).
3. `anthropic.ts` holds the evaluation `PROMPT` (the scoring rubric: college reputation, degree fit, GPA, projects, bonus) and calls `claude-3-5-sonnet-20240620` at temperature 0. The raw response text is passed straight to `JSON.parse`, so the model must return bare JSON with no markdown fences.
4. `index.ts` appends one row to `<DIR_OUTPUT>/processed.csv` and copies the PDF to `<DIR_OUTPUT>/<FirstLetterOfName>/<Name_with_underscores>_<original>.pdf`.

## Jev re-scorer (jev-rescore.ts)

A second, independent entry point that re-scores an existing `processed.csv` with TypeSafe AI's Jev model and makes no Claude call. Jev is a "System One" model: it answers typed Score/Choice/Noul questions about a `state` and cannot generate text, so it can score but not extract.

For each CSV row it locates the PDF that `index.ts` copied into `<DIR_OUTPUT>/<FirstLetter>/<Name_with_underscores>_<original>.pdf` (the original filename is not in the CSV, so it matches by name prefix and disambiguates with the row's phone number), extracts the text, and sends `{ resume_text, extracted_fields }` as the state. Rows with no readable PDF fall back to the CSV fields alone; the `jev_state_source` column records which. Name, phone, and gender are never sent. GPA points are computed in code because Jev is weak at numeric comparison. Output is the input CSV plus `jev_*` columns, written to a new file. `--in` defaults to `<DIR_OUTPUT>/processed.csv` when it exists, since that copy is the complete one. `--dry-run` prints the state and questions without calling the API. Testing without a key: point `TYPESAFE_BASE_URL` at a local mock server.

## Things to keep in sync

The output schema is defined in three places that must match column-for-column:
- the `ResumeEvaluation` type in `anthropic.ts`
- the JSON shape described in `PROMPT` (note: it currently omits `points.bonus` even though the rubric and the code use it)
- the CSV header string in `main()` and the `resultLine` builder in `processResumes()` in `index.ts`

## Gotchas

- `processed.csv` is **append-only**. Re-running over the same input directory produces duplicate rows; there is no dedup.
- `pdf-extract.js` at the repo root is a stale compiled artifact; the real compiled output lives in `build/` (gitignored). Edit only the `.ts` files.
- `processed.csv` at the repo root contains real candidate data (names, phones) and is untracked. Do not commit it.
- `pdf2json` is listed in dependencies but unused; `pdf-parse` is the extractor in use.
