export function wokeFromSleep(lastBeat, now, maxGapMs = 90_000) {
  return Number(now) - Number(lastBeat) > maxGapMs;
}

export function tunnelBackoffMs(prev = 2000) {
  return Math.min(60_000, Math.max(2000, prev * 2));
}

export async function probeTunnel(wssUrl, timeoutMs = 8000) {
  const httpsUrl = String(wssUrl || "").replace(/^wss:/i, "https:").replace(/\/$/, "");
  if (!httpsUrl.startsWith("https://")) return false;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${httpsUrl}/health`, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const json = await res.json();
    return Boolean(json?.ok);
  } catch {
    return false;
  }
}
