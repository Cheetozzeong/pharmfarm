import { strict as assert } from "node:assert";
import { test } from "node:test";
import { registerHooks } from "node:module";
// Node's type stripping needs the extension that Vite resolves automatically.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier === "./mobileOrderDates" ? "./mobileOrderDates.ts" : specifier,
      context,
    );
  },
});
const { aggregateRecentStock, recentStockRange, recentStockDays } =
  await import("../src/mobileRecentStock.ts");
const range = { startDate: "2026-10-17", endDate: "2026-10-19" };
const movement = (
  id,
  stockId,
  changeQuantity,
  createdAt = "2026-10-19T10:00:00+09:00",
  extra = {},
) => ({
  id,
  stockId,
  source: "PRESCRIPTION",
  drugName: `약품 ${stockId}`,
  insuranceCode: "",
  changeQuantity,
  createdAt,
  ...extra,
});

test("three Korean calendar days include today across a year boundary", () => {
  const value = recentStockRange(new Date("2026-12-31T15:00:00Z"));
  assert.deepEqual(value, { startDate: "2026-12-30", endDate: "2027-01-01" });
  assert.deepEqual(recentStockDays(value), [
    "2027-01-01",
    "2026-12-31",
    "2026-12-30",
  ]);
});
test("only actual prescription decreases in the three-day window are grouped by Korean day", () => {
  const a = movement("a", "1", -10, "2026-10-16T15:00:00Z");
  const result = aggregateRecentStock(
    [
      a,
      a,
      movement("b", "1", -0.5, "2026.10.19 10:00"),
      movement("old", "1", -90, "2026-10-16T14:59:59Z"),
      movement("future", "1", -10, "2026-10-20T00:00:00+09:00"),
      movement("return", "1", -10, undefined, { source: "RETURN" }),
      movement("positive", "1", 20),
      movement("zero", "1", 0),
      movement("cancelled", "1", -10, undefined, { cancelled: true }),
      movement("invalid", "1", -20, "garbage"),
    ],
    [{ id: "1", name: "실제 약품", insuranceCode: "A", quantity: 8 }],
    range,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].deductedQuantity, 10.5);
  assert.deepEqual(result[0].dailyQuantities, {
    "2026-10-17": 10,
    "2026-10-19": 0.5,
  });
  assert.equal(result[0].remainingQuantity, 8);
});
test("remaining inventory is current, sums stock rows of the same drug, and sorts zero and negatives first", () => {
  const stocks = [
    { id: "1", insuranceCode: "A", name: "약품 A", quantity: 8 },
    { id: "2", insuranceCode: "A", name: "약품 A", quantity: 2 },
    { id: "3", insuranceCode: "B", name: "약품 B", quantity: 0 },
    { id: "4", insuranceCode: "C", name: "약품 C", quantity: -3 },
  ];
  const result = aggregateRecentStock(
    [
      movement("a", "1", -5),
      movement("b", "2", -3),
      movement("c", "3", -2),
      movement("d", "4", -8),
      movement("missing", "9", -1),
    ],
    stocks,
    range,
  );
  assert.deepEqual(
    result.map((row) => row.remainingQuantity),
    [-3, 0, 10, null],
  );
  assert.equal(result[2].deductedQuantity, 8);
});
test("unknown inventory is not presented as zero and ambiguous names are not matched", () => {
  const stocks = [
    { id: "1", name: "같은 이름", insuranceCode: "A", quantity: 20 },
    { id: "2", name: "같은 이름", insuranceCode: "B", quantity: 10 },
    { id: "3", name: "수량 누락", insuranceCode: "C", quantity: null },
  ];
  const result = aggregateRecentStock(
    [
      movement("a", undefined, -10, undefined, { drugName: "같은 이름" }),
      movement("b", "3", -3),
      movement("c", undefined, -2, undefined, {
        insuranceCode: "A",
        drugName: "보험코드로 확인",
      }),
    ],
    stocks,
    range,
  );
  assert.deepEqual(
    result.map((row) => row.remainingQuantity),
    [20, null, null],
  );
  assert.equal(result.length, 3);
});

test("a prescribed drug with no actual deduction still appears with zero outgoing quantity", () => {
  const result = aggregateRecentStock(
    [
      movement("zero", "1", 0, undefined, { prescriptionExists: true }),
      movement("unprescribed", "2", 0),
    ],
    [
      { id: "1", name: "전량 부족 처방", insuranceCode: "A", quantity: 0 },
      { id: "2", name: "처방 없는 약품", insuranceCode: "B", quantity: 2 },
    ],
    range,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].deductedQuantity, 0);
  assert.equal(result[0].remainingQuantity, 0);
});
