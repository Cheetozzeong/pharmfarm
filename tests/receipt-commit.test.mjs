import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual handler with in-memory React state and a stubbed API.
// No server requests or inventory writes are made by these tests.
const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile(
  "App.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function declaration(name) {
  let found;
  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === name
    ) {
      found = node.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `${name} must exist in App.tsx`);
  return found;
}
const handler = ts.transpileModule(
  `${declaration("ApiError")}\n${declaration("commitReceipt")}`,
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
).outputText;

function setup({ failure, preview = false, unresolved = false } = {}) {
  const ready = {
    id: "ready",
    qr: { pc: "8806419068936", sn: "TEST-SN" },
    drug: {
      name: "케이슈머현탁액",
      insuranceCode: "641906891",
      priceMasterId: "123",
      productTotalQuantity: 20,
    },
  };
  const issue = {
    ...ready,
    id: "unresolved",
    drug: { ...ready.drug, priceMasterId: undefined },
  };
  const queue = unresolved ? [ready, issue] : [ready];
  const state = {
    queue,
    screen: "receiptMatch",
    error: "previous error",
    summary: null,
    demoWrites: 0,
    refreshes: 0,
    requests: [],
  };
  const context = vm.createContext({
    Error,
    selectedWholesaler: { id: "7", name: "테스트 도매처" },
    receiptQueue: queue,
    eligibleReceiptItems: [ready],
    receiptIssueItems: unresolved ? [issue] : [],
    receiptMatchPreview: preview,
    hasManualVirtualReceiptInput: () => false,
    validateReceiptQr: async () => ready.drug,
    isKnownInsuranceReceiptDrug: () => true,
    optionalId: (id) => id,
    apiFetch: async (path, options) => {
      state.requests.push({ path, body: JSON.parse(options.body) });
      if (failure === "http")
        throw new context.ApiError("이미 등록된 PC+SN 입고 데이터입니다.", 400);
      if (failure) throw failure;
      return { receivedCount: 1, shortageNotices: [] };
    },
    unwrapObjectPayload: (value) => value,
    firstArrayPayload: (value, [key]) => value[key],
    asRecord: (value) => value,
    finiteNumber: Number,
    setReceiptSubmitError: (value) => {
      state.error = value;
    },
    setReceiptPartialConfirmOpen: () => {},
    setApiState: (value) => {
      state.apiState = value;
    },
    setApiMessage: (value) => {
      state.apiMessage = value;
    },
    setScanNotice: (value) => {
      state.notice = value;
    },
    setApiFallback: () => {
      state.demoWrites++;
    },
    commitReceiptDemo: () => {
      state.demoWrites++;
    },
    setReceiptSummary: (value) => {
      state.summary = value;
    },
    setReceiptQueue: (update) => {
      state.queue = update(state.queue);
    },
    setScreen: (value) => {
      state.screen = value;
    },
    refreshFromBackend: () => {
      state.refreshes++;
    },
  });
  vm.runInContext(`${handler}\nthis.ApiError = ApiError;`, context);
  return {
    state,
    queue,
    commit: () => context.commitReceipt({ partialConfirmed: true }),
  };
}

for (const [name, failure] of [
  ["network failure", new TypeError("Failed to fetch")],
  ["unreadable server response", new SyntaxError("Unexpected token")],
  ["aborted request", new DOMException("Request aborted", "AbortError")],
  ["expired authentication", new Error("UNAUTHORIZED")],
  ["missing permission", new Error("FORBIDDEN")],
  ["server validation failure", "http"],
]) {
  test(`${name} shows an error and preserves all scans and selections`, async () => {
    const { state, queue, commit } = setup({ failure, unresolved: true });
    const original = structuredClone(queue);
    await commit();
    assert.equal(state.screen, "receiptMatch");
    assert.equal(state.queue, queue);
    assert.deepEqual(state.queue, original);
    assert.ok(state.error);
    assert.notEqual(state.error, "previous error");
    assert.equal(state.notice, state.error);
    assert.equal(state.summary, null);
    assert.equal(state.demoWrites, 0);
    assert.equal(state.refreshes, 0);
    if (failure === "http") assert.match(state.error, /이미 등록된 PC\+SN/);
  });
}

test("preview failures also show an error and keep the scanned list", async () => {
  const { state, queue, commit } = setup({
    failure: new TypeError("Failed to fetch"),
    preview: true,
  });
  await commit();
  assert.equal(state.screen, "receiptMatch");
  assert.equal(state.queue, queue);
  assert.ok(state.error);
  assert.equal(state.demoWrites, 0);
});

test("a confirmed successful save completes only the submitted items", async () => {
  const { state, queue, commit } = setup({ unresolved: true });
  await commit();
  assert.equal(state.screen, "receiptDone");
  assert.equal(state.error, "");
  assert.deepEqual(state.queue, [queue[1]]);
  assert.equal(state.summary.count, 1);
  assert.equal(state.summary.increase, 20);
  assert.equal(state.summary.missing, 1);
  assert.equal(state.requests[0].path, "/receipts");
  assert.equal(state.requests[0].body.items[0].productTotalQuantity, 20);
  assert.equal(state.refreshes, 1);
  assert.equal(state.demoWrites, 0);
});
