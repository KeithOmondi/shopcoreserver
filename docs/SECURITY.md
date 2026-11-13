# Security Model

## Identity and access
- **Authentication:** JWTs from the IdP (Cognito/Auth0/Keycloak), verified against JWKS (cached,
  rotation-aware). Signature, `iss`, `aud`, `exp`, `nbf`, `iat` are all checked; 5 s clock tolerance.
  Algorithms are pinned; `none` and HS* are refused at boot. `sub` must be a UUID.
- **Authorization:** roles `customer`, `admin`, `payments`, checked per route. Ownership is
  enforced in the service: another user's order returns **404** (no existence leak).
- **Service-to-service:** the payment service calls `payment-confirmation` with a `payments` token
  (client-credentials grant).
- **Cloud:** pods use IRSA scoped to one Secrets Manager secret. CI/CD uses GitHub OIDC (no
  long-lived keys). The EKS API endpoint is private. IMDSv2 is enforced with hop limit 1.

## Input and API protection
- zod strict schemas: unknown fields rejected, numeric bounds, UUID formats, line and quantity caps.
- Clients cannot submit prices; totals are computed server-side from DB prices inside the transaction.
- Body limit 64 KB; request timeout 10 s; header size bounds; JSON-only parser.
- All SQL is parameterized (no string-built queries with user input).
- Opaque, validated cursors. Request IDs are accepted only if they match a safe pattern (log-injection guard).
- Rate limiting at the edge (WAF per IP, managed OWASP/bad-input/IP-reputation rule sets) and in
  the app (per user/IP token buckets for reads and writes).
- Idempotency keys stop duplicate charges and orders from client retries.
- Security headers via helmet; CORS off by default, allow-list when enabled.

## Data protection
- TLS 1.3 at the ALB; TLS to Aurora (`rds.force_ssl`, `DB_SSL=true` enforced in production config),
  Redis (in-transit + AUTH token) and MSK.
- KMS encryption at rest: Aurora, Redis, MSK, EBS, Secrets Manager, Kubernetes Secrets (envelope), backups.
- Secrets live only in AWS Secrets Manager and are synced by External Secrets. Never in images,
  values files or git. Logs redact `authorization`, cookies and `*.password|token|secret`.
- PII minimization: the service stores a user id (`sub`), not names, emails or addresses.

## Request authentication hardening
- Failed-token throttle: each client IP gets `AUTH_FAIL_CAPACITY` failures (refilling at `AUTH_FAIL_REFILL_PER_SEC`);
  beyond that, requests carrying a bearer token get `429` *before* any signature verification, so garbage
  tokens cannot be used to burn CPU.
- Client IP comes from `TRUST_PROXY` (default `false`; production requires a hop count such as `1` or a CIDR
  list and refuses `true`), so `X-Forwarded-For` cannot be spoofed to evade per-IP limits.
- `JWT_ROLES_CLAIM` / `JWT_SUB_MODE` adapt to Cognito (`cognito:groups`) and Auth0/Keycloak (non-UUID subjects).
- `/health/deps` needs `x-health-token` and is off in production unless `HEALTH_DEPS_TOKEN` is set.

## Auditability
- `audit_log` is append-only: a trigger rejects UPDATE/DELETE/TRUNCATE for every role (migration 0003), and
  the app role is also revoked those privileges where it exists. It records every admin and state-changing action with
  actor, request id and payload. The outbox provides an ordered event history of every aggregate.
- EKS audit logs, VPC flow logs, ALB access logs and WAF logs go to CloudWatch/S3.

## Supply chain and runtime
- Distroless non-root image (uid 65532), read-only root filesystem, all capabilities dropped,
  seccomp RuntimeDefault, no service-account token automount.
- Immutable ECR tags, scan on push; Trivy image + IaC scan and `npm audit` gate CI; SBOM +
  provenance attestations on build.
- NetworkPolicy: app pods accept traffic only on the app port, and metrics only from the monitoring namespace.

## Threats explicitly handled
| Threat | Control |
|---|---|
| Token forgery / alg confusion | pinned asymmetric algs, JWKS, claim checks (tests: forged key, `alg=none`) |
| IDOR on orders | ownership check, 404 for non-owners (tested) |
| Price tampering | server-side pricing, strict schema rejects price fields (tested) |
| Oversell race | transactional reservation + CHECK constraint (tested with 400 concurrent buyers) |
| Replay / double submit | idempotency keys, request hash mismatch → 422 (tested) |
| Credential stuffing / scraping / DoS | WAF rate + reputation rules, app rate limits, load shedding |
| Lost / forged events | outbox in the same transaction; consumers verify via the API, not trust payloads |
