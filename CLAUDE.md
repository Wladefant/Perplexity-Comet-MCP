# Perplexity-Comet-MCP — Project Instructions

## Comet Profile Mode (CRITICAL)
When using Comet MCP tools (`comet_connect`, `comet_ask`, etc.):
- **ALWAYS set `COMET_PROFILE_MODE=default`** before connecting
- This uses the user's logged-in Comet session, not an isolated throwaway instance
- If Comet is already running with CDP on ports 9222-9225, connect to the existing instance
- NEVER launch isolated mode unless explicitly asked
- `COMET_FORCE_RESTART=true` is opt-in only — never set it without being asked

## Git Workflow
- `origin` = RapierCraft (upstream, read-only)
- `fork` = Wladefant (push target)
- `main` tracks `fork/main`
- Use rebase, never squash merge
- Create GitHub issues before implementing fixes
- Don't commit `.claude/` directory contents
