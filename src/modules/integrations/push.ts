import { z } from 'zod';
import type { Logger } from 'pino';
import type { Config } from '../../config/index.js';
import type { Database, Queryable } from '../../infra/db.js';

export type Owner = { type: 'rider' | 'customer'; id: string };
export const LANGUAGES = ['en', 'sw'] as const;
export type Language = (typeof LANGUAGES)[number];

/** The kinds of message a rider can switch on or off. */
export const RIDER_PUSH_KINDS = ['requests', 'payouts', 'documents', 'account'] as const;
export type RiderPushKind = (typeof RIDER_PUSH_KINDS)[number];

export const PushTokenSchema = z.strictObject({ token: z.string().trim().min(10).max(300), platform: z.enum(['android', 'ios']).default('android') });

type Text = { title: string; body: string };

/** Every message the system sends, in each language. {name} style holes are filled in when the message is sent. */
export const TEMPLATES = {
  offer: { kind: 'requests', en: { title: 'New order request', body: 'Order {order} · you earn {amount}. You have 75 seconds to answer.' }, sw: { title: 'Ombi jipya la oda', body: 'Oda {order} · unapata {amount}. Una sekunde 75 kujibu.' } },
  doc_accepted: { kind: 'documents', en: { title: 'Document approved', body: 'Your {title} was verified.' }, sw: { title: 'Hati imekubaliwa', body: '{title} yako imethibitishwa.' } },
  doc_rejected: { kind: 'documents', en: { title: 'Document needs another look', body: '{title}: {note}' }, sw: { title: 'Hati inahitaji kuangaliwa tena', body: '{title}: {note}' } },
  approved: { kind: 'account', en: { title: 'You’re approved', body: 'Open ShopCore Rider and go online to start earning.' }, sw: { title: 'Umekubaliwa', body: 'Fungua ShopCore Rider na uanze kazi ili upate mapato.' } },
  suspended: { kind: 'account', en: { title: 'Your account is paused', body: '{reason}' }, sw: { title: 'Akaunti yako imesitishwa', body: '{reason}' } },
  reinstated: { kind: 'account', en: { title: 'Your account is active again', body: 'You can go online now.' }, sw: { title: 'Akaunti yako imerudi', body: 'Unaweza kuanza kazi sasa.' } },
  payout_paid: { kind: 'payouts', en: { title: 'Payout sent', body: '{amount} was sent to your M-Pesa.' }, sw: { title: 'Malipo yametumwa', body: '{amount} imetumwa kwa M-Pesa yako.' } },
  payout_failed: { kind: 'payouts', en: { title: 'Payout failed', body: '{amount} is back in your balance. {reason}' }, sw: { title: 'Malipo hayakufaulu', body: '{amount} imerudi kwenye salio lako. {reason}' } },
  referral: { kind: 'payouts', en: { title: 'Referral bonus', body: '{name} reached {goal} deliveries. {amount} was added to your balance.' }, sw: { title: 'Bonasi ya rufaa', body: '{name} amefikia oda {goal}. {amount} imeongezwa kwenye salio lako.' } },
  order_accepted: { kind: 'orders', en: { title: 'A rider is on the way to the shop', body: '{rider} will deliver order {order}.' }, sw: { title: 'Mpanda pikipiki anaelekea dukani', body: '{rider} atakuletea oda {order}.' } },
  order_on_the_way: { kind: 'orders', en: { title: 'Your order is on its way', body: 'Order {order} has been picked up. Keep your code ready: {code}.' }, sw: { title: 'Oda yako iko njiani', body: 'Oda {order} imechukuliwa. Weka msimbo wako tayari: {code}.' } },
  order_arrived: { kind: 'orders', en: { title: 'Your rider has arrived', body: 'Give {code} to the rider to receive order {order}.' }, sw: { title: 'Mpanda pikipiki amefika', body: 'Mpe {code} ili upokee oda {order}.' } },
  order_delivered: { kind: 'orders', en: { title: 'Order delivered', body: 'Order {order} was delivered. Tell us how it went.' }, sw: { title: 'Oda imewasilishwa', body: 'Oda {order} imewasilishwa. Tuambie ilivyokuwa.' } },
  campaign: { kind: 'deals', en: { title: '{title}', body: '{body}' }, sw: { title: '{title}', body: '{body}' } },
  return_update: { kind: 'returns', en: { title: 'Update on your return', body: '{message}' }, sw: { title: 'Taarifa kuhusu kurudisha bidhaa', body: '{message}' } },
  back_in_stock: { kind: 'stock', en: { title: 'Back in stock', body: '{product} is available again.' }, sw: { title: 'Imerudi dukani', body: '{product} inapatikana tena.' } },
  chat_reply: { kind: 'support', en: { title: 'ShopCore support replied', body: '{text}' }, sw: { title: 'Huduma kwa wateja imejibu', body: '{text}' } },
  referral_points: { kind: 'orders', en: { title: 'You earned reward points', body: '{name} placed their first order. {points} points were added.' }, sw: { title: 'Umepata pointi za zawadi', body: '{name} ameagiza kwa mara ya kwanza. Pointi {points} zimeongezwa.' } },
} as const satisfies Record<string, { kind: string; en: Text; sw: Text }>;
export type TemplateId = keyof typeof TEMPLATES;

