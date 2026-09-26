// Every HTTP request the worker makes goes through this: no redirects (a 3xx from a
// monitored project must not bounce a request carrying its keys somewhere else), a
// per-request timeout, and the run's deadline signal when there is one.

export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]   aborts every request made through the returned fetch
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {typeof fetch}
 */
export function makeSafeFetch({ signal, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return (url, init = {}) => {
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    if (init.signal) signals.push(init.signal);
    return fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.any(signals) });
  };
}
