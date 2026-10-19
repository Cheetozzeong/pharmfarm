export type OrderDateRange = { startDate: string; endDate: string };
export type OrderDatePreset = "today" | "week" | "month";

export function orderDateRange(
  preset: OrderDatePreset,
  now = new Date(),
): OrderDateRange {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) =>
    parts.find((item) => item.type === name)!.value;
  const endDate = `${part("year")}-${part("month")}-${part("day")}`;
  const start = new Date(`${endDate}T00:00:00Z`);
  if (preset === "week") start.setUTCDate(start.getUTCDate() - 6);
  if (preset === "month") start.setUTCDate(1);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

export function orderDateLabel(range: OrderDateRange): string {
  const format = (value: string) => value.replace(/-/g, ".");
  return range.startDate === range.endDate
    ? format(range.startDate)
    : `${format(range.startDate)} ~ ${format(range.endDate)}`;
}
