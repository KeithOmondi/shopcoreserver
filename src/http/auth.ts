import { createLocalJWKSet, createRemoteJWKSet, importSPKI, jwtVerify, type JWTVerifyGetKey, type KeyObject } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config/index.js';
import { ForbiddenError, UnauthorizedError } from '../domain/errors.js';
import { isUuid, uuidFromName } from '../infra/uuid.js';

export type Role = 'customer' | 'admin' | 'payments' | 'staff';

export interface Principal {
  sub: string;
  roles: ReadonlySet<Role>;
  /** Staff sign-in session id (staff tokens only). */
  sid?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(['customer', 'admin', 'payments', 'staff']);

/**
 * Stateless bearer-token authentication. Tokens are issued by the identity provider
 * (e.g. Cognito); this service only verifies signature, issuer, audience, expiry and
 * not-before (with 5s clock tolerance). JWKS keys are cached and rotated by jose.
 * Algorithms are pinned explicitly to prevent alg-confusion attacks ("none", HS*).
 */
export class TokenVerifier {
  private constructor(
    private readonly key: JWTVerifyGetKey | KeyObject,
    private readonly cfg: Config,
    private readonly algorithms: string[],
  ) {}

  static async create(cfg: Config): Promise<TokenVerifier> {
    const algorithms = cfg.JWT_ALGORITHMS.split(',').map((s) => s.trim()).filter(Boolean);
    if (algorithms.some((a) => a === 'none' || a.startsWith('HS'))) {
      throw new Error('Symmetric or "none" JWT algorithms are not permitted');
    }
    if (cfg.JWT_JWKS_URL) {
      const jwks = createRemoteJWKSet(new URL(cfg.JWT_JWKS_URL), {
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
        timeoutDuration: 2_000,
      });
      return new TokenVerifier(jwks, cfg, algorithms);
    }
    const pem = cfg.JWT_PUBLIC_KEY!.replace(/\\n/g, '\n');
    const alg = algorithms[0]!;
    const key = await importSPKI(pem, alg);
    return new TokenVerifier(key as KeyObject, cfg, [alg]);
  }

  /** Exposed for tests that want to verify against a local JWK set. */
  static fromLocalJwks(jwks: Parameters<typeof createLocalJWKSet>[0], cfg: Config): TokenVerifier {
    return new TokenVerifier(createLocalJWKSet(jwks), cfg, cfg.JWT_ALGORITHMS.split(','));
  }

  async verify(token: string): Promise<Principal> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key as never, {
        issuer: this.cfg.JWT_ISSUER,
        audience: this.cfg.JWT_AUDIENCE,
        algorithms: this.algorithms,
        clockTolerance: 5,
        requiredClaims: ['sub', 'exp', 'iat'],
      }));
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }
    let sub = payload.sub;
    if (!sub || sub.length > 256) throw new UnauthorizedError('Invalid subject');
    if (this.cfg.JWT_SUB_MODE === 'hash') {
      if (!isUuid(sub)) sub = uuidFromName(this.cfg.JWT_ISSUER, sub);
    } else if (!isUuid(sub)) {
      throw new UnauthorizedError('Invalid subject');
    }
    const raw = (payload as Record<string, unknown>)[this.cfg.JWT_ROLES_CLAIM];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
    const roles = new Set<Role>();
    for (const r of list) if (typeof r === 'string' && KNOWN_ROLES.has(r)) roles.add(r as Role);
    if (roles.size === 0) roles.add('customer');
    const sid = (payload as Record<string, unknown>).sid;
    return { sub, roles, sid: roles.has('staff') && typeof sid === 'string' ? sid : undefined };
  }
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (!h || h.length > 8192) return undefined;
  const [scheme, token] = h.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw new UnauthorizedError();
  return req.principal;
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): Principal {
  const p = requirePrincipal(req);
  if (!roles.some((r) => p.roles.has(r))) throw new ForbiddenError();
  return p;
}
