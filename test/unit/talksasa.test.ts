import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { TalkSasaSms } from '../../src/modules/integrations/sms.js';

const log = pino({ level: 'silent' });

describe('TalkSasa SMS', () => {
  it('posts the text with the bearer token and a number without the plus', async () => {
    const seen: { url: string; headers: Record<string, string>; body: Record<string, string> }[] = [];
    const http = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, string> });
      return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
    }) as unknown as typeof fetch;
    await new TalkSasaSms('tok', 'SHOPCORE', 'https://bulksms.talksasa.com/api/v3/', log, http).send('+254712345678', 'Hello');
    expect(seen[0]!.url).toBe('https://bulksms.talksasa.com/api/v3/sms/send');
    expect(seen[0]!.headers.authorization).toBe('Bearer tok');
    expect(seen[0]!.body).toEqual({ recipient: '254712345678', sender_id: 'SHOPCORE', type: 'plain', message: 'Hello' });
  });

  it('fails when the provider says error, even with a 200', async () => {
    const http = (async () => new Response(JSON.stringify({ status: 'error', message: 'Insufficient balance' }), { status: 200 })) as unknown as typeof fetch;
    await expect(new TalkSasaSms('t', 'S', 'https://x.test/api/v3', log, http).send('+254712345678', 'Hi')).rejects.toThrow('Insufficient balance');
  });
});
