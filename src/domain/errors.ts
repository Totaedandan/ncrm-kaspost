export class DomainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidTrackCodeError extends DomainError {
  constructor(public readonly raw: string) {
    super(`Invalid track code: "${raw}"`);
  }
}

export class NotImplementedError extends DomainError {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
  }
}

/** Transport-level failure of an external system (network, 5xx, timeout). Worth retrying. */
export class ExternalServiceError extends DomainError {
  constructor(
    public readonly service: string,
    message: string,
    cause?: unknown,
  ) {
    super(`${service}: ${message}`, { cause });
  }
}

/** External response did not match the expected shape. Not a transport problem — needs a developer. */
export class ExternalSchemaError extends DomainError {
  constructor(
    public readonly service: string,
    message: string,
    public readonly sample: string,
  ) {
    super(`${service}: ${message}`);
  }
}

/** The notifier was told to slow down (e.g. Telegram 429). */
export class RateLimitedError extends DomainError {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Rate limited, retry after ${retryAfterSeconds}s`);
  }
}
