# Perplexity-Comet-MCP — Project Instructions

## Comet Profile Mode (CRITICAL)
- **ALWAYS use `COMET_PROFILE_MODE=default`** — uses the user's logged-in Comet session
- If Comet is already running with CDP on ports 9222-9225, connect to the existing instance
- NEVER launch isolated mode unless explicitly asked
- `COMET_FORCE_RESTART=true` is opt-in only

## Tab & Window Behavior (CRITICAL)
- **Always open a fresh Perplexity tab** — never scan or reuse existing user tabs
- Only exception: reuse `automationMainTabId` if the same session is still alive (reconnect)
- Goal: MCP should use a **separate window** from the user's browsing (same profile, own window) — see #11
- Be careful: user may have multiple Perplexity accounts; new tabs can land on wrong account

## Perplexity UI Selectors (as of 2026-03-11)
These selectors change frequently. When broken, use Comet MCP to inspect current DOM.
- **Model picker button**: `button[aria-label="<ModelName>"]` or `button[aria-label="Model"]` (non-Pro)
- **Model picker items**: `div[role="menuitemradio"]`, `div[role="menuitem"]` — only exist when picker is open
- **Thinking toggle**: `div[role="menuitemcheckbox"]` containing "Thinking"
- **Mode nav links**: `nav a` in sidebar — currently "Search" and "Computer" only (Research/Labs/Learn removed)
- **File upload**: `button[aria-label="Add files or tools"]`, `input[type="file"]`
- **Text input**: textarea with placeholder "Ask anything..."
- React uses Radix UI popovers — `.click()` via Runtime.evaluate does NOT work. Must use `Input.dispatchMouseEvent` (native mouse events) via `clickAtCoords()` helper.
- Picker popover needs ~1200ms to fully render after clicking the model button.
- Each CDP `connect()` call triggers `Browser.setWindowBounds` which can close open popovers. The `connect()` method skips reconnect if already connected to the same target.

## Dev Workflow: Hot-Reload with mcpmon (#14)
The MCP server is wrapped with `mcpmon` which auto-restarts on file changes:
```bash
# Start TypeScript watcher in one terminal:
npm run dev    # runs tsc --watch

# .mcp.json wraps the server with mcpmon:
# mcpmon --watch dist/ --ext js -- node dist/index.js
# Claude Code stays connected through restarts.
```
- After saving a .ts file, tsc recompiles → mcpmon detects dist/ change → server restarts → tools refresh
- No Claude Code restart needed for code changes
- New tool definitions may need `/mcp` → server → Reconnect
- **Do NOT spawn test subprocess servers** — use the live MCP tools directly to verify changes

## Git Workflow
- `origin` = RapierCraft (upstream, read-only)
- `fork` = Wladefant (push target)
- `main` tracks `fork/main`
- Use rebase, never squash merge
- Create GitHub issues before implementing fixes
- Don't commit `.claude/` directory contents

## Open Issues
- #7: comet_mode — IMPLEMENTED (Search/Computer), needs commit
- #8: comet_upload — fix applied (React event dispatch), needs verification
- #9: comet_model — IMPLEMENTED (model switch + thinking toggle), needs commit
- #10: global plugin setup — registered but needs session restart to verify
- #11: separate MCP window from user's window (same profile)
- #12: model button generic "Model" label fix — applied
- #13: audit all Perplexity selectors via Comet MCP
