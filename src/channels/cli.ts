import net from 'net';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';
import {
  getAllRegisteredGroups,
  getAllTasks,
  getAllSessions,
  getRecentMessages,
} from '../db.js';

const CLI_JID = 'cli:local';
export const CLI_SOCKET_PATH = path.join(DATA_DIR, 'cli.sock');

const STATUS_BROADCAST_INTERVAL = 1000;

export class CliChannel implements Channel {
  name = 'cli';

  private server: net.Server | null = null;
  private clients: Set<net.Socket> = new Set();
  private opts: ChannelOpts;
  private connected = false;
  private messageCounter = 0;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Auto-register cli group if cli:local is not yet registered
    const groups = this.opts.registeredGroups();
    if (!groups[CLI_JID] && this.opts.registerGroup) {
      const hasMain = Object.values(groups).some((g) => g.isMain === true);
      this.opts.registerGroup(CLI_JID, {
        name: 'CLI',
        folder: 'cli_main',
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
        isMain: !hasMain,
      });
      logger.info({ isMain: !hasMain }, 'Auto-registered cli_main group');
    }

    this.opts.onChatMetadata(
      CLI_JID,
      new Date().toISOString(),
      'CLI',
      'cli',
      false,
    );

    // Clean up stale socket file
    if (fs.existsSync(CLI_SOCKET_PATH)) {
      fs.unlinkSync(CLI_SOCKET_PATH);
    }

    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      logger.info('CLI client connected');

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;

          // Intercept /commands
          if (line.startsWith('/')) {
            const result = this.handleCommand(line);
            const payload = JSON.stringify({ commandResult: result }) + '\n';
            if (!socket.destroyed) socket.write(payload);
            continue;
          }

          this.messageCounter++;
          const msgId = `cli-${this.messageCounter}`;
          const timestamp = new Date().toISOString();

          this.opts.onChatMetadata(CLI_JID, timestamp, 'CLI', 'cli', false);
          this.opts.onMessage(CLI_JID, {
            id: msgId,
            chat_jid: CLI_JID,
            sender: 'cli_user',
            sender_name: 'User',
            content: line,
            timestamp,
            is_from_me: false,
          });

