---
name: issue-driven-task
description: Use GitHub issues as the default task record before implementing non-trivial work. Trigger this whenever work should be tracked visibly, when roadmap items need to become executable tasks, or when you would otherwise create a local markdown plan that could fit in an issue instead.
---

# Issue-Driven Task

Default to GitHub issues for scoped work.

## When to use local markdown instead
Use a local design or plan document only when the work is architectural enough that the issue body cannot hold the necessary context cleanly.

## Workflow
1. Check whether a relevant GitHub issue already exists.
2. If none exists and GitHub MCP is available, create a focused issue with:
   - scope
   - acceptance criteria
   - any constraints that matter
3. Use the issue as the main execution record.
4. Keep progress visible in GitHub rather than storing the working state only in local markdown.
5. Finish in a PR-oriented state when appropriate.

## Reporting expectations
Before claiming completion, summarize:
- which issue the work belongs to
- what changed
- what verification ran
- what still remains
