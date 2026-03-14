#!/usr/bin/env node
/**
 * CLI client for NanoClaw.
 * Connects to the running service via Unix socket and provides
 * an interactive prompt to chat with the agent.
 */

import net from 'net';
import readline from 'readline';
import path from 'path';

const SOCKET_PATH = path.join(process.cwd(), 'data', 'cli.sock');
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerIndex = 0;

function startSpinner() {
  stopSpinner();
  spinnerIndex = 0;
  spinnerTimer = setInterval(() => {
    process.stdout.write(`\r\x1b[K${SPINNER_FRAMES[spinnerIndex]}`);
    spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
  }, 80);
}

function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    process.stdout.write('\r\x1b[K');
  }
}

const socket = net.createConnection(SOCKET_PATH);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> ',
});

socket.on('connect', () => {
  console.log(`\n  Connected to NanoClaw. Type messages below.`);
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
      if (msg.typing === true) {
        startSpinner();
      } else if (msg.typing === false) {
        stopSpinner();
      }
      if (msg.text) {
        stopSpinner();
        // Clear current line, print response, re-show prompt
        process.stdout.write('\r\x1b[K');
        console.log(`\x1b[1m${ASSISTANT_NAME}\x1b[0m: ${msg.text}\n`);
        rl.prompt();
      }
    } catch {
      // ignore malformed lines
    }
  }
});

socket.on('close', () => {
  stopSpinner();
  console.log('\nDisconnected from NanoClaw.');
  process.exit(0);
});

rl.on('line', (line) => {
  const content = line.trim();
  if (content) {
    socket.write(content + '\n');
    startSpinner();
  }
  rl.prompt();
});

rl.on('close', () => {
  stopSpinner();
  socket.end();
  process.exit(0);
});
