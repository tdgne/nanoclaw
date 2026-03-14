#!/usr/bin/env node
/**
 * CLI client for NanoClaw.
 * Connects to the running service via Unix socket and provides
 * an interactive prompt with a vim-style statusline and command autocomplete.
 */

import net from 'net';
import readline from 'readline';
import path from 'path';

const SOCKET_PATH = path.join(process.cwd(), 'data', 'cli.sock');
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';

// --- Colors / ANSI helpers ---
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const BG_GRAY = '\x1b[48;5;236m';
const FG_WHITE = '\x1b[38;5;255m';
const FG_GREEN = '\x1b[38;5;114m';
const FG_YELLOW = '\x1b[38;5;221m';
const FG_RED = '\x1b[38;5;203m';
const FG_GRAY = '\x1b[38;5;245m';
const FG_CYAN = '\x1b[38;5;117m';

// --- Commands ---
const COMMANDS = [
  { name: '/groups', desc: 'List registered groups' },
  { name: '/memory', desc: 'Show group memory (CLAUDE.md)' },
  { name: '/messages', desc: 'Show recent messages' },
  { name: '/tasks', desc: 'List scheduled tasks' },
  { name: '/sessions', desc: 'List active sessions' },
];

// --- Spinner ---
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerIndex = 0;
let isTyping = false;

function startSpinner() {
  isTyping = true;
  if (spinnerTimer) return;
  spinnerIndex = 0;
  spinnerTimer = setInterval(() => {
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
    renderStatusline();
  }, 80);
}

function stopSpinner() {
  isTyping = false;
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
  }
}

// --- Status state ---
interface GroupStatusInfo {
  jid: string;
  state: 'active' | 'idle' | 'queued' | 'retry' | 'inactive';
  pendingMessages: boolean;
  pendingTaskCount: number;
  runningTaskId: string | null;
  retryCount: number;
  groupFolder: string | null;
}

interface SystemStatus {
  queue: {
    activeCount: number;
    maxContainers: number;
    waitingCount: number;
    groups: GroupStatusInfo[];
  };
  activeTasks: number;
  nextTaskRun: string | null;
  uptime: number;
  channels: string[];
}

let lastStatus: SystemStatus | null = null;
let statuslineHeight = 0;

// --- Autocomplete state ---
let autocompleteLines: string[] = [];
let ghostText = '';

function getGroupFolders(): string[] {
  if (!lastStatus) return [];
  return lastStatus.queue.groups
    .map((g) => g.groupFolder)
    .filter((f): f is string => f !== null);
}

function getMatchingCommands(input: string): typeof COMMANDS {
  if (!input.startsWith('/')) return [];
  return COMMANDS.filter((c) => c.name.startsWith(input));
}

function computeAutocomplete(line: string): void {
  ghostText = '';
  autocompleteLines = [];

  if (!line.startsWith('/')) return;

  // Check if we're completing a command argument (e.g. /memory <folder>)
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx !== -1) {
    const cmd = line.slice(0, spaceIdx);
    const arg = line.slice(spaceIdx + 1);
    if (cmd === '/memory' || cmd === '/messages') {
      const folders = getGroupFolders();
      const matches = arg ? folders.filter((f) => f.startsWith(arg)) : folders;
      if (matches.length === 1) {
        ghostText = matches[0].slice(arg.length);
      } else if (matches.length > 1) {
        autocompleteLines = matches.map((f) => `  ${DIM}${f}${RESET}`);
      }
    }
    return;
  }

  // Command name completion
  const matches = getMatchingCommands(line);
  if (matches.length === 1) {
    ghostText = matches[0].name.slice(line.length);
  } else if (matches.length > 1) {
    autocompleteLines = matches.map(
      (c) => `  ${DIM}${c.name}  ${FG_GRAY}${c.desc}${RESET}`,
    );
    // Also show ghost text of the first match
    if (matches[0].name.length > line.length) {
      ghostText = matches[0].name.slice(line.length);
    }
  }
}

function renderAutocomplete(): void {
  if (autocompleteLines.length === 0) return;

  const rows = process.stdout.rows || 24;
  const contentRows = Math.max(1, rows - statuslineHeight);

  // Save cursor
  process.stdout.write('\x1b7');

  // Draw autocomplete lines above the statusline, below the prompt line
  // Get current cursor row
  const maxLines = Math.min(autocompleteLines.length, contentRows - 2);
  for (let i = 0; i < maxLines; i++) {
    // Write below current prompt line
    process.stdout.write(`\n\x1b[2K${autocompleteLines[i]}`);
  }

  // Restore cursor
  process.stdout.write('\x1b8');
}

function clearAutocomplete(): void {
  if (autocompleteLines.length === 0) return;
  // The autocomplete lines are ephemeral — they'll be overwritten
  // on next prompt. Just clear state.
  autocompleteLines = [];
  ghostText = '';
}

