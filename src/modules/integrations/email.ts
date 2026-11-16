import type { Logger } from 'pino';
import type { Config } from '../../config/index.js';

export interface EmailMessage { to: string; name?: string; subject: string; text: string }
export interface EmailSender { send(m: EmailMessage): Promise<void> }

/** Development: nothing is sent, the message is only logged. */
export const consoleEmail = (log: Logger): EmailSender => ({ send: async (m) => { log.info({ to: m.to, subject: m.subject }, 'email (not sent, dev)'); } });

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Brevo (formerly Sendinblue) transactional email API. */
export class BrevoEmail implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: { email: string; name: string },
    private readonly log: Logger,
    private readonly http: typeof fetch = fetch,
  ) {}

  async send(m: EmailMessage): Promise<void> {
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${escapeHtml(m.text).replace(/\n/g, '<br>')}</div>`;
    const res = await this.http('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.apiKey, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ sender: this.from, to: [{ email: m.to, ...(m.name ? { name: m.name } : {}) }], subject: m.subject, htmlContent: html, textContent: m.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      this.log.error({ status: res.status }, 'Brevo refused the email');
      throw new Error(`Brevo answered ${res.status}`);
    }
  }
}

export function makeEmail(cfg: Config, log: Logger): EmailSender {
  if (cfg.EMAIL_PROVIDER === 'brevo') return new BrevoEmail(cfg.BREVO_API_KEY!, { email: cfg.EMAIL_FROM_ADDRESS!, name: cfg.EMAIL_FROM_NAME }, log);
  return consoleEmail(log);
}
