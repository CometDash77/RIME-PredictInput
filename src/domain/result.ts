/**
 * Explicit success/failure values.
 *
 * The legacy sidecar signalled failure with `None`, `(value, error)` tuples and
 * dicts carrying a `status` key, so callers had to remember which shape meant
 * what. Every fallible operation here returns a `Result` instead.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Unwrap an `Ok`, or throw the supplied error — for invariants that must hold. */
export function expectOk<T, E>(result: Result<T, E>, describe: (error: E) => string): T {
  if (result.ok) return result.value;
  throw new Error(describe(result.error));
}
