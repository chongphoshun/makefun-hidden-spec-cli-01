# mend — one patch tool for every AI edit format

`mend` applies the edits AI models write, in four formats, to a tree of files.
It reads them all to one specification (`SPEC.md` in the starter kit), finds the
lines an edit names even when the model's whitespace or indentation drifted, and
changes every file or none at all.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` absent or `-` reads the patch from stdin. The working directory is the
tree root; all patch paths are relative to it.

- `--format` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto`
  (the default, detected from the patch text).
- `--check` does everything but write.
- `--strict` matches exactly only (tier 0).

## Formats

- **Unified diff** — `diff --git` / `---` / `+++` headers, `@@` hunks, creation,
  deletion and rename/move, wrong line numbers tolerated by nearest-match.
- **SEARCH/REPLACE** — fenced `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks, path taken from the nearest preceding line.
- **V4A** — `*** Begin Patch` / `*** End Patch`, `Add` / `Delete` / `Update`
  sections, `@@` anchors, cursor-ordered chunks, `*** Move to:`, `*** End of File`.
- **JSON** — one array of edit objects, or JSON Lines; `create`, `str_replace`,
  `insert`.

## Matching

Old lines are found at the first tier where they occur at least once:

0. exact, 1. ignoring trailing spaces/tabs, 2. ignoring leading and trailing
spaces/tabs (with new lines re-indented to the file's block). `--strict` tries
tier 0 only. An old block occurring more than once is `ambiguous`; occurring
nowhere is `no-match`.

## Output and exit codes

- Exit 0: one line per changed path in byte order (`A`, `D`, `M`, or
  `R <old> -> <new>` for a move), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. Nothing is written.
- Exit 2: exactly one line — `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

A changed file keeps its own line break (CRLF or LF) and its final line break,
unless a unified hunk says otherwise; a created file is LF with a final break.
Paths are checked for safety before anything else about an edit.

## Files

- `main.ts` — the CLI. Node 22, standard library alone.
- `runner.ts` — the kit's trial runner (unchanged); it runs `node main.ts` on
  each check in a fresh directory when `MAKEFUN_ENV_URL` is set.
- `LICENSE` — MIT.

## Verification

Against the kit's 100 public practice checks:

```
node check.ts ../program/generator/practice.json
```

Result for this entry: **100 of 100 passed (practice score 1000)**.
