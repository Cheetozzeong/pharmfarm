export type AgentPrescriptionRange = { startDate: string; endDate: string };

export function prescriptionWeekRange(
  now = new Date(),
): AgentPrescriptionRange {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  const monday = new Date(
    `${part("year")}-${part("month")}-${part("day")}T00:00:00Z`,
  );
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return {
    startDate: monday.toISOString().slice(0, 10),
    endDate: sunday.toISOString().slice(0, 10),
  };
}

export function prescriptionRangeError(range: AgentPrescriptionRange): string {
  const valid = (value: string) => {
    if (
      !/^(?:19\d{2}|[2-9]\d{3})-\d{2}-\d{2}$/.test(value) ||
      value > "9998-12-31"
    )
      return false;
    const time = Date.parse(`${value}T00:00:00Z`);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    );
  };
  if (!valid(range.startDate) || !valid(range.endDate))
    return "시작일과 종료일을 올바르게 입력해 주세요.";
  const days =
    (Date.parse(range.endDate) - Date.parse(range.startDate)) / 86_400_000;
  if (days < 0) return "종료일은 시작일 이후로 지정해 주세요.";
  if (days >= 31) return "한 번에 최대 31일까지 수집할 수 있습니다.";
  return "";
}