// --- Statusline rendering ---

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24)
    return remainingMinutes > 0 ? `${hours}h${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d${remainingHours}h` : `${days}d`;
}

function formatNextRun(isoStr: string | null): string {
  if (!isoStr) return '';
  const diff = new Date(isoStr).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function groupStateIcon(state: GroupStatusInfo['state']): string {
  switch (state) {
    case 'active':
      return (
        FG_GREEN + SPINNER_FRAMES[spinnerIndex] + RESET + BG_GRAY + FG_WHITE
      );
    case 'idle':
      return FG_GREEN + '●' + RESET + BG_GRAY + FG_WHITE;
    case 'queued':
      return FG_YELLOW + '◌' + RESET + BG_GRAY + FG_WHITE;
    case 'retry':
      return FG_RED + '⟳' + RESET + BG_GRAY + FG_WHITE;
    case 'inactive':
      return FG_GRAY + '○' + RESET + BG_GRAY + FG_WHITE;
  }
}

function groupStateLabel(g: GroupStatusInfo): string {
  switch (g.state) {
    case 'active':
      if (g.runningTaskId) return 'task';
      return 'active';
    case 'idle':
      return 'idle';
    case 'queued': {
      const parts: string[] = [];
      if (g.pendingMessages) parts.push('msg');
      if (g.pendingTaskCount > 0) parts.push(`${g.pendingTaskCount}task`);
      return parts.length > 0 ? parts.join('+') : 'queued';
    }
    case 'retry':
      return `retry ${g.retryCount}`;
    case 'inactive':
      return '--';
  }
}

function groupDisplayName(g: GroupStatusInfo): string {
  // Use folder if available, otherwise shorten JID
  if (g.groupFolder) return g.groupFolder;
  const parts = g.jid.split(':');
  return parts.length > 1 ? `${parts[0]}:${parts[1].slice(0, 8)}` : g.jid;
}

function buildStatusline(): string {
  if (!lastStatus) return '';

  const s = lastStatus;
  const cols = process.stdout.columns || 80;

  // Line 1: System overview
  const containerPart = `${s.queue.activeCount}/${s.queue.maxContainers}`;
  const groupCount = Object.keys(s.queue.groups).length;
  const taskPart =
    s.activeTasks > 0
      ? `${s.activeTasks} task${s.activeTasks !== 1 ? 's' : ''}${s.nextTaskRun ? ` (next: ${formatNextRun(s.nextTaskRun)})` : ''}`
      : 'no tasks';
  const uptimePart = formatUptime(s.uptime);
  const channelsPart = s.channels.join(',');
  const spinnerPart = isTyping ? ` ${SPINNER_FRAMES[spinnerIndex]}` : '';

  const line1 = ` ${containerPart} containers | ${groupCount} groups | ${taskPart} | ${channelsPart} | ${uptimePart}${spinnerPart} `;

  // Line 2: Per-group status (only show groups that have any activity)
  const groupParts: string[] = [];
  // Show active/idle/queued/retry first, then inactive
  const sortedGroups = [...s.queue.groups].sort((a, b) => {
    const order = { active: 0, idle: 1, queued: 2, retry: 3, inactive: 4 };
    return order[a.state] - order[b.state];
  });

  for (const g of sortedGroups) {
    const icon = groupStateIcon(g.state);
    const name = groupDisplayName(g);
    const label = groupStateLabel(g);
    groupParts.push(`${icon} ${name}[${label}]`);
  }

  const line2Content =
    groupParts.length > 0 ? ` ${groupParts.join('  ')} ` : '';

  // Pad lines to fill terminal width
  const pad = (text: string, width: number): string => {
    // Strip ANSI for length calculation
    const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
    const padding = Math.max(0, width - stripped.length);
    return text + ' '.repeat(padding);
  };

  const styledLine1 = BG_GRAY + FG_WHITE + pad(line1, cols) + RESET;
  const styledLine2 = line2Content
    ? BG_GRAY + FG_WHITE + pad(line2Content, cols) + RESET
    : '';

  return styledLine2 ? `${styledLine1}\n${styledLine2}` : styledLine1;
}

function renderStatusline() {
  const statusline = buildStatusline();
  if (!statusline) return;

  const lines = statusline.split('\n');
  const newHeight = lines.length;
  const rows = process.stdout.rows || 24;

  // Save cursor position
  process.stdout.write('\x1b7');

  // Clear old statusline area
  for (let i = 0; i < statuslineHeight; i++) {
    process.stdout.write(`\x1b[${rows - i};1H\x1b[2K`);
  }

  // Draw new statusline at bottom
  for (let i = 0; i < newHeight; i++) {
    process.stdout.write(`\x1b[${rows - newHeight + 1 + i};1H${lines[i]}`);
  }

  statuslineHeight = newHeight;

  // Restore cursor position
  process.stdout.write('\x1b8');
}

// --- Set scrolling region to exclude statusline ---

function updateScrollRegion() {
  const rows = process.stdout.rows || 24;
  const contentRows = Math.max(1, rows - statuslineHeight);
  // Set scrolling region to exclude statusline area
  process.stdout.write(`\x1b[1;${contentRows}r`);
  // Move cursor to content area (in case it was in statusline area)
  process.stdout.write(`\x1b[${contentRows};1H`);
}

function resetScrollRegion() {
  const rows = process.stdout.rows || 24;
  process.stdout.write(`\x1b[1;${rows}r`);
}

// --- Ghost text rendering ---

function renderGhostText(): void {
  if (!ghostText) return;
  // Write ghost text in dim after current cursor, then move cursor back
  process.stdout.write(`${DIM}${ghostText}${RESET}`);
  process.stdout.write(`\x1b[${ghostText.length}D`);
}

// --- Main ---

const socket = net.createConnection(SOCKET_PATH);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
  completer: (line: string): [string[], string] => {
    // Tab completion handler
    if (!line.startsWith('/')) return [[], line];

    const spaceIdx = line.indexOf(' ');
    if (spaceIdx !== -1) {
      // Completing argument
      const cmd = line.slice(0, spaceIdx);
      const arg = line.slice(spaceIdx + 1);
      if (cmd === '/memory' || cmd === '/messages') {
        const folders = getGroupFolders();
        const matches = arg
          ? folders.filter((f) => f.startsWith(arg))
          : folders;
        return [matches.map((f) => `${cmd} ${f}`), line];
      }
      return [[], line];
    }

    // Completing command name
    const matches = getMatchingCommands(line);
    return [matches.map((c) => c.name), line];
  },
});

