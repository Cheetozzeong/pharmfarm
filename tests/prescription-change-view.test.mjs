import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
const source = readFileSync(
  new URL("../src/prescriptionChangeView.ts", import.meta.url),
  "utf8",
);
const context = vm.createContext({ exports: {} });
vm.runInContext(
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText,
  context,
);
const {
  prescriptionLineChanges: diff,
  prescriptionChangeSummary: summary,
  prescriptionDecisionReadiness: ready,
} = context.exports;
const line = (overrides = {}) => ({
  lineNo: "1",
  insuranceCode: "640007761",
  drugName: "검증용 약품",
  dose: "1",
  daily: "2",
  days: 60,
  quantity: 120,
  totalQuantity: "120",
  substitutionType: 0,
  ...overrides,
});

test("only changed medication is shown among many unchanged lines", () => {
  const before = Array.from({ length: 30 }, (_, i) =>
    line({ lineNo: String(i + 1), insuranceCode: String(640000000 + i) }),
  );
  const after = before.map((item, i) =>
    i ? { ...item } : { ...item, days: 40, totalQuantity: "80", quantity: 80 },
  );
  const changes = diff(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].before.quantity, 120);
  assert.equal(changes[0].after.quantity, 80);
  assert.equal(summary(changes, false), "변경 1품목");
});
test("different products are addition and removal, not a misleading quantity comparison", () => {
  const changes = diff(
    [line()],
    [line({ insuranceCode: "999000001", drugName: "새 약품" })],
  );
  assert.equal(changes.length, 2);
  assert.equal(changes[0].kind, "added");
  assert.equal(changes[1].kind, "removed");
});
test("unchanged duplicate products remain unchanged after rows are reordered", () => {
  const before = [
    line(),
    line({ lineNo: "2", days: 40, totalQuantity: "80", quantity: 80 }),
  ];
  const after = [
    { ...before[1], lineNo: "1" },
    { ...before[0], lineNo: "2" },
  ];
  assert.equal(diff(before, after).length, 0);
});
test("dose and substitution changes remain visible even when total quantity is equal", () => {
  const changes = diff(
    [line()],
    [line({ dose: "2", daily: "1", substitutionType: 2 })],
  );
  assert.equal(changes.length, 1);
  assert.ok(changes[0].fields.includes("복용 정보"));
  assert.ok(changes[0].fields.includes("대체 정보"));
});
test("decimal source quantities and cancellation are preserved", () => {
  const before = [line({ quantity: 1, totalQuantity: "0.5" })];
  assert.equal(
    diff(before, [line({ quantity: 1, totalQuantity: "1" })]).length,
    1,
  );
  const changes = diff(before, before, true);
  assert.equal(changes[0].kind, "removed");
  assert.equal(summary(changes, true), "처방 취소");
});
test("both required inputs are explained and block both actions", () => {
  const initial = ready({
    memo: " ",
    confirmed: false,
    reviewToken: "test",
    canApprove: true,
    saving: false,
  });
  assert.equal(initial.missing.length, 2);
  assert.equal(initial.canKeep, false);
  assert.equal(initial.canApply, false);
  const memoOnly = ready({
    memo: "확인",
    confirmed: false,
    reviewToken: "test",
    canApprove: true,
    saving: false,
  });
  assert.equal(memoOnly.missing.length, 1);
  assert.match(memoOnly.commonMessage, /체크/);
  assert.equal(memoOnly.canApply, false);
  const checkOnly = ready({
    memo: "",
    confirmed: true,
    reviewToken: "test",
    canApprove: true,
    saving: false,
  });
  assert.match(checkOnly.commonMessage, /사유/);
});
test("blocked stock connection disables approval while keeping reject available after required checks", () => {
  const state = ready({
    memo: "재고 확인",
    confirmed: true,
    reviewToken: "test",
    canApprove: false,
    saving: false,
  });
  assert.equal(state.canKeep, true);
  assert.equal(state.canApply, false);
  assert.match(state.applyMessage, /재고 연결/);
});
test("valid review enables actions; stale token or saving disables both", () => {
  const valid = {
    memo: "확인",
    confirmed: true,
    reviewToken: "test",
    canApprove: true,
    saving: false,
  };
  assert.equal(ready(valid).canApply, true);
  assert.equal(ready({ ...valid, reviewToken: undefined }).canKeep, false);
  assert.match(
    ready({ ...valid, reviewToken: undefined }).commonMessage,
    /다시/,
  );
  assert.equal(ready({ ...valid, saving: true }).canApply, false);
});
