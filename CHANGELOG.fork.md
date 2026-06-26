# Fork Changelog

Changes specific to this fork (`ephraimduncan/oh-my-pi`), kept out of the upstream
per-package `CHANGELOG.md` files so that merging `upstream/main` never conflicts on
changelogs. Entries are grouped by package. See `AGENTS.md` → "Changelog" for the
convention.

## [Unreleased]

### agent

- Added `ThinkingLevel.Max`, the agent-local selector for Anthropic's `max` reasoning effort.

### ai

- Added `max` reasoning-effort support across providers. The per-provider thinking-budget tables (Anthropic/Google/Bedrock) gain a `max` entry for type-completeness (adaptive Claude ignore these budgets), and the request dispatch (`mapOptionsForApi`, plus the OpenAI-shim and GitLab Duo bypass paths) clamps a `max` request down to the target model's top supported effort. Models without a `max` tier (including OpenAI-family endpoints that top out at `high`/`xhigh`) degrade gracefully instead of forwarding an unsupported `max`/`xhigh` to the provider.

### catalog

- Added a sixth canonical thinking effort, `Effort.Max`, ranking above `xhigh` — Anthropic's deepest reasoning tier.
- Changed first-party Anthropic Messages Claude (Opus 4.6+, Fable/Mythos 5) and the Devin Opus effort-tier variants to expose Anthropic's literal effort scale 1:1 (matching Claude Code), removing the previous up-one-notch shift. Opus 4.7+/Fable/Mythos now expose `low/medium/high/xhigh/max`, Opus 4.6 `low/medium/high/max`, and Sonnet/Haiku 4.6 `low/medium/high`; `minimal` is dropped from these models. Non-Claude models, Bedrock Claude, and OpenRouter-Anthropic are unchanged.

### ci

- Added a fork-only `Fork CI` workflow (`.github/workflows/fork-ci.yml`): lint + type check + collab-web build, and the full TS test suite against a locally-built native addon, on GitHub-hosted `ubuntu-22.04` runners, for PRs and pushes to `main`.
- Disabled upstream's `CI`, `Vouch (PR gate)`, and `Vouch (manage)` workflows on this fork via repo Actions settings (`gh workflow disable`) instead of editing the upstream-owned files, so daily `upstream/main` syncs never conflict. Upstream `CI` only ever queued-then-cancelled here (its jobs target the `omp-kata` self-hosted runner this fork lacks) and its release jobs need upstream npm/Homebrew/Apple secrets; the vouch gate auto-closed PRs and labeled for the `robomp` bot, neither of which applies to this personal fork.
- Added automatic fork releases: `.github/workflows/fork-auto-release.yml` publishes a GitHub Release on every push to `main` (PR merges, direct pushes), and `sync-upstream.yml` publishes one after each successful upstream sync. Both reuse `fork-release.yml` via `workflow_call`; releases are tag-only and never bump `package.json`, and the manual `bun run release` path is de-duplicated via a `chore: bump version to` commit-subject guard.
- Fixed the daily upstream sync, which had been failing on every run (the fork had fallen 156 commits behind upstream): `AGENTS.md` is now `merge=ours` in `.gitattributes` so its intentional fork divergence no longer blocks the auto-merge, and merge-conflict reporting writes to the workflow run's job summary instead of `gh issue create` (issues are disabled on this fork, so the old path made every conflicting run exit non-zero).

### coding-agent

- Added a selectable `max` thinking level (Anthropic's deepest reasoning tier) for first-party Claude models on the Messages API (Opus 4.6+). Selectable via `--thinking max`, `defaultThinkingLevel: max`, the `provider/id:max` suffix, the TUI thinking picker/cycle, and agent/skill/rule `thinking: max` frontmatter; it clamps down to a model's top tier on models without a `max` tier.
