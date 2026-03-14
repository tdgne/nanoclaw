import net from 'net';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

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
