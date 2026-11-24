/**
 * Wait until a condition holds: at once when isReady(), else on the first
 * event that matches, else reject after timeoutMs. Always unsubscribes.
 * Pure (no React Native), so it runs under plain node for tests.
 */
export function waitUntil({ isReady, subscribe, match, timeoutMs, timeoutMessage }) {
  if (isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let unsub = null;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    unsub = subscribe((ev) => {
      if (!match(ev)) return;
      clearTimeout(timer);
      unsub?.();
      resolve();
    });
  });
}
