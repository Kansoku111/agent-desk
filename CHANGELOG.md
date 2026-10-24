# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- EX remembers parent/child model selections as soon as they change, even when the dialog is cancelled or launch fails. Selections are saved on the app and restored across browsers, phones and app restarts; legacy browser-only choices migrate only if no app-side choice exists. TM settings remain separate.

### Added

- Execution mode (EX), next to TM: a separately configured parent/low-tier-child workflow with project verification commands, application-recorded logs and source fingerprints, bounded automatic repairs, explicit acceptance/abandonment, read-only parallel investigation, and serialized writes through review. Checks support cancellation and timeout; stale or failed results cannot be accepted. Available dsh usage and workflow counts are recorded without equating API prices with subscription usage. Existing TM choices and behavior remain unchanged outside overlapping EX workspace protection. See [docs/execution.md](docs/execution.md).

- OpenCode Go: Settings → Accounts → "OpenCode Go" takes an OpenCode Go API key (checked against `https://opencode.ai/inference/go/v1/models`). While it is saved, dsh gets pi-ai's `opencode-go` route, so its models (GLM, Kimi, DeepSeek, Qwen and others, from pi-ai's catalog) show in the model picker; requests carry dsh's own User-Agent and an `x-opencode-session` header per conversation. No cost is shown (flat-rate subscription). Agent teams can use them as children ("OpenCode Go", child only, off by default).

## [0.1.2] - 2026-10-24

### Added

