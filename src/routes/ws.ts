/**
 * WebSocket endpoint /ws.
 *
 * Clients send `{ action: 'subscribe', channel: 'deposit.new.user.<id>' }`.
 * The server subscribes to the in-process bus and fans out JSON messages.
 */
import type { FastifyInstance } from 'fastify';
import { subscribe } from '../lib/bus.js';

interface ClientMsg {
  action: 'subscribe' | 'unsubscribe';
  channel: string;
}

export async function registerWsRoutes(app: FastifyInstance) {
  app.get('/ws', { websocket: true }, (socket /* WebSocket */) => {
    const unsubs = new Map<string, () => void>();

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMsg;
        if (msg.action === 'subscribe' && typeof msg.channel === 'string') {
          if (unsubs.has(msg.channel)) return;
          const un = subscribe(msg.channel, (payload) => {
            try {
              socket.send(JSON.stringify({ channel: msg.channel, payload }));
            } catch {
              /* socket closed */
            }
          });
          unsubs.set(msg.channel, un);
        } else if (msg.action === 'unsubscribe') {
          const un = unsubs.get(msg.channel);
          if (un) {
            un();
            unsubs.delete(msg.channel);
          }
        }
      } catch {
        // malformed; ignore
      }
    });

    socket.on('close', () => {
      for (const un of unsubs.values()) un();
      unsubs.clear();
    });
  });
}
