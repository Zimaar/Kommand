const TRANSIENT_PATTERNS = [
  /timeout/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /network/i,
  /503/,
  /504/,
  /502/,
  /500/,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
];

export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return TRANSIENT_PATTERNS.some((p) => p.test(error.message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 * Only retries on transient errors unless `retryAll` is set.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries?: number;
    baseDelayMs?: number;
    retryAll?: boolean;
    onRetry?: (attempt: number, error: unknown) => void;
  } = {}
): Promise<T> {
  const { maxRetries = 2, baseDelayMs = 500, retryAll = false, onRetry } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const shouldRetry = attempt < maxRetries && (retryAll || isTransientError(err));
      if (!shouldRetry) throw err;
      onRetry?.(attempt + 1, err);
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }

  throw lastError;
}
