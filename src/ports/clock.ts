/** Business time (e.g. `transformedAt`). Injected so tests can use a fixed instant. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
