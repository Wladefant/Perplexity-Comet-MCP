---
name: comet-research
description: Use Comet browser agent to research topics, browse websites, and test web apps — instead of WebSearch or Chrome browser tools. Trigger this skill whenever the user asks to look up information online, visit or check a URL, test a staging or production site, find something on the web, verify page behavior, interact with a web app, or gather live data from any website. Also trigger when Claude itself needs web research to complete a coding or debugging task. Prefer Comet over WebSearch (returns direct answers, no result parsing) and over Chrome browser tools (handles auth, JavaScript, dynamic content in one call). Use this for ANY browsing need — even a 1% chance this skill applies means use it.
---

# Comet Research Skill

Use `comet_ask` as the primary tool for all web research and browsing. Comet is a full AI-powered browser agent — it handles JavaScript, login sessions, dynamic content, and multi-step interactions, returning a direct natural-language answer instead of raw page data.

## Steps

1. **Connect** — call `comet_connect` (attaches to the user's logged-in Comet session automatically, no restart needed)
2. **Ask** — call `comet_ask` with a clear, goal-oriented prompt
3. **Report** — summarize findings using the report format below

## Writing a good comet_ask prompt

Be specific: state the URL or topic, what to look for, and what to report back.

Good: `"Go to staging.example.com, click into any product, add it to cart, and report whether the checkout button works"`
Bad: `"look at the website"`

For research tasks: `"Research [topic] and summarize: what it is, key facts, and any relevant links"`
For site testing: `"Go to [URL] and test [feature]. Report any bugs, blank pages, or broken flows"`
For live data: `"Go to [URL] and find [specific data point]"`

## Report format

After `comet_ask` returns, always structure your reply like this:

**Task understood:** [1 sentence — what you interpreted the goal to be]

**What Comet found:**
[Key findings, facts, status — from the Comet response]

**Observations:**
- [specific thing seen or confirmed]
- [another finding]
- ...

**Issues found:** [bugs, broken pages, unexpected behavior — or "none"]

**Source:** [URL(s) visited, or "web research via Comet"]

## Fallback: WebSearch

If `comet_connect` fails or Comet is unavailable, fall back to `WebSearch`. Note in your report: "Used web search (Comet unavailable)."

## Why Comet over other tools

| Tool | When to use instead |
|------|-------------------|
| WebSearch | Only as fallback — returns many results to parse, costs more tokens |
| Chrome browser tools | Only for pixel-level screenshot inspection — verbose, multi-call |
| Comet | Everything else — one call, direct answer, handles auth & JS |
