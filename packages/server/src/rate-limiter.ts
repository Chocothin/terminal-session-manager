interface RateLimiterConfig {
  windowMs: number;
  maxAttempts: number;
}

export class RateLimiter {
  private windowMs: number;
  private maxAttempts: number;
  private attempts: Map<string, number[]>;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: RateLimiterConfig) {
    this.windowMs = config.windowMs;
    this.maxAttempts = config.maxAttempts;
    this.attempts = new Map();

    // Start cleanup interval to prevent memory leaks
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Run every 60 seconds
  }

  /**
   * Attempt to perform an action for a given key.
   * Returns true if allowed, false if rate-limited.
   */
  attempt(key: string): boolean {
    const now = Date.now();
    const timestamps = this.attempts.get(key) || [];

    // Filter out expired timestamps
    const validTimestamps = timestamps.filter(
      (timestamp) => now - timestamp < this.windowMs
    );

    // Check if we've exceeded max attempts
    if (validTimestamps.length >= this.maxAttempts) {
      return false;
    }

    // Add current timestamp and update map
    validTimestamps.push(now);
    this.attempts.set(key, validTimestamps);

    return true;
  }

  /**
   * Check if a key is blocked without consuming an attempt.
   */
  isBlocked(key: string): boolean {
    const now = Date.now();
    const timestamps = this.attempts.get(key) || [];

    // Filter out expired timestamps
    const validTimestamps = timestamps.filter(
      (timestamp) => now - timestamp < this.windowMs
    );

    return validTimestamps.length >= this.maxAttempts;
  }

  /**
   * Reset all attempts for a given key.
   */
  reset(key: string): void {
    this.attempts.delete(key);
  }

  /**
   * Clean up keys with no recent timestamps to prevent memory leaks.
   */
  private cleanup(): void {
    const now = Date.now();

    for (const [key, timestamps] of this.attempts.entries()) {
      // Filter out expired timestamps
      const validTimestamps = timestamps.filter(
        (timestamp) => now - timestamp < this.windowMs
      );

      // Remove key if no valid timestamps remain
      if (validTimestamps.length === 0) {
        this.attempts.delete(key);
      } else {
        // Update with only valid timestamps
        this.attempts.set(key, validTimestamps);
      }
    }
  }

  /**
   * Destroy the rate limiter and clear the cleanup interval.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.attempts.clear();
  }
}
