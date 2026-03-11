// CDP Client wrapper for Comet browser control
// Modified for Windows/WSL support

import CDP from "chrome-remote-interface";
import { spawn, ChildProcess, execSync, execFileSync } from "child_process";
import { platform, homedir } from "os";
import { existsSync } from "fs";
import path from "path";
import type {
  CDPTarget,
  CDPVersion,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
  CometState,
  TabContext,
} from "./types.js";

// Detect if running in WSL (must be before windowsFetch)
function isWSL(): boolean {
  if (platform() !== 'linux') return false;
  try {
    const release = execSync('uname -r', { encoding: 'utf8' }).toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

const IS_WSL = isWSL();

// Check if WSL can directly connect to Windows localhost (mirrored networking)
async function canConnectToWindowsLocalhost(port: number): Promise<boolean> {
  if (!IS_WSL) return true;

  const net = await import('net');
  return new Promise((resolve) => {
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      resolve(false);
    });
    client.setTimeout(2000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

// For WSL: port to use for CDP connection
async function getWSLConnectPort(targetPort: number): Promise<number> {
  if (!IS_WSL) return targetPort;

  // Check if mirrored networking is enabled (direct localhost access works)
  const canConnect = await canConnectToWindowsLocalhost(targetPort);
  if (canConnect) {
    return targetPort;
  }

  // Cannot connect - throw helpful error
  throw new Error(
    `WSL cannot connect to Windows localhost:${targetPort}.\n\n` +
    `To fix this, enable WSL mirrored networking:\n` +
    `1. Create/edit %USERPROFILE%\\.wslconfig with:\n` +
    `   [wsl2]\n` +
    `   networkingMode=mirrored\n` +
    `2. Run: wsl --shutdown\n` +
    `3. Restart WSL and try again\n\n` +
    `Alternatively, run Claude Code from Windows PowerShell instead of WSL.`
  );
}

// Windows/WSL-compatible fetch using PowerShell
// On WSL, native fetch connects to WSL's localhost, not Windows where Comet runs
async function windowsFetch(url: string, method: string = 'GET'): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  // Use native fetch only on non-Windows AND non-WSL
  if (platform() !== 'win32' && !IS_WSL) {
    const response = await fetch(url, { method });
    return response;
  }

  // On Windows or WSL, use PowerShell to reach Windows localhost
  try {
    const psCommand = method === 'PUT'
      ? `Invoke-WebRequest -Uri '${url}' -Method PUT -UseBasicParsing | Select-Object -ExpandProperty Content`
      : `Invoke-WebRequest -Uri '${url}' -UseBasicParsing | Select-Object -ExpandProperty Content`;

    const result = execSync(`powershell.exe -NoProfile -Command "${psCommand}"`, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });

    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(result.trim())
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      json: async () => { throw error; }
    };
  }
}

// Detect platform and set appropriate Comet path
function getCometPath(): string {
  const os = platform();

  // Check for custom path via environment variable
  if (process.env.COMET_PATH) {
    return process.env.COMET_PATH;
  }

  if (os === "darwin") {
    return "/Applications/Comet.app/Contents/MacOS/Comet";
  } else if (os === "win32" || IS_WSL) {
    // Common Windows installation paths for Comet (Perplexity)
    // For WSL, these paths won't be directly usable but we track them for reference
    const possiblePaths = [
      `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${process.env.APPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      "C:\\Program Files\\Perplexity\\Comet\\Application\\comet.exe",
      "C:\\Program Files (x86)\\Perplexity\\Comet\\Application\\comet.exe",
    ];

    for (const p of possiblePaths) {
      if (existsSync(p)) {
        return p;
      }
    }

    // Default to LOCALAPPDATA path
    return `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`;
  }

  // Fallback for other platforms
  return "/Applications/Comet.app/Contents/MacOS/Comet";
}

const COMET_PATH = getCometPath();
const IS_WINDOWS = platform() === "win32" || IS_WSL;
const DEFAULT_PORT = Number.parseInt(process.env.COMET_PORT || "9223", 10) || 9223;
const DEFAULT_AUTOMATION_PROFILE = "ClaudeAutomation";

type ProfileMode = 'isolated' | 'default';

function getProfileMode(): ProfileMode {
  return process.env.COMET_PROFILE_MODE === 'isolated' ? 'isolated' : 'default';
}

function getProfileModeLabel(): string {
  return getProfileMode() === 'default' ? 'default-profile' : 'isolated';
}

function getDefaultAutomationUserDataDir(): string {
  if (platform() === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Perplexity", "Comet-Claude-Automation");
  }

  if (platform() === "win32" || IS_WSL) {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    return path.join(localAppData, "Perplexity", "Comet", "ClaudeAutomation");
  }

  return path.join(homedir(), ".config", "perplexity-comet-claude-automation");
}

function getDefaultProfileUserDataDir(): string {
  if (platform() === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "Perplexity", "Comet", "User Data");
  }

  if (platform() === "win32" || IS_WSL) {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    return path.join(localAppData, "Perplexity", "Comet", "User Data");
  }

  return path.join(homedir(), ".config", "Perplexity", "Comet", "User Data");
}

function getDefaultProfileDir(): string {
  return "Default";
}

function getAutomationUserDataDir(): string {
  if (getProfileMode() === 'default') {
    return getDefaultProfileUserDataDir();
  }

  return process.env.COMET_USER_DATA_DIR || getDefaultAutomationUserDataDir();
}

function getAutomationProfileDir(): string {
  if (getProfileMode() === 'default') {
    return getDefaultProfileDir();
  }

  return process.env.COMET_PROFILE_DIR || DEFAULT_AUTOMATION_PROFILE;
}

function getCometLaunchArgs(port: number, restoreSession: boolean = false): string[] {
  if (getProfileMode() === 'default') {
    // Default-profile mode: no user-data-dir/profile-directory so we use the user's logged-in profile.
    // When restarting an existing Comet, --restore-last-session preserves open tabs.
    const args = [
      `--remote-debugging-port=${port}`,
      "--new-window",
    ];
    if (restoreSession) {
      args.push("--restore-last-session");
    }
    return args;
  }

  // Isolated mode: separate profile directory for automation
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${getAutomationUserDataDir()}`,
    `--profile-directory=${getAutomationProfileDir()}`,
    "--new-window",
  ];
}

function formatAutomationDescriptor(port: number): string {
  return `mode=${getProfileModeLabel()} port=${port} profile=${getAutomationProfileDir()} userDataDir=${getAutomationUserDataDir()}`;
}

export class CometCDPClient {
  private client: CDP.Client | null = null;
  private cometProcess: ChildProcess | null = null;
  private state: CometState = {
    connected: false,
    port: DEFAULT_PORT,
  };
  private automationMainTabId: string | undefined;
  private lastTargetId: string | undefined;

  private isPerplexityUrl(url: string | undefined): boolean {
    return Boolean(url && url.includes('perplexity.ai'));
  }
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private isReconnecting: boolean = false;
  private connectionCheckInterval: NodeJS.Timeout | null = null;
  private lastHealthCheck: number = 0;
  private healthCheckCache: boolean = false;
  private readonly HEALTH_CHECK_CACHE_MS: number = 2000; // Cache health check for 2s

  // Tab context registry for multi-tab workflow awareness
  private tabRegistry: Map<string, TabContext> = new Map();
  // Tabs that existed before the MCP session started (pre-existing user tabs)
  private baselineTabIds: Set<string> = new Set();

  get isConnected(): boolean {
    return this.state.connected && this.client !== null;
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  /**
   * Check if connection is healthy by testing a simple operation (cached)
   */
  async isConnectionHealthy(): Promise<boolean> {
    // Return cached result if recent
    const now = Date.now();
    if (now - this.lastHealthCheck < this.HEALTH_CHECK_CACHE_MS) {
      return this.healthCheckCache;
    }

    if (!this.client) {
      this.healthCheckCache = false;
      this.lastHealthCheck = now;
      return false;
    }

    try {
      await this.client.Runtime.evaluate({ expression: '1+1', timeout: 3000 });
      this.healthCheckCache = true;
      this.lastHealthCheck = now;
      return true;
    } catch {
      this.healthCheckCache = false;
      this.lastHealthCheck = now;
      return false;
    }
  }

  /**
   * Force invalidate health cache (call after known connection issues)
   */
  invalidateHealthCache(): void {
    this.lastHealthCheck = 0;
    this.healthCheckCache = false;
  }

  /**
   * Ensure connection is healthy, reconnect if not
   */
  async ensureConnection(): Promise<void> {
    if (!await this.isConnectionHealthy()) {
      this.invalidateHealthCache();
      await this.reconnect();
    }
  }

  /**
   * Pre-operation check - ensures connection is valid before any operation
   * Call this before critical operations
   */
  async preOperationCheck(): Promise<void> {
    // Quick check if client exists
    if (!this.client) {
      await this.reconnect();
      return;
    }

    // If we recently verified health, skip
    if (Date.now() - this.lastHealthCheck < this.HEALTH_CHECK_CACHE_MS && this.healthCheckCache) {
      return;
    }

    // Full health check
    if (!await this.isConnectionHealthy()) {
      this.invalidateHealthCache();
      await this.reconnect();
    }
  }

  /**
   * Auto-reconnect wrapper for operations with exponential backoff
   */
  async withAutoReconnect<T>(operation: () => Promise<T>): Promise<T> {
    // Wait for ongoing reconnect
    if (this.isReconnecting) {
      let waitCount = 0;
      while (this.isReconnecting && waitCount < 20) {
        await new Promise(resolve => setTimeout(resolve, 300));
        waitCount++;
      }
    }

    // Pre-operation health check (uses cache for efficiency)
    try {
      await this.preOperationCheck();
    } catch {
      // If pre-check fails, try to proceed anyway
    }

    try {
      const result = await operation();
      this.reconnectAttempts = 0;
      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const connectionErrors = [
        'WebSocket', 'CLOSED', 'not open', 'disconnected', 'readyState',
        'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'socket hang up',
        'Protocol error', 'Target closed', 'Session closed', 'Execution context',
        'not found', 'detached', 'crashed', 'Inspected target navigated', 'aborted'
      ];

      const isConnectionError = connectionErrors.some(e =>
        errorMessage.toLowerCase().includes(e.toLowerCase())
      );

      if (isConnectionError && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.isReconnecting = true;
        this.invalidateHealthCache();

        try {
          // Shorter delays for faster recovery
          const delay = Math.min(300 * Math.pow(1.3, this.reconnectAttempts - 1), 2000);
          await new Promise(resolve => setTimeout(resolve, delay));
          await this.reconnect();
          this.isReconnecting = false;
          // Retry the operation after reconnect
          return await operation();
        } catch (reconnectError) {
          this.isReconnecting = false;
          // If reconnect fails, try fresh start
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            try {
              await this.startComet(this.state.port);
              await new Promise(r => setTimeout(r, 1500));
              const targets = await this.listTargets();
              const page = targets.find(t => t.type === 'page' && t.url.includes('perplexity'));
              const anyPage = page || targets.find(t => t.type === 'page');
              if (anyPage) {
                await this.connect(anyPage.id);
                return await operation();
              }
            } catch {
              // Last resort failed
            }
          }
          throw reconnectError;
        }
      }

      throw error;
    }
  }

  /**
   * Reconnect to the last connected tab
   */
  async reconnect(): Promise<string> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.state.connected = false;
    this.client = null;

    try {
      await this.getVersion();
    } catch {
      try {
        await this.startComet(this.state.port);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch {
        throw new Error(`Cannot connect to Comet automation on debug port ${this.state.port}`);
      }
    }

    if (this.lastTargetId) {
      try {
        const targets = await this.listTargets();
        if (targets.find(t => t.id === this.lastTargetId)) {
          return await this.connect(this.lastTargetId);
        }
      } catch { /* target gone */ }
    }

    if (this.automationMainTabId) {
      try {
        const targets = await this.listTargets();
        if (targets.find(t => t.id === this.automationMainTabId)) {
          return await this.connect(this.automationMainTabId);
        }
      } catch { /* target gone */ }
    }

    const targets = await this.listTargets();
    const pageTargets = targets.filter(t => t.type === 'page');
    const activeTarget = pageTargets.find(t => t.id === this.state.activeTabId);
    if (activeTarget) {
      return await this.connect(activeTarget.id);
    }

    const nonInternalTarget = pageTargets.find(t => !this.isInternalTab(t.url));
    if (nonInternalTarget) {
      return await this.connect(nonInternalTarget.id);
    }

    const target = await this.ensureAutomationPerplexityTab();
    return `Connected to tab: ${target.url}`;
  }

  /**
   * List tabs with categorization
   */
  async listTabsCategorized(): Promise<{
    main: CDPTarget | null;
    sidecar: CDPTarget | null;
    agentBrowsing: CDPTarget | null;
    overlay: CDPTarget | null;
    others: CDPTarget[];
  }> {
    const targets = await this.listTargets();
    const pageTargets = targets.filter(t => t.type === 'page');
    const mainTarget = this.automationMainTabId
      ? pageTargets.find(t => t.id === this.automationMainTabId) || null
      : null;
    const scopedMain = mainTarget || pageTargets.find(t =>
      this.isPerplexityUrl(t.url) && !t.url.includes('sidecar')
    ) || null;

    return {
      main: scopedMain,
      sidecar: pageTargets.find(t =>
        t.url.includes('sidecar')
      ) || null,
      agentBrowsing: pageTargets.find(t =>
        t.id !== scopedMain?.id &&
        !this.isInternalTab(t.url) &&
        !this.isPerplexityUrl(t.url) &&
        !this.baselineTabIds.has(t.id) // Only report tabs opened during this session
      ) || null,
      overlay: targets.find(t =>
        t.url.includes('chrome-extension') && t.url.includes('overlay')
      ) || null,
      others: pageTargets.filter(t =>
        t.id !== scopedMain?.id &&
        !t.url.includes('chrome-extension')
      ),
    };
  }

  getAutomationConfig(): { port: number; profileMode: string; userDataDir: string; profileDir: string } {
    return {
      port: this.state.port,
      profileMode: getProfileModeLabel(),
      userDataDir: getAutomationUserDataDir(),
      profileDir: getAutomationProfileDir(),
    };
  }

  private async connectToPort(port: number): Promise<CDP.Client> {
    const connectPort = await getWSLConnectPort(port);
    return CDP({ port: connectPort, host: '127.0.0.1' });
  }

  private async isDebugPortReachable(port: number): Promise<boolean> {
    try {
      const client = await this.connectToPort(port);
      await client.close();
      return true;
    } catch {
      return false;
    }
  }

  private async waitForDebugPort(port: number, startDelayMs: number = 1500): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, startDelayMs));

    const maxAttempts = 40;
    for (let attempts = 0; attempts < maxAttempts; attempts++) {
      if (await this.isDebugPortReachable(port)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error(`Timeout waiting for Comet on debug port ${port}. Try running: "${COMET_PATH}" ${getCometLaunchArgs(port).join(' ')}`);
  }

  private getWindowsProcessCommandLines(): string[] {
    try {
      const output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "comet.exe" } | Select-Object -ExpandProperty CommandLine'
      ], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });

      return output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async isExpectedAutomationInstance(port: number): Promise<boolean> {
    const portArg = `--remote-debugging-port=${port}`;

    if (IS_WINDOWS) {
      const commandLines = this.getWindowsProcessCommandLines();
      return commandLines.some(commandLine => {
        if (!commandLine.includes(portArg)) {
          return false;
        }

        if (getProfileMode() === 'default') {
          // Default-profile mode: just match on the debug port (no user-data-dir in args)
          return true;
        }

        const userDataDirArg = `--user-data-dir=${getAutomationUserDataDir()}`;
        const profileDirArg = `--profile-directory=${getAutomationProfileDir()}`;
        return commandLine.includes(userDataDirArg) && commandLine.includes(profileDirArg);
      });
    }

    // Non-Windows: accept any reachable debug port as the expected instance
    return true;
  }

  private async getBrowserCommandLine(port: number): Promise<string[] | null> {
    try {
      const client = await this.connectToPort(port);
      try {
        const result = await (client as any).Browser.getBrowserCommandLine();
        return Array.isArray(result?.arguments) ? result.arguments : null;
      } finally {
        await client.close();
      }
    } catch {
      return null;
    }
  }

  private async findRunningAutomationPort(startPort: number): Promise<number | null> {
    let candidate = startPort;
    for (let attempts = 0; attempts < 20; attempts++, candidate++) {
      if (!await this.isDebugPortReachable(candidate)) {
        continue;
      }

      if (await this.isExpectedAutomationInstance(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private async findAvailableDebugPort(startPort: number): Promise<number> {
    let candidate = startPort;
    for (let attempts = 0; attempts < 20; attempts++, candidate++) {
      if (!await this.isDebugPortReachable(candidate)) {
        return candidate;
      }
    }

    throw new Error(`Could not find an available Comet debug port starting at ${startPort}`);
  }

  private async launchCometProcess(port: number, restoreSession: boolean = false): Promise<void> {
    const args = getCometLaunchArgs(port, restoreSession);

    if (IS_WSL) {
      const cometPath = COMET_PATH;
      const escapedArgs = args.map(arg => `'${arg.replace(/'/g, "''")}'`).join(', ');
      const psCommand = `Set-Location C:\\; Start-Process -FilePath '${cometPath.replace(/'/g, "''")}' -ArgumentList @(${escapedArgs})`;
      spawn('powershell.exe', ['-NoProfile', '-Command', psCommand], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return;
    }

    this.cometProcess = spawn(COMET_PATH, args, {
      detached: true,
      stdio: "ignore",
      shell: true,
    });
    this.cometProcess.on('error', (err) => {
      console.error(`[comet] Failed to launch Comet process: ${err.message}`);
    });
    this.cometProcess.unref();
  }

  async ensureAutomationPerplexityTab(url: string = "https://www.perplexity.ai/"): Promise<CDPTarget> {
    const targets = await this.listTargets();
    const pageTargets = targets.filter(t => t.type === 'page');

    let mainTarget: CDPTarget | null = null;

    // Reuse the saved tab only if it's still alive (handles reconnects within the same session)
    if (this.automationMainTabId) {
      const saved = pageTargets.find(t => t.id === this.automationMainTabId);
      if (saved && this.isPerplexityUrl(saved.url) && !saved.url.includes('sidecar')) {
        mainTarget = saved;
      }
    }

    if (!mainTarget) {
      // Always open a fresh tab — never hijack an existing user tab
      mainTarget = await this.newTab(url);
      await new Promise(resolve => setTimeout(resolve, 2200));
    }

    this.automationMainTabId = mainTarget.id;
    await this.connect(mainTarget.id);

    if (!this.isPerplexityUrl(mainTarget.url)) {
      await this.navigate(url, true);
      await new Promise(resolve => setTimeout(resolve, 1800));
      const refreshedTargets = await this.listTargets();
      mainTarget = refreshedTargets.find(t => t.id === this.automationMainTabId) || mainTarget;
    }

    // Record baseline tabs (pre-existing user tabs) on first setup
    if (this.baselineTabIds.size === 0) {
      for (const t of pageTargets) {
        this.baselineTabIds.add(t.id);
      }
    }

    this.setTabPurpose(mainTarget.id, 'main');
    return mainTarget;
  }

  async connectToAutomationMainTab(): Promise<CDPTarget> {
    const mainTarget = await this.ensureAutomationPerplexityTab();
    this.automationMainTabId = mainTarget.id;
    return mainTarget;
  }

  async getAutomationMainTab(): Promise<CDPTarget | null> {
    if (!this.automationMainTabId) {
      return null;
    }

    const targets = await this.listTargets();
    return targets.find(t => t.id === this.automationMainTabId) || null;
  }

  async connectToLastActiveTab(): Promise<boolean> {
    const targets = await this.listTargets();
    const pageTargets = targets.filter(t => t.type === 'page');

    const preferredTarget = [
      this.lastTargetId,
      this.state.activeTabId,
      pageTargets.find(t => !this.isInternalTab(t.url))?.id,
      this.automationMainTabId,
    ].filter((id): id is string => Boolean(id)).find(id => pageTargets.some(t => t.id === id));

    if (!preferredTarget) {
      return false;
    }

    await this.connect(preferredTarget);
    return true;
  }

  async withAutomationMainTab<T>(operation: () => Promise<T>): Promise<T> {
    const previousTargetId = this.state.activeTabId ?? this.lastTargetId;
    await this.connectToAutomationMainTab();

    try {
      return await operation();
    } finally {
      if (previousTargetId && previousTargetId !== this.automationMainTabId) {
        try {
          const targets = await this.listTargets();
          if (targets.some(t => t.id === previousTargetId)) {
            await this.connect(previousTargetId);
          }
        } catch {
          // Keep control tab connection if restoring the previous tab fails
        }
      }
    }
  }

  async getVisibleTabContexts(): Promise<TabContext[]> {
    const tabs = await this.getTabContexts();
    return tabs.filter(t => !this.isInternalTab(t.url));
  }

  async forceRestartComet(port: number = this.state.port): Promise<string> {
    this.state.port = port;
    await this.killComet();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.launchCometProcess(port);
    await this.waitForDebugPort(port);
    return `Comet force-restarted on mode=${getProfileModeLabel()} port ${port}`;
  }

  getAutomationMainTabId(): string | undefined {
    return this.automationMainTabId;
  }

  setAutomationMainTabId(tabId: string | undefined): void {
    this.automationMainTabId = tabId;
  }

  /**
   * Ensure we're connected to the main Perplexity tab
   * Used during agentic browsing when Comet may open new tabs
   */
  async ensureOnPerplexityTab(): Promise<boolean> {
    try {
      await this.connectToAutomationMainTab();
      this.invalidateHealthCache();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if we're currently connected to the Perplexity control tab
   */
  async isOnPerplexityTab(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const result = await this.client.Runtime.evaluate({
        expression: 'window.location.href',
        timeout: 2000
      });
      const url = result.result.value as string;
      return this.isPerplexityUrl(url) && (!this.automationMainTabId || this.state.activeTabId === this.automationMainTabId);
    } catch {
      return false;
    }
  }

  async isAutomationMainTab(targetId: string | undefined): Promise<boolean> {
    return Boolean(targetId && this.automationMainTabId && targetId === this.automationMainTabId);
  }

  async getActiveTabContext(): Promise<TabContext | null> {
    const tabs = await this.getTabContexts();
    const activeTabId = this.state.activeTabId ?? this.lastTargetId;
    return tabs.find(tab => tab.id === activeTabId) || null;
  }

  async getBrowsingTabCount(): Promise<number> {
    const tabs = await this.getVisibleTabContexts();
    return tabs.length;
  }

  async getClosableTabCount(): Promise<number> {
    const tabs = await this.getVisibleTabContexts();
    return tabs.filter(tab => tab.id !== this.automationMainTabId).length;
  }

  async isControlTabAvailable(): Promise<boolean> {
    return Boolean(await this.getAutomationMainTab());
  }

  async closeTrackedTab(targetId: string): Promise<boolean> {
    const success = await this.closeTab(targetId);
    if (success) {
      this.tabRegistry.delete(targetId);
      if (this.automationMainTabId === targetId) {
        this.automationMainTabId = undefined;
      }
      if (this.lastTargetId === targetId) {
        this.lastTargetId = undefined;
      }
      if (this.state.activeTabId === targetId) {
        this.state.activeTabId = undefined;
      }
    }
    return success;
  }

  // ============ TAB REGISTRY METHODS ============

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Check if URL is an internal Chrome/Comet page (not a real browsing tab)
   */
  private isInternalTab(url: string): boolean {
    return url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('devtools://') ||
      url === 'about:blank' ||
      url === '';
  }

  /**
   * Infer tab purpose from URL and context
   */
  private inferPurpose(url: string, title: string, targetId?: string): TabContext['purpose'] {
    if (this.isInternalTab(url)) return 'unknown';
    if ((targetId && targetId === this.automationMainTabId) || this.isPerplexityUrl(url)) return 'main';
    // Only label tabs opened during this session as agent-browsing
    if (targetId && this.baselineTabIds.has(targetId)) return 'unknown';
    return 'agent-browsing';
  }

  /**
   * Update tab registry with current browser state
   */
  async refreshTabRegistry(): Promise<TabContext[]> {
    const targets = await this.listTargets();
    const currentTime = Date.now();

    // Track which tabs still exist
    const existingIds = new Set<string>();

    for (const target of targets) {
      if (target.type !== 'page') continue;

      // Skip internal Chrome tabs entirely
      if (this.isInternalTab(target.url)) continue;

      existingIds.add(target.id);

      // Update or create tab context
      const existing = this.tabRegistry.get(target.id);
      const domain = this.extractDomain(target.url);

      if (existing) {
        // Update existing entry
        const previousDomain = existing.domain;
        existing.url = target.url;
        existing.title = target.title;
        existing.domain = domain;
        existing.lastActivity = currentTime;
        if (previousDomain !== domain || existing.purpose === 'unknown') {
          existing.purpose = this.inferPurpose(target.url, target.title, target.id);
        }
        if (target.id === this.automationMainTabId) {
          existing.purpose = 'main';
        }
      } else {
        // New tab - create entry
        const context: TabContext = {
          id: target.id,
          url: target.url,
          title: target.title,
          purpose: this.inferPurpose(target.url, target.title, target.id),
          domain,
          lastActivity: currentTime,
        };
        this.tabRegistry.set(target.id, context);
      }

      if (target.id === this.automationMainTabId) {
        const controlTab = this.tabRegistry.get(target.id);
        if (controlTab) {
          controlTab.purpose = 'main';
        }
      }
    }

    // Remove closed tabs from registry
    for (const id of this.tabRegistry.keys()) {
      if (!existingIds.has(id)) {
        this.tabRegistry.delete(id);
      }
    }

    return Array.from(this.tabRegistry.values());
  }

  /**
   * Get all tracked tabs with context
   */
  async getTabContexts(): Promise<TabContext[]> {
    await this.refreshTabRegistry();
    return Array.from(this.tabRegistry.values());
  }

  /**
   * Find a tab by domain (for reuse)
   */
  async findTabByDomain(domain: string): Promise<TabContext | null> {
    await this.refreshTabRegistry();
    for (const tab of this.tabRegistry.values()) {
      if (tab.domain.includes(domain) || domain.includes(tab.domain)) {
        return tab;
      }
    }
    return null;
  }

  /**
   * Find a tab by URL pattern
   */
  async findTabByUrl(urlPattern: string): Promise<TabContext | null> {
    await this.refreshTabRegistry();
    for (const tab of this.tabRegistry.values()) {
      if (tab.url.includes(urlPattern)) {
        return tab;
      }
    }
    return null;
  }

  /**
   * Find tabs by purpose
   */
  async findTabsByPurpose(purpose: TabContext['purpose']): Promise<TabContext[]> {
    await this.refreshTabRegistry();
    return Array.from(this.tabRegistry.values()).filter(t => t.purpose === purpose);
  }

  /**
   * Update tab purpose (for workflow tracking)
   */
  setTabPurpose(tabId: string, purpose: TabContext['purpose'], taskId?: string): void {
    const tab = this.tabRegistry.get(tabId);
    if (tab) {
      tab.purpose = purpose;
      if (taskId) tab.taskId = taskId;
      tab.lastActivity = Date.now();
    }
  }

  /**
   * Set content summary for a tab
   */
  setTabContentSummary(tabId: string, summary: string): void {
    const tab = this.tabRegistry.get(tabId);
    if (tab) {
      tab.contentSummary = summary;
      tab.lastActivity = Date.now();
    }
  }

  /**
   * Navigate to URL, reusing existing tab if one exists for that domain
   */
  async navigateOrReuseTab(url: string, purpose: TabContext['purpose'] = 'agent-browsing'): Promise<{ tabId: string; reused: boolean }> {
    const domain = this.extractDomain(url);

    // Check if we already have a tab for this domain
    const existingTab = await this.findTabByDomain(domain);

    if (existingTab && existingTab.purpose !== 'main') {
      // Reuse existing tab
      await this.connect(existingTab.id);
      await this.navigate(url, true);
      this.setTabPurpose(existingTab.id, purpose);
      return { tabId: existingTab.id, reused: true };
    }

    // Create new tab
    const newTab = await this.newTab(url);
    await new Promise(r => setTimeout(r, 1500)); // Wait for load
    await this.connect(newTab.id);

    // Register the new tab
    const context: TabContext = {
      id: newTab.id,
      url: newTab.url,
      title: newTab.title,
      purpose,
      domain,
      lastActivity: Date.now(),
    };
    this.tabRegistry.set(newTab.id, context);

    return { tabId: newTab.id, reused: false };
  }

  /**
   * Get formatted tab summary for context display (filters out internal Chrome tabs)
   */
  async getTabSummary(): Promise<string> {
    const tabs = await this.getVisibleTabContexts();

    if (tabs.length === 0) {
      return "No browsing tabs open";
    }

    const lines: string[] = [`${tabs.length} browsing tab(s) open:`];

    for (const tab of tabs) {
      const active = tab.id === this.state.activeTabId ? " [ACTIVE]" : "";
      const task = tab.taskId ? ` (task: ${tab.taskId})` : "";
      const summary = tab.contentSummary ? ` - ${tab.contentSummary}` : "";
      const label = tab.purpose === 'unknown' ? 'TAB' : tab.purpose.toUpperCase();
      lines.push(`  • ${label}: ${tab.domain}${active}${task}${summary}`);
      lines.push(`    URL: ${tab.url.substring(0, 80)}${tab.url.length > 80 ? '...' : ''}`);
    }

    return lines.join('\n');
  }

  /**
   * Check if Comet process is running
   */
  private async isCometProcessRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use tasklist to check for comet.exe
        const check = spawn('tasklist', ['/FI', 'IMAGENAME eq comet.exe', '/NH']);
        let output = '';
        check.stdout?.on('data', (data) => { output += data.toString(); });
        check.on('close', () => {
          // If comet.exe is running, output will contain "comet.exe"
          resolve(output.toLowerCase().includes('comet.exe'));
        });
        check.on('error', () => resolve(false));
      } else {
        // macOS/Linux: use pgrep
        const check = spawn('pgrep', ['-f', 'Comet.app']);
        check.on('close', (code) => resolve(code === 0));
        check.on('error', () => resolve(false));
      }
    });
  }

  /**
   * Kill any running Comet process
   */
  private async killComet(): Promise<void> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use taskkill to kill comet.exe
        const kill = spawn('taskkill', ['/F', '/IM', 'comet.exe']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      } else {
        // macOS/Linux: use pkill
        const kill = spawn('pkill', ['-f', 'Comet.app']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      }
    });
  }

  /**
   * Start Comet browser with remote debugging enabled
   */
  async startComet(port: number = DEFAULT_PORT): Promise<string> {
    this.state.port = port;
    let config = this.getAutomationConfig();

    if (await this.isDebugPortReachable(port)) {
      const isExpectedAutomation = await this.isExpectedAutomationInstance(port);
      if (isExpectedAutomation) {
        console.error(`[comet] Using existing automation instance ${formatAutomationDescriptor(port)}`);
        return `Comet automation already running on port ${port} (mode=${config.profileMode}, profile=${config.profileDir}, userDataDir=${config.userDataDir})`;
      }

      const existingAutomationPort = await this.findRunningAutomationPort(port + 1);
      if (existingAutomationPort !== null) {
        this.state.port = existingAutomationPort;
        config = this.getAutomationConfig();
        console.error(`[comet] Debug port ${port} is attached to a non-automation Comet instance; reusing automation ${formatAutomationDescriptor(existingAutomationPort)}.`);
        return `Comet automation already running on fallback port ${existingAutomationPort} (mode=${config.profileMode}, profile=${config.profileDir}, userDataDir=${config.userDataDir})`;
      }

      const fallbackPort = await this.findAvailableDebugPort(port + 1);
      this.state.port = fallbackPort;
      config = this.getAutomationConfig();
      console.error(`[comet] Debug port ${port} is attached to a non-automation Comet instance; launching automation ${formatAutomationDescriptor(fallbackPort)}.`);
      await this.launchCometProcess(fallbackPort);
      await this.waitForDebugPort(fallbackPort, IS_WSL ? 2000 : 1500);
      return `Comet automation started on fallback port ${fallbackPort} (mode=${config.profileMode}, profile=${config.profileDir}, userDataDir=${config.userDataDir})`;
    }

    const isRunning = await this.isCometProcessRunning();
    if (isRunning) {
      // Search for our automation on nearby ports first
      const existingAutomationPort = await this.findRunningAutomationPort(port);
      if (existingAutomationPort !== null) {
        this.state.port = existingAutomationPort;
        config = this.getAutomationConfig();
        console.error(`[comet] Found existing automation ${formatAutomationDescriptor(existingAutomationPort)}.`);
        return `Comet automation already running on port ${existingAutomationPort} (mode=${config.profileMode}, profile=${config.profileDir}, userDataDir=${config.userDataDir})`;
      }

      if (getProfileMode() === 'default') {
        // Default-profile mode: Comet is running but without CDP.
        // Try common debug ports first (in case it was launched with one we didn't check).
        for (const probePort of [9222, 9223, 9224, 9225]) {
          if (probePort === port) continue; // Already checked above
          if (await this.isDebugPortReachable(probePort)) {
            this.state.port = probePort;
            config = this.getAutomationConfig();
            console.error(`[comet] Default-profile mode: found existing CDP on port ${probePort}. No restart needed.`);
            return `Comet automation found on port ${probePort} (mode=${config.profileMode}, profile=${config.profileDir}, userDataDir=${config.userDataDir})`;
          }
        }

        // No CDP port found. Respect existing Comet windows by default.
        const forceRestart = process.env.COMET_FORCE_RESTART === 'true';
        if (forceRestart) {
          // Opt-in restart: kill and relaunch with CDP + --restore-last-session to preserve tabs.
          console.error(`[comet] Default-profile mode: COMET_FORCE_RESTART=true. Restarting Comet with CDP on port ${port}. Open tabs will be restored via --restore-last-session.`);
          await this.killComet();
          await new Promise(resolve => setTimeout(resolve, 2000));
          await this.launchCometProcess(port, true);
          await this.waitForDebugPort(port, IS_WSL ? 3000 : 2500);
          config = this.getAutomationConfig();
          return `Comet automation started on port ${port} (mode=${config.profileMode}, profile=${config.profileDir}, userDataDir=${config.userDataDir})`;
        }

        // Non-destructive: tell the user how to start Comet with CDP themselves.
        const cometPath = COMET_PATH;
        console.error(`[comet] Default-profile mode: Comet is running without CDP. Cannot attach without restarting.`);
        console.error(`[comet] To enable CDP, close Comet and relaunch with: "${cometPath}" --remote-debugging-port=${port} --restore-last-session --new-window`);
        console.error(`[comet] Or set COMET_FORCE_RESTART=true to allow automatic restart.`);
        return `Comet is running without CDP (remote debugging). To connect:\n` +
          `1. Close Comet and relaunch with: "${cometPath}" --remote-debugging-port=${port} --restore-last-session --new-window\n` +
          `2. Or set env var COMET_FORCE_RESTART=true to allow automatic restart (tabs are preserved via --restore-last-session).\n` +
          `Mode: ${config.profileMode}, Port: ${port}`;
      }

      console.error(`[comet] Existing Comet process detected without CDP on port ${port}; leaving it untouched and launching automation ${formatAutomationDescriptor(port)}.`);
    } else {
      console.error(`[comet] Launching automation ${formatAutomationDescriptor(port)}.`);
    }

    await this.launchCometProcess(port);
    await this.waitForDebugPort(port, IS_WSL ? 2000 : 1500);

    return `Comet automation started on port ${port} (mode=${config.profileMode}, profile=${config.profileDir}, userDataDir=${config.userDataDir})`;
  }

  /**
   * Get CDP version info
   */

  /**
   * Get CDP version info
   */
  async getVersion(): Promise<CDPVersion> {
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/version`);
    if (!response.ok) throw new Error(`Failed to get version: ${response.status}`);
    return response.json() as Promise<CDPVersion>;
  }

  /**
   * List all available tabs/targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    // On WSL, use HTTP via PowerShell (WebSocket doesn't work across WSL/Windows boundary)
    if (IS_WSL) {
      const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/list`);
      if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
      return response.json() as Promise<CDPTarget[]>;
    }

    // On native Windows (not WSL), use CDP Target.getTargets() to avoid HTTP issues
    if (IS_WINDOWS) {
      try {
        const tempClient = await CDP({ port: this.state.port, host: '127.0.0.1' });
        const { targetInfos } = await (tempClient as any).Target.getTargets();
        await tempClient.close();

        return targetInfos.map((t: any) => ({
          id: t.targetId,
          type: t.type,
          title: t.title,
          url: t.url,
          webSocketDebuggerUrl: `ws://127.0.0.1:${this.state.port}/devtools/page/${t.targetId}`
        }));
      } catch (error) {
        throw new Error(`Failed to list targets: ${error}`);
      }
    }

    // Fallback for other platforms (macOS, Linux)
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/list`);
    if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
    return response.json() as Promise<CDPTarget[]>;
  }

  /**
   * Connect to a specific tab
   */
  async connect(targetId?: string): Promise<string> {
    // Skip reconnect if already connected to the same target (avoids closing open pickers/popovers)
    if (this.client && targetId && this.state.activeTabId === targetId) {
      return `Already connected to tab: ${this.state.currentUrl}`;
    }
    if (this.client) {
      await this.disconnect();
    }

    // On WSL, check if we can connect directly (mirrored networking required)
    const connectPort = await getWSLConnectPort(this.state.port);

    const options: CDP.Options = { port: connectPort, host: '127.0.0.1' };
    if (targetId) options.target = targetId;

    this.client = await CDP(options);

    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.DOM.enable(),
      this.client.Network.enable(),
    ]);

    // Set window size for consistent UI
    try {
      const { windowId } = await (this.client as any).Browser.getWindowForTarget({ targetId });
      await (this.client as any).Browser.setWindowBounds({
        windowId,
        bounds: { width: 1440, height: 900, windowState: 'normal' },
      });
    } catch {
      try {
        await (this.client as any).Emulation.setDeviceMetricsOverride({
          width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
        });
      } catch { /* continue */ }
    }

    this.state.connected = true;
    this.state.activeTabId = targetId;
    this.lastTargetId = targetId;
    this.reconnectAttempts = 0;

    const { result } = await this.client.Runtime.evaluate({ expression: "window.location.href" });
    this.state.currentUrl = result.value as string;

    return `Connected to tab: ${this.state.currentUrl}`;
  }

  /**
   * Disconnect from current tab
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.state.connected = false;
      this.state.activeTabId = undefined;
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(url: string, waitForLoad: boolean = true): Promise<NavigateResult> {
    this.ensureConnected();
    const result = await this.client!.Page.navigate({ url });
    if (waitForLoad) await this.client!.Page.loadEventFired();
    this.state.currentUrl = url;
    return result as NavigateResult;
  }

  /**
   * Navigate to a URL with automatic retry on failure
   * @param url - URL to navigate to
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param retryDelay - Delay between retries in ms (default: 1000)
   */
  async navigateWithRetry(url: string, maxRetries: number = 3, retryDelay: number = 1000): Promise<{ success: boolean; url: string; attempts: number; error?: string }> {
    let lastError: string = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.withAutoReconnect(async () => {
          this.ensureConnected();
          const result = await this.client!.Page.navigate({ url });

          // Check if navigation succeeded
          if (result.errorText) {
            throw new Error(result.errorText);
          }

          // Wait for load with timeout
          await Promise.race([
            this.client!.Page.loadEventFired(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timeout')), 15000))
          ]);

          this.state.currentUrl = url;
        });

        return { success: true, url, attempts: attempt };
      } catch (error: any) {
        lastError = error.message || String(error);

        // Don't retry for certain errors
        if (lastError.includes('net::ERR_NAME_NOT_RESOLVED') ||
            lastError.includes('net::ERR_INVALID_URL')) {
          return { success: false, url, attempts: attempt, error: lastError };
        }

        // Wait before retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
      }
    }

    return { success: false, url, attempts: maxRetries, error: lastError };
  }

  /**
   * Capture screenshot
   */
  async screenshot(format: "png" | "jpeg" = "png"): Promise<ScreenshotResult> {
    this.ensureConnected();
    return this.client!.Page.captureScreenshot({ format }) as Promise<ScreenshotResult>;
  }

  /**
   * Execute JavaScript in the page context
   */
  async evaluate(expression: string): Promise<EvaluateResult> {
    this.ensureConnected();
    return this.client!.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<EvaluateResult>;
  }

  /**
   * Execute JavaScript with auto-reconnect on connection loss
   */
  async safeEvaluate(expression: string): Promise<EvaluateResult> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();
      return this.client!.Runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as Promise<EvaluateResult>;
    });
  }

  /**
   * Press a key
   */
  async pressKey(key: string): Promise<void> {
    this.ensureConnected();

    if (key === "Enter") {
      await this.client!.Input.dispatchKeyEvent({
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        unmodifiedText: "\r",
        text: "\r",
      });
      await this.client!.Input.dispatchKeyEvent({
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
      return;
    }

    await this.client!.Input.dispatchKeyEvent({ type: "keyDown", key });
    await this.client!.Input.dispatchKeyEvent({ type: "keyUp", key });
  }

  /**
   * Insert text via CDP (fires native input events, compatible with React)
   */
  async insertText(text: string): Promise<void> {
    this.ensureConnected();
    await this.client!.Input.insertText({ text });
  }

  /**
   * Click an element by evaluating a JS expression that returns {x, y} coordinates.
   * Uses native CDP mouse events, which React's pointer event handlers respond to.
   * @param jsExpr - JS expression returning {x, y} of the center of the element to click, or null
   */
  async clickAtCoords(jsExpr: string): Promise<boolean> {
    this.ensureConnected();
    const result = await this.client!.Runtime.evaluate({ expression: jsExpr, returnByValue: true });
    const coords = result.result.value as { x: number; y: number } | null;
    if (!coords) return false;
    await this.client!.Input.dispatchMouseEvent({ type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await this.client!.Input.dispatchMouseEvent({ type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    return true;
  }

  /**
   * Create a new tab
   */
  async newTab(url?: string): Promise<CDPTarget> {
    const response = await windowsFetch(
      `http://127.0.0.1:${this.state.port}/json/new${url ? `?${url}` : ""}`,
      'PUT'
    );
    if (!response.ok) throw new Error(`Failed to create new tab: ${response.status}`);
    return response.json() as Promise<CDPTarget>;
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<boolean> {
    try {
      if (this.client) {
        const result = await this.client.Target.closeTarget({ targetId });
        return result.success;
      }
    } catch { /* fallback to HTTP */ }

    try {
      const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/close/${targetId}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private ensureConnected(): void {
    if (!this.client) {
      throw new Error("Not connected to Comet. Call connect() first.");
    }
  }

  /**
   * Upload a file to a file input element on the page
   * Uses CDP DOM.setFileInputFiles to inject file into input
   *
   * @param filePath - Absolute path to the file to upload
   * @param selector - Optional CSS selector for the file input (auto-detects if not provided)
   * @returns Result with success status and details
   */
  async uploadFile(filePath: string, selector?: string): Promise<{ success: boolean; message: string; inputFound: boolean }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      // Find the file input element
      let nodeId: number;

      if (selector) {
        // Use provided selector
        const doc = await this.client!.DOM.getDocument();
        const result = await this.client!.DOM.querySelector({
          nodeId: doc.root.nodeId,
          selector: selector
        });

        if (!result.nodeId) {
          return {
            success: false,
            message: `No element found matching selector: ${selector}`,
            inputFound: false
          };
        }
        nodeId = result.nodeId;
      } else {
        // Auto-detect file input - find first visible file input
        const doc = await this.client!.DOM.getDocument();

        // Try common file input selectors
        const selectors = [
          'input[type="file"]:not([disabled])',
          'input[type="file"]',
          '[data-testid*="file"] input',
          '[class*="upload"] input[type="file"]',
          '[class*="dropzone"] input[type="file"]'
        ];

        let found = false;
        for (const sel of selectors) {
          try {
            const result = await this.client!.DOM.querySelector({
              nodeId: doc.root.nodeId,
              selector: sel
            });
            if (result.nodeId) {
              nodeId = result.nodeId;
              found = true;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!found) {
          return {
            success: false,
            message: 'No file input element found on the page. Try providing a specific selector.',
            inputFound: false
          };
        }
      }

      // Set the file on the input element
      try {
        await this.client!.DOM.setFileInputFiles({
          nodeId: nodeId!,
          files: [filePath]
        });

        // Trigger React-compatible change event
        // React 16+ uses a synthetic event system that intercepts native events;
        // we must simulate a real browser-level change via the native prototype setter.
        await this.client!.Runtime.evaluate({
          expression: `
            (function() {
              const sel = ${JSON.stringify(selector || 'input[type="file"]')};
              const input = document.querySelector(sel);
              if (!input) return;
              // Dispatch native change event — React's event delegation picks this up
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new Event('input', { bubbles: true }));
              // Also try clicking the input to trigger any React onClick → onChange chain
              input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            })();
          `
        });

        return {
          success: true,
          message: `File uploaded successfully: ${filePath}`,
          inputFound: true
        };
      } catch (error: any) {
        return {
          success: false,
          message: `Failed to set file: ${error.message}`,
          inputFound: true
        };
      }
    });
  }

  /**
   * Upload multiple files to a file input element
   *
   * @param filePaths - Array of absolute file paths
   * @param selector - Optional CSS selector for the file input
   */
  async uploadFiles(filePaths: string[], selector?: string): Promise<{ success: boolean; message: string }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      const doc = await this.client!.DOM.getDocument();
      const sel = selector || 'input[type="file"]';

      const result = await this.client!.DOM.querySelector({
        nodeId: doc.root.nodeId,
        selector: sel
      });

      if (!result.nodeId) {
        return {
          success: false,
          message: `No file input found with selector: ${sel}`
        };
      }

      try {
        await this.client!.DOM.setFileInputFiles({
          nodeId: result.nodeId,
          files: filePaths
        });

        // Trigger change event
        await this.client!.Runtime.evaluate({
          expression: `
            (function() {
              const input = document.querySelector('${sel}');
              if (input) {
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })();
          `
        });

        return {
          success: true,
          message: `${filePaths.length} file(s) uploaded successfully`
        };
      } catch (error: any) {
        return {
          success: false,
          message: `Failed to upload files: ${error.message}`
        };
      }
    });
  }

  /**
   * Check if the current page has any file inputs
   */
  async hasFileInput(): Promise<{ found: boolean; count: number; selectors: string[] }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      const result = await this.client!.Runtime.evaluate({
        expression: `
          (function() {
            const inputs = document.querySelectorAll('input[type="file"]');
            const selectors = [];
            inputs.forEach((input, i) => {
              let sel = 'input[type="file"]';
              if (input.id) sel = '#' + input.id;
              else if (input.name) sel = 'input[name="' + input.name + '"]';
              else if (input.className) sel = 'input[type="file"].' + input.className.split(' ')[0];
              selectors.push(sel);
            });
            return { count: inputs.length, selectors };
          })();
        `,
        returnByValue: true
      });

      const data = result.result.value as { count: number; selectors: string[] };
      return {
        found: data.count > 0,
        count: data.count,
        selectors: data.selectors
      };
    });
  }

  /**
   * Click on a file input to potentially trigger a file picker dialog
   * Note: This won't actually open a native dialog in headless mode,
   * but can trigger custom file picker UIs
   */
  async clickFileInput(selector?: string): Promise<{ success: boolean; message: string }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      const sel = selector || 'input[type="file"]';

      const result = await this.client!.Runtime.evaluate({
        expression: `
          (function() {
            const input = document.querySelector('${sel}');
            if (input) {
              input.click();
              return { clicked: true };
            }
            return { clicked: false };
          })();
        `,
        returnByValue: true
      });

      const data = result.result.value as { clicked: boolean };
      return {
        success: data.clicked,
        message: data.clicked ? 'File input clicked' : 'No file input found to click'
      };
    });
  }
}

export const cometClient = new CometCDPClient();
