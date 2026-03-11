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
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (analytics/visualization), 'learn' (educational). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Mode to switch to (optional - omit to see current mode)",
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
  { name: "comet-bridge", version: "2.5.0" },
  { capabilities: { tools: {} } }
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

        if (!mode) {
          const result = await cometClient.withAutomationMainTab(async () => cometClient.evaluate(`
            (() => {
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const mode of modes) {
                const btn = document.querySelector('button[aria-label="' + mode + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return mode.toLowerCase();
                }
              }
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('search')) return 'search';
                if (text.includes('research')) return 'research';
                if (text.includes('labs')) return 'labs';
                if (text.includes('learn')) return 'learn';
              }
              return 'search';
            })()
          `));

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Analytics, visualizations, and coding',
            learn: 'Educational content and explanations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "→" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Research",
          labs: "Labs",
          learn: "Learn",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to home page for mode switching (modes are on the main search page)
        await cometClient.withAutomationMainTab(async () => {
          const state = cometClient.currentState;
          if (!state.currentUrl || !state.currentUrl.match(/perplexity\.ai\/?$/)) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        });

        const result = await cometClient.withAutomationMainTab(async () => {
          return cometClient.evaluate(`
            (() => {
              // Try direct aria-label buttons first (old UI)
              const directBtn = document.querySelector('button[aria-label="${ariaLabel}"]');
              if (directBtn) {
                directBtn.click();
                return { success: true, method: 'direct-button' };
              }

              // Try finding any button that could open a mode/model menu
              const menuButton = [...document.querySelectorAll('button')].find(btn => {
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                const text = (btn.innerText || '').trim().toLowerCase();
                return aria === 'model' || text === 'model' ||
                       aria.includes('search mode') || aria.includes('focus') ||
                       text === 'search' || text === 'research' || text === 'labs' || text === 'learn';
              });

              if (menuButton) {
                // If this button IS the desired mode, just click it
                const btnText = (menuButton.innerText || '').trim().toLowerCase();
                if (btnText === '${mode}'.toLowerCase()) {
                  menuButton.click();
                  return { success: true, method: 'direct-mode-button' };
                }
                menuButton.click();
                return { success: true, method: 'model-menu', needsSelect: true };
              }

              return { success: false, error: "Mode selector not found on page. Navigate to perplexity.ai first." };
            })()
          `);
        });

        const clickResult = result.result.value as { success: boolean; method?: string; needsSelect?: boolean; error?: string };

        if (clickResult.success && clickResult.needsSelect) {
          // Wait for dropdown/popover to render
          await new Promise(resolve => setTimeout(resolve, 600));

          // Try selecting the mode from the dropdown with retries
          for (let attempt = 0; attempt < 3; attempt++) {
            const selectResult = await cometClient.withAutomationMainTab(async () => cometClient.evaluate(`
              (() => {
                const desired = '${mode}'.toLowerCase();
                // Search for clickable elements matching the desired mode
                // Use leaf-node links/buttons first (most specific), then broaden
                const selectors = ['a', 'button', '[role="menuitem"]', '[role="option"]', 'div[role="button"]', 'label'];
                for (const sel of selectors) {
                  const items = [...document.querySelectorAll(sel)];
                  for (const item of items) {
                    const text = (item.innerText || '').trim().toLowerCase();
                    const aria = (item.getAttribute?.('aria-label') || '').trim().toLowerCase();
                    const rect = item.getBoundingClientRect();
                    const isVisible = rect.height > 0 && rect.width > 0;
                    // Match: exact text match or text starts with desired mode
                    if (isVisible && text.length < 40 && (text === desired || aria === desired)) {
                      item.click();
                      return { success: true, matched: text || aria };
                    }
                  }
                }
                // Fallback: partial match (text starts with desired)
                for (const sel of selectors) {
                  const items = [...document.querySelectorAll(sel)];
                  for (const item of items) {
                    const text = (item.innerText || '').trim().toLowerCase();
                    const aria = (item.getAttribute?.('aria-label') || '').trim().toLowerCase();
                    const rect = item.getBoundingClientRect();
                    const isVisible = rect.height > 0 && rect.width > 0;
                    if (isVisible && text.length < 40 && (text.startsWith(desired) || aria.startsWith(desired))) {
                      item.click();
                      return { success: true, matched: text || aria };
                    }
                  }
                }
                // Debug info
                const visibleLinks = [...document.querySelectorAll('a, button')].filter(e => e.getBoundingClientRect().height > 0).map(e => e.innerText.trim().substring(0, 30)).filter(t => t.length > 0 && t.length < 30);
                return { success: false, error: "Mode option not found in dropdown", visibleOptions: visibleLinks.slice(0, 15).join(', ') };
              })()
            `));
            const selectRes = selectResult.result.value as { success: boolean; error?: string; matched?: string; visibleOptions?: string };
            if (selectRes.success) {
              return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
            }
            if (attempt < 2) {
              await new Promise(resolve => setTimeout(resolve, 400));
            } else {
              return { content: [{ type: "text", text: `Failed: ${selectRes.error}${selectRes.visibleOptions ? ` (visible: ${selectRes.visibleOptions})` : ''}` }], isError: true };
            }
          }
        }

        if (clickResult.success) {
          return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
        }

        return {
          content: [{ type: "text", text: `Failed to switch mode: ${clickResult.error}` }],
          isError: true,
        };
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
