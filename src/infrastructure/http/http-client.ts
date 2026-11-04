import { ExternalServiceError } from '../../domain/errors';
import { sleep } from '../../shared/concurrency';

export interface HttpClientOptions {
  service: string;
  userAgent: string;
  timeoutMs?: number;
  /** Retries after the first attempt (so 3 means up to 4 requests). */
  retries?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | FormData;
  /** Overrides the client default; use 0 for non-idempotent requests. */
  retries?: number;
}

export interface HttpResponse {
  status: number;
  text: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

/** GET with timeout and retries (network errors, timeouts, 5xx, 429) using exponential backoff + jitter. */
export class HttpClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly options: HttpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.random = options.random ?? Math.random;
  }

  get(url: string): Promise<HttpResponse> {
    return this.request(url);
  }

  /**
   * Returns any non-retryable response (including 4xx); throws ExternalServiceError once retries run out.
   * Error messages never contain the URL, because some APIs carry credentials in the query string.
   */
  async request(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
    const retries = request.retries ?? this.retries;
    let lastProblem = 'unknown error';
    let lastCause: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await this.sleepImpl(this.delayFor(attempt));
      try {
        const response = await this.fetchOnce(url, request);
        if (!isRetryableStatus(response.status)) return response;
        lastProblem = `HTTP ${response.status}`;
        lastCause = undefined;
      } catch (error) {
        lastProblem = error instanceof Error ? error.message : String(error);
        lastCause = error;
      }
    }
    throw new ExternalServiceError(
      this.options.service,
      `request failed after ${retries + 1} attempts: ${lastProblem}`,
      lastCause,
    );
  }

  private async fetchOnce(url: string, request: HttpRequest): Promise<HttpResponse> {
    const response = await this.fetchImpl(url, {
      method: request.method ?? 'GET',
      headers: { 'User-Agent': this.options.userAgent, Accept: 'application/json', ...request.headers },
      body: request.body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  }

  private delayFor(attempt: number): number {
    const exponential = Math.min(this.baseDelayMs * 2 ** (attempt - 1), MAX_DELAY_MS);
    return Math.round(exponential / 2 + this.random() * (exponential / 2));
  }
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}
