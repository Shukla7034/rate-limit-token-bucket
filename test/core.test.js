import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenBucket } from "../src/index.js";

/**
 * A controllable clock for deterministic tests.
 * Returns the value set via `tick()` / `set()`.
 */
class FakeClock {
  constructor(initial = 0) {
    this.now = initial;
  }
  set(ms) {
    this.now = ms;
  }
  tick(ms) {
    this.now += ms;
  }
  // Must be a plain function reference; TokenBucket calls it as clock().
  // We bind `this` here so the destructure in TokenBucket still works.
  getTime() {
    return this.now;
  }
}

/**
 * Helper: create a bucket whose clock is the bound getTime method.
 * Returns both so tests can advance time.
 */
function makeBucket(capacity, refillRatePerMs, startMs = 0) {
  const clock = new FakeClock(startMs);
  const bucket = new TokenBucket({
    capacity,
    refillRate: refillRatePerMs,
    clock: clock.getTime.bind(clock),
  });
  return { bucket, clock };
}

describe("TokenBucket construction", () => {
  it("starts full", () => {
    const { bucket } = makeBucket(10, 1);
    assert.equal(bucket.tokens, 10);
  });

  it("rejects non-positive capacity", () => {
    assert.throws(() => new TokenBucket({ capacity: 0, refillRate: 1 }), /TypeError/);
    assert.throws(() => new TokenBucket({ capacity: -5, refillRate: 1 }), /TypeError/);
  });

  it("rejects non-positive refillRate", () => {
    assert.throws(() => new TokenBucket({ capacity: 5, refillRate: 0 }), /TypeError/);
    assert.throws(() => new TokenBucket({ capacity: 5, refillRate: -1 }), /TypeError/);
  });

  it("rejects non-number arguments", () => {
    assert.throws(() => new TokenBucket({ capacity: "10", refillRate: 1 }), /TypeError/);
    assert.throws(() => new TokenBucket({ capacity: 10, refillRate: "1" }), /TypeError/);
  });

  it("rejects NaN / Infinity", () => {
    assert.throws(() => new TokenBucket({ capacity: NaN, refillRate: 1 }), /TypeError/);
    assert.throws(() => new TokenBucket({ capacity: 10, refillRate: Infinity }), /TypeError/);
  });

  it("defaults to Date.now when clock omitted", () => {
    const b = new TokenBucket({ capacity: 3, refillRate: 1 });
    assert.equal(typeof b.tokens, "number");
    assert.equal(b.tokens, 3);
  });
});

describe("TokenBucket.consume happy path", () => {
  it("allows a request when enough tokens", () => {
    const { bucket } = makeBucket(10, 1);
    const r = bucket.consume(3);
    assert.deepEqual(r, { allowed: true, retryAfter: 0 });
    assert.equal(bucket.tokens, 7);
  });

  it("defaults cost to 1", () => {
    const { bucket } = makeBucket(5, 1);
    const r = bucket.consume();
    assert.deepEqual(r, { allowed: true, retryAfter: 0 });
    assert.equal(bucket.tokens, 4);
  });

  it("refills over time", () => {
    const { bucket, clock } = makeBucket(10, 1); // 1 token per ms
    bucket.consume(10);
    assert.equal(bucket.tokens, 0);
    clock.tick(5);
    assert.equal(bucket.tokens, 5);
  });

  it("caps at capacity on refill", () => {
    const { bucket, clock } = makeBucket(5, 1);
    bucket.consume(3); // tokens = 2
    clock.tick(1000); // would add 1000 but cap is 5
    assert.equal(bucket.tokens, 5);
  });
});

