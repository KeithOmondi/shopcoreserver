import { createHash, createHmac } from 'node:crypto';
import { NotFoundError } from '../../domain/errors.js';
import type { FileStore } from './storage.js';

export interface S3Options {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Leave empty for Amazon S3. Set for Cloudflare R2, MinIO, Spaces and other S3-compatible services (path-style addresses are used). */
  endpoint?: string;
  prefix?: string;
}

const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Files kept in an S3-compatible bucket, signed with AWS Signature V4 (no SDK needed). */
export class S3Store implements FileStore {
  constructor(private readonly o: S3Options, private readonly http: typeof fetch = fetch, private readonly now: () => Date = () => new Date()) {}

  private target(id: string, ext: string) {
    const key = `${this.o.prefix ?? ''}${id.slice(-2)}/${id}.${ext}`.split('/').map(enc).join('/');
    if (this.o.endpoint) {
      const u = new URL(this.o.endpoint);
      return { host: u.host, url: `${u.origin}/${enc(this.o.bucket)}/${key}`, path: `/${enc(this.o.bucket)}/${key}` };
    }
    const host = `${this.o.bucket}.s3.${this.o.region}.amazonaws.com`;
    return { host, url: `https://${host}/${key}`, path: `/${key}` };
  }

  private sign(method: 'PUT' | 'GET', t: { host: string; path: string }, payloadHash: string, extra: Record<string, string>) {
    const d = this.now().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = d.slice(0, 8);
    const headers: Record<string, string> = { host: t.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': d, ...extra };
    const names = Object.keys(headers).sort();
    const canonical = [method, t.path, '', ...names.map((n) => `${n}:${headers[n]!.trim()}`), '', names.join(';'), payloadHash].join('\n');
    const scope = `${day}/${this.o.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', d, scope, sha(canonical)].join('\n');
    const k = hmac(hmac(hmac(hmac(`AWS4${this.o.secretAccessKey}`, day), this.o.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', k).update(toSign).digest('hex');
    const { host: _host, ...send } = headers;
    void _host;
    return { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${this.o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
  }

  async put(id: string, ext: string, bytes: Buffer) {
    const t = this.target(id, ext);
    const type = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const res = await this.http(t.url, { method: 'PUT', headers: this.sign('PUT', t, sha(bytes), { 'content-type': type }), body: new Uint8Array(bytes) });
    if (!res.ok) throw new Error(`File storage answered ${res.status} when saving`);
  }

  async get(id: string, ext: string) {
    const t = this.target(id, ext);
    const res = await this.http(t.url, { method: 'GET', headers: this.sign('GET', t, sha(''), {}) });
    if (res.status === 404 || res.status === 403) throw new NotFoundError('File');
    if (!res.ok) throw new Error(`File storage answered ${res.status} when reading`);
    return Buffer.from(await res.arrayBuffer());
  }
}
