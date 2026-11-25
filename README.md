# pi-auto-compact

A minimal Pi extension that automatically compacts the conversation at a configurable percentage of the current model's context window — both **before sending a prompt** (`input` preflight) and **between tool batches during a run** (`turn_end` boundary) — and reports context pressure **before every tool call**.

Compaction reuses Pi's built-in compaction machinery (`ctx.compact()` on idle `input`, `compact()` + `CompactionEntryDraft` on `turn_end`), while Pi's own automatic compaction and overflow recovery remain active as the final safety net.

Requires `@earendil-works/pi-coding-agent >= 0.99.0` on Node 22.19+ (typechecked and SDK scheduling tested against pi 1.6.0).

## Install

```bash
pi install npm:pi-auto-compact
```

Or install directly from GitHub:

```bash
pi install git:github.com/Chasen-Liao/pi-auto-compact
```

## Configuration

The generic fallback threshold is **78% used**, preserving existing behavior. All model-specific policies are configured in `~/.pi/agent/pi-auto-compact.json`; there is no model-family branch or model-specific default in code. Resolution is exact `provider/model` key, then matching configured wildcard pattern, then global `threshold`. If multiple wildcards match, the most-specific (fewest `*`, longest literal text) wins; ties use config insertion order.

```json
{
  "threshold": 78,
  "modelThresholds": {
    "*/gpt-*": 40,
    "subrouter-gpt/gpt-6.2-sol": 47.62
  }
}
```

Here `*/gpt-*` makes the 40% value a config policy, while the exact key preserves the distinct 47.62% (500,001-token trigger on a 1,050,000-token window) policy. A 40% rule would trigger at 420,000. Edit the config map to add/change any model policy; `/compact-threshold model <key-or-pattern> <percent|reset>` edits any rule, and `/compact-threshold <percent>` changes the global fallback. Threshold values accept 30–98. The feature does not silently enable or change Pi settings. `/compact-threshold align on` remains an explicit opt-in to write Pi's mid-tool-loop `reserveTokens`; user-owned reserves are preserved. Show effective settings and match count with `/compact-threshold`.

Reset to the default generic 78% (and remove extension-managed Pi settings alignment):

```text
/compact-threshold reset
```

The threshold is calculated against the active model's context window, so the same percentage works across models with different window sizes. It is re-read before every prompt, turn, and tool call, so config changes apply without restarting the session.

## Mid-run (between tool calls) compaction

During a multi-turn agent run, context grows as tool calls execute. The extension handles this automatically **between completed tool batches**:

- **Automatic `turn_end` compaction (always on)**: when a turn completes with pending continuation (`toolResults`, queued steering/follow-up messages, or another extension's continuation request) and context usage has reached the configured threshold, the extension summarizes earlier turns via `compact()` and returns a `CompactionEntryDraft` through Pi's actionable `turn_end` boundary. Pi appends the compaction entry, rebuilds context with the summary plus recent turns (`keepRecentTokens`), and **continues the next model request seamlessly** without aborting the run or modifying `~/.pi/agent/settings.json`.
- **The `tool_call` status check (always on)**: before every tool call, if usage is at or above the threshold, the footer shows `context XX% · compacting after this tool batch`. This check never blocks a tool and never calls `ctx.compact()` (which aborts active runs).
- **Optional Pi threshold alignment (`align on|off`)**: if you also want Pi's built-in mid-tool-loop check and `settings.json` per-model reserve to match the effective threshold, `/compact-threshold align on` writes `compaction.modelOverrides["<provider>/<model>"].reserveTokens` using exact-model > configured wildcard > global fallback (run `/reload` afterwards to apply). `align off` removes only the exact `reserveTokens` keys written by this extension, leaving other user-owned settings untouched.

```text
/compact-threshold align on     # optional: also align Pi's settings.json reserve
/reload                         # let pi re-read its settings
/compact-threshold align off    # remove extension-managed reserveTokens
```

Alignment is **off by default** and is no longer required for mid-run compaction at your configured threshold.

The boundary is a **completed tool batch**, not each individual tool call:

- Sibling tool calls emitted in a single assistant response finish before compaction runs.
- Nested calls inside a single `codemode` script do not create separate compaction boundaries; split long scripts into top-level batches when you need checkpoints.
- If a single turn itself is smaller than `keepRecentTokens` with no earlier history to summarize, or if mid-run summarization fails, the extension warns and lets the run continue rather than aborting active work.

> **Note on `reserveTokens` and summary length**: Starting in Pi 1.4.0, `compaction.reserveTokens` only controls when Pi's built-in compaction triggers; summary requests use the model's output limit (`maxTokens`). (`0.8 × reserveTokens` only applied to Pi versions earlier than 1.4.0.)

## Behavior

- **Preflight trigger (`input`)**: when you submit a prompt while the agent is idle, the extension estimates `current context + your input` (using Pi's own token estimator). At or above the threshold, it runs `ctx.compact()` once before sending the prompt, so long inputs never interrupt a running tool chain.
- **Failure policy**:
  - Preflight (`input`): if compaction fails, the prompt is **not sent** (fail-closed; recall it from the editor history and resubmit) and an error is shown. Exception: `"Nothing to compact"` / `"Already compacted"` mean the context is already minimal, so the prompt is sent anyway.
  - Mid-run (`turn_end`): if summarization fails, a warning is shown and the run continues without compaction so active tool work is not lost.
- **Status**: the footer shows a warning when context is past the threshold at turn end without continuation (`compact before next prompt`), while preflight or mid-run compaction is running, and clears automatically once compaction completes (`session_compact`) or usage drops below threshold.
- **Not preflighted in `input`**: messages queued during an active run (`steer`/`followUp`), slash commands handled before `input`, and content injected later by `/skill:` or `/template` expansion — those are covered by mid-run `turn_end` compaction and Pi's built-in compaction.
- **Requires a known context window**: if the active model/session doesn't report one (or usage is unknown, e.g. right after a compaction), checks skip cleanly and Pi's built-in compaction covers it.
- Session switches/reloads mid-compaction are detected; stale callbacks never touch the new session's status.

## Development

```bash
npm install
npm run typecheck
npm test
pi -e .
```

`npm test` runs the mock smoke suite (`test/smoke.ts`) and real Pi SDK scheduling suite (`test/integration.ts`), using Node native TS type stripping. Both suites use temporary agent directories; the SDK suite also isolates its workspace and replaces model responses and summary generation, so it makes no network requests or changes to user settings.

The smoke suite covers threshold gating, failure classification, concurrency, session guarding, config persistence, image-prompt projection, mid-run `turn_end` boundary compaction and fallbacks, `tool_call` status reporting, `session_compact` status cleanup, threshold alignment (preserving user-owned `keepRecentTokens`), virtual-model / disabled-compaction reporting, and command argument completions. The SDK suite verifies below-threshold pass-through, automatic mid-run compaction without `align on`, sibling tool batch ordering, preflight `input` compaction, and `align on`/`align off` settings reload boundaries.

These tests verify Pi 1.6.0's runtime scheduling, not real-provider summarization quality. The last real-provider CLI end-to-end baseline remains pi 0.99.1.

## License

MIT