// Enable keypress events for real-time autocomplete
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin, rl);
  process.stdin.on('keypress', (_ch, _key) => {
    // Defer to next tick so rl.line is updated
    setImmediate(() => {
      const currentLine = rl.line;
      const prevGhost = ghostText;
      const prevAutoLines = autocompleteLines.length;

      computeAutocomplete(currentLine);

      // If autocomplete state changed, redraw
      if (
        ghostText !== prevGhost ||
        autocompleteLines.length !== prevAutoLines
      ) {
        // Clear ghost text from display by rewriting the prompt line
        process.stdout.write(`\r\x1b[K> ${currentLine}`);
        renderGhostText();
        renderAutocomplete();
      }
    });
  });
}

socket.on('connect', () => {
  statuslineHeight = 2; // Reserve space
  updateScrollRegion();
  console.log(`\n  Connected to NanoClaw. Type messages below.`);
  console.log(`  Commands: ${COMMANDS.map((c) => c.name).join(' ')}`);
  console.log(`  Press Ctrl+D to exit.\n`);
  rl.prompt();
});

socket.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
    console.error(
      `Cannot connect to NanoClaw. Is the service running with NANOCLAW_CLI=1?`,
    );
    console.error(`  Socket: ${SOCKET_PATH}`);
  } else {
    console.error(`Connection error: ${err.message}`);
  }
  process.exit(1);
});

// Handle terminal resize
process.stdout.on('resize', () => {
  updateScrollRegion();
  renderStatusline();
});

// Parse newline-delimited JSON responses from service
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString();
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIdx);
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);

      if (msg.status) {
        lastStatus = msg.status as SystemStatus;
        renderStatusline();
        continue;
      }

      if (msg.typing === true) {
        startSpinner();
      } else if (msg.typing === false) {
        stopSpinner();
        renderStatusline();
      }

      if (msg.commandResult !== undefined) {
        // Display command result without spinner
        process.stdout.write('\r\x1b[K');
        console.log(`${msg.commandResult}\n`);
        rl.prompt();
        renderStatusline();
        continue;
      }

      if (msg.text) {
        stopSpinner();
        // Clear current line, print response, re-show prompt
        process.stdout.write('\r\x1b[K');
        console.log(`${BOLD}${ASSISTANT_NAME}${RESET}: ${msg.text}\n`);
        rl.prompt();
        renderStatusline();
      }
    } catch {
      // ignore malformed lines
    }
  }
});

socket.on('close', () => {
  stopSpinner();
  resetScrollRegion();
  console.log('\nDisconnected from NanoClaw.');
  process.exit(0);
});

rl.on('line', (line) => {
  const content = line.trim();
  clearAutocomplete();
  if (content) {
    socket.write(content + '\n');
    // Don't start spinner for commands (they return immediately)
    if (!content.startsWith('/')) {
      startSpinner();
    }
  }
  rl.prompt();
});

rl.on('close', () => {
  stopSpinner();
  resetScrollRegion();
  socket.end();
  process.exit(0);
});
