import { describe, expect, it } from 'vitest';
import { S3Store } from '../../src/modules/integrations/s3-store.js';

/** A tiny pretend bucket that remembers what it is sent and refuses unsigned requests. */
function bucket() {
  const files = new Map<string, Uint8Array>();
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const http = (async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
    calls.push({ method: init.method, url, headers: init.headers });
    if (!/^AWS4-HMAC-SHA256 Credential=AKID\/20260102\/auto\/s3\/aws4_request, SignedHeaders=.*, Signature=[0-9a-f]{64}$/.test(init.headers.authorization ?? '')) return new Response('no', { status: 403 });
    if (init.method === 'PUT') { files.set(url, init.body!); return new Response(null, { status: 200 }); }
    const f = files.get(url);
    return f ? new Response(f as BodyInit, { status: 200 }) : new Response('missing', { status: 404 });
  }) as unknown as typeof fetch;
  return { http, calls, files };
}
const now = () => new Date('2026-01-02T03:04:05.678Z');

describe('S3 file store', () => {
  it('saves and reads back a file with signed requests (path-style for R2 and friends)', async () => {
    const b = bucket();
    const s = new S3Store({ bucket: 'shopcore', region: 'auto', accessKeyId: 'AKID', secretAccessKey: 'secret', endpoint: 'https://acct.r2.cloudflarestorage.com', prefix: 'prod/' }, b.http, now);
    await s.put('0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeee42', 'jpg', Buffer.from('hello'));
    expect(b.calls[0]!.url).toBe('https://acct.r2.cloudflarestorage.com/shopcore/prod/42/0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeee42.jpg');
    expect(b.calls[0]!.headers['x-amz-date']).toBe('20260102T030405Z');
    expect((await s.get('0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeee42', 'jpg')).toString()).toBe('hello');
    await expect(s.get('0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeee99', 'jpg')).rejects.toThrow('File not found');
  });

  it('uses the bucket’s own address on Amazon S3 and reports a failed save', async () => {
    const calls: string[] = [];
    const http = (async (url: string) => { calls.push(url); return new Response('err', { status: 500 }); }) as unknown as typeof fetch;
    const s = new S3Store({ bucket: 'my-bucket', region: 'eu-west-1', accessKeyId: 'AKID', secretAccessKey: 's' }, http, now);
    await expect(s.put('0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeee42', 'pdf', Buffer.from('%PDF-'))).rejects.toThrow('500');
    expect(calls[0]).toBe('https://my-bucket.s3.eu-west-1.amazonaws.com/42/0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeee42.pdf');
  });
});
