import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile(
  "App.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const names = new Set([
  "normalizeReceiptValidation",
  "normalizePriceMaster",
  "normalizeStockCandidate",
  "normalizeBoolean",
  "normalizeSearchText",
  "normalizeInsuranceCode",
  "isMeaningfulInsuranceCode",
  "isPlaceholderReceiptDrugName",
  "isKnownInsuranceReceiptDrug",
  "isKnownInsuranceReceiptItem",
  "getReceiptIssueReason",
  "boxReceiptQuantityPatch",
]);
const declarations = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text))
    declarations.push(node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.length, names.size);
const parsing = source.slice(
  source.indexOf("function parseQrPayload("),
  source.indexOf("function formatExpiryNotice("),
);
const context = vm.createContext({
  URL,
  URLSearchParams,
  unwrapObjectPayload: (value) => value.data ?? value,
  asRecord: (value) => value,
  firstArrayPayload: (value, keys) =>
    keys.map((key) => value[key]).find(Array.isArray) ?? [],
});
vm.runInContext(
  ts.transpileModule(parsing + declarations.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText,
  context,
);
const hri = "(01)18806449122339(17)270628(10)A2606292(21)10A2606292B1034";
const compact = "01188064491223391727062810A2606292\x1d2110A2606292B1034";
const qr = context.parseQrPayload(hri);
const response = (count) => ({
  pc: qr.pc,
  drugMasterId: 44299,
  drugName: "엔커버액 200mL 커피맛",
  insuranceCode: "644912233",
  boxPackage: true,
  basePc: "8806449122332",
  baseProductTotalQuantity: 1,
  boxPackageCount: count,
  boxMappingRevision: count == null ? 0 : 1,
  totalQuantity: count ?? 0,
  priceMasters: [
    {
      priceMasterId: 12192,
      productCode: "644912233",
      productName: "엔커버액 200mL 커피맛",
      maxPrice: 2300,
      productTotalQuantity: 1,
    },
  ],
});
const item = (drug) => ({ id: "box-test", qr, drug });

test("QR and barcode modes preserve box PC, serial, lot and expiry", () => {
  for (const input of [hri, compact]) {
    for (const parse of [context.parseQrPayload, context.parseBarcodePayload]) {
      const scanned = parse(input);
      assert.equal(scanned.pc, "18806449122339");
      assert.equal(scanned.sn, "10A2606292B1034");
      assert.equal(scanned.lot, "A2606292");
      assert.equal(scanned.exp, "2027-06-28");
    }
  }
  assert.equal(
    context.parseBarcodePayload("18806449122339").pc,
    "18806449122339",
  );
  assert.equal(context.normalizeBarcodePc("08806449122332"), "8806449122332");
  assert.equal(context.getLowConfidenceBarcodeReason("18806449122339", qr), "");
  assert.ok(
    context.getLowConfidenceBarcodeReason("18806449122332", {
      ...qr,
      pc: "18806449122332",
    }),
  );
});

test("first registration cannot silently use the one-unit price master quantity", () => {
  const drug = context.normalizeReceiptValidation({ data: response(null) }, qr);
  assert.equal(drug.productTotalQuantity, 0);
  assert.equal(drug.boxPackageCount, undefined);
  assert.match(context.getReceiptIssueReason(item(drug)), /입력/);
});

test("subsequent user sees 24 but must confirm it for this scan", () => {
  const drug = context.normalizeReceiptValidation(response(24), qr);
  assert.equal(drug.productTotalQuantity, 24);
  assert.equal(drug.boxQuantityConfirmed, false);
  assert.match(context.getReceiptIssueReason(item(drug)), /확인/);
  Object.assign(drug, context.boxReceiptQuantityPatch(drug, 24, true));
  assert.equal(context.getReceiptIssueReason(item(drug)), "");
  assert.equal(
    context.normalizeReceiptValidation(response(24), qr).boxQuantityConfirmed,
    false,
  );
});

test("editing clears confirmation and recalculates inventory units", () => {
  const drug = context.normalizeReceiptValidation(response(24), qr);
  Object.assign(drug, context.boxReceiptQuantityPatch(drug, 24, true));
  Object.assign(drug, context.boxReceiptQuantityPatch(drug, 20, false));
  assert.equal(drug.productTotalQuantity, 20);
  assert.match(context.getReceiptIssueReason(item(drug)), /확인/);
  Object.assign(drug, context.boxReceiptQuantityPatch(drug, 20, true));
  assert.equal(context.getReceiptIssueReason(item(drug)), "");
  drug.baseProductTotalQuantity = 30;
  Object.assign(drug, context.boxReceiptQuantityPatch(drug, 24, true));
  assert.equal(drug.productTotalQuantity, 720);
});

test("invalid counts and unresolved PC masters cannot appear ready", () => {
  const drug = context.normalizeReceiptValidation(response(24), qr);
  for (const count of [0, -1, 1.5, 10001, NaN]) {
    Object.assign(drug, context.boxReceiptQuantityPatch(drug, count, true));
    assert.notEqual(context.getReceiptIssueReason(item(drug)), "");
  }
  const unknown = {
    name: "미확인 약",
    virtualDrugName: "미확인 약",
    virtualInsuranceCode: "4PF000060",
    insuranceCode: "4PF000060",
    insuranceCodeExists: false,
    matchStatus: "VIRTUAL",
    productTotalQuantity: 0,
  };
  assert.match(context.getReceiptIssueReason(item(unknown)), /기준 데이터/);
});
