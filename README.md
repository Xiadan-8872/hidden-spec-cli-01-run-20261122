# mend — one patch tool for every AI edit format

`mend` is a command-line tool that applies AI-written edits in four formats to a tree of text files, to the specification in `SPEC.md`: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

[![bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Xiadan-8872/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Xiadan-8872/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file; when absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Matching runs at three tiers: exact lines, then lines equal once trailing spaces and tabs are removed, then lines equal once leading and trailing spaces and tabs are removed (with new lines re-indented to the file's own indentation). A unified hunk takes the occurrence nearest its stated line; a SEARCH/REPLACE block requires exactly one occurrence; a V4A chunk works from a cursor and an anchor. All edits apply atomically: a failed edit changes nothing, and when any edit fails no file is written.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, kept as shipped.
- `check.ts` — runs the practice set on this machine.
- `SPEC.md` — the full specification.
