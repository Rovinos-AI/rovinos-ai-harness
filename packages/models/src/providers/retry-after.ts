// SPDX-License-Identifier: Apache-2.0
/** Parses Retry-After as seconds or an HTTP date, clamping past dates to zero. */
export function retryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - nowMs) : undefined;
}
