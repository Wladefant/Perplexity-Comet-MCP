#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";

interface SessionState {
  currentTaskId: string | null;
  taskStartTime: number | null;
  lastPrompt: string | null;
  lastResponse: string | null;
  lastResponseTime: number | null;
  steps: string[];
  isActive: boolean;
}

const sessionState: SessionState = {
  currentTaskId: null,
  taskStartTime: null,
  lastPrompt: null,
  lastResponse: null,
  lastResponseTime: null,
  steps: [],
  isActive: false,
};

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function startNewTask(prompt: string): string {
  const taskId = generateTaskId();
  sessionState.currentTaskId = taskId;
  sessionState.taskStartTime = Date.now();
  sessionState.lastPrompt = prompt;
  sessionState.lastResponse = null;
  sessionState.lastResponseTime = null;
  sessionState.steps = [];
  sessionState.isActive = true;
  cometAI.resetStabilityTracking();
  return taskId;
}

function completeTask(response: string): void {
  sessionState.lastResponse = response;
  sessionState.lastResponseTime = Date.now();
  sessionState.isActive = false;
}

function isSessionStale(): boolean {
  if (!sessionState.taskStartTime) return true;
  return Date.now() - sessionState.taskStartTime > 5 * 60 * 1000;
}

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description: "Connect to Comet browser (auto-starts if needed)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_ask",
    description: "Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Ideal for tasks requiring real browser interaction (login walls, dynamic content, filling forms) or deep research with agentic browsing.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
        context: { type: "string", description: "Optional context to include (e.g., file contents, codebase info, marketing guidelines). This will be prefixed to the prompt to give Comet full context." },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 120000 = 2min)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll",
    description: "Check agent status and progress. Call repeatedly to monitor agentic tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_stop",
    description: "Stop the current agent task if it's going off track",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_screenshot",
    description: "Capture a screenshot of current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_tabs",
    description: "View and manage browser tabs. Shows all open tabs with their purpose, domain, and status. Helps coordinate multi-tab workflows without creating duplicate tabs.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "switch", "close"],
          description: "Action to perform: 'list' (default) shows all tabs, 'switch' activates a tab, 'close' closes a tab",
        },
        domain: {
          type: "string",
          description: "For switch/close: domain to match (e.g., 'github.com')",
        },
        tabId: {
          type: "string",
          description: "For switch/close: specific tab ID",
        },
      },
    },
  },
  {
    name: "comet_mode",
    description: "Switch Perplexity mode. Current modes: 'search' (standard web search) and 'computer' (agentic browser mode). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "computer"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "comet_model",
    description: "Get or set the AI model used by Perplexity. Available models: 'best' (auto), 'sonar', 'gpt-5.4', 'gemini', 'claude-sonnet', 'claude-opus', 'kimi'. Call without model to see current model.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "Model to switch to (optional - omit to see current model). Partial names work: 'claude', 'gpt', 'gemini', 'sonar', 'kimi', 'best'",
        },
        thinking: {
          type: "boolean",
          description: "Enable or disable the Thinking toggle for Claude models (optional)",
        },
      },
    },
  },
  {
    name: "comet_upload",
    description: "Upload a file to a file input on the current page. Use this to attach images, documents, or other files to forms, posts, or upload dialogs. The file must exist on the local filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file to upload (e.g., '/home/user/image.png' or 'C:\\Users\\user\\image.png')",
        },
        selector: {
          type: "string",
          description: "Optional CSS selector for the file input element. If not provided, auto-detects the first file input on the page.",
        },
        checkOnly: {
          type: "boolean",
          description: "If true, only checks if file inputs exist on the page without uploading",
        },
      },
      required: ["filePath"],
    },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "2.6.2" },
  { capabilities: { tools: { listChanged: true } } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        const requestedAutomationConfig = cometClient.getAutomationConfig();
        const startResult = await cometClient.startComet(requestedAutomationConfig.port);
        const activeAutomationConfig = cometClient.getAutomationConfig();
        const mainTab = await cometClient.connectToAutomationMainTab();
        cometClient.setAutomationMainTabId(mainTab.id);

        console.error(`[comet] Connected automation session mode=${activeAutomationConfig.profileMode} port=${activeAutomationConfig.port} profile=${activeAutomationConfig.profileDir} userDataDir=${activeAutomationConfig.userDataDir} controlTab=${mainTab.id}`);

        return {
          content: [{
            type: "text",
            text: `${startResult}\nConnected automation session mode=${activeAutomationConfig.profileMode} profile=${activeAutomationConfig.profileDir} userDataDir=${activeAutomationConfig.userDataDir} with Perplexity control tab (${mainTab.id})`
          }]
        };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const context = args?.context as string | undefined;
        const maxTimeout = (args?.timeout as number) || 120000;
        const newChat = (args?.newChat as boolean) || false;

        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }

        if (context && context.trim().length > 0) {
          const contextPrefix = `Context for this task:\n\`\`\`\n${context.trim()}\n\`\`\`\n\nBased on the above context, `;
          prompt = contextPrefix + prompt;
        }

        startNewTask(prompt);

        try {
          await cometClient.preOperationCheck();
          await cometClient.connectToAutomationMainTab();
        } catch {
          try {
            await cometClient.startComet(cometClient.getAutomationConfig().port);
            await cometClient.connectToAutomationMainTab();
          } catch {
            return { content: [{ type: "text", text: "Error: Failed to establish connection to Comet browser" }] };
          }
        }

        prompt = prompt
          .replace(/^[-*•]\s*/gm, '')
          .replace(/\n+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        // Only add agentic browsing prefix when the prompt contains an explicit URL.
        // Common words like "check", "read", "open" in regular prompts should NOT
        // trigger the browsing transform — Perplexity handles agentic browsing on its own.
        const hasUrl = /https?:\/\/[^\s]+/.test(prompt);
        if (hasUrl) {
          const alreadyAgentic = /^(use your browser|using your browser|open a browser|navigate to|browse to)/i.test(prompt);
          if (!alreadyAgentic) {
            const urlMatch = prompt.match(/https?:\/\/[^\s]+/);
            if (urlMatch) {
              const url = urlMatch[0];
              const restOfPrompt = prompt.replace(url, '').trim();
              prompt = `Use your browser to navigate to ${url} and ${restOfPrompt || 'tell me what you find there'}`;
            }
          }
        }

        await cometClient.connectToAutomationMainTab();

        if (newChat) {
          await cometClient.ensureConnection();
          const mainTab = await cometClient.connectToAutomationMainTab();
          cometClient.setAutomationMainTabId(mainTab.id);
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 2200));
        } else {
          const mainTab = await cometClient.connectToAutomationMainTab();
          cometClient.setAutomationMainTabId(mainTab.id);

          const urlResult = await cometClient.evaluate('window.location.href');
          const currentUrl = urlResult.result.value as string;
          if (!currentUrl?.includes('perplexity.ai')) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        const askAutomationConfig = cometClient.getAutomationConfig();
        console.error(`[comet] Ask using automation controlTab=${cometClient.getAutomationMainTabId() || 'unknown'} port=${askAutomationConfig.port} profile=${askAutomationConfig.profileDir}`);

        cometAI.resetStabilityTracking();

        const oldUrlResult = await cometClient.evaluate('window.location.href');
        const oldUrl = (oldUrlResult.result.value as string) || '';

        const oldStateResult = await cometClient.evaluate(`
          (() => {
            const proseEls = document.querySelectorAll('[class*="prose"]');
            const lastProse = proseEls[proseEls.length - 1];
            return {
              count: proseEls.length,
              lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
            };
          })()
        `);
        const oldState = oldStateResult.result.value as { count: number; lastText: string };

        await cometAI.sendPrompt(prompt);

        const startTime = Date.now();
        const stepsCollected: string[] = [];
        let sawNewResponse = false;
        let lastActivityTime = Date.now();
        let previousResponse = '';
        const POLL_INTERVAL = 500;
        const IDLE_TIMEOUT = 2000;
        let consecutiveErrors = 0;
        const MAX_CONSECUTIVE_ERRORS = 5;

        while (Date.now() - startTime < maxTimeout) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

          try {
            const status = await cometClient.withAutomationMainTab(async () => {
              const currentStateResult = await cometClient.withAutoReconnect(async () => {
                return await cometClient.evaluate(`
                  (() => {
                    const proseEls = document.querySelectorAll('[class*="prose"]');
                    const lastProse = proseEls[proseEls.length - 1];
                    return {
                      count: proseEls.length,
                      lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
                    };
                  })()
                `);
              });
              const currentState = currentStateResult.result.value as { count: number; lastText: string };

              if (!sawNewResponse) {
                // Check URL change (most reliable signal — home → search results)
                try {
                  const curUrlResult = await cometClient.evaluate('window.location.href');
                  const curUrl = (curUrlResult.result.value as string) || '';
                  if (curUrl !== oldUrl && curUrl.includes('/search/')) {
                    sawNewResponse = true;
                  }
                } catch { /* continue with prose check */ }

                // Also check prose element changes
                if (currentState.count > oldState.count ||
                    (currentState.lastText && currentState.lastText !== oldState.lastText)) {
                  sawNewResponse = true;
                }
              }

              return await cometAI.getAgentStatus();
            });

            consecutiveErrors = 0;

            if (status.response !== previousResponse) {
              lastActivityTime = Date.now();
              previousResponse = status.response;
            }

            for (const step of status.steps) {
              if (!stepsCollected.includes(step)) {
                stepsCollected.push(step);
                lastActivityTime = Date.now();
              }
            }

            sessionState.steps = stepsCollected;

            if (status.status === 'completed' && sawNewResponse && status.response) {
              completeTask(status.response);
              return { content: [{ type: "text", text: status.response }] };
            }

            if (status.isStable && sawNewResponse && status.response && !status.hasStopButton) {
              completeTask(status.response);
              return { content: [{ type: "text", text: status.response }] };
            }

            const idleTime = Date.now() - lastActivityTime;
            if (idleTime > IDLE_TIMEOUT && sawNewResponse && status.response && status.response.length > 10 && !status.hasStopButton) {
              completeTask(status.response);
              return { content: [{ type: "text", text: status.response }] };
            }
          } catch {
            consecutiveErrors++;

            try {
              await cometClient.connectToAutomationMainTab();
              consecutiveErrors = Math.max(0, consecutiveErrors - 1);
              continue;
            } catch {
              // Continue to fallback recovery.
            }

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              try {
                await cometClient.ensureConnection();
                await cometClient.connectToAutomationMainTab();
                consecutiveErrors = 0;
              } catch {
                break;
              }
            }
          }
        }

        let finalStatus;
        try {
          finalStatus = await cometClient.withAutomationMainTab(async () => cometAI.getAgentStatus());
        } catch {
          // Status check failed — fall through to timeout message
        }
        if (finalStatus?.response && finalStatus.response.length > 0) {
          completeTask(finalStatus.response);
          return { content: [{ type: "text", text: finalStatus.response }] };
        }

        let inProgressMsg = `Task may still be in progress (max timeout reached).\n`;
        inProgressMsg += `Status: ${finalStatus?.status?.toUpperCase() || 'UNKNOWN'}\n`;
        if (finalStatus?.currentStep) {
          inProgressMsg += `Current: ${finalStatus.currentStep}\n`;
        }
        if (stepsCollected.length > 0) {
          inProgressMsg += `\nSteps:\n${stepsCollected.map(s => `  • ${s}`).join('\n')}\n`;
        }
        inProgressMsg += `\nUse comet_poll to check progress or comet_stop to cancel.`;

        sessionState.steps = stepsCollected;
        return { content: [{ type: "text", text: inProgressMsg }] };
      }

      case "comet_poll": {
        if (!sessionState.isActive && !sessionState.currentTaskId) {
          return { content: [{ type: "text", text: "Status: IDLE\nNo active task. Use comet_ask to start a new task." }] };
        }

        if (isSessionStale() && !sessionState.isActive) {
          return { content: [{ type: "text", text: "Status: IDLE\nPrevious task session expired. Use comet_ask to start a new task." }] };
        }

        if (!sessionState.isActive && sessionState.lastResponse) {
          const timeSinceComplete = sessionState.lastResponseTime
            ? Math.round((Date.now() - sessionState.lastResponseTime) / 1000)
            : 0;
          return { content: [{ type: "text", text: `Status: COMPLETED (${timeSinceComplete}s ago)\n\n${sessionState.lastResponse}` }] };
        }

        const status = await cometClient.withAutomationMainTab(async () => cometAI.getAgentStatus());

        if (status.status === 'completed' && status.response) {
          completeTask(status.response);
          return { content: [{ type: "text", text: status.response }] };
        }

        let output = `Status: ${status.status.toUpperCase()}\n`;
        if (sessionState.currentTaskId) {
          output += `Task: ${sessionState.currentTaskId}\n`;
        }
        if (status.agentBrowsingUrl) {
          output += `Browsing: ${status.agentBrowsingUrl}\n`;
        }
        if (status.currentStep) {
          output += `Current: ${status.currentStep}\n`;
        }

        const allSteps = [...new Set([...sessionState.steps, ...status.steps])];
        if (allSteps.length > 0) {
          output += `\nSteps:\n${allSteps.map(s => `  • ${s}`).join('\n')}\n`;
        }

        if (status.status === 'working' || sessionState.isActive) {
          output += `\n[Use comet_stop to interrupt, or comet_screenshot to see current page]`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_stop": {
        const stopped = await cometClient.withAutomationMainTab(async () => cometAI.stopAgent());
        if (stopped) {
          sessionState.isActive = false;
        }
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "comet_screenshot": {
        const result = await cometClient.screenshot("png");
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }

      case "comet_tabs": {
        const action = (args?.action as string) || 'list';
        const domain = args?.domain as string | undefined;
        const tabId = args?.tabId as string | undefined;

        switch (action) {
          case 'list': {
            const summary = await cometClient.getTabSummary();
            return { content: [{ type: "text", text: summary }] };
          }

          case 'switch': {
            if (tabId) {
              await cometClient.connect(tabId);
              return { content: [{ type: "text", text: `Switched to tab: ${tabId}` }] };
            }
            if (domain) {
              const tab = await cometClient.findTabByDomain(domain);
              if (tab) {
                await cometClient.connect(tab.id);
                return { content: [{ type: "text", text: `Switched to ${tab.domain} (${tab.url})` }] };
              }
              return { content: [{ type: "text", text: `No tab found for domain: ${domain}` }], isError: true };
            }
            return { content: [{ type: "text", text: "Specify domain or tabId to switch" }], isError: true };
          }

          case 'close': {
            if (tabId) {
              if (await cometClient.isAutomationMainTab(tabId)) {
                return { content: [{ type: "text", text: "Cannot close the Perplexity control tab" }], isError: true };
              }

              const closableCount = await cometClient.getClosableTabCount();
              if (closableCount <= 0) {
                return { content: [{ type: "text", text: "Cannot close - no closable browsing tabs are open." }], isError: true };
              }

              const success = await cometClient.closeTrackedTab(tabId);
              return { content: [{ type: "text", text: success ? `Closed tab: ${tabId}` : `Failed to close tab` }] };
            }

            if (domain) {
              const tab = await cometClient.findTabByDomain(domain);
              if (tab && tab.purpose !== 'main') {
                const success = await cometClient.closeTrackedTab(tab.id);
                return { content: [{ type: "text", text: success ? `Closed ${tab.domain}` : `Failed to close tab` }] };
              }
              if (tab?.purpose === 'main') {
                return { content: [{ type: "text", text: "Cannot close the Perplexity control tab" }], isError: true };
              }
              return { content: [{ type: "text", text: `No tab found for domain: ${domain}` }], isError: true };
            }

            return { content: [{ type: "text", text: "Specify domain or tabId to close" }], isError: true };
          }

          default:
            return { content: [{ type: "text", text: `Unknown action: ${action}. Use: list, switch, close` }], isError: true };
        }
      }

      case "comet_mode": {
        const mode = args?.mode as string | undefined;

        // Ensure we're on the home page (sidebar modes only show there)
        await cometClient.withAutomationMainTab(async () => {
          const state = cometClient.currentState;
          if (!state.currentUrl?.includes('perplexity.ai')) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 1200));
          }
        });

        if (!mode) {
          // Detect current mode from the highlighted sidebar link
          const result = await cometClient.withAutomationMainTab(async () => cometClient.evaluate(`
            (function() {
              // Active sidebar link has a highlighted background class
              const links = [...document.querySelectorAll('a')].filter(a => a.getBoundingClientRect().height > 0);
              for (const link of links) {
                const text = link.innerText.trim().toLowerCase();
                if ((text === 'search' || text === 'computer') && link.closest('nav')) {
                  const classes = link.className || '';
                  if (classes.includes('bg-') || link.parentElement?.className?.includes('bg-')) {
                    return text;
                  }
                }
              }
              // Fallback: check the Computer button in the input toolbar
              const computerBtn = document.querySelector('button[aria-label="Computer"]');
              if (computerBtn && computerBtn.getAttribute('data-state') === 'on') return 'computer';
              return 'search';
            })()
          `));

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Standard web search',
            computer: 'Agentic browser mode (Computer use)',
          };
          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            output += `${m === currentMode ? '→' : ' '} ${m}: ${desc}\n`;
          }
          return { content: [{ type: "text", text: output }] };
        }

        if (mode !== 'search' && mode !== 'computer') {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Current Perplexity modes are: search, computer` }],
            isError: true,
          };
        }

        // Click the sidebar link for the desired mode
        const switchResult = await cometClient.withAutomationMainTab(async () => cometClient.evaluate(`
          (function() {
            const desired = '${mode}';
            // Find sidebar nav links (Search / Computer)
            const links = [...document.querySelectorAll('nav a')].filter(a => a.getBoundingClientRect().height > 0);
            for (const link of links) {
              if (link.innerText.trim().toLowerCase() === desired) {
                link.click();
                return { success: true };
              }
            }
            // Fallback: check input toolbar Computer toggle button
            if (desired === 'computer') {
              const btn = document.querySelector('button[aria-label="Computer"]');
              if (btn) { btn.click(); return { success: true }; }
            }
            return { success: false, available: [...document.querySelectorAll('nav a')].map(a => a.innerText.trim()).filter(t => t).join(', ') };
          })()
        `));

        const switchRes = switchResult.result.value as { success: boolean; available?: string };
        if (switchRes.success) {
          return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
        }
        return {
          content: [{ type: "text", text: `Failed to switch mode. Available sidebar links: ${switchRes.available || 'none found'}` }],
          isError: true,
        };
      }

      case "comet_model": {
        const modelArg = (args?.model as string | undefined)?.toLowerCase().trim();
        const thinkingArg = args?.thinking as boolean | undefined;

        // Ensure we're on perplexity home
        await cometClient.withAutomationMainTab(async () => {
          const state = cometClient.currentState;
          if (!state.currentUrl?.includes('perplexity.ai')) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 1200));
          }
        });

        // Model button is identified by its aria-label containing a known model keyword
        const MODEL_KEYWORDS = ['claude', 'gpt', 'sonar', 'gemini', 'kimi', 'best'];
        const currentModelResult = await cometClient.withAutomationMainTab(async () => cometClient.evaluate(`
          (function() {
            const keywords = ${JSON.stringify(MODEL_KEYWORDS)};
            const btn = [...document.querySelectorAll('button')].find(b => {
              if (!b.getBoundingClientRect().height) return false;
              const label = (b.getAttribute('aria-label') || '').toLowerCase();
              return keywords.some(k => label.includes(k)) || label === 'model';
            });
            return btn ? { label: btn.getAttribute('aria-label'), text: btn.innerText?.trim() } : null;
          })()
        `));
        const currentModel = currentModelResult.result.value as { label: string; text: string } | null;

        if (!modelArg && thinkingArg === undefined) {
          const name = currentModel?.label || currentModel?.text || 'unknown';
          return { content: [{ type: "text", text: `Current model: ${name}\n\nAvailable models: best, sonar, gpt-5.4, gemini, claude-sonnet, claude-opus, kimi` }] };
        }

        // All picker interaction happens in a single withAutomationMainTab call to avoid
        // CDP reconnects closing the popover between operations.
        const aliases: Record<string, string> = {
          'best': 'best', 'auto': 'best',
          'sonar': 'sonar',
          'gpt': 'gpt', 'gpt-5.4': 'gpt-5.4', 'gpt5': 'gpt-5.4',
          'gemini': 'gemini', 'google': 'gemini',
          'claude': 'claude sonnet', 'claude-sonnet': 'claude sonnet',
          'claude-opus': 'claude opus', 'opus': 'claude opus',
          'kimi': 'kimi',
        };
        const targetText = modelArg ? (aliases[modelArg] || modelArg) : '';

        const pickerResult = await cometClient.withAutomationMainTab(async () => {
          // Step 1: click the model button
          const opened = await cometClient.clickAtCoords(`
            (function() {
              const keywords = ${JSON.stringify(MODEL_KEYWORDS)};
              const btn = [...document.querySelectorAll('button')].find(b => {
                if (!b.getBoundingClientRect().height) return false;
                const label = (b.getAttribute('aria-label') || '').toLowerCase();
                return keywords.some(k => label.includes(k)) || label === 'model';
              });
              if (!btn) return null;
              const r = btn.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()
          `);
          if (!opened) return { error: 'no-button' };

          // Step 2: wait for picker to open
          await new Promise(resolve => setTimeout(resolve, 1200));

          // Step 3: handle thinking toggle if requested (same open picker)
          if (thinkingArg !== undefined) {
            const toggleR = await cometClient.evaluate(`
              (function() {
                const toggle = [...document.querySelectorAll('[role="menuitemcheckbox"]')]
                  .find(e => e.getBoundingClientRect().height > 0 && (e.innerText || '').toLowerCase().includes('thinking'));
                if (!toggle) return null;
                const isOn = toggle.getAttribute('aria-checked') === 'true' || toggle.getAttribute('data-state') === 'checked';
                const wantOn = ${thinkingArg};
                if (isOn !== wantOn) toggle.click();
                return { toggled: isOn !== wantOn, nowOn: wantOn };
              })()
            `);
            const toggleRes = toggleR.result.value;
            if (!modelArg) {
              await new Promise(resolve => setTimeout(resolve, 200));
              await cometClient.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
              return { thinking: thinkingArg, thinkingResult: toggleRes };
            }
          }

          if (!modelArg) {
            await cometClient.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
            return { thinking: thinkingArg };
          }

          // Step 4: find target model in picker
          const target = targetText.toLowerCase();
          const queryR = await cometClient.evaluate(`
            (function() {
              const target = '${target}';
              const items = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="menuitemcheckbox"]')]
                .filter(e => e.getBoundingClientRect().height > 0);
              if (items.length === 0) return { pickerClosed: true };
              const matches = items
                .map(e => ({ text: (e.innerText || '').trim().toLowerCase(), rect: e.getBoundingClientRect() }))
                .filter(({ text: t }) => t.startsWith(target))
                .sort((a, b) => a.text.length - b.text.length);
              if (matches.length > 0) {
                const r = matches[0].rect;
                return { x: r.x + r.width / 2, y: r.y + r.height / 2, matched: matches[0].text.split('\\n')[0].substring(0, 40) };
              }
              const visible = items.map(e => (e.innerText || '').trim().split('\\n')[0].substring(0, 20));
              return { notFound: true, visible: [...new Set(visible)].join(', ') };
            })()
          `);
          const sel = queryR.result.value as { x?: number; y?: number; matched?: string; notFound?: boolean; visible?: string; pickerClosed?: boolean } | undefined;
          if (!sel || sel.pickerClosed || sel.notFound) return sel ?? { error: 'query-failed' };

          // Step 5: click the model item
          await cometClient.clickAtCoords(`({ x: ${sel.x}, y: ${sel.y} })`);
          return { switched: sel.matched };
        });

        if (!pickerResult) return { content: [{ type: "text", text: 'Picker interaction failed' }], isError: true };
        if ('error' in pickerResult) {
          const msg = pickerResult.error === 'no-button' ? 'Could not find model button' : 'Picker query failed';
          return { content: [{ type: "text", text: msg }], isError: true };
        }
        if ('thinking' in pickerResult) {
          return { content: [{ type: "text", text: `Thinking ${pickerResult.thinking ? 'enabled' : 'disabled'}` }] };
        }
        if ('pickerClosed' in pickerResult) {
          return { content: [{ type: "text", text: 'Could not open model picker' }], isError: true };
        }
        if ('notFound' in pickerResult) {
          return { content: [{ type: "text", text: `Model "${modelArg}" not found. Options: ${pickerResult.visible}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Switched to model: ${(pickerResult as { switched: string }).switched}` }] };
      }

      case "comet_upload": {
        const filePath = args?.filePath as string;
        const selector = args?.selector as string | undefined;
        const checkOnly = args?.checkOnly as boolean | undefined;

        if (!filePath) {
          return { content: [{ type: "text", text: "Error: filePath is required" }], isError: true };
        }

        const fs = await import('fs');
        if (!fs.existsSync(filePath)) {
          return { content: [{ type: "text", text: `Error: File not found: ${filePath}` }], isError: true };
        }

        if (checkOnly) {
          const inputInfo = await cometClient.hasFileInput();
          if (inputInfo.found) {
            let msg = `Found ${inputInfo.count} file input(s) on the page:\n`;
            msg += inputInfo.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
            msg += `\n\nUse comet_upload with filePath to upload to one of these inputs.`;
            return { content: [{ type: "text", text: msg }] };
          }
          return { content: [{ type: "text", text: "No file input elements found on the current page. Navigate to a page with a file upload form first." }] };
        }

        const result = await cometClient.uploadFile(filePath, selector);

        if (result.success) {
          return { content: [{ type: "text", text: result.message }] };
        }

        if (!result.inputFound) {
          const inputInfo = await cometClient.hasFileInput();
          let msg = result.message;
          if (inputInfo.found) {
            msg += `\n\nAvailable file inputs:\n${inputInfo.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
            msg += `\n\nTry specifying a selector parameter.`;
          }
          return { content: [{ type: "text", text: msg }], isError: true };
        }

        return { content: [{ type: "text", text: result.message }], isError: true };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