const fill = (s: string, p: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => p[k] ?? '');
export const render = (id: TemplateId, lang: Language, params: Record<string, string>): Text => {
  const t = TEMPLATES[id][lang];
  return { title: fill(t.title, params), body: fill(t.body, params) };
};

/** Adds a message to the queue inside the caller's transaction, so it exists only if the change it announces was saved. */
export async function queuePush(c: Queryable, owner: Owner, template: TemplateId, params: Record<string, string> = {}, data: Record<string, unknown> = {}) {
  await c.query('INSERT INTO push_queue (owner_type, owner_id, kind, template, params, data) VALUES ($1,$2,$3,$4,$5,$6)', [owner.type, owner.id, TEMPLATES[template].kind, template, JSON.stringify(params), JSON.stringify(data)]);
}

export interface SentPush { to: string; title: string; body: string; data: Record<string, unknown> }

/** Phones' notifications: kept per person, sent by the worker through Expo's push service (or just logged in development). */
export class PushService {
  /** What the console provider "sent", for tests and development. */
  readonly sent: SentPush[] = [];
  constructor(private readonly db: Database, private readonly cfg: Config, private readonly log: Logger, private readonly http: typeof fetch = fetch) {}

  async register(owner: Owner, token: string, platform: string) {
    await this.db.tx((c) => c.query(
      `INSERT INTO push_tokens (token, owner_type, owner_id, platform) VALUES ($1,$2,$3,$4)
       ON CONFLICT (token) DO UPDATE SET owner_type = $2, owner_id = $3, platform = $4, updated_at = now()`, [token, owner.type, owner.id, platform]));
  }

  async unregister(owner: Owner, token: string) {
    await this.db.tx((c) => c.query('DELETE FROM push_tokens WHERE token = $1 AND owner_type = $2 AND owner_id = $3', [token, owner.type, owner.id]));
  }

  /** Sends what is waiting. Returns how many messages were handled. */
  async drain(limit = 100): Promise<number> {
    return this.db.tx(async (c) => {
      const rows = (await c.query<{ id: string; owner_type: 'rider' | 'customer'; owner_id: string; kind: string; template: TemplateId; params: Record<string, string>; data: Record<string, unknown> }>(
        `SELECT id, owner_type, owner_id, kind, template, params, data FROM push_queue WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
      for (const m of rows) {
        let lang: Language = 'en';
        let off = false;
        if (m.owner_type === 'customer') {
          const u = (await c.query<{ push_opt_in: boolean; notify_topics: Record<string, boolean>; language: Language }>('SELECT push_opt_in, notify_topics, language FROM customers WHERE id = $1', [m.owner_id])).rows[0];
          off = !u || !u.push_opt_in || u.notify_topics?.[m.kind] === false;
          if (u) lang = u.language;
        }
        if (m.owner_type === 'rider') {
          const r = (await c.query<{ language: Language; notify: Record<string, boolean> }>('SELECT language, notify FROM riders WHERE id = $1', [m.owner_id])).rows[0];
          if (r) { lang = r.language; off = r.notify?.[m.kind] === false; }
        }
        const tokens = off ? [] : (await c.query<{ token: string }>('SELECT token FROM push_tokens WHERE owner_type = $1 AND owner_id = $2', [m.owner_type, m.owner_id])).rows.map((t) => t.token);
        try {
          if (tokens.length) {
            const text = render(m.template, lang, m.params);
            const gone = await this.send(tokens.map((to) => ({ to, ...text, data: m.data })), m.kind === 'requests');
            if (gone.length) await c.query('DELETE FROM push_tokens WHERE token = ANY($1::text[])', [gone]);
          }
          await c.query('UPDATE push_queue SET sent_at = now() WHERE id = $1', [m.id]);
        } catch (err) {
          this.log.warn({ err, id: m.id }, 'push send failed');
          await c.query('UPDATE push_queue SET attempts = attempts + 1, error = $2 WHERE id = $1', [m.id, String((err as Error).message).slice(0, 200)]);
        }
      }
      return rows.length;
    });
  }

  /** Returns the tokens the push service says are no longer valid. */
  private async send(messages: SentPush[], urgent: boolean): Promise<string[]> {
    if (this.cfg.PUSH_PROVIDER !== 'expo') {
      this.sent.push(...messages);
      for (const m of messages) this.log.info({ to: m.to.slice(0, 18), title: m.title }, 'push (not sent, dev)');
      return [];
    }
    const res = await this.http('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(this.cfg.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${this.cfg.EXPO_ACCESS_TOKEN}` } : {}) },
      body: JSON.stringify(messages.map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data, sound: 'default', priority: urgent ? 'high' : 'default', channelId: 'default' }))),
    });
    if (!res.ok) throw new Error(`Expo push answered ${res.status}`);
    const out = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    return (out.data ?? []).flatMap((t, i) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? [messages[i]!.to] : []));
  }
}
