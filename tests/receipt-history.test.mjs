import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["asRecord", "unwrapObjectPayload", "optionalText", "finiteNumber", "formatTransactionAt", "normalizeLookupSn", "normalizeSearchText", "normalizeCmsReceiptHistory", "sortCmsReceiptHistories", "receiptHistoryMatchesQuery", "receiptHistoryMatchesFilters", "receiptHistoryQuantityDetail", "receiptHistoryStatusText", "receiptHistoryStatusBadgeClass"];
const functions = names.map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}).join("\n");
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(functions, {compilerOptions: {target: ts.ScriptTarget.ES2020}}).outputText, context);
const normalize = raw => context.normalizeCmsReceiptHistory(raw, 0);
const qr = {id: 11, pharmacyId: 3, productTotalQuantity: 20, returnedQuantity: 4, returnableQuantity: 16, receivedAt: "2026-10-23T10:00:00", sn: "QR-REAL-SN"};
const manual = {...qr, receiptType: "MANUAL", drugName: "케이슈머현탁액", pc: "8806419068936", wholesalerName: "동원", productTotalQuantity: 240, returnedQuantity: 0, returnableQuantity: 0, receivedAt: "2026-10-23T14:00:00", sn: null, receiptDetail: "12통 간편 입고 (1통 20개) · PC 8806419068936"};

test("manual and QR IDs cannot collide and both sort by receipt time", () => {
  const q=normalize(qr), m=normalize(manual);
  assert.equal(q.id, "11");
  assert.equal(m.id, "manual:11");
  const sorted=context.sortCmsReceiptHistories([q,m]);
  assert.equal(sorted.length, 2);
  assert.equal(sorted[0].id, m.id);
});
test("manual receipt stays completed, has no QR return quantity, preserves saved quantity", () => {
  const m=normalize({...manual, returnableQuantity: 240});
  assert.equal(m.productTotalQuantity, 240);
  assert.equal(m.returnableQuantity, 0);
  assert.equal(m.status, "MANUAL");
  assert.equal(m.sn, "");
  assert.equal(m.receiptDetail, manual.receiptDetail);
  assert.equal(context.receiptHistoryStatusText(m.status), "입고 완료");
  assert.equal(context.receiptHistoryStatusBadgeClass(m.status), "normal");
});
test("legacy and new QR responses preserve return states", () => {
  assert.equal(normalize(qr).receiptType, "QR");
  assert.equal(normalize(qr).returnableQuantity, 16);
  assert.equal(normalize(qr).status, "RETURNABLE");
  assert.equal(normalize({...qr, receiptType:"QR", returnableQuantity:0}).status,"RETURNED");
});
test("manual receipts obey the same date, pharmacy and keyword filters", () => {
  const m=normalize(manual);
  const filters={pharmacyId:"3",query:"케이슈머",startDate:"2026-10-23",endDate:"2026-10-23"};
  for (const query of ["케이슈머","8806419068936","동원"]) assert.equal(context.receiptHistoryMatchesFilters(m,{...filters,query}),true);
  assert.equal(context.receiptHistoryMatchesFilters(m,{...filters,pharmacyId:"4"}),false);
  assert.equal(context.receiptHistoryMatchesFilters(m,{...filters,endDate:"2026-10-22"}),false);
  assert.equal(context.receiptHistoryMatchesFilters(m,{...filters,query:"없는약"}),false);
});

test("manual package calculation is readable without inventing units for old records", () => {
  assert.equal(context.receiptHistoryQuantityDetail(normalize(manual)), "12통 × 20개");
  assert.equal(context.receiptHistoryQuantityDetail(normalize({...manual, receiptDetail:"12통 간편 입고 (1통 1개) · PC 8806419068936"})), "12통 × 1개");
  assert.equal(context.receiptHistoryQuantityDetail(normalize({...manual, receiptDetail:null})), "간편입고 수량");
  assert.equal(context.receiptHistoryQuantityDetail(normalize(qr)), "PC 기준 재고 반영");
});
