/**
 * Typed application errors. The HTTP layer maps these to status codes; anything
 * that is not an AppError is treated as an unexpected 500 and logged with stack.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown) {
    super('VALIDATION_FAILED', 'Request validation failed', 400, details);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', message, 401);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super('FORBIDDEN', message, 403);
  }
}
export class NotFoundError extends AppError {
  constructor(entity: string) {
    super('NOT_FOUND', `${entity} not found`, 404);
  }
}
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 409, details);
  }
}
export class UnprocessableError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 422, details);
  }
}
export class RateLimitedError extends AppError {
  constructor(retryAfterSec: number) {
    super('RATE_LIMITED', 'Too many requests', 429, undefined, retryAfterSec);
  }
}
export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', retryAfterSec = 1) {
    super('SERVICE_UNAVAILABLE', message, 503, undefined, retryAfterSec);
  }
}
