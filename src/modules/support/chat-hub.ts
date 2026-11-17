import { EventEmitter } from 'node:events';

/** Something changed in a chat: a message was sent, the chat was taken or closed. */
export interface ChatEvent { chatId: string; customerId: string }

/** The slice of Redis the hub uses. Kept small so tests (and a Redis outage) never get in the way. */
export interface ChatBus {
  publish(channel: string, message: string): Promise<unknown>;
  duplicate(options?: Record<string, unknown>): { subscribe(channel: string): Promise<unknown>; on(event: 'message', fn: (channel: string, message: string) => void): unknown; disconnect(): void };
}

const CHANNEL = 'shopcore:chat';

/**
 * Wakes people who are waiting on a chat the moment something happens in it, so messages arrive in about a
 * tenth of a second instead of on the next refresh. Waiting requests are held open for a few seconds (long polling),
 * which works the same for the admin website and the phone apps and needs no extra connection type.
 *
 * With one server it is all in memory. With Redis, events are shared so any server instance wakes its own waiters.
 */
export class ChatHub {
  private readonly events = new EventEmitter();
  private readonly id = Math.random().toString(36).slice(2);
  private sub?: { disconnect(): void };

  constructor(private readonly bus?: ChatBus, private readonly warn: (msg: string) => void = () => undefined) {
    this.events.setMaxListeners(0);
    if (bus) {
      try {
        const sub = bus.duplicate({ enableOfflineQueue: true, commandTimeout: undefined, maxRetriesPerRequest: null });
        sub.on('message', (_c, raw) => {
          try {
            const m = JSON.parse(raw) as ChatEvent & { from: string };
            if (m.from !== this.id) this.events.emit('chat', { chatId: m.chatId, customerId: m.customerId });
          } catch { /* ignore a malformed event */ }
        });
        void sub.subscribe(CHANNEL).catch((e: Error) => this.warn(`chat hub: redis subscribe failed (${e.message}); this server only wakes its own chats`));
        this.sub = sub;
      } catch (e) {
        this.warn(`chat hub: redis unavailable (${(e as Error).message}); this server only wakes its own chats`);
      }
    }
  }

  publish(e: ChatEvent): void {
    this.events.emit('chat', e);
    void this.bus?.publish(CHANNEL, JSON.stringify({ ...e, from: this.id })).catch(() => undefined);
  }

  /**
   * Starts listening right away. `promise` resolves true when a matching event arrives, or false after `ms` with nothing.
   * Start listening BEFORE reading the current state, so a message that lands in between is not missed.
   */
  listen(match: (e: ChatEvent) => boolean, ms: number): { promise: Promise<boolean>; cancel: () => void } {
    let finish: (v: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      const done = (v: boolean) => { clearTimeout(timer); this.events.off('chat', on); resolve(v); };
      const on = (e: ChatEvent) => { if (match(e)) done(true); };
      const timer = setTimeout(() => done(false), ms);
      this.events.on('chat', on);
      finish = done;
    });
    return { promise, cancel: () => finish(false) };
  }

  close(): void { this.sub?.disconnect(); this.events.removeAllListeners(); }
}
