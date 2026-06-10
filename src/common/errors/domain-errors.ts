export abstract class DomainError extends Error {
  abstract readonly code: string;
  /** HTTP status this error maps to. */
  abstract readonly status: number;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * For domain-rule validation failures (e.g. "journal entry does not balance"),
 * not DTO/request validation — the latter is handled by NestJS ValidationPipe,
 * which throws an HttpException.
 */
export class ValidationFailedError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
  readonly status = 422;
}

export class NotFoundDomainError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly status = 404;
}

export class ConflictDomainError extends DomainError {
  readonly code = 'CONFLICT';
  readonly status = 409;
}

export class UnauthorizedDomainError extends DomainError {
  readonly code = 'UNAUTHORIZED';
  readonly status = 401;
}

export class ForbiddenDomainError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly status = 403;
}