          logger.info({ msgId }, 'CLI message received');
        }
      });

      socket.on('close', () => {
        this.clients.delete(socket);
        logger.info('CLI client disconnected');
      });

      socket.on('error', (err) => {
        this.clients.delete(socket);
        logger.debug({ err }, 'CLI client error');
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(CLI_SOCKET_PATH, () => {
        this.connected = true;
        logger.info({ socket: CLI_SOCKET_PATH }, 'CLI socket server started');
        resolve();
      });
      this.server!.on('error', reject);
    });

    // Broadcast system status to connected clients periodically
    if (this.opts.getSystemStatus) {
      this.statusTimer = setInterval(() => {
        if (this.clients.size === 0) return;
        const status = this.opts.getSystemStatus!();
        const payload = JSON.stringify({ status }) + '\n';
        for (const client of this.clients) {
          if (!client.destroyed) {
            client.write(payload);
          }
        }
      }, STATUS_BROADCAST_INTERVAL);
    }
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    const payload = JSON.stringify({ text }) + '\n';
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(payload);
      }
    }
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    const payload = JSON.stringify({ typing: isTyping }) + '\n';
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(payload);
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('cli:');
  }

  private handleCommand(line: string): string {
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/groups':
        return this.cmdGroups();
      case '/memory':
        return this.cmdMemory(parts[1]);
      case '/messages':
        return this.cmdMessages(parts[1], parts[2] ? parseInt(parts[2], 10) : undefined);
      case '/tasks':
        return this.cmdTasks();
      case '/sessions':
        return this.cmdSessions();
      default:
        return `Unknown command: ${cmd}\nAvailable: /groups /memory /messages /tasks /sessions`;
    }
  }

  private cmdGroups(): string {
    const groups = getAllRegisteredGroups();
    const entries = Object.entries(groups);
    if (entries.length === 0) return 'No registered groups.';

    const lines = ['Registered Groups:', ''];
    for (const [jid, g] of entries) {
      const flags: string[] = [];
      if (g.isMain) flags.push('main');
      if (g.requiresTrigger === false) flags.push('no-trigger');
      const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
      lines.push(`  ${g.folder}${flagStr}`);
      lines.push(`    name: ${g.name}  trigger: ${g.trigger}  jid: ${jid}`);
    }
    return lines.join('\n');
  }

  private cmdMemory(folder?: string): string {
    const targetFolder = folder || 'cli_main';
    const lines: string[] = [];

    // Group memory
    const groupPath = path.join(GROUPS_DIR, targetFolder, 'CLAUDE.md');
    if (fs.existsSync(groupPath)) {
      lines.push(`=== ${targetFolder}/CLAUDE.md ===`, '');
      lines.push(fs.readFileSync(groupPath, 'utf-8'));
    } else {
      lines.push(`No CLAUDE.md found for "${targetFolder}".`);
    }

    // Global memory
    const globalPath = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
    if (fs.existsSync(globalPath)) {
      lines.push('', `=== global/CLAUDE.md ===`, '');
      lines.push(fs.readFileSync(globalPath, 'utf-8'));
    }

    return lines.join('\n');
  }

  private cmdMessages(folder?: string, n?: number): string {
    const targetFolder = folder || 'cli_main';
    const limit = n || 20;

    // Find the JID for this folder
    const groups = getAllRegisteredGroups();
    let targetJid: string | null = null;
    for (const [jid, g] of Object.entries(groups)) {
      if (g.folder === targetFolder) {
        targetJid = jid;
        break;
      }
    }
    if (!targetJid) return `No group found with folder "${targetFolder}".`;

    const messages = getRecentMessages(targetJid, limit);
    if (messages.length === 0) return `No messages in "${targetFolder}".`;

    const lines = [`Recent messages in ${targetFolder} (${messages.length}):`, ''];
    for (const m of messages) {
      const time = new Date(m.timestamp).toLocaleString();
      const prefix = m.is_from_me ? `[${ASSISTANT_NAME}]` : `[${m.sender_name || m.sender}]`;
      lines.push(`  ${time}  ${prefix}  ${m.content}`);
    }
    return lines.join('\n');
  }

  private cmdTasks(): string {
    const tasks = getAllTasks();
    if (tasks.length === 0) return 'No scheduled tasks.';

    const lines = ['Scheduled Tasks:', ''];
    for (const t of tasks) {
      const status = t.status === 'active' ? '●' : t.status === 'paused' ? '◌' : '✓';
      lines.push(`  ${status} ${t.id}  [${t.status}]`);
      lines.push(`    group: ${t.group_folder}  schedule: ${t.schedule_type} ${t.schedule_value}`);
      lines.push(`    prompt: ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '...' : ''}`);
      if (t.next_run) lines.push(`    next: ${new Date(t.next_run).toLocaleString()}`);
      if (t.last_run) lines.push(`    last: ${new Date(t.last_run).toLocaleString()}`);
    }
    return lines.join('\n');
  }

  private cmdSessions(): string {
    const sessions = getAllSessions();
    const entries = Object.entries(sessions);
    if (entries.length === 0) return 'No active sessions.';

    const lines = ['Active Sessions:', ''];
    for (const [folder, sessionId] of entries) {
      lines.push(`  ${folder}: ${sessionId}`);
    }
    return lines.join('\n');
  }

  async disconnect(): Promise<void> {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (fs.existsSync(CLI_SOCKET_PATH)) {
      fs.unlinkSync(CLI_SOCKET_PATH);
    }
    this.connected = false;
    logger.info('CLI socket server stopped');
  }
}

registerChannel('cli', (opts: ChannelOpts) => {
  const enabled =
    process.env.NANOCLAW_CLI === '1' || process.argv.includes('--cli');
  if (!enabled) return null;
  return new CliChannel(opts);
});
