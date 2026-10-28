import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  prescriptionWeekRange,
  prescriptionRangeError,
} from "../src/agentPrescriptionRange.ts";

test("October 28 uses Monday October 26 through Sunday November 1", () => {
  assert.deepEqual(prescriptionWeekRange(new Date("2026-10-28T08:00:00Z")), {
    startDate: "2026-10-26",
    endDate: "2026-11-01",
  });
});
test("Korean Monday midnight advances the entire week, even in a western browser timezone", () => {
  assert.deepEqual(prescriptionWeekRange(new Date("2026-11-01T14:59:59Z")), {
    startDate: "2026-10-26",
    endDate: "2026-11-01",
  });
  assert.deepEqual(prescriptionWeekRange(new Date("2026-11-01T15:00:00Z")), {
    startDate: "2026-11-02",
    endDate: "2026-11-08",
  });
});
test("week handles a year boundary and Sunday", () => {
  for (const now of ["2027-01-01T03:00:00Z", "2027-01-03T03:00:00Z"]) {
    assert.deepEqual(prescriptionWeekRange(new Date(now)), {
      startDate: "2026-12-28",
      endDate: "2027-01-03",
    });
  }
});
test("manual dates are real calendar dates, ordered, and inclusive up to 31 days", () => {
  const error = (startDate, endDate) =>
    prescriptionRangeError({ startDate, endDate });
  assert.equal(error("2026-10-27", "2026-10-27"), "");
  assert.equal(error("2026-10-01", "2026-10-31"), "");
  assert.equal(error("2028-02-29", "2028-03-01"), "");
  for (const [start, end] of [
    ["", "2026-10-28"],
    ["2026-02-29", "2026-03-01"],
    ["2026-10-28", "2026-10-27"],
    ["2026-10-01", "2026-11-01"],
    ["2026-10-27' OR 1=1", "2026-10-28"],
    ["1899-12-31", "1900-01-01"],
    ["9999-01-01", "9999-01-01"],
  ]) {
    assert.notEqual(error(start, end), "", `${start} / ${end} must fail`);
  }
});
