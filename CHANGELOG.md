# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Agent teams: a "Claude (API)" child that runs as a dsh task on the user's Anthropic API key, so the monthly API credits of Max and Team plans can be used by a team. It is off by default and needs an Anthropic API key in Settings → Accounts.
- Agent teams: before a Claude Code child starts, `claude auth status` (which asks no model anything) is checked. A run that would use an API key (environment, Claude Code settings or `apiKeyHelper`) or a cloud account (Bedrock, Vertex, Foundry) is not started, and the leader is told why.
- On a phone, a swipe right opens the task list and a swipe left closes it. It does not act inside text fields, over a dialog, while the page is pinch-zoomed, or on something that scrolls sideways and can still move that way.

### Changed

- The README and known issues now say what Anthropic's Legal and compliance page allows and forbids for a Claude subscription (the unmodified Claude Code signed in by the user is not prevented; routing through subscription credentials for others and collecting, storing or intermediating them are forbidden), instead of only pointing at the terms, and list what users should not do (extracting sign-in tokens, sharing the account, reselling, working around limits).
- Agent teams: every kind of child (GPT, Claude Code, Claude (API), DeepSeek) is now off in a new install, so nothing runs, bills or signs in until the user turns it on in the team start dialog. The start button needs at least one on; a running team's settings keep one on too. Settings already saved are unchanged.
- The CLI's own `init` event is only a last guard: the first model request follows it within tens of milliseconds, so it cannot promise that nothing was requested. The docs no longer say it does.
- The cloud-switch variables (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `AWS_BEARER_TOKEN_BEDROCK`) are no longer passed to a team's Claude Code, like the API key variables.
- docs/architecture.md now lists what Agent Desk reads and saves of Claude Code's data.

### Fixed

- A Claude Code task no longer stays "working" (with a stop button that does nothing) after a turn was stopped before Claude Code answered. That leaves no Stop hook and no note in the conversation file, so the task is now ended by Claude Code's own idle report (`~/.claude/sessions`) when stop is pressed.
- A finished turn no longer folds away part of the answer. When the agent wrote its conclusion and then a short note on it (no tool call between them), only the note was shown and the conclusion was hidden inside "worked for…". Every message after the last tool call is now shown as the answer, and the context carried into a new session (after a permission mode change) includes all of them instead of the last one only.

## [0.1.1] - 2026-10-22

### Added

- Agent team panel: a usage button that shows the Claude subscription's five-hour and weekly limits next to the GPT (Codex) limits. The Claude limits are read from the `rate_limit_event` that the team's own `claude -p` runs print, so nothing extra is requested and no usage is spent; the values are as fresh as the last team turn.
- Agent team panel: a stop-all button that ends the turn of every working child. The leader is told the user stopped them and not to continue on its own.

### Fixed

- Text typed in the Claude Code task field or in a team child's field is kept when you switch to another session and come back.

### Changed

- The README now describes the Claude routes accurately: API keys for regular tasks, and the local Claude Code (its own sign-in) for Claude Code tasks and team Claude children.

## [0.1.0] - 2026-10-22

### Changed

- GPT chat and hosted web search now use Agent Desk's own official Sign in with ChatGPT registration and the public Responses API. Existing users must sign in again; legacy Codex OAuth credentials are not reused.
- GPT fast mode is unavailable on this route (priority is ignored); Claude fast mode is unchanged. Old GPT fast preferences migrate to off.
- Image generation and Codex five-hour/weekly limits use a separate official Codex app-server sign-in, with exactly pinned `@openai/codex` 0.163.0, a dedicated local CODEX_HOME, lean image-only settings and idle shutdown. Image generation remains on by default; disabling it is also checked at tool invocation.
- Removed direct private ChatGPT HTTP transports and pi-ai Codex OAuth usage. SIWC and Codex credentials and usage displays are kept distinct.
- SIWC validates OIDC identity and granted scopes, serializes rotating-token refresh, strips preview-unsupported fields, maps reasoning efforts to supported values, and requires response.completed.
- Restored transient DSH retries (up to eight retries); subscription-sharing usage failures, authentication failures and HTTP 4xx are terminal. Plan-limit task errors link directly to ChatGPT Usage; account settings show a Manage usage link.
- All bundled/installed/fetched GPT catalog metadata is normalized to the SIWC public route, including old update caches. Image threads are ephemeral; generated copies and process-local diagnostic DBs/logs are removed after use/exit.

### Added

- Initial public release.
- GPT models through official Sign in with ChatGPT and the user's eligible ChatGPT plan.
- Claude models through Anthropic API keys, and optional DeepSeek API keys, on top of DeepSeek Harness (`dsh`).
- Codex-style desktop UI: per-workspace tasks, command and diff views, approval cards, and changed-file lists.
- "My PC" and project-based task grouping, bulk session deletion, and per-turn token and cost display.
- Claude Code tasks (CL) that run the local `claude` CLI in an in-app terminal.
- Agent teams (TM): a leader that delegates work to GPT, Claude, and DeepSeek child agents.
- Phone access over Tailscale.
- Workspace checkpoints with "restore to before this request" and undo.
- dsh update check, with backup and recovery for updates.
- Optional Chrome browser control and Windows desktop control (desktop control is off by default).
- Image generation, web search, subagents on other models, fast mode, and custom instructions.
