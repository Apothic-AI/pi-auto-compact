# Changelog

## [1.4.0] - 2026-11-23

### Added

- Automatic mid-run compaction via Pi's actionable `turn_end` boundary (`CompactionEntryDraft`): when context usage reaches the configured threshold during a multi-turn tool run, the extension summarizes earlier history between completed tool batches and seamlessly continues the run without aborting or requiring `settings.json` alignment.
- Argument autocomplete (`getArgumentCompletions`) for `/compact-threshold` (`align on`, `align off`, `reset`).

### Changed

- Updated `tool_call` status reporting and `align on|off` notices to reflect native mid-run compaction at the configured threshold after each completed tool batch.
- Updated `describePiTrigger` to respect `compaction.enabled: false` and fall back to `ctx.getContextUsage().contextWindow` for virtual models.
- Aligned typecheck and SDK integration test baseline with `@earendil-works/pi-coding-agent` 1.6.0.

### Fixed

- Preserved cumulative `readFiles` / `modifiedFiles` tracking across consecutive mid-run boundary compactions (`fromHook: true`).
- Guarded `prepareBoundaryCompaction` against picking ephemeral preview IDs from earlier `turn_end` drafts as `firstKeptEntryId`, and captured `ctx.signal` before `await compact()` so stale session replacement cannot throw during `turn_end`.
- `clearPiAlignment()` (`align off` / `reset`) now deletes only `reserveTokens` from `compaction.modelOverrides[key]` so user-configured `keepRecentTokens` settings are preserved.
- `session_compact` and `tool_call` (when usage becomes unknown) now clear stale warning status lines from the footer.
- `/compact-threshold reset` now reminds the user to run `/reload` when aligned `settings.json` entries were removed.
- Fixed outdated documentation claiming `reserveTokens` raises the summary token cap (`0.8 × reserveTokens` only applied prior to Pi 1.4.0; Pi 1.4.0+ uses the model's output limit).

## [1.3.1] - 2026-10-04

- Previous release aligned with Pi 0.99.x–1.0.x with opt-in `align on|off`, `tool_call` status reporting, and `input` preflight compaction.
