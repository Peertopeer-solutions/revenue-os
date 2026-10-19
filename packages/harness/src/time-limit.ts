// Every call to a service outside the worker (the AI model, the dialer, the WhatsApp service) waits at most a set time,
// so one that never answers can't hold a job, and the worker's slot for it, for ever.
// G1: runtime-agnostic (setTimeout and AbortController are web standards).

/** An outside service did not answer within its time limit. */
export class TimeLimitError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${ms} ms`);
    this.name = "TimeLimitError";
  }
}

/**
 * Runs `call` and gives up after `ms`: the returned promise rejects with a TimeLimitError and `call`'s signal is
 * aborted, so a call that honours it (fetch does) stops too. A call that ignores the signal is left to finish on its
 * own; its answer is dropped.
 */
export async function withTimeLimit<T>(
  what: string,
  ms: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new TimeLimitError(what, ms);
      stop.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([call(stop.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}
