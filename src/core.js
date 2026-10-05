/**
 * Core token-bucket rate limiter.
 *
 * The bucket holds at most `capacity` tokens. Tokens refill at a constant
 * `refillRate` tokens per millisecond. A request consumes `cost` tokens if
 * available; otherwise the request is denied and the caller is told how long
 * to wait until enough tokens exist.
 *
 * Why a clock function rather than Date.now(): keeping the bucket's notion
 * of time injectable makes the behaviour fully deterministic in tests.
 * A test that relied on real elapsed time would be flaky on slow machines,
 * so the clock is a constructor argument with a sensible default.
 */

/**
 * @typedef {() => number} Clock - Returns a monotonically increasing millisecond timestamp.
 */

export class TokenBucket {
  #capacity;
  #refillRate;
  #clock;
  #tokens;
  #lastRefill;

  /**
   * @param {Object} opts
   * @param {number} opts.capacity    - Maximum tokens the bucket can hold.
   * @param {number} opts.refillRate  - Tokens added per millisecond.
   * @param {Clock} [opts.clock]      - Optional clock function returning ms. Defaults to Date.now.
   * @throws {TypeError|RangeError} On invalid arguments.
   */
  constructor({ capacity, refillRate, clock }) {
    if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= 0) {
      throw new TypeError("capacity must be a positive finite number");
    }
    if (typeof refillRate !== "number" || !Number.isFinite(refillRate) || refillRate <= 0) {
      throw new TypeError("refillRate must be a positive finite number");
    }
    if (clock !== undefined && typeof clock !== "function") {
      throw new TypeError("clock must be a function");
    }

    this.#capacity = capacity;
    this.#refillRate = refillRate;
    // Use the provided clock for the initial timestamp so the first consume()
    // call sees a near-zero elapsed delta. If we used Date.now here while a
    // fake clock were in play, the first refill would add a huge amount.
    this.#clock = clock ?? Date.now;
    this.#tokens = capacity;
    this.#lastRefill = this.#clock();
  }

  /** Current number of available tokens (after refilling at the current clock time). */
  get tokens() {
    this.#refill();
    return this.#tokens;
  }

  /** Bucket capacity (immutable). */
  get capacity() {
    return this.#capacity;
  }

  /** Refill rate in tokens per millisecond (immutable). */
  get refillRate() {
    return this.#refillRate;
  }

  /**
   * Bring the token count up to date for elapsed wall-clock time.
   * Tokens are capped at capacity; partial tokens are preserved so that a
   * sub-token cost can still succeed once enough fractional tokens accumulate.
   */
  #refill() {
    const now = this.#clock();
    const elapsed = now - this.#lastRefill;
    if (elapsed > 0) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillRate);
      this.#lastRefill = now;
    } else if (elapsed < 0) {
      // Clock went backwards (e.g. NTP adjustment). Rather than adding a
      // negative amount, we reset the reference point so we never grant more
      // tokens than the real elapsed time would allow. The token count
      // itself is left unchanged.
      this.#lastRefill = now;
    }
  }

  /**
   * Attempt to consume `cost` tokens.
   *
   * @param {number} [cost=1] - Tokens the request needs.
   * @returns {{ allowed: boolean, retryAfter: number }}
   *   `allowed` is true if tokens were consumed.
   *   `retryAfter` is 0 on success, or the milliseconds to wait until `cost`
   *   tokens are available on failure. If `cost` exceeds `capacity`,
   *   `retryAfter` is Infinity because the request can never succeed.
   * @throws {TypeError|RangeError} On invalid cost.
   */
  consume(cost = 1) {
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
      throw new TypeError("cost must be a positive finite number");
    }

    this.#refill();

    if (cost > this.#capacity) {
      // The request can never be satisfied; no point waiting.
      return { allowed: false, retryAfter: Infinity };
    }

    if (this.#tokens >= cost) {
      this.#tokens -= cost;
      return { allowed: true, retryAfter: 0 };
    }

    const deficit = cost - this.#tokens;
    return { allowed: false, retryAfter: deficit / this.#refillRate };
  }
}
