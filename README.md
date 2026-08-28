# cc-waste

[![npm downloads](https://img.shields.io/npm/dt/cc-waste.svg)](https://www.npmjs.com/package/cc-waste)
[![npm version](https://img.shields.io/npm/v/cc-waste.svg)](https://www.npmjs.com/package/cc-waste)

Scans your local Claude Code session logs and generates a single self-contained
HTML report showing token usage, estimated cost, and likely token-waste
patterns — repeated file reads, oversized tool results, large pasted content,
low prompt-cache hit rates, and unused or rarely-used installed skills. With
`--fix`, it disables the unused/rarely-used skills itself and the report
shows exactly what it found and what it did about it.

**100% local.** It only reads files under your own `~/.claude/projects/`
directory. It makes no network calls and sends nothing anywhere.

> **Early version.** Token/cost numbers are heuristic estimates (not exact),
> and this hasn't been battle-tested against every Claude Code setup yet
> (Windows, huge logs, etc.). Feedback and bug reports are very welcome —
> [open an issue](https://github.com/yoodongdong/cc-waste/issues).

## Usage

```bash
npx cc-waste
```

This writes `cc-waste-report.html` in the current directory, prints a summary
to the terminal, and **opens the report in your default browser** — no extra
flag needed. If any installed skill looks unused, the terminal and the
report both print the exact command to clean it up.

### Options

```
-o, --out <file>     Output HTML path (default: ./cc-waste-report.html)
--dir <path>         Claude config dir to scan (default: $CLAUDE_CONFIG_DIR or ~/.claude)
--days <n>           Only include activity from the last N days
--project <substr>   Only include projects whose folder name contains this
--json               Also write a .json file with the raw aggregated data
--no-open            Don't auto-open the report in a browser (default: opens)
--fix                Disable unused/rarely-used skills automatically (see below)
-h, --help           Show help
```

Examples:

```bash
# Last 30 days only
npx cc-waste --days 30

# One project, with raw JSON alongside the HTML, no auto-open
npx cc-waste --project my-app --json --no-open

# Also disable the skills that turned out to be unused
npx cc-waste --fix
```

## What counts as "waste"

The tool is heuristic, not exact — token counts are estimated at roughly 4
characters per token, and costs use approximate Anthropic list pricing by
model family (see `src/pricing.js`). Treat every number as directional.

| Pattern | What it flags |
|---|---|
| Oversized tool result | A single tool call (Read, Bash, Grep, ...) returned a very large result. |
| Repeated full-file read | The same file was read in full more than once in one session. |
| Large pasted content | A user turn pasted a large block of text/code directly instead of referencing a file. |
| Low prompt-cache hit rate | A multi-turn session had a low share of cached input tokens, usually from unstable context between turns. |
| Unused skill | A skill installed under `~/.claude/skills` was never invoked in any scanned session (needs ≥5 scanned sessions to flag). |
| Rarely-used skill | A skill was invoked once or less across ≥10 scanned sessions. |

Every installed skill's name + description sits in the tool catalog every
session whether or not it's ever used, so an unused skill has a real,
ongoing token cost — the report estimates it the same way as the other
findings.

## Self-fixing unused skills (`--fix`)

Without `--fix`, the report only lists what it found — nothing on disk is
touched. If it found any unused/rarely-used skills, both the terminal output
and the report's "설치된 스킬 감사" section print the exact command to run
next (your original `--dir`/`--project`/`--days` carried over, plus `--fix`),
so you can just copy-paste it.

With `--fix`, `cc-waste` moves each unused/rarely-used skill's folder from
`~/.claude/skills/<name>` to `~/.claude/skills-disabled/<name>`.
This **disables it without deleting it** — Claude Code only discovers skills
under `skills/`, so the moved folder simply stops showing up, and you can
restore it any time with the exact `mv` command the report prints for it
(also shown in the "설치된 스킬 감사" / "installed skills audit" section of
the HTML). A skill that's still frequently used is never touched.

**Skills wired into a Claude Code hook are never disabled, even by `--fix`.**
Some skills ship a hook (e.g. a Stop hook) referenced by file path in
`settings.json` — moving the skill's folder away breaks that hook ("No such
file or directory") even though nothing was deleted. Before disabling
anything, `cc-waste` scans `settings.json`/`settings.local.json` (global and,
for every project seen in the scanned logs, per-project) for any string that
references a flagged skill's folder, and marks a match "보호됨 (hook 연결)" —
reported like any other finding, but `--fix` skips it and leaves it alone.

## How it works

1. `src/find-logs.js` locates every `*.jsonl` transcript under
   `<claude home>/projects/*/`.
2. `src/parse-session.js` streams each transcript line by line (no full-file
   loads), accumulating token usage per model and matching each tool call to
   its result to compute the waste findings above.
3. `src/aggregate.js` rolls sessions up into per-day, per-project, and
   per-model totals plus a ranked findings list.
4. `src/skills-audit.js` reads every installed skill's frontmatter under
   `<claude home>/skills/*/SKILL.md`, cross-references call counts collected
   in step 2 (from `Skill` tool calls), flags unused/rarely-used ones, checks
   each against `settings.json` hook references, and — only with `--fix` —
   moves the unprotected ones to `skills-disabled/`.
5. `src/html-report.js` renders it all into one static HTML file — no
   external scripts, stylesheets, or CDN dependencies, so it works fully
   offline.

No dependencies beyond Node's built-in modules (`node >= 18`).

## Support

If this saved you some tokens, you can buy the author a coffee:
[ko-fi.com/slowwave](https://ko-fi.com/slowwave). Completely optional —
`cc-waste` stays free, local-only, and doesn't nag you about it beyond a
quiet link in the report footer and `npm install`'s funding notice.

## License

MIT © [slow.wave](https://github.com/yoodongdong) — see [LICENSE](./LICENSE).
