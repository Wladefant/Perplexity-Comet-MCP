// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";

// Input selectors - contenteditable div is primary for Perplexity
const INPUT_SELECTORS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

export class CometAI {
  /**
   * Find the first matching element from a list of selectors
   */
  private async findInputElement(): Promise<string | null> {
    for (const selector of INPUT_SELECTORS) {
      const result = await cometClient.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);
      if (result.result.value === true) {
        return selector;
      }
    }
    return null;
  }

  private async getInputContentState(inputSelector: string): Promise<{ hasContent: boolean; value: string; elementType: string }> {
    const result = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(inputSelector)});
        if (!el) return { hasContent: false, value: '', elementType: 'missing' };

        if (el.matches('[contenteditable="true"]')) {
          const value = el.innerText.trim();
          return { hasContent: value.length > 0, value, elementType: 'contenteditable' };
        }

        if (el instanceof HTMLTextAreaElement) {
          const value = el.value.trim();
          return { hasContent: value.length > 0, value, elementType: 'textarea' };
        }

        if (el instanceof HTMLInputElement && el.type === 'text') {
          const value = el.value.trim();
          return { hasContent: value.length > 0, value, elementType: 'text-input' };
        }

        return { hasContent: false, value: '', elementType: 'unsupported' };
      })()
    `);

    return (result.result.value as { hasContent: boolean; value: string; elementType: string }) || { hasContent: false, value: '', elementType: 'missing' };
  }

  private async verifyInputHasContent(inputSelector: string): Promise<boolean> {
    const state = await this.getInputContentState(inputSelector);
    return state.hasContent;
  }

  private async isPromptSubmitted(inputSelector: string): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(inputSelector)});
        const hasLoading = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;

        // Check for "Thinking" as a status indicator, excluding model names
        let hasThinking = false;
        const body = document.body.innerText;
        const thinkIdx = body.indexOf('Thinking');
        if (thinkIdx !== -1) {
          const before = body.substring(Math.max(0, thinkIdx - 30), thinkIdx);
          const isModelName = before.includes('Sonnet') || before.includes('Opus') ||
            before.includes('Claude') || before.includes('Haiku') ||
            before.includes('4.6') || before.includes('4.5') || before.includes('3.5');
          hasThinking = !isModelName;
        }

        // URL change is a strong signal (home -> search results)
        const urlChanged = window.location.pathname.startsWith('/search/');

        if (!el) return hasLoading || hasThinking || urlChanged;

        let remainingLength = 999;
        if (el.matches('[contenteditable="true"]')) {
          remainingLength = el.innerText.trim().length;
        } else if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text')) {
          remainingLength = el.value.trim().length;
        }

        return remainingLength < 5 || hasLoading || hasThinking || urlChanged;
      })()
    `);

    return Boolean(result.result.value);
  }

  private async detectSubmitButton(inputSelector: string): Promise<{ selector: string | null; method: string | null }> {
    const result = await cometClient.evaluate(`
      (() => {
        const inputEl = document.querySelector(${JSON.stringify(inputSelector)});
        if (!inputEl) return { selector: null, method: null };

        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
          'form button[type="button"]:last-of-type',
        ];

        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            return { selector: sel, method: 'selector' };
          }
        }

        let parent = inputEl.parentElement;
        const candidates = [];

        for (let depth = 0; depth < 5 && parent; depth++) {
          const buttons = parent.querySelectorAll('button');
          buttons.forEach((btn, index) => {
            if (btn.disabled || btn.offsetParent === null) return;

            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (ariaLabel.includes('search') || ariaLabel.includes('research') ||
                ariaLabel.includes('labs') || ariaLabel.includes('learn') ||
                ariaLabel.includes('attach') || ariaLabel.includes('voice') ||
                ariaLabel.includes('menu') || ariaLabel.includes('more')) {
              return;
            }

            let selector = btn.id ? ('#' + btn.id) : '';
            if (!selector) {
              const buttonType = btn.getAttribute('type');
              selector = buttonType ? ('button[type="' + buttonType + '"]') : 'button';
              const sameTypeButtons = Array.from(parent.querySelectorAll(selector));
              const position = sameTypeButtons.indexOf(btn) + 1;
              selector = selector + ':nth-of-type(' + (position || index + 1) + ')';
            }

            const rect = btn.getBoundingClientRect();
            candidates.push({ selector, x: rect.right });
          });
          parent = parent.parentElement;
        }

        candidates.sort((a, b) => b.x - a.x);
        return { selector: candidates[0]?.selector || null, method: candidates[0] ? 'position' : null };
      })()
    `);

    return (result.result.value as { selector: string | null; method: string | null }) || { selector: null, method: null };
  }

  /**
   * Send a prompt to Comet's AI (Perplexity)
   */
  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findInputElement();

    if (!inputSelector) {
      throw new Error("Could not find input element. Navigate to Perplexity first.");
    }

    console.error(`[comet] Input selector chosen: ${inputSelector}`);

    const typingResult = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(inputSelector)});
        if (!el) {
          return { success: false, path: null, reason: 'input-not-found' };
        }

        const promptText = ${JSON.stringify(prompt)};

        if (el.matches('[contenteditable="true"]')) {
          // Clear existing content with native select-all + delete
          el.focus();
          document.execCommand('selectAll', false);
          document.execCommand('delete', false);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          // Signal that we need CDP insertText for proper React compatibility
          return { success: true, path: 'contenteditable-cdp', needsCdpInsert: true };
        }

        if (el instanceof HTMLTextAreaElement) {
          el.focus();
          el.value = promptText;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, path: 'textarea' };
        }

        if (el instanceof HTMLInputElement && el.type === 'text') {
          el.focus();
          el.value = promptText;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, path: 'text-input' };
        }

        return { success: false, path: null, reason: 'unsupported-element' };
      })()
    `);

    const typed = (typingResult.result.value as { success: boolean; path?: string; reason?: string; needsCdpInsert?: boolean }) || { success: false };
    if (!typed.success) {
      throw new Error(`Failed to type into input element (${typed.reason || 'unknown error'})`);
    }

    // For contenteditable: use CDP insertText for proper React state sync
    if (typed.needsCdpInsert) {
      await cometClient.insertText(prompt);
      await new Promise(resolve => setTimeout(resolve, 200));
    } else {
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    const inputState = await this.getInputContentState(inputSelector);
    const hasTypedContent = inputState.hasContent;
    console.error(`[comet] Typing path=${typed.path} success=${hasTypedContent} elementType=${inputState.elementType}`);

    if (!hasTypedContent) {
      throw new Error("Prompt text not found in selected input - typing may have failed");
    }

    await this.submitPrompt(inputSelector);

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
  }

  /**
   * Submit the current prompt
   */
  private async submitPrompt(inputSelector: string): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 200));

    const hasContent = await this.verifyInputHasContent(inputSelector);
    if (!hasContent) {
      throw new Error("Prompt text not found in selected input - typing may have failed");
    }

    const contentEditableSubmit = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(inputSelector)});
        if (!el) return false;
        el.focus();
        return el.matches('[contenteditable="true"]');
      })()
    `);

    let submitMethod = '';

    // Strategy 1: Click the submit button directly (fastest, most reliable)
    const submitButton = await this.detectSubmitButton(inputSelector);
    if (submitButton.selector) {
      await cometClient.evaluate(`
        (() => {
          const btn = document.querySelector(${JSON.stringify(submitButton.selector)});
          if (btn && !btn.disabled) { btn.click(); return true; }
          return false;
        })()
      `);
      await new Promise(resolve => setTimeout(resolve, 400));
      if (await this.isPromptSubmitted(inputSelector)) {
        submitMethod = `click-${submitButton.method || 'button'}`;
      }
    }

    // Strategy 2: Escape autocomplete + Enter key
    if (!submitMethod && contentEditableSubmit.result.value === true) {
      await cometClient.pressKey('Escape');
      await new Promise(resolve => setTimeout(resolve, 150));
      await cometClient.evaluate(`
        (() => { const el = document.querySelector(${JSON.stringify(inputSelector)}); if (el) el.focus(); })()
      `);
      await new Promise(resolve => setTimeout(resolve, 100));
      await cometClient.pressKey('Enter');
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await this.isPromptSubmitted(inputSelector)) {
        submitMethod = 'cdp-enter-key';
      }
    }

    // Strategy 3: Form submit
    if (!submitMethod) {
      await cometClient.evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(inputSelector)});
          const form = el?.closest('form') || document.querySelector('form');
          if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return true; }
          if (form) { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return true; }
          return false;
        })()
      `);
      await new Promise(resolve => setTimeout(resolve, 400));
      if (await this.isPromptSubmitted(inputSelector)) {
        submitMethod = 'form-submit';
      }
    }

    console.error(`[comet] Submit strategy=${submitMethod || 'failed'}`);

    if (!submitMethod) {
      throw new Error("Prompt submission failed after all fallback strategies");
    }
  }

  // Track response stability for completion detection
  private lastResponseText: string = '';
  private stableResponseCount: number = 0;
  private readonly STABILITY_THRESHOLD: number = 2; // Response must be same for 2 consecutive polls

  /**
   * Check if response has stabilized (same content for multiple polls)
   */
  isResponseStable(currentResponse: string): boolean {
    if (currentResponse && currentResponse.length > 8) {
      if (currentResponse === this.lastResponseText) {
        this.stableResponseCount++;
      } else {
        this.stableResponseCount = 0;
        this.lastResponseText = currentResponse;
      }
      return this.stableResponseCount >= this.STABILITY_THRESHOLD;
    }
    return false;
  }

  /**
   * Reset stability tracking (call when starting new prompt)
   */
  resetStabilityTracking(): void {
    this.lastResponseText = '';
    this.stableResponseCount = 0;
  }

  /**
   * Get current agent status and progress (for polling)
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
    isStable: boolean;
  }> {
    // Get browsing URL from agent's tab
    let agentBrowsingUrl = '';
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    const result = await cometClient.safeEvaluate(`
      (() => {
        const body = document.body.innerText;

        // Check for active stop button — must be specific to avoid false positives
        // from other buttons with rect SVG elements (share, copy, etc.)
        let hasActiveStopButton = false;
        for (const btn of document.querySelectorAll('button')) {
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const btnText = btn.innerText.toLowerCase().trim();

          // Only match explicit stop/cancel buttons by label
          const isStopByLabel = ariaLabel.includes('stop') ||
                                ariaLabel.includes('cancel') ||
                                btnText === 'stop';

          // Also check for the specific Perplexity stop pattern:
          // a small circular button with a square <rect> icon, near the input area
          let isStopByIcon = false;
          if (!isStopByLabel) {
            const rect = btn.querySelector('svg rect');
            if (rect && btn.offsetParent !== null) {
              const btnRect = btn.getBoundingClientRect();
              // Stop button is typically small (< 50px) and near the bottom of the page
              isStopByIcon = btnRect.width < 50 && btnRect.height < 50 && btnRect.y > window.innerHeight * 0.5;
            }
          }

          if ((isStopByLabel || isStopByIcon) && btn.offsetParent !== null && !btn.disabled) {
            hasActiveStopButton = true;
            break;
          }
        }

        // More comprehensive loading detection
        const hasLoadingSpinner = document.querySelector(
          '[class*="animate-spin"], [class*="animate-pulse"], [class*="loading"], [class*="thinking"]'
        ) !== null;

        // Check for "Thinking" indicator — exclude model names like "Claude Sonnet 4.6 Thinking"
        // Look for standalone "Thinking" (as a status indicator), not as part of a model name
        const thinkingIdx = body.indexOf('Thinking');
        let hasThinkingIndicator = false;
        if (thinkingIdx !== -1 && !body.includes('Thinking about')) {
          const before = body.substring(Math.max(0, thinkingIdx - 30), thinkingIdx);
          const isModelName = before.includes('Sonnet') || before.includes('Opus') ||
            before.includes('Claude') || before.includes('Haiku') ||
            before.includes('4.6') || before.includes('4.5') || before.includes('3.5');
          hasThinkingIndicator = !isModelName;
        }

        const hasStepsCompleted = /\\d+ steps? completed/i.test(body);
        const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
        const hasReviewedSources = /Reviewed \\d+ sources?/i.test(body);
        const hasSourcesIndicator = /\\d+\\s*sources?/i.test(body); // "10 sources" etc
        const hasAskFollowUp = body.includes('Ask a follow-up') || body.includes('Ask follow-up') || body.includes('Ask anything');

        // Check for prose content (actual response) - lowered threshold for short answers
        const proseEls = [...document.querySelectorAll('[class*="prose"]')];
        const hasProseContent = proseEls.some(el => {
          const text = el.innerText.trim();
          // Allow short but real answers while excluding obvious UI labels
          return text.length > 8 && !text.startsWith('Library') && !text.startsWith('Discover');
        });

        // Check if input is focused (user might be typing, not agent working)
        const inputFocused = document.activeElement?.matches('[contenteditable], textarea, input');

        const workingPatterns = [
          'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
          'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing',
          'Browsing', 'Looking at', 'Checking', 'Opening', 'Scrolling',
          'Waiting', 'Processing'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        // Determine status with improved logic
        let status = 'idle';

        // FIRST: Check if actively working (stop button is the strongest indicator)
        if (hasActiveStopButton) {
          status = 'working';
        } else if (hasLoadingSpinner || hasThinkingIndicator) {
          status = 'working';
        }
        // SECOND: Check completion indicators BEFORE working text
        // (because completed pages still show historical step text)
        else if (hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        } else if (hasAskFollowUp && hasProseContent) {
          status = 'completed';
        } else if (hasSourcesIndicator && hasProseContent && !hasActiveStopButton) {
          status = 'completed';
        } else if (hasReviewedSources && !hasActiveStopButton) {
          status = 'completed';
        }
        // THIRD: Fall back to working text patterns (only if no completion signals)
        else if (hasWorkingText) {
          status = 'working';
        }

        // Extract steps
        const steps = [];
        const stepPatterns = [
          /Preparing to assist[^\\n]*/g, /Clicking[^\\n]*/g, /Typing:[^\\n]*/g,
          /Navigating[^\\n]*/g, /Reading[^\\n]*/g, /Searching[^\\n]*/g, /Found[^\\n]*/g
        ];
        for (const pattern of stepPatterns) {
          const matches = body.match(pattern);
          if (matches) steps.push(...matches.map(s => s.trim().substring(0, 100)));
        }

        // Extract response - get the FULL FINAL response after agent completes
        let response = '';
        if (status === 'completed') {
          const mainContent = document.querySelector('main') || document.body;
          const bodyText = mainContent.innerText;

          // Strategy 1: Find content after "X steps completed" marker (agent's final response)
          const stepsMatch = bodyText.match(/(\\d+)\\s*steps?\\s*completed/i);
          if (stepsMatch) {
            const markerIndex = bodyText.indexOf(stepsMatch[0]);
            if (markerIndex !== -1) {
              // Get everything after the marker
              let afterMarker = bodyText.substring(markerIndex + stepsMatch[0].length).trim();

              // Remove the ">" or arrow that often follows
              afterMarker = afterMarker.replace(/^[>›→\\s]+/, '').trim();

              // Find where the response ends (before input area or UI elements)
              const endMarkers = ['Ask anything', 'Ask a follow-up', 'Add details', 'Type a message'];
              let endIndex = afterMarker.length;
              for (const marker of endMarkers) {
                const idx = afterMarker.indexOf(marker);
                if (idx !== -1 && idx < endIndex) {
                  endIndex = idx;
                }
              }

              response = afterMarker.substring(0, endIndex).trim();
            }
          }

          // Strategy 2: If no steps marker, look for content after source citations
          if (!response || response.length < 12) {
            const sourcesMatch = bodyText.match(/Reviewed\\s+\\d+\\s+sources?/i);
            if (sourcesMatch) {
              const markerIndex = bodyText.indexOf(sourcesMatch[0]);
              if (markerIndex !== -1) {
                let afterMarker = bodyText.substring(markerIndex + sourcesMatch[0].length).trim();
                const endMarkers = ['Ask anything', 'Ask a follow-up', 'Add details'];
                let endIndex = afterMarker.length;
                for (const marker of endMarkers) {
                  const idx = afterMarker.indexOf(marker);
                  if (idx !== -1 && idx < endIndex) endIndex = idx;
                }
                response = afterMarker.substring(0, endIndex).trim();
              }
            }
          }

          // Strategy 3: Fallback - get all prose content combined
          if (!response || response.length < 12) {
            const allProseEls = [...mainContent.querySelectorAll('[class*="prose"]')];
            const validTexts = allProseEls
              .filter(el => {
                if (el.closest('nav, aside, header, footer, form, [contenteditable]')) return false;
                const text = el.innerText.trim();
                const isUIText = ['Library', 'Discover', 'Spaces', 'Finance', 'Account',
                                  'Upgrade', 'Home', 'Search'].some(ui => text.startsWith(ui));
                return !isUIText && text.length > 8;
              })
              .map(el => el.innerText.trim());

            // Combine all valid prose texts, taking the last/most recent ones
            if (validTexts.length > 0) {
              // Take last 3 prose blocks max (most recent response)
              response = validTexts.slice(-3).join('\\n\\n');
            }
          }

          // Clean up response - preserve formatting but remove UI artifacts
          if (response) {
            response = response
              .replace(/View All/gi, '')
              .replace(/Show more/gi, '')
              .replace(/Ask a follow-up/gi, '')
              .replace(/Ask anything\\.*/gi, '')
              .replace(/Add details to this task\\.*/gi, '')
              .replace(/\\d+\\s*sources?\\s*$/gi, '')
              .replace(/[\\u{1F300}-\\u{1F9FF}]/gu, '') // Remove most emojis from UI
              .replace(/^[>›→\\s]+/gm, '') // Remove leading arrows
              .replace(/\\n{3,}/g, '\\n\\n') // Collapse multiple newlines
              .trim();
          }
        }

        return {
          status,
          steps: [...new Set(steps)].slice(-5),
          currentStep: steps.length > 0 ? steps[steps.length - 1] : '',
          response: response.substring(0, 8000),
          hasStopButton: hasActiveStopButton
        };
      })()
    `);

    const statusResult = (result.result.value as {
      status: "idle" | "working" | "completed";
      steps: string[];
      currentStep: string;
      response: string;
      hasStopButton: boolean;
    }) || { status: 'idle' as const, steps: [], currentStep: '', response: '', hasStopButton: false };

    // Check response stability
    const isStable = this.isResponseStable(statusResult.response);

    // If response is stable and has content, override status to completed
    if (isStable && statusResult.response.length > 8 && !statusResult.hasStopButton) {
      statusResult.status = 'completed';
    }

    return {
      ...statusResult,
      agentBrowsingUrl,
      isStable,
    };
  }

  /**
   * Stop the current agent task
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        // Try aria-label buttons first
        for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
          btn.click();
          return true;
        }
        // Try square stop icon
        for (const btn of document.querySelectorAll('button')) {
          if (btn.querySelector('svg rect')) {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }
}

export const cometAI = new CometAI();
