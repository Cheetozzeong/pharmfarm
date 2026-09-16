// Agent API LocalDateTime values are Korean server time, not the browser's timezone.
export function agentTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? text
    : `${text.replace(" ", "T")}+09:00`;
  const time = Date.parse(zoned);
  return Number.isFinite(time) ? time : null;
}

export function agentConnection(lastSeen: number | null, now = Date.now()) {
  if (lastSeen === null || lastSeen > now + 60_000) return "unknown" as const;
  return now - lastSeen <= 180_000 ? ("online" as const) : ("offline" as const);
}
