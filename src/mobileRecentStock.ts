import { orderDateRange } from "./mobileOrderDates";
import type { OrderDateRange } from "./mobileOrderDates";

export type RecentStockMovement = {
  id: string;
  source: string;
  createdAt: string;
  stockId?: string;
  drugName: string;
  insuranceCode: string;
  changeQuantity: number;
  cancelled?: boolean;
  prescriptionExists?: boolean;
};
export type RecentStock = {
  id: string;
  insuranceCode: string;
  name: string;
  quantity: number | null;
};
export type RecentStockRecord = {
  id: string;
  drugName: string;
  insuranceCode: string;
  remainingQuantity: number | null;
  deductedQuantity: number;
  dailyQuantities: Record<string, number>;
};

export function recentStockRange(now = new Date()): OrderDateRange {
  const { endDate } = orderDateRange("today", now);
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 2);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

export function recentStockDays(range: OrderDateRange): string[] {
  const end = new Date(`${range.endDate}T00:00:00Z`);
  return Array.from({ length: 3 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - index);
    return date.toISOString().slice(0, 10);
  });
}

function movementDay(value: string): string {
  // Offset-bearing API timestamps are converted to the pharmacy's Korean day.
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ""
      : orderDateRange("today", date).endDate;
  }
  return (
    value
      .match(/^(\d{4})[-.](\d{2})[-.](\d{2})/)
      ?.slice(1)
      .join("-") ?? ""
  );
}

const code = (value: string) => {
  const result = value.trim();
  return ["", "-", "보험코드 없음", "null", "undefined"].includes(result)
    ? ""
    : result;
};
const sum = (a: number, b: number) => Math.round((a + b) * 1e6) / 1e6;

export function aggregateRecentStock(
  movements: RecentStockMovement[],
  stocks: RecentStock[],
  range: OrderDateRange,
): RecentStockRecord[] {
  const byId = new Map(stocks.map((stock) => [stock.id, stock]));
  const byName = new Map<string, RecentStock[]>();
  const inventory = new Map<string, number | null>();
  const stockKey = (stock: RecentStock) =>
    code(stock.insuranceCode)
      ? `code:${code(stock.insuranceCode)}`
      : `stock:${stock.id}`;
  for (const stock of stocks) {
    const key = stockKey(stock);
    const current = inventory.get(key);
    inventory.set(
      key,
      current === null ||
        stock.quantity === null ||
        !Number.isFinite(stock.quantity)
        ? null
        : sum(current ?? 0, stock.quantity),
    );
    const name = stock.name.trim();
    byName.set(name, [...(byName.get(name) ?? []), stock]);
  }
  const grouped = new Map<string, RecentStockRecord>();
  const seen = new Set<string>();
  for (const movement of movements) {
    const day = movementDay(movement.createdAt);
    if (
      movement.source !== "PRESCRIPTION" ||
      movement.cancelled ||
      !Number.isFinite(movement.changeQuantity) ||
      movement.changeQuantity > 0 ||
      (movement.changeQuantity === 0 && !movement.prescriptionExists) ||
      day < range.startDate ||
      day > range.endDate ||
      !day
    )
      continue;
    if (seen.has(movement.id)) continue;
    seen.add(movement.id);
    const nameMatches = byName.get(movement.drugName.trim()) ?? [];
    const matched = movement.stockId
      ? byId.get(movement.stockId)
      : !code(movement.insuranceCode) && nameMatches.length === 1
        ? nameMatches[0]
        : undefined;
    const insuranceCode =
      code(matched?.insuranceCode ?? "") || code(movement.insuranceCode);
    const key = insuranceCode
      ? `code:${insuranceCode}`
      : matched
        ? stockKey(matched)
        : movement.stockId
          ? `stock:${movement.stockId}`
          : `unknown:${movement.drugName.trim()}`;
    const row = grouped.get(key) ?? {
      id: key,
      drugName: matched?.name || movement.drugName,
      insuranceCode,
      remainingQuantity: inventory.get(key) ?? null,
      deductedQuantity: 0,
      dailyQuantities: {},
    };
    const deducted = -movement.changeQuantity;
    row.dailyQuantities[day] = sum(row.dailyQuantities[day] ?? 0, deducted);
    row.deductedQuantity = sum(row.deductedQuantity, deducted);
    grouped.set(key, row);
  }
  return [...grouped.values()].sort((a, b) => {
    if (a.remainingQuantity === null && b.remainingQuantity !== null) return 1;
    if (a.remainingQuantity !== null && b.remainingQuantity === null) return -1;
    return (
      (a.remainingQuantity ?? 0) - (b.remainingQuantity ?? 0) ||
      b.deductedQuantity - a.deductedQuantity ||
      a.drugName.localeCompare(b.drugName, "ko")
    );
  });
}
