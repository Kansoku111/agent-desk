# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.8] - 2026-10-31

### Security

- Override vulnerable transitive dependencies with MCP client 2.3.0, fflate 0.8.3, undici 8.12.2 and Zod 4.6.6, without changing the pinned dsh/Codex runtimes or model routes. Add installed-tree and ZIP64, collection-validation and cross-origin MCP redirect regression tests; document the override lifecycle and MCP redirect compatibility.
- MCP HTTP and OAuth requests now reject cross-origin redirects by default. If an MCP server intentionally redirects to another origin, configure its final URL instead. See [SECURITY.md](https://github.com/Kansoku111/agent-desk/blob/v0.1.8/SECURITY.md) for details.

## [0.1.7] - 2026-10-31

### Added

- Choose available skills directly from the composer.
- Opt in to AI conversation history search tools; history access remains disabled by default.
- Configure reasoning levels for subagents and enable or disable custom instructions without deleting them.

### Changed

- PTC is enabled by default for new work; existing saved choices are preserved.
- Updated the bundled DeepSeek Harness (`@deepseek-ai/dsh` and `@deepseek-ai/dsh-atomic-write`) from 0.2.1-rc.2 to 0.2.1-rc.5; refreshed dependency notices and made the OpenCode catalog integration test independent of retired upstream model IDs.
- Documented isolated validation and the prohibition on running `npm ci` from a live Agent Desk installation.
- Updated the bundled Codex app-server (`@openai/codex`) from 0.165.0 to 0.166.0.

### Fixed

- Corrected Claude Code model selection in workflows, restored conversation scroll position on reopening, and improved history-copy retries on phones.
- Automatic dependency installation no longer rewrites the tracked lockfile, which could prevent subsequent Git-based updates or rollback. Existing local changes are still preserved and must be resolved before updating.

## [0.1.6] - 2026-10-29

### Added

- Plan mode provides per-message read-only consultation while preserving conversation history. Eco can optionally proceed from planning to implementation.
- Team settings support multiple child model rows, removal of children, and model-specific reasoning levels.
- `/goal <objective>` (case-insensitive) directly creates and arms a persisted goal before the first model request in ordinary dsh tasks and dsh-led Eco/TM. Initial and queued messages are supported; commands do not interrupt running turns or overwrite unfinished goals. Empty commands, Plan combinations, AB and child commands are rejected. Internal reports stay plain text, and missing runtime support fails closed. Claude Code terminal commands are unchanged.

### Changed

- Updated the bundled Codex app-server (`@openai/codex`) from 0.164.0 to 0.165.0.

### Fixed

- AB displays stop failures and unfinished history clearly, and opens direct implementation reports correctly.
- Eco verification avoids stalled source checks and preserves workflow handoff context.

## [0.1.5] - 2026-10-27

### Added

- Standard tasks, AB, Eco and teams support task- or workflow-scoped PTC configuration.
- Teams support flexible model selection, including a model picker for the leader and a copyable policy-creation prompt. Model pickers distinguish Claude Code from the Claude API.

- Sidebar task menus support persistent pin/unpin for regular conversations, Claude Code tasks, teams/Eco and AB. Pins appear first within their project with a small marker, remain outside the recent-row quota, and keep their state across restarts and archiving.
- Eco leaders can continue related implementation with the same child after reviewing and accepting its research. The explicit `implement` tool retains the model and conversation, applies writer permissions through the app, captures a new baseline, and preserves serialized writes, verification and parent judgment. Ordinary research follow-ups remain read-only; failed session migration never silently starts a replacement conversation.

### Changed

- Authenticated phones can use Open → Build and restart with the same confirmation as the PC. Remote menus keep workspace-path copying and restart while terminal launching and other PC-only RPC restrictions remain unchanged.
- Eco guidance prioritizes inexpensive children for investigation and implementation while leaving research depth, planning detail and review needs to the leader. Eco launches no longer include TM parallel-writer or mid-tier advice. Children receive their work unit's captured verification commands and working directories at new-unit/conversation boundaries, with focused checks preferred but necessary full testing still allowed. Research reports can include evidence-backed implementation ideas; no presets, review caps, automatic acceptance or verification bypasses are added.

### Fixed

- Concurrent display-only Claude Code auth inspections with the same launch context share a running check, while consent and launch checks stay independent. Checks queued before a process starts are batched without reusing started or completed results, preserving billing consent. Interactive Claude login-expired errors now show a Japanese recovery message and a link to the terminal; CLI-side token refresh interruptions remain possible.
- Eco re-verification invalidates earlier evidence immediately; failed, cancelled or incomplete verification/review records cannot be accepted using an older success. Verification detects temporary new source files while retaining generated-file exclusions, and accepts legitimate dot-prefixed working directories without allowing project escapes.
- Eco and AB start dialogs block known unsupported reasoning choices and let users explicitly clear stale levels on models without reasoning controls, without silently changing saved preferences.
- Team report delivery preserves reports when a Claude leader submits an unrelated prompt. Stop-all clears idle/interrupted children's queued instructions too; closing a child during startup prevents later execution. Concurrent approval requests reconcile individually, and restart reports identify children lost before task creation and explain how to reassign them.
- Interrupted regular turns persist their settled transcript and use the last recorded activity instead of the next load time. Task creation tolerates removal by another client while settings are saved, without creating or sending the task again.
- Queued-message steering and retries wait for active delivery instead of disappearing; other unsent messages can still be removed. Initial connection restores the saved reasoning default without overwriting later user choices on reconnect.
- AB stop requests arriving after a stage finishes preserve the completed plan/report and its approval or follow-up actions. Active-worker stopping and explicit retries remain unchanged.
- Release ZIPs and standalone updaters include the shared runtime modules, preventing missing-module startup failures. Automatic UI rebuilds track shared code, public assets and Vite configuration; server fingerprints also track shared JavaScript.
- A launch waiting for an older busy instance can take over after that instance disappears, while the data-folder lock still prevents duplicate writers.
- Concurrent browser-tool sessions choose and atomically save one shared Chrome debugging port under a cross-process lock.
- Transient HTTP 429 rate limits retain dsh's retryable RATE_LIMIT classification instead of being intercepted as invalid requests. Authentication failures, other client errors and permanent quota/subscription limits remain terminal.
- Unrelated or non-GET OAuth callbacks no longer consume a legitimate ChatGPT sign-in attempt; valid callbacks still enforce state and single-use checks.
- New-task messages carry a persisted creation ID across same-tab retries, so a lost create response does not launch the request twice. Durable creation and message receipts coalesce parallel calls, reject changed payloads and keep deleted tasks from being recreated by stale retries; legacy callers remain compatible.
- Claude Code message delivery serializes each terminal's paste and Enter, waits for the first Enter before acknowledging success, and preserves drafts on interrupted delivery. Uncertain partial writes block later pastes on that process until restart instead of combining different messages.
- Eco verification rows get unique generated IDs after deletions or manual naming. Claude workspace choices arriving after the settings screen opens select a usable value, including a single available workspace.
- Per-turn usage includes nested subagents. Usage-history totals distinguish unpriced metered responses from zero-cost or subscription usage, with unknown and partial amounts shown consistently in totals, model rows and chart tooltips.
- Windows file-link actions wait for the native launcher and report failures instead of silently succeeding. Explorer reveal uses the Shell selection API, matches the requested view and selection even in reused windows, restores minimized windows, and verifies foreground activation without raising unrelated new windows. Literal paths, executable-file guards and non-Windows launch behavior are preserved.
- TM and Eco dsh leaders share event-driven goal waiting for delegated work, verification, reports and user decisions. Independent parent work can opt into automatic rounds with `wait({waiting:false})` and yield with `wait()`, while queued reports, approvals, pending user questions and stop requests take priority. Goals and round budgets are preserved; ordinary tasks and child goal continuation remain unchanged.
- Questions are answered only by newly accepted human input, not rejected sends, duplicate retries or child reports. Accepted steering updates scheduling atomically; late steering cannot fall through to an orphan normal prompt. Parked-parent cancellation and concurrent wait writes are acknowledged in order, and stop generations fence delayed child starts, follow-ups and automatic retries. Dismissing a question notifies the parent without granting approval.

## [0.1.3] - 2026-10-26

### Changed

- Usage footers show cumulative **API-equivalent amounts** (`API換算 $…` / `API換算 ¥…`) instead of points across regular/CL/Eco/TM/AB. General settings selects USD (default) or JPY with a required positive manual USD/JPY rate; no rate is guessed or fetched. Settings validate/save before publication and need no model restart. Existing saved scores and USD equivalents remain unchanged; changing the manual rate changes only JPY presentation, including history. API-equivalent amounts truncate to at most one decimal (`$19.282996` → `$19.2`) without reducing stored-value or exchange-rate precision. Positive amounts below 0.1 remain distinct from zero (`< $0.1` / `< ¥0.1`); unknown totals show `—` and partial totals keep a rounded-down lower bound. Metered estimates and actual billing totals remain in USD, separate from the reference display.
- Renamed EX to **eco** (エコモード / economy mode) across the UI and reports. Existing settings and workflow behavior are unchanged.

### Fixed

- Workspace overlap checks resolve existing ancestor aliases even for descendants that do not exist yet, including Windows temporary-folder junctions. The local-model integration test waits for the actual idle state before checking finalized output speed.
- Eco acceptance now requires recorded verification evidence; overlapping-workspace conflicts identify the blocking workflow, and restores are fenced across overlapping workspaces. Eco children always retain the extra tools needed for implementation.
- Settings updates are isolated and committed before publishing state, including queued-history changes and account-update failures. TM policy/playbook deletions persist immediately, and those instructions remain scoped to TM.
- AB supports per-role reasoning levels, screenshots, Enter-to-send, safe follow-ups and history actions. Consultations show their live conversations, and the header includes the Open menu. New AB/Eco reasoning defaults to medium; Eco reasoning choices persist, and model/reasoning dropdowns support mouse-wheel selection.
- Terminal actions launch visible terminals; the redundant project Explorer action is removed, and sidebar workflow-launch colors are distinct.
- The API-equivalent amount is now a keyboard/touch-accessible button opening usage details instead of leaving metered cost estimates only in a native hover title. Legacy turns without a recorded equivalent still expose their saved metered costs. JPY details include the USD reference and applied manual rate; Escape/close returns focus to the amount.
- API-price-equivalent points no longer leak subscription/local-model reference prices into metered-cost totals, history, or subagent cost readouts. Existing usage caches remove only non-metered costs while preserving tokens, metered costs and deleted-log history; live logs are repriced under the corrected billing policy.
- Responses without usage now count as unpriced rather than silently disappearing from points. Duplicate responses prefer their latest available usage, including when it arrives after a usage-less record, without counting twice.
- Interactive Claude's response index keeps turn IDs and compact usage metadata instead of references to full turn bodies, allowing text/thought/tool output beyond the 80-turn display limit to be released while preserving cumulative points, deduplication and late usage corrections.
- Goal updates now explain which fields each action accepts and how to omit unused fields (or use empty strings / a zero round cap when all fields are required). Invalid calls identify the offending fields and include a corrected retry example instead of encouraging repeated resume/completion failures; argument validation and goal authority checks remain unchanged.
- Broad `glob` / `grep` searches now stop collecting at bounded record/byte limits and return clearly marked partial results instead of failing at dsh's 20 MB raw-output cap. Partial searches never claim an exact total or save a misleading complete-result artifact; genuine errors and cancellation still fail. Search guidance starts narrow and expands as needed. Small searches retain their normal results and full-result spill behavior.
- AB implementations no longer stop on a Windows sandbox setup failure (`SetNamedSecurityInfoW failed (Win32 5)`): the dsh implementation worker now always runs with full access, while consultation, judgment and review stay read-only and the implementation tool guards stay active. Denied or blocked implementations keep a stage retry even after review, including older saved attention states, and a provisioning failure in a tool result is flagged instead of trusting a completion report. Workers are told approval prompts are unavailable.
- OpenCode Go no longer reports legacy service IDs absent from, or deprecated in, its official Go catalog as models waiting for definitions. These IDs remain visible under 同期の詳細 → 公式カタログ対象外; actual unsupported definitions and catalog-fetch failures still warn. Older definition caches are rechecked automatically.
- OpenCode Go no longer silently loses new or renamed model IDs while waiting for pi-ai: missing exact IDs are supplemented from OpenCode's structured model catalog after validating the supported protocol, pinned endpoint, capabilities and limits. Cached valid definitions survive source failures; unresolved IDs and definition-fetch failures show a warning instead of a successful-sync check. Public metadata requests never carry the user's API key or conversation data.
- AB no longer strands hidden workers at permission prompts: it answers the actual pending request IDs synchronously and retains denied operations from both dsh and Claude Code in reports and review input. Failed consultations stop their peer, cancellation waits for confirmed completion, and unconfirmed stops keep a busy fence and stop control. Approved implementation stages can be explicitly retried without repeating consultation or silently rerunning writes; the existing diff is preserved. AB-level notifications open AB rather than a hidden worker. Native implementation tools use an allowlist, the read-only escalation guard uses dsh's real `arguments` field, corrupt JSON is backed up, and manual no-provider verification fixtures are now tracked.
- Dialogs no longer pull focus back to themselves on every re-render. Any server update used to move focus off the field being edited, which closed an open model list (AB's model picker) and interrupted typing. AB's model fields now use the same menu as the composer, with the models' own names under their Claude Code, ChatGPT, Claude and other headings instead of names suffixed with a company or billing route.
- The updates card gives OpenCode Go its own always-visible row, with its new models and read failures kept separate from the general model row. An unset API key or disabled auto-sync is shown in place instead of hiding the row.
- OpenCode Go's model list follows the service: the saved key reads `/v1/models` (at once, then every six hours) and the picker keeps only the catalog models still listed there, so withdrawn ones (e.g. Space Bunny, Cat Jam Free, Step 5 Preview Free) disappear. New model definitions are read from verified pi-ai releases and overlaid in memory when dsh starts; installed packages are never modified. Concurrent refreshes are serialized, inconsistent replies retain the last verified list, and old runtime snapshots cannot mark a newer catalog current. It is part of the model sync in Settings → About → 更新: the automatic-sync switch controls it, 今すぐ確認 reads it, and 同期の詳細 shows the last check, read failures, hidden models and service ids still awaiting a supported definition.
- EX remembers parent/child model selections as soon as they change, even when the dialog is cancelled or launch fails. Selections are saved on the app and restored across browsers, phones and app restarts; legacy browser-only choices migrate only if no app-side choice exists. TM settings remain separate.

### Added

- Cumulative API-price-equivalent usage at the start of the answer usage footer, shared by regular/CL tasks and Eco/TM/AB workflows (displayed as USD or manual-rate JPY, not a bill or subscription-quota estimate). Existing model catalogs supply input/output/cache rates, applied per response before summing context tiers. Interactive Claude Code parents read/deduplicate their own usage logs; headless workers retain usage and totals beyond the displayed turn limit. Retries, fresh conversations and removed team children retain recorded consumption. Unpriced/missing usage shows `—` or a partial `≥ $…`; recorded values survive restarts and catalog price changes. See [docs/usage.md](docs/usage.md).

- "ビルドして再起動" in the task header's 開く menu (PC only): rebuilds the UI, then restarts Agent Desk on the same port and token so open windows reconnect, stopping any running tasks. The build runs first, so a failed build leaves the app running with the error shown. A normal relaunch still waits for running tasks to finish before replacing an older instance. See [docs/updating.md](docs/updating.md).

- AB beside EX/TM: independent raw-request consultation by two models, followed by a separate judgment model and revision-bound human approval before implementation. Four model choices and lean/delegation/review switches persist separately from TM/EX. Supports Claude Code and connected catalog models; consultation uses read-only, non-delegating runtimes, with optional native web research and no mutating MCP tools. Delegated implementations receive focused leader-written instructions; review OFF does not wake the leader. Interrupted work never resumes automatically. See [docs/ab.md](docs/ab.md).

- Provider-independent output speed for streamed DSH tasks (OpenAI, Claude API, DeepSeek, OpenCode Go and local LLMs) and team Claude Code runs. A small `≈ … t/s` readout uses the current model response's cumulative average both live and at completion, including silence within the response. It hides during tools/approvals, resets for each response, and requires at least one second between received text samples. The final value is the last response only, never a different turn-wide average or a fallback to an earlier response. It is not a provider decoding benchmark: buffered-only replies have no readout, hidden reasoning/tool arguments are not counted, and billed usage is never used to falsely mark the estimate exact.

- Execution mode (EX), next to TM: a separately configured parent/low-tier-child workflow with project verification commands, application-recorded logs and source fingerprints, bounded automatic repairs, explicit acceptance/abandonment, read-only parallel investigation, and serialized writes through review. Checks support cancellation and timeout; stale or failed results cannot be accepted. Available dsh usage and workflow counts are recorded without equating API prices with subscription usage. Existing TM choices and behavior remain unchanged outside overlapping EX workspace protection. See [docs/execution.md](docs/execution.md).

- OpenCode Go: Settings → Accounts → "OpenCode Go" takes an OpenCode Go API key (checked against `https://opencode.ai/inference/go/v1/models`). While it is saved, dsh gets pi-ai's `opencode-go` route, so its models (GLM, Kimi, DeepSeek, Qwen and others, from pi-ai's catalog) show in the model picker; requests carry dsh's own User-Agent and an `x-opencode-session` header per conversation. No metered bill estimate is shown (flat-rate subscription); API-equivalent usage is displayed separately. Agent teams can use them as children ("OpenCode Go", child only, off by default).

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