- Agent Desk updates itself. Settings → About → "更新" has an "Agent Desk" row for the newest GitHub release (checked at startup and every six hours, with the sidebar's dot), and its "更新" button installs it and restarts Agent Desk on the same port and token, so open windows reconnect to the new version. A git checkout fast-forwards to the release tag; it is refused with uncommitted changes or commits the release lacks. Other installs take the release's `AgentDesk-<version>.zip`, checked against GitHub's SHA-256 digest, and keep `node_modules` and the user's own files. `npm install` runs when the lockfile changed. When the new version does not start, the previous one is put back and started, and the row says why. It is refused while a task works, from a phone, and under `npm run dev`. Pushing a `v<version>` tag publishes the release with the zip (`.github/workflows/release.yml`, `scripts/pack-release.mjs`); see [docs/development.md](docs/development.md).

- The "裏で作業中（N）" chip of a Claude Code task opens a list of what goes on in the background: each command (or its description), workflow, MCP task or agent type, with how long it has run. It is read from the `background_tasks` of Claude Code's Stop hook and from SubagentStart.
- Agent teams: Settings → Agent teams → "方針" and "プレイブック", read only by team leaders. Policies are named texts (up to 2,000 characters); the start dialog picks one per team ("なし" by default), and its full text joins the leader's system prompt at launch. Playbooks (name, when to use, body) appear in the leader's prompt by name and description only; the leader opens a body with the new `playbook` tool, which is offered only when playbooks exist and reads the current text. Children see neither.
- Settings → About → "更新" checks dsh, the bundled Codex and Claude Code for newer releases in one place, next to the model list sync. dsh and Codex offer "指示をコピー", which copies an instruction for an AI agent working in the repository (versions, repository, release notes; the steps live in [docs/updating.md](docs/updating.md)); it only shows when Agent Desk runs from a git checkout. Claude Code offers "更新", which runs `claude update`.
- Local LLM: Settings → Accounts → "ローカル LLM" connects an OpenAI-compatible model server (Ollama, LM Studio, vLLM, llama.cpp) by its URL (e.g. `http://localhost:11434/v1`), with an optional API key. Its models are read from `/models` when it connects and kept in the settings, so they stay in the model picker while the server is off; "再読み込み" reads them again. They run as dsh tasks without images or reasoning levels, with a 32K window unless the server reports one. Agent teams can use them as children ("ローカル LLM", child only, off by default).
- Agent teams: reports that arrive while the leader works now reach it together in its next turn, as one message with the next steps said once, instead of one turn per report. While other children still work, a report waits up to 30 seconds (from the oldest waiting) for theirs, so children finishing tens of seconds apart no longer cost a leader turn each; an approval, or the last child working, goes at once. A message gathers at most 6,000 characters of reports; the rest follow. Settings → Agent teams → "報告をまとめて渡す" (on by default) turns it off.
- Agent teams: the leader's `send` takes `fresh: true` to start a child over in a new conversation (its earlier one is removed), for work that needs little of what it carried. It is refused while the child works.
- Agent teams: a child whose turn ends on a passing failure (the model's service overloaded or down, a lost connection) goes on by itself once, a minute later, before the leader hears of it. A second failure, or a lasting one (usage limits, billing, auth, a refused request), reaches the leader as before; "全停止" also stops a child waiting to go on.
- Agent teams: Settings → Agent teams → "子のツールを絞る" (off by default). Teams started with it on give children no browser, desktop or image-generation tools (a Claude child runs with `--strict-mcp-config`, so without MCP servers) unless the leader spawns them with `tools: true`.
- Agent teams: Claude children get Claude in Chrome (`--chrome`), which headless Claude Code otherwise leaves out; a child kept lean goes without it.

- Agent teams: a "Claude (API)" child runs as a dsh task on the user's Anthropic API key and is recommended for automatic team processing. It is off by default and needs a key in Settings → Accounts. Its runtime and history are separate from Claude Code. Credits, if any, depend on provider plan conditions; parallel or long-running work can incur substantial metered costs. Configure provider-console spending controls: Agent Desk does not enforce a hard USD cap.
- Agent teams: start/settings inspect `claude auth status` without a model call and return only a sanitized authentication descriptor. The explicit billing confirmation is saved once per authentication mode for all teams (no tokens or account data), so it is not asked again for each new team. Authentication is rechecked before every Claude Code leader/child CLI launch or resume and every child turn. Changed modes require reconfirmation; unknown modes additionally require a separate explicit risk acknowledgement, and logged-out runs are blocked.
- On a phone, a swipe right opens the task list and a swipe left closes it. It does not act inside text fields, over a dialog, while the page is pinch-zoomed, or on something that scrolls sideways and can still move that way.
- Agent teams: a Claude child takes messages while it works, as a task does. What you write in its view waits above the input and is sent when its turn ends, and "割り込む" gives it to the turn at once (Claude Code reads it at its next step; with no step left, it follows as a turn of its own). The leader's `send` reaches a working Claude child the same way instead of waiting for the turn to end. To do this the child's `claude -p` reads stream-json on stdin (`--input-format stream-json --replay-user-messages`) and its input stays open while the turn runs.
- The sidebar task list keeps its scroll position when the sidebar is closed and opened again, instead of starting from the top each time.
- A Claude Code task's menu now has "Copy history" like a GPT task's. The copy starts with the full path of Claude Code's own conversation file, so an agent on the same PC can read the whole conversation, and says how many earlier exchanges (Agent Desk shows the last 80) it leaves out.

### Changed

- Agent teams: when a team's policy says how to choose a tier or provider, the leader follows it over the built-in tier descriptions (low for simple or repetitive work, mid for judgment), in its instructions and in the `spawn` tool. A policy still cannot turn on a tier the user switched off.
- Updated the bundled Codex app-server (`@openai/codex`) from 0.163.0 to 0.164.0.
- Agent Desk no longer installs dsh releases itself: the install, verification, rollback and recovery steps (and "自動で更新する") are gone, and so is the execution lock they needed. The update check remains.
- Agent teams: GPT, Claude (API) and DeepSeek children get their standing instructions as a system prompt section (a dsh plugin in the children's layer) instead of their first message, so compaction no longer drops them. The first message names the child and gives its task.
- Agent teams: a child checks its work before it reports (tests, build, running it, or looking at the result), and its report says how it checked and what came out, between what it did and the paths it changed. The leader audits with that in hand.
- Legal documentation now describes Anthropic's conditional allowance for an unmodified Claude Code binary using users' own subscription/API/cloud credentials, including Commercial Terms for product/service providers and no restriction of built-in authentication. Disclaimers and billing acknowledgements do not guarantee compliance or grant policy permission.
- Agent teams: every kind of child (GPT, Claude Code, Claude (API), DeepSeek) is now off in a new install, so nothing runs, bills or signs in until the user turns it on in the team start dialog. The start button needs at least one on; a running team's settings keep one on too. Settings already saved are unchanged.
- Team Claude Code leaders and children inherit normal authentication, including users' own API keys and cloud credentials, rather than subscription-only environment filtering or API/cloud rejection. Regular CL behavior is unchanged. Saved team choices, models, and histories remain intact; no automatic migration to API, enabling, or fallback is performed.
- docs/architecture.md now lists what Agent Desk reads and saves of Claude Code's data.

### Removed

- Settings → Models → "モデルを追加" (adding a model by ID, cloned from another model's definition) and its list. New models arrive by the automatic sync with the ChatGPT account's list and the newest pi-ai release. Models added this way earlier leave the catalog.

### Fixed

- Claude Code's phone screen view keeps unsent text and reports a failed send instead of clearing the field while disconnected.
- Undoing the latest of several workspace restores preserves the notification about file changes that remain reverted, including after restarting Agent Desk.
- Codex allowance updates preserve previously read windows and plan information when rolling notifications omit them, ignore other quota buckets, and do not show unknown durations as zero-hour windows.
- File references preserve names ending in parentheses and literal percent escapes, prefer an existing literal path over a decoded alternative, and decode `file://` URLs only once.
- Agent teams: a Claude child that ended its turn while its own commands ran in the background (`run_in_background`, Monitor) reported "waiting for …" to the leader as if done, and its `claude -p` exited, so it was never woken when they finished: the team stalled until someone said "続けて". The run now keeps Claude Code's input open while `background_tasks_changed` lists anything, Claude Code goes on by itself when they end, and only the answer given with nothing left in the background reaches the leader. The wait is capped at 2 hours; past that the report names what was left. Claude children are told they may end a turn on a background command; dsh children still wait for theirs.
- Agent teams: "全停止" and `close` no longer leave messages waiting that start the child's next turn once the stopped one ends (a closed child could work on unseen and uncounted). A leader's `send` that missed a GPT child's turn ending while it was steered now goes as soon as the child is free instead of waiting for good. A child waiting to go on after a passing failure shows as "再開待ち", and "全停止" can stop it.
- Agent teams: a Claude child's report keeps the actions that were denied for want of an approval when its turn ends in an error, not only when it succeeds.
- The agent-team MCP server no longer trips a libuv assertion on Windows when Claude Code closes it: it ends once its calls are answered instead of calling process.exit.
- Docs: the Claude Code billing confirmation is described as it works: once per authentication mode, reused by every team.
- Claude Code background status no longer counts internal/unknown hook tasks as active work or duplicates an agent under its task-registry id. Lifecycle hooks report in order so a delayed start cannot resurrect a completed agent; idle notifications reconcile missed agent completions without clearing running shell commands.
- A GPT task on a model other than the one chosen under Settings → Models → Subagents (for example GPT-6 Astra with GPT-6.1 Sol chosen) started its subagents on its own model, because it called the plain `subagent`, which always runs on the task's model, instead of `subagent_gpt`. The prompt now tells each task to delegate with the pinned tool of its own model family, and to use `subagent_fork` only when the child must see the conversation. The paragraph is no longer than before (508 characters against 510 with both tools pinned). It is guidance to the model, not a guarantee; the settings screen now says plainly that `subagent` follows the task's model.
- A Claude Code task's conversation view now shows a message you typed while it worked (Claude Code keeps it as a queued command, which was skipped), in the turn it was read in.
- A Claude Code task whose turn ended while background agents (or commands) still worked was shown as idle, so the app could be replaced or updated, and its model or level changed, which ended Claude Code and cut those agents off midway ("didn't finish before the previous session ended"). The task now shows "裏で作業中", the app waits to be replaced and the model chip is locked until they end. This reads the `background_tasks` of Claude Code's Stop hook and the new SubagentStart / SubagentStop hooks. The log also records the time and reason each time Claude Code is ended or exits.
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
