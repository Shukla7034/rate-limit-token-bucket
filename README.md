# Rate Limit Token Bucket

A small ESM TypeScript-compatible JavaScript library implementing a token-bucket rate limiter. A `TokenBucket` holds a fixed capacity of tokens that refill at a steady per-millisecond rate; calling `consume(cost)` returns whether the request is allowed and, if not, how many milliseconds to wait until enough tokens are available.

## Usage

```js
import { TokenBucket } from "./src/index.js";

// 10 tokens max, refilling at 1 token per 100ms (0.01/ms).
const bucket = new TokenBucket({ capacity: 10, refillRate: 0.01 });

const r = bucket.consume(1);
if (r.allowed) {
  // handle the request
} else {
  // wait r.retryAfter ms before retrying
}
```

The exported names are `TokenBucket` (the only export) from `src/index.js`. The constructor takes `{ capacity, refillRate, clock? }`. `consume(cost = 1)` returns `{ allowed: boolean, retryAfter: number }`. The `tokens` getter returns the current count after refilling. `capacity` and `refillRate` are read-only getters.

## Why this exists

Rate-limiting needs a data structure, not a framework. Most token-bucket libraries bundle adapters for Express, Redis, or some specific stack. This one does only the accounting: given a capacity and a refill rate, tell you whether a request fits and when it will. The trade-off is that you wire it into whatever transport you use — there is no middleware, no store, no persistence. The bucket state lives in the process and is lost on restart.

## The awkward edge

Tokens are real numbers, not integers. A `refillRate` of `0.01` tokens per millisecond means a fractional token accumulates over partial-millisecond intervals. This is deliberate — it lets you express rates like "5 requests per second" without rounding surprises — but it means `bucket.tokens` can be `3.5`. Costs can also be fractional. If you want integer-only behaviour, floor `cost` and `refillRate` yourself; the library does not impose it.

The clock is injectable via the `clock` constructor argument so tests can be deterministic. If omitted, `Date.now` is used. A backwards-moving clock (NTP adjustments, manual changes) is tolerated: the bucket resets its refill reference point and never grants tokens for negative elapsed time.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

## Limitations

Values are coerced to floats, so very large integers lose precision. If you need
exact integer aggregates over a window, this is the wrong tool.

