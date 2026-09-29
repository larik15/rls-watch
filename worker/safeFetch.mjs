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
  return async (url, init = {}) => {
    // A manually-managed AbortController + setTimeout, not AbortSignal.timeout()/
    // AbortSignal.any(): those compose signals via a chain of internal listeners that
    // nothing outside keeps a strong reference to, so V8 is free to collect the
    // timeout signal (and its timer) before it ever fires. Observed as a request's
    // timeout silently never firing under GC pressure. A plain timer id and
    // controller, held by this closure until the request settles, can't be collected
    // out from under us.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException(`timed out after ${timeoutMs}ms`, "TimeoutError")),
      timeoutMs
    );
    const forwarded = [signal, init.signal].filter(Boolean);
    const onAbort = (source) => () => controller.abort(source.reason);
    const listeners = [];
    for (const source of forwarded) {
      if (source.aborted) controller.abort(source.reason);
      else {
        const handler = onAbort(source);
        source.addEventListener("abort", handler, { once: true });
        listeners.push(() => source.removeEventListener("abort", handler));
      }
    }
    try {
      return await fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timer);
      for (const remove of listeners) remove();
    }
  };
}