describe("TokenBucket.consume denial", () => {
  it("denies when not enough tokens", () => {
    const { bucket } = makeBucket(2, 1);
    const r = bucket.consume(3);
    assert.equal(r.allowed, false);
    assert.equal(r.retryAfter, Infinity); // 3 > capacity 2
  });

  it("reports retryAfter when cost exceeds current tokens but not capacity", () => {
    const { bucket, clock } = makeBucket(10, 1); // 1 token/ms
    bucket.consume(8); // tokens = 2
    clock.tick(0); // no time passes
    const r = bucket.consume(5); // need 3 more tokens
    assert.equal(r.allowed, false);
    assert.equal(r.retryAfter, 3); // 3 tokens at 1/ms = 3ms
  });

  it("retryAfter reflects fractional tokens correctly", () => {
    // refillRate 0.5 token/ms; after consuming we have 0 tokens, need 2.
    const { bucket, clock } = makeBucket(4, 0.5);
    bucket.consume(4);
    clock.tick(0);
    const r = bucket.consume(2);
    // deficit = 2, rate = 0.5/ms, retryAfter = 2/0.5 = 4
    assert.equal(r.allowed, false);
    assert.equal(r.retryAfter, 4);
  });

  it("a denied request does not consume tokens", () => {
    const { bucket, clock } = makeBucket(10, 1);
    bucket.consume(6); // tokens = 4
    const before = bucket.tokens;
    clock.tick(0);
    const r = bucket.consume(8); // denied
    assert.equal(r.allowed, false);
    assert.equal(bucket.tokens, before);
  });
});

describe("TokenBucket edge cases", () => {
  it("handles fractional costs", () => {
    const { bucket } = makeBucket(1, 1);
    const r = bucket.consume(0.5);
    assert.deepEqual(r, { allowed: true, retryAfter: 0 });
    assert.equal(bucket.tokens, 0.5);
  });

  it("accumulates fractional tokens to allow a fractional cost", () => {
    const { bucket, clock } = makeBucket(1, 0.1); // 0.1 token/ms
    bucket.consume(1); // 0 tokens
    clock.tick(5); // 0.5 tokens
    assert.equal(bucket.tokens, 0.5);
    clock.tick(5); // 1.0 tokens, capped
    assert.equal(bucket.tokens, 1);
    const r = bucket.consume(0.5);
    assert.deepEqual(r, { allowed: true, retryAfter: 0 });
  });

  it("tolerates a backwards clock without granting extra tokens", () => {
    const { bucket, clock } = makeBucket(10, 1);
    bucket.consume(5); // tokens = 5
    clock.set(-100); // clock jumps backwards
    assert.equal(bucket.tokens, 5); // no refill, no extra tokens
    // After the backwards jump, forward progress should refill normally.
    clock.set(-95); // 5 ms forward from -100
    assert.equal(bucket.tokens, 10); // 5 + 5 = 10, capped
  });

  it("zero elapsed time does not change tokens", () => {
    const { bucket, clock } = makeBucket(10, 1);
    bucket.consume(5);
    clock.tick(0);
    assert.equal(bucket.tokens, 5);
  });

  it("rejects invalid cost", () => {
    const { bucket } = makeBucket(10, 1);
    assert.throws(() => bucket.consume(0), /TypeError/);
    assert.throws(() => bucket.consume(-1), /TypeError/);
    assert.throws(() => bucket.consume(NaN), /TypeError/);
    assert.throws(() => bucket.consume(Infinity), /TypeError/);
    assert.throws(() => bucket.consume("1"), /TypeError/);
  });

  it("consume with cost exactly equal to tokens succeeds", () => {
    const { bucket } = makeBucket(5, 1);
    bucket.consume(3); // tokens = 2
    const r = bucket.consume(2);
    assert.deepEqual(r, { allowed: true, retryAfter: 0 });
    assert.equal(bucket.tokens, 0);
  });

  it("consume with cost equal to capacity succeeds when full", () => {
    const { bucket } = makeBucket(5, 1);
    const r = bucket.consume(5);
    assert.deepEqual(r, { allowed: true, retryAfter: 0 });
    assert.equal(bucket.tokens, 0);
  });
});
