import type { Config } from '../../config/index.js';
import type { Logger } from 'pino';
import { consoleSms, type SmsSender } from '../dispatch/riders.js';

/** Africa's Talking bulk SMS. The sandbox host is used when the username is `sandbox`. */
export class AfricasTalkingSms implements SmsSender {
  constructor(
    private readonly user: string,
    private readonly apiKey: string,
    private readonly senderId: string | undefined,
    private readonly log: Logger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(phone: string, text: string): Promise<void> {
    const host = this.user === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const body = new URLSearchParams({ username: this.user, to: phone, message: text });
    if (this.senderId) body.set('from', this.senderId);
    const res = await this.fetchFn(`https://${host}/version1/messaging`, {
      method: 'POST',
      headers: { apiKey: this.apiKey, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      this.log.error({ status: res.status }, 'SMS provider refused the request');
      throw new Error(`The SMS provider answered ${res.status}`);
    }
    const j = (await res.json()) as { SMSMessageData?: { Recipients?: { status?: string; statusCode?: number }[] } };
    const r = j.SMSMessageData?.Recipients?.[0];
    // 100-102 mean the message was processed, sent or queued.
    if (!r || (r.statusCode !== undefined && (r.statusCode < 100 || r.statusCode > 102))) {
      this.log.error({ status: r?.status }, 'SMS was not accepted');
      throw new Error(`The SMS was not accepted${r?.status ? ` (${r.status})` : ''}`);
    }
  }
}

export function makeSms(cfg: Config, log: Logger): SmsSender {
  if (cfg.SMS_PROVIDER === 'africastalking') return new AfricasTalkingSms(cfg.AT_USERNAME!, cfg.AT_API_KEY!, cfg.AT_SENDER_ID, log);
  return consoleSms(log);
}
