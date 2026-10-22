# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
