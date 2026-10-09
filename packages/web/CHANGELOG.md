# Changelog

## [Unreleased]

### Added

- Initial release of the ZGAgent web console: HTTP + WebSocket server embedding the coding-agent SDK, a Chinese React control console (streaming chat, tool cards, session list, mode switch), the bash approval gate with command editing for review mode, and OpenAI-compatible endpoint configuration persisted to `~/.zgagent/agent/models.json`
- Added an end-to-end smoke suite that drives the full stack against a scripted local OpenAI-compatible endpoint: review-mode gating with an edited command, final-answer streaming, and auto-mode passthrough

### Added (round 2 polish)

- Approval queue: every pending command is listed with per-item edit/approve/reject plus approve-all and reject-all
- Session-scoped command-prefix allowlist: approve with "always allow this prefix" or manage prefixes in the sidebar; compound commands (&&, ;, |, substitution) never match the allowlist
- Endpoint test connection with actionable Chinese diagnostics (timeout, 401/403, 404 path hint, unknown model); an empty API key no longer invalidates models.json
- Tool output upgrades: copy command, copy output, fullscreen viewer with line filtering
- Session branching UI: tree drawer plus inline "fork from here" on user messages
- Usage panel (input/output/cache tokens and cost) refreshed after each run
- `get_state` protocol message for pulling a fresh snapshot on demand

### Added (sub-agent support)

- Added the `spawn_agent` tool: the main agent can delegate self-contained tasks (e.g. per-host recon) to isolated in-memory sub-agent sessions with a turn budget; "explore" mode is read-only, "act" mode shares the operator approval gate (approval requests are labeled with their source), and sub-agents cannot spawn further sub-agents

### Added (projects)

- Added project management: named working directories persisted in `~/.zgagent/agent/projects.json`, selected from a picker at the top of the sidebar; sessions, context files, and the bash cwd follow the project automatically
- Switching projects rebuilds the agent session and is locked while a run is active; the server restores the last active project on startup
- Deleting a project requires typing its name, unregisters it, and removes its session directory; the model endpoint stays global

### Fixed

- Fixed sessions running with only `bash` and `spawn_agent`: the runtime's `baseToolsOverride` replaces the whole base tool set, so `read`, `edit`, and `write` must be named explicitly alongside the gated bash. The system prompt's tool section now lists all four with their snippets and guidelines instead of the custom tools alone.

### Fixed (round 2 polish)

- Concurrent bash tool calls previously surfaced only one approval at a time
- Saving a config with an empty API Key wrote `apiKey: ""`, which fails models.json validation and dropped every provider; unauthenticated endpoints now get a placeholder bearer Pi accepts (endpoints ignore it)
