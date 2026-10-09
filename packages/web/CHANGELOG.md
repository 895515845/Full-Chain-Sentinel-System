# Changelog

## [Unreleased]

### Breaking Changes

- The console has no default directory any more: without a project there is no container, so the chat is replaced by a full-screen project-required screen with inline project creation and the project list
- Removed the host-session fallback and the `ZG_ALLOW_HOST_SESSIONS` escape hatch, the "back to default directory" picker entry, and `switch_project: null`. Bash, the file tools, and the file panel all require the project container

### Added

- Initial release of the ZGAgent web console: HTTP + WebSocket server embedding the coding-agent SDK, a Chinese React control console (streaming chat, tool cards, session list, mode switch), the bash approval gate with command editing for review mode, and OpenAI-compatible endpoint configuration persisted to `~/.zgagent/agent/models.json`
- Approval queue: every pending command is listed with per-item edit/approve/reject plus approve-all and reject-all
- Session-scoped command-prefix allowlist: approve with "always allow this prefix" or manage prefixes in the sidebar; compound commands (&&, ;, |, substitution) never match the allowlist
- Endpoint test connection with actionable Chinese diagnostics (timeout, 401/403, 404 path hint, unknown model); an empty API key no longer invalidates models.json
- Tool output upgrades: copy command, copy output, fullscreen viewer with line filtering
- Session branching UI: tree drawer plus inline "fork from here" on user messages
- Usage panel (input/output/cache tokens and cost) refreshed after each run
- `get_state` protocol message for pulling a fresh snapshot on demand
- Added the `spawn_agent` tool: the main agent can delegate self-contained tasks (e.g. per-host recon) to isolated in-memory sub-agent sessions with a turn budget; "explore" mode is read-only, "act" mode shares the operator approval gate (approval requests are labeled with their source), and sub-agents cannot spawn further sub-agents
- Added project management: named working directories persisted in `~/.zgagent/agent/projects.json`, selected from a picker at the top of the sidebar; sessions, context files, and the bash cwd follow the project automatically
- Switching projects rebuilds the agent session and is locked while a run is active; the server restores the last active project on startup
- Deleting a project requires typing its name, unregisters it, and removes its session directory; the model endpoint stays global
- Manual context compaction: a "压缩上下文" button and a typed `/compact` both compact the viewed session, with pi's English refusal messages ("session too small", "already compacted") reported in Chinese
- Thinking-level control: the composer lists the levels the active model accepts and switches between them for the current session only
- Image input: paste a screenshot or pick image files, sent as base64 attachments and rendered in the transcript. The endpoint config now declares `input: ["text", "image"]`; without it pi silently dropped every attachment because the provider-model default is text only
- Built-in codemode and tool_search extensions, plus the MCP extension reading `mcp.json` from the agent directory and the project. Sessions now call `bindExtensions()`, which emits `session_start` and lets extensions contribute skills, prompt templates, and MCP servers
- Right-hand drawer with two tabs: container files and sub-agents
- File panel for the container work directory `/work`: browse with breadcrumbs, preview text and images, edit text inline, upload, download, rename, delete, and create directories. Every operation runs through `docker exec` in the project container, so the panel sees exactly what the agent's bash tool sees and keeps container root on bind mounts that are not user-mapped
- Paths are normalized against `/work` and rejected when they escape it; they reach the container as positional parameters, never interpolated into a script. Deletes and renames refuse the work root itself
- Sub-agent panel: every run of the current session with its status, mode, task, turn count, and duration; expanding a run shows the recorded process (assistant text, thinking, tool calls with output) plus its result
- Sub-agent runs and their process steps are stored permanently in SQLite (`<agentDir>/subagents.db`, `node:sqlite`), so a finished run stays reviewable after its in-memory session was disposed and across restarts; runs left `running` by a previous process are closed as interrupted
- Sub-agent controls: abort one run, or steer it with an appended instruction (`streamingBehavior: "steer"`)
- Added an end-to-end smoke suite that drives the full stack against a scripted local OpenAI-compatible endpoint: review-mode gating with an edited command, final-answer streaming, auto-mode passthrough, the container file panel, and sub-agent history. It installs a fake `docker` on PATH so the real container scripts run without Docker

### Changed

- Deleting the active project now detaches the runtime from it, so the console returns to the project-required screen instead of pointing at a deleted container
- Replaced the emoji and text glyphs the UI used as icons (⑂, ⤓, 🗀, ⛬, 🖼, ✏, ×, ▸/▾, ⌃/⌄, ↑) with `lucide-react`. All icons go through `webui/src/components/icons.tsx`, which pins size and stroke weight, so the composer pills, sidebar tabs, tool cards, branch tree, project picker, drawer and file panel now share one icon set

### Fixed

- Fixed sessions running with only `bash` and `spawn_agent`: the runtime's `baseToolsOverride` replaces the whole base tool set, so `read`, `edit`, and `write` must be named explicitly alongside the gated bash. The system prompt's tool section now lists all four with their snippets and guidelines instead of the custom tools alone.
- Fixed the context-overflow hint pointing at `/compact`, which pi only handles in interactive mode; the console now honors that command itself
- Concurrent bash tool calls previously surfaced only one approval at a time
- Saving a config with an empty API Key wrote `apiKey: ""`, which fails models.json validation and dropped every provider; unauthenticated endpoints now get a placeholder bearer Pi accepts (endpoints ignore it)

