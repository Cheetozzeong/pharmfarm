import { strict as assert } from "node:assert";
import { test } from "node:test";
import { orderDateRange, orderDateLabel } from "../src/mobileOrderDates.ts";

test("today follows Korean midnight regardless of the browser timezone", () => {
  assert.deepEqual(orderDateRange("today", new Date("2026-10-18T15:00:00Z")), {
    startDate: "2026-10-19",
    endDate: "2026-10-19",
  });
  assert.equal(
    orderDateRange("today", new Date("2026-10-18T14:59:59Z")).endDate,
    "2026-10-18",
  );
});
test("recent seven days includes today across the year boundary", () => {
  assert.deepEqual(orderDateRange("week", new Date("2027-01-01T03:00:00Z")), {
    startDate: "2026-12-26",
    endDate: "2027-01-01",
  });
});
test("this month starts on the first, including leap day", () => {
  assert.deepEqual(orderDateRange("month", new Date("2028-02-29T03:00:00Z")), {
    startDate: "2028-02-01",
    endDate: "2028-02-29",
  });
});
test("period label keeps years visible and avoids repeating a single date", () => {
  assert.equal(
    orderDateLabel({ startDate: "2026-12-31", endDate: "2027-01-01" }),
    "2026.12.31 ~ 2027.01.01",
  );
  assert.equal(
    orderDateLabel({ startDate: "2026-10-19", endDate: "2026-10-19" }),
    "2026.10.19",
  );
});
