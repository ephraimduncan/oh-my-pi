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

### coding-agent

- Added a selectable `max` thinking level (Anthropic's deepest reasoning tier) for first-party Claude models on the Messages API (Opus 4.6+). Selectable via `--thinking max`, `defaultThinkingLevel: max`, the `provider/id:max` suffix, the TUI thinking picker/cycle, and agent/skill/rule `thinking: max` frontmatter; it clamps down to a model's top tier on models without a `max` tier.
