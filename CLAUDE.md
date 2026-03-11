# Perplexity-Comet-MCP — Project Instructions

## Comet Profile Mode (CRITICAL)
When using Comet MCP tools (`comet_connect`, `comet_ask`, etc.):
- **ALWAYS set `COMET_PROFILE_MODE=default`** before connecting
- This uses the user's logged-in Comet session, not an isolated throwaway instance
- If Comet is already running with CDP on ports 9222-9225, connect to the existing instance
- NEVER launch isolated mode unless explicitly asked
- `COMET_FORCE_RESTART=true` is opt-in only — never set it without being asked

## Tab Behavior (CRITICAL)
- **Always open a fresh Perplexity tab** for automation — never scan or reuse existing user tabs
- The only exception: reuse `automationMainTabId` if the same session is still alive (reconnect case)
- This avoids hijacking tabs the user is actively using

## Testing the MCP Server Locally
To test without restarting Claude Code, spawn the server directly via JSON-RPC over stdin:
```js
// spawn with env var (no longer needed — default is now default-profile)
const server = spawn('node', ['dist/index.js'], {
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'inherit'],
});
// send JSON-RPC messages line by line over server.stdin
// read responses from server.stdout
```
This is the canonical way to smoke-test MCP tools mid-session without a full restart.

## Git Workflow
- `origin` = RapierCraft (upstream, read-only)
- `fork` = Wladefant (push target)
- `main` tracks `fork/main`
- Use rebase, never squash merge
- Create GitHub issues before implementing fixes
- Don't commit `.claude/` directory contents
