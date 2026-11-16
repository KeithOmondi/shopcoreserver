import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { BrevoEmail } from '../../src/modules/integrations/email.js';

const log = pino({ level: 'silent' });

describe('Brevo email', () => {
  it('posts the message to Brevo with the key, sender and escaped body', async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const http = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    const mail = new BrevoEmail('key-123', { email: 'hello@shopcore.test', name: 'ShopCore' }, log, http);
    await mail.send({ to: 'ann@example.com', name: 'Ann', subject: 'Sale', text: 'Save <20%>\nthis weekend' });
    expect(seen[0]!.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(seen[0]!.headers['api-key']).toBe('key-123');
    expect(seen[0]!.body).toMatchObject({ sender: { email: 'hello@shopcore.test' }, to: [{ email: 'ann@example.com', name: 'Ann' }], subject: 'Sale' });
    expect(String(seen[0]!.body.htmlContent)).toContain('Save &lt;20%&gt;<br>this weekend');
  });

  it('reports a refusal from Brevo', async () => {
    const http = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    await expect(new BrevoEmail('bad', { email: 'a@b.co', name: 'X' }, log, http).send({ to: 'c@d.co', subject: 's', text: 't' })).rejects.toThrow('401');
  });
});
