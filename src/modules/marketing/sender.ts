import type { Logger } from 'pino';
import type { Database } from '../../infra/db.js';
import type { SmsSender } from '../dispatch/riders.js';
import type { EmailSender } from '../integrations/email.js';
import { segmentMembers } from './audience.js';
import type { MessageSender } from './engage.js';

/**
 * Delivers campaigns to the customers who agreed to hear from ShopCore:
 * phone notifications go through the notification queue, texts through the SMS provider.
 * Emails go through the email provider (Brevo), each with a line saying how to stop them.
 */
export class CampaignSender implements MessageSender {
  constructor(private readonly db: Database, private readonly sms: SmsSender, private readonly email: EmailSender, private readonly log: Logger) {}

  async send(m: Parameters<MessageSender['send']>[0]): Promise<void> {
    const channel = m.channel;
    const members = await this.db.read((c) => segmentMembers(c, m.segmentId, channel));
    if (m.channel === 'push') {
      if (!members.length) return;
      await this.db.tx((c) => c.query(
        `INSERT INTO push_queue (owner_type, owner_id, kind, template, params, data)
         SELECT 'customer', id, 'deals', 'campaign', $2::jsonb, $3::jsonb FROM unnest($1::uuid[]) AS id`,
        [members.map((x) => x.id), JSON.stringify({ title: m.title, body: m.body }), JSON.stringify({ campaign: m.ref })]));
      return;
    }
    if (channel === 'email') {
      const footer = '\n\n--\nYou get this because you chose to hear from ShopCore. To stop these emails, turn off Email in the ShopCore app under Profile > Settings > Notifications.';
      let bad = 0;
      const list = members.filter((x) => x.email);
      for (let i = 0; i < list.length; i += 10) {
        const results = await Promise.allSettled(list.slice(i, i + 10).map((x) => this.email.send({ to: x.email!, name: x.name || undefined, subject: m.title, text: m.body + footer })));
        bad += results.filter((r) => r.status === 'rejected').length;
      }
      if (bad) this.log.warn({ ref: m.ref, failed: bad, total: list.length }, 'some campaign emails failed');
      return;
    }
    // Texts: a few at a time, and one failure never stops the rest.
    let failed = 0;
    const todo = members.filter((x) => x.phone);
    for (let i = 0; i < todo.length; i += 10) {
      const results = await Promise.allSettled(todo.slice(i, i + 10).map((x) => this.sms.send(x.phone!, m.body)));
      failed += results.filter((r) => r.status === 'rejected').length;
    }
    if (failed) this.log.warn({ ref: m.ref, failed, total: todo.length }, 'some campaign texts failed');
  }
}
