import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode, RefObject } from "react";
import {
  BrowserMultiFormatReader,
  type IScannerControls,
} from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

type Screen =
  | "scan"
  | "wholesaler"
  | "receiptReview"
  | "receiptMatch"
  | "receiptDone"
  | "returnConfirmed"
  | "returnEstimated"
  | "returnNone"
  | "returnQty"
  | "returnDone"
  | "stocks"
  | "account";
type Mode = "receipt" | "return";
type MatchStatus = "NORMAL" | "NAME_MATCH" | "VIRTUAL" | "MISSING";

type QrFields = {
  pc: string;
  sn: string;
  lot: string;
  exp: string;
  raw: string;
  format: "query" | "gs1" | "text";
  errors: string[];
};

type Wholesaler = {
  id: string;
  name: string;
  meta: string;
};

type DrugMaster = {
  pc: string;
  insuranceCode: string;
  name: string;
  productTotalQuantity: number;
  price: number;
  matchStatus: MatchStatus;
};

type ReceiptQueueItem = {
  id: string;
  qr: QrFields;
  drug: DrugMaster;
};

type StockItem = {
  id: string;
  pc: string;
  insuranceCode: string;
  name: string;
  quantity: number;
  price: number;
  matchStatus: MatchStatus;
};

type ReceiptTrace = {
  id: string;
  pc: string;
  sn: string;
  lot: string;
  exp: string;
  drugName: string;
  insuranceCode: string;
  productTotalQuantity: number;
  returnedQuantity: number;
  wholesalerId: string;
  wholesalerName: string;
};

type SellerCandidate = {
  id: string;
  sellerName: string;
  transactionDate: string;
  orderItemName: string;
  productName: string;
  quantity: number;
};

type ReturnLookup =
  | {
      matchType: "CONFIRMED";
      pc: string;
      sn: string;
      lot: string;
      exp: string;
      drugName: string;
      wholesalerName: string;
      productTotalQuantity: number;
      returnedQuantity: number;
      returnableQuantity: number;
      stockQuantity: number;
    }
  | {
      matchType: "ESTIMATED";
      pc: string;
      sn: string;
      lot: string;
      exp: string;
      drugName: string;
      sellerCandidates: SellerCandidate[];
      returnableQuantity: number;
      stockQuantity: number;
    }
  | {
      matchType: "NONE";
      pc: string;
      sn: string;
      lot: string;
      exp: string;
      drugName: string;
      message: string;
    };

type ReceiptSummary = {
  wholesalerName: string;
  count: number;
  increase: number;
  missing: number;
};

type ReturnSummary = {
  drugName: string;
  wholesalerName: string;
  quantity: number;
  stockAfter: number;
};

type CameraConstraintSet = MediaTrackConstraintSet & {
  exposureMode?: string;
  focusMode?: string;
  whiteBalanceMode?: string;
};

type ApiState =
  | "checking"
  | "connected"
  | "demo"
  | "unauthorized"
  | "forbidden";

const apiBase = (
  import.meta.env.VITE_PHARMFARM_API_BASE ??
  "https://api.solusi.co.kr/api/v1/pharmfarm"
).replace(/\/$/, "");

const storageKeys = {
  accessToken: "pharmfarm.accessToken",
  refreshToken: "pharmfarm.refreshToken",
};

type TokenResponse = {
  accessToken?: string;
  refreshToken?: string;
  token?: string;
  data?: {
    accessToken?: string;
    refreshToken?: string;
  };
};

const demoWholesalers: Wholesaler[] = [
  { id: "10", name: "한미약품 A도매", meta: "공통 · 서울 강남" },
  { id: "20", name: "지오영 도매", meta: "공통 · 경기 성남" },
  { id: "30", name: "백제약품", meta: "공통 · 전국" },
  { id: "90", name: "우리동네 직거래", meta: "약국 등록" },
];

const demoMasters: DrugMaster[] = [
  {
    pc: "8806400017004",
    insuranceCode: "640001700",
    name: "타이레놀정 500mg",
    productTotalQuantity: 30,
    price: 86,
    matchStatus: "NORMAL",
  },
  {
    pc: "8806526045210",
    insuranceCode: "652604520",
    name: "아목시실린 250mg",
    productTotalQuantity: 30,
    price: 124,
    matchStatus: "NAME_MATCH",
  },
  {
    pc: "8899000000201",
    insuranceCode: "3PF000124",
    name: "비급여 연고 20g",
    productTotalQuantity: 30,
    price: 0,
    matchStatus: "VIRTUAL",
  },
];

const initialStocks: StockItem[] = [
  {
    id: "S-001",
    pc: "8806400017004",
    insuranceCode: "640001700",
    name: "타이레놀정 500mg",
    quantity: 30,
    price: 86,
    matchStatus: "NORMAL",
  },
  {
    id: "S-002",
    pc: "8800000000000",
    insuranceCode: "880000001",
    name: "예시약 30T",
    quantity: 30,
    price: 110,
    matchStatus: "NORMAL",
  },
  {
    id: "S-003",
    pc: "8899000000201",
    insuranceCode: "3PF000124",
    name: "비급여 연고 20g",
    quantity: 8,
    price: 0,
    matchStatus: "VIRTUAL",
  },
];

const initialTraces: ReceiptTrace[] = [
  {
    id: "R-1001",
    pc: "8806400017004",
    sn: "SN8842",
    lot: "LOT202606",
    exp: "2027-12-31",
    drugName: "타이레놀정 500mg",
    insuranceCode: "640001700",
    productTotalQuantity: 30,
    returnedQuantity: 0,
    wholesalerId: "10",
    wholesalerName: "한미약품 A도매",
  },
];

const demoPurchaseHistories: SellerCandidate[] = [
  {
    id: "100",
    sellerName: "한미약품 A도매",
    transactionDate: "2026-01-10",
    orderItemName: "예시약 30T",
    productName: "예시약",
    quantity: 30,
  },
  {
    id: "200",
    sellerName: "지오영 도매",
    transactionDate: "2025-11-22",
    orderItemName: "예시약 30정",
    productName: "예시약",
    quantity: 60,
  },
];

const receiptSamples = [
  "pc=8806400017004&sn=SN8842&lot=LOT202606&exp=2027-12-31",
  "pc=8806526045210&sn=SN3310&lot=LOT202605&exp=2027-11-30",
  "pc=8899000000201&sn=SN7720&lot=LOT202604&exp=2027-10-31",
  "pc=0000000000000&sn=SN0021&lot=LOT0000&exp=2027-01-31",
];

const returnSamples = [
  "pc=8806400017004&sn=SN8842&lot=LOT202606&exp=2027-12-31",
  "pc=8800000000000&sn=SN-EST001&lot=LOT202505&exp=2027-05-31",
  "pc=0000000000000&sn=SN-NONE&lot=LOT000&exp=2027-01-01",
];

function createScannerReader() {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.CHARACTER_SET, "UTF-8");
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.QR_CODE,
    BarcodeFormat.DATA_MATRIX,
  ]);

  return new BrowserMultiFormatReader(hints, {
    delayBetweenScanAttempts: 80,
    delayBetweenScanSuccess: 220,
    tryPlayVideoTimeout: 5000,
  });
}

function getCameraConstraints(): MediaStreamConstraints {
  const advanced: CameraConstraintSet[] = [
    {
      exposureMode: "continuous",
      focusMode: "continuous",
      whiteBalanceMode: "continuous",
    },
  ];

  return {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920, min: 1280 },
      height: { ideal: 1080, min: 720 },
      frameRate: { ideal: 30, min: 15 },
      advanced,
    },
  };
}

function getStoredAccessToken() {
  return localStorage.getItem(storageKeys.accessToken);
}

function getStoredRefreshToken() {
  return localStorage.getItem(storageKeys.refreshToken);
}

function hasStoredAuthTokens() {
  return Boolean(getStoredAccessToken() || getStoredRefreshToken());
}

function clearAuthTokens() {
  localStorage.removeItem(storageKeys.accessToken);
  localStorage.removeItem(storageKeys.refreshToken);
}

function storeTokenResponse(raw: TokenResponse) {
  const accessToken = raw.accessToken ?? raw.token ?? raw.data?.accessToken;
  const refreshToken = raw.refreshToken ?? raw.data?.refreshToken;

  if (!accessToken) return false;

  localStorage.setItem(storageKeys.accessToken, accessToken);
  if (refreshToken) {
    localStorage.setItem(storageKeys.refreshToken, refreshToken);
  }
  return true;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;

  return JSON.parse(text) as T;
}

async function rawApiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);

  if (
    !headers.has("Content-Type") &&
    options.body &&
    !(options.body instanceof FormData)
  ) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    throw new Error("UNAUTHORIZED");
  }
  if (response.status === 403) {
    throw new Error("FORBIDDEN");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return parseJsonResponse<T>(response);
}

async function refreshAccessToken() {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return false;

  try {
    const data = await rawApiFetch<TokenResponse>("/auth/reissue", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshToken}`,
      },
      body: JSON.stringify({ refreshToken }),
    });
    return storeTokenResponse(data);
  } catch {
    clearAuthTokens();
    return false;
  }
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  retryOnUnauthorized = true,
): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getStoredAccessToken();

  if (
    !headers.has("Content-Type") &&
    options.body &&
    !(options.body instanceof FormData)
  ) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    if (
      retryOnUnauthorized &&
      path !== "/auth/login" &&
      path !== "/auth/reissue"
    ) {
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        return apiFetch<T>(path, options, false);
      }
    }
    clearAuthTokens();
    throw new Error("UNAUTHORIZED");
  }
  if (response.status === 403) {
    throw new Error("FORBIDDEN");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return parseJsonResponse<T>(response);
}

async function login(loginId: string, password: string) {
  let data: TokenResponse;

  try {
    data = await rawApiFetch<TokenResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ loginId, password }),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "UNAUTHORIZED" || error.message === "FORBIDDEN")
    ) {
      throw new Error("아이디 또는 비밀번호를 확인해 주세요.");
    }
    throw error;
  }

  if (!storeTokenResponse(data)) {
    throw new Error("로그인 응답에 accessToken이 없습니다.");
  }
}

function normalizeWholesaler(raw: unknown, index: number): Wholesaler {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? item.wholesalerId ?? index),
    name: String(item.name ?? item.wholesalerName ?? item.sellerName ?? "-"),
    meta: String(item.meta ?? item.typeName ?? item.address ?? "공통"),
  };
}

function normalizeStock(raw: unknown, index: number): StockItem {
  const item = raw as Record<string, unknown>;
  const quantity = Number(
    item.quantity ?? item.count ?? item.stockQuantity ?? 0,
  );
  const price = Number(item.price ?? item.unitPrice ?? item.upperPrice ?? 0);

  return {
    id: String(item.id ?? item.stockId ?? index),
    pc: String(item.pc ?? item.standardCode ?? ""),
    insuranceCode: String(item.insuranceCode ?? item.productCode ?? ""),
    name: String(
      item.name ?? item.drugName ?? item.productName ?? "미확인 약품",
    ),
    quantity,
    price,
    matchStatus: normalizeMatchStatus(item.matchStatus),
  };
}

function normalizeMatchStatus(value: unknown): MatchStatus {
  const raw = String(value ?? "NORMAL").toUpperCase();
  if (raw.includes("NAME") || raw.includes("이름")) return "NAME_MATCH";
  if (raw.includes("VIRTUAL") || raw.includes("가상")) return "VIRTUAL";
  if (raw.includes("MISSING") || raw.includes("미등록")) return "MISSING";
  return "NORMAL";
}

function normalizeLookup(raw: unknown, qr: QrFields): ReturnLookup {
  const item = raw as Record<string, unknown>;
  const matchType = String(item.matchType ?? item.type ?? "NONE").toUpperCase();

  if (matchType === "CONFIRMED") {
    const productTotalQuantity = Number(
      item.productTotalQuantity ?? item.packageQuantity ?? 0,
    );
    const returnedQuantity = Number(item.returnedQuantity ?? 0);
    const returnableQuantity = Number(
      item.returnableQuantity ??
        item.availableQuantity ??
        Math.max(0, productTotalQuantity - returnedQuantity),
    );
    return {
      matchType: "CONFIRMED",
      pc: String(item.pc ?? qr.pc),
      sn: String(item.sn ?? qr.sn),
      lot: String(item.lot ?? qr.lot),
      exp: String(item.exp ?? qr.exp),
      drugName: String(item.drugName ?? item.name ?? "미확인 약품"),
      wholesalerName: String(item.wholesalerName ?? item.sellerName ?? "-"),
      productTotalQuantity,
      returnedQuantity,
      returnableQuantity,
      stockQuantity: Number(item.stockQuantity ?? returnableQuantity),
    };
  }

  if (matchType === "ESTIMATED") {
    const sellerCandidates = Array.isArray(item.sellerCandidates)
      ? item.sellerCandidates.map(normalizeCandidate)
      : [];
    return {
      matchType: "ESTIMATED",
      pc: String(item.pc ?? qr.pc),
      sn: String(item.sn ?? qr.sn),
      lot: String(item.lot ?? qr.lot),
      exp: String(item.exp ?? qr.exp),
      drugName: String(item.drugName ?? item.name ?? "미확인 약품"),
      sellerCandidates,
      returnableQuantity: Number(
        item.returnableQuantity ?? item.stockQuantity ?? 0,
      ),
      stockQuantity: Number(item.stockQuantity ?? item.returnableQuantity ?? 0),
    };
  }

  return {
    matchType: "NONE",
    pc: qr.pc,
    sn: qr.sn,
    lot: qr.lot,
    exp: qr.exp,
    drugName: String(item.drugName ?? item.name ?? "미확인 약품"),
    message: String(
      item.message ??
        "입고·구매 내역에 근거가 없어 반품 대상으로 등록할 수 없습니다.",
    ),
  };
}

function normalizeCandidate(raw: unknown, index: number): SellerCandidate {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? item.purchaseHistoryId ?? index),
    sellerName: String(item.sellerName ?? item.wholesalerName ?? "-"),
    transactionDate: String(item.transactionDate ?? item.orderDate ?? "-"),
    orderItemName: String(item.orderItemName ?? item.inventoryName ?? "-"),
    productName: String(item.productName ?? item.name ?? "-"),
    quantity: Number(item.quantity ?? 0),
  };
}

function parseQrPayload(rawValue: string): QrFields {
  const raw = rawValue.trim();
  const queryFields = parseQueryQr(raw);
  const gs1Fields = parseGs1Qr(raw);
  const textFields = parseTextQr(raw);
  const fields = queryFields ?? gs1Fields ?? textFields;
  const format = queryFields ? "query" : gs1Fields ? "gs1" : "text";

  const result: QrFields = {
    pc: normalizePc(fields.pc),
    sn: fields.sn,
    lot: fields.lot,
    exp: normalizeExp(fields.exp),
    raw,
    format,
    errors: [],
  };

  if (!result.pc) result.errors.push("PC 없음");
  if (!result.sn) result.errors.push("SN 없음");
  if (!result.lot) result.errors.push("LOT 없음");
  if (!result.exp) result.errors.push("EXP 없음");

  return result;
}

function normalizePc(value: string) {
  const compact = value.trim();
  const digits = compact.replace(/\D/g, "");

  if (digits.length === compact.length) {
    return digits.length === 14 && digits.startsWith("0")
      ? digits.slice(1)
      : digits;
  }

  return compact;
}

function parseQueryQr(raw: string) {
  try {
    const url = new URL(raw);
    return readSearchParams(url.searchParams);
  } catch {
    if (!raw.includes("=")) return null;
    return readSearchParams(new URLSearchParams(raw.replace(/^[?#]/, "")));
  }
}

function readSearchParams(params: URLSearchParams) {
  const first = (keys: string[]) => {
    for (const key of keys) {
      const value = params.get(key);
      if (value) return value.trim();
    }
    return "";
  };

  return {
    pc: first(["pc", "PC", "01", "gtin"]),
    sn: first(["sn", "SN", "21", "serial"]),
    lot: first(["lot", "LOT", "10"]),
    exp: first(["exp", "EXP", "17"]),
  };
}

function parseGs1Qr(raw: string) {
  const parenthesized = [...raw.matchAll(/\((01|21|10|17)\)([^()]+)/g)];

  if (parenthesized.length > 0) {
    const values = new Map(
      parenthesized.map((match) => [match[1], match[2].trim()]),
    );
    return {
      pc: values.get("01") ?? "",
      sn: values.get("21") ?? "",
      lot: values.get("10") ?? "",
      exp: values.get("17") ?? "",
    };
  }

  return parseCompactGs1(raw);
}

function parseCompactGs1(raw: string) {
  const compact = raw
    .replace(/^\][A-Za-z0-9]{2}/, "")
    .replace(/\u001d/g, "\x1d")
    .replace(/[ \n\r\t]+/g, "");

  const pcIndex = findFixedGs1Ai(compact, "01", 0, 14);
  const pcEnd = pcIndex >= 0 ? pcIndex + 16 : 0;
  const expIndex = findFixedGs1Ai(compact, "17", pcEnd, 6);
  const expEnd = expIndex >= 0 ? expIndex + 8 : pcEnd;
  const lot = readVariableGs1Ai(compact, "10", expEnd);
  const sn = readVariableGs1Ai(compact, "21", expEnd);
  const result = {
    pc: pcIndex >= 0 ? compact.slice(pcIndex + 2, pcIndex + 16) : "",
    sn,
    lot,
    exp: expIndex >= 0 ? compact.slice(expIndex + 2, expIndex + 8) : "",
  };

  return result.pc || result.sn || result.lot || result.exp ? result : null;
}

function findFixedGs1Ai(
  raw: string,
  ai: string,
  start: number,
  valueLength: number,
) {
  for (
    let index = Math.max(0, start);
    index <= raw.length - valueLength - 2;
    index += 1
  ) {
    if (raw.slice(index, index + 2) !== ai) continue;

    const value = raw.slice(index + 2, index + 2 + valueLength);
    if (/^\d+$/.test(value)) return index;
  }

  return -1;
}

function readVariableGs1Ai(raw: string, ai: string, start: number) {
  const index = raw.indexOf(ai, Math.max(0, start));
  if (index < 0) return "";

  const valueStart = index + 2;
  const separatorIndex = raw.indexOf("\x1d", valueStart);
  const nextAiIndex =
    separatorIndex >= 0 ? separatorIndex : findNextGs1Ai(raw, valueStart);
  const valueEnd = nextAiIndex >= 0 ? nextAiIndex : raw.length;

  return raw.slice(valueStart, valueEnd).replace(/\x1d/g, "").trim();
}

function findNextGs1Ai(raw: string, start: number) {
  for (let index = start + 1; index < raw.length - 1; index += 1) {
    const ai = raw.slice(index, index + 2);

    if (ai === "01" && /^\d{14}/.test(raw.slice(index + 2, index + 16))) {
      return index;
    }
    if (ai === "17" && /^\d{6}/.test(raw.slice(index + 2, index + 8))) {
      return index;
    }
    if (ai === "10" || ai === "21") {
      return index;
    }
  }

  return -1;
}

function parseTextQr(raw: string) {
  const values = readLabeledQrText(raw);
  const read = (keys: string[]) => {
    for (const key of keys) {
      const value = values.get(key);
      if (value) return value;
    }
    return "";
  };

  return {
    pc: read(["pc", "gtin"]),
    sn: read(["sn", "serial"]),
    lot: read(["lot"]),
    exp: read(["exp", "expiry", "expiration"]),
  };
}

function readLabeledQrText(raw: string) {
  const labelMatches = [
    ...raw.matchAll(
      /\b(PC|GTIN|SN|SERIAL|LOT|EXP|EXPIRY|EXPIRATION)\b\s*[:=]\s*/gi,
    ),
  ];
  const values = new Map<string, string>();

  labelMatches.forEach((match, index) => {
    const label = match[1].toLowerCase();
    const start = (match.index ?? 0) + match[0].length;
    const end = labelMatches[index + 1]?.index ?? raw.length;
    const value = raw.slice(start, end).replace(/^[\s,;|]+|[\s,;|]+$/g, "");

    if (value) {
      values.set(label, value);
    }
  });

  return values;
}

function normalizeExp(value: string) {
  const humanDate = value.trim().match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D*$/);

  if (humanDate) {
    return `${humanDate[1]}-${humanDate[2].padStart(2, "0")}-${humanDate[3].padStart(2, "0")}`;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length === 6)
    return `20${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
  if (digits.length === 8)
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
  return value;
}

function resolveDrug(pc: string): DrugMaster {
  const match = demoMasters.find((drug) => drug.pc === pc);
  if (match) return match;

  return {
    pc,
    insuranceCode: `3PF${pc.slice(-6).padStart(6, "0")}`,
    name: "미확인 약품",
    productTotalQuantity: 0,
    price: 0,
    matchStatus: "MISSING",
  };
}

function statusText(status: MatchStatus) {
  switch (status) {
    case "NAME_MATCH":
      return "이름매칭";
    case "VIRTUAL":
      return "가상생성";
    case "MISSING":
      return "미등록";
    default:
      return "정상";
  }
}

function statusClass(status: MatchStatus) {
  switch (status) {
    case "NAME_MATCH":
      return "name";
    case "VIRTUAL":
      return "virtual";
    case "MISSING":
      return "missing";
    default:
      return "normal";
  }
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function currency(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function MobileApp() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockedRef = useRef(false);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const lastDetectedRef = useRef({ value: "", at: 0 });
  const modeRef = useRef<Mode>("receipt");

  const [screen, setScreen] = useState<Screen>(() =>
    hasStoredAuthTokens() ? "wholesaler" : "account",
  );
  const [mode, setMode] = useState<Mode>("receipt");
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [apiMessage, setApiMessage] = useState("");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [wholesalers, setWholesalers] = useState(demoWholesalers);
  const [selectedWholesalerId, setSelectedWholesalerId] = useState("");
  const [pendingWholesalerId, setPendingWholesalerId] = useState(
    demoWholesalers[0].id,
  );
  const [stocks, setStocks] = useState(initialStocks);
  const [traces, setTraces] = useState(initialTraces);
  const [receiptQueue, setReceiptQueue] = useState<ReceiptQueueItem[]>([]);
  const [lastScanName, setLastScanName] = useState("타이레놀정 500mg");
  const [scanNotice, setScanNotice] = useState(
    "카메라를 시작하면 QR이 자동으로 인식됩니다.",
  );
  const [receiptSummary, setReceiptSummary] = useState<ReceiptSummary | null>(
    null,
  );
  const [returnLookup, setReturnLookup] = useState<ReturnLookup | null>(null);
  const [returnQuantity, setReturnQuantity] = useState(10);
  const [returnMemo, setReturnMemo] = useState("유통기한 임박 반품");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [returnSummary, setReturnSummary] = useState<ReturnSummary | null>(
    null,
  );
  const [sampleCursor, setSampleCursor] = useState(0);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const audio = new Audio("/barcode_sound.mp3");
    audio.preload = "auto";
    scanAudioRef.current = audio;

    return () => {
      audio.pause();
      scanAudioRef.current = null;
    };
  }, []);

  const unlockScanAudio = useCallback(() => {
    const audio = scanAudioRef.current;
    if (!audio || audioUnlockedRef.current) return;

    const previousVolume = audio.volume;
    audio.volume = 0;
    void audio
      .play()
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.volume = previousVolume;
        audioUnlockedRef.current = true;
      })
      .catch(() => {
        audio.volume = previousVolume;
      });
  }, []);

  const playScanSound = useCallback(() => {
    const audio = scanAudioRef.current;
    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    void audio.play().catch(() => undefined);
  }, []);

  const selectedWholesaler = useMemo(
    () =>
      wholesalers.find(
        (wholesaler) => wholesaler.id === selectedWholesalerId,
      ) ?? null,
    [selectedWholesalerId, wholesalers],
  );

  const pendingWholesaler = useMemo(
    () =>
      wholesalers.find((wholesaler) => wholesaler.id === pendingWholesalerId) ??
      wholesalers[0],
    [pendingWholesalerId, wholesalers],
  );

  const eligibleReceiptItems = useMemo(
    () => receiptQueue.filter((item) => item.drug.matchStatus !== "MISSING"),
    [receiptQueue],
  );

  const receiptIncrease = useMemo(
    () =>
      eligibleReceiptItems.reduce(
        (sum, item) => sum + item.drug.productTotalQuantity,
        0,
      ),
    [eligibleReceiptItems],
  );

  const selectedCandidate = useMemo(() => {
    if (returnLookup?.matchType !== "ESTIMATED") return null;
    return (
      returnLookup.sellerCandidates.find(
        (candidate) => candidate.id === selectedCandidateId,
      ) ?? returnLookup.sellerCandidates[0]
    );
  }, [returnLookup, selectedCandidateId]);

  const returnDrugName =
    returnLookup?.matchType === "CONFIRMED" ||
    returnLookup?.matchType === "ESTIMATED"
      ? returnLookup.drugName
      : "";
  const returnWholesalerName =
    returnLookup?.matchType === "CONFIRMED"
      ? returnLookup.wholesalerName
      : (selectedCandidate?.sellerName ?? "");
  const returnMax =
    returnLookup?.matchType === "CONFIRMED" ||
    returnLookup?.matchType === "ESTIMATED"
      ? Math.max(0, returnLookup.returnableQuantity)
      : 0;
  const returnStockBefore =
    returnLookup?.matchType === "CONFIRMED" ||
    returnLookup?.matchType === "ESTIMATED"
      ? returnLookup.stockQuantity
      : 0;

  const setApiFallback = useCallback((error: unknown) => {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      clearAuthTokens();
      setApiState("unauthorized");
      setApiMessage("로그인이 필요합니다.");
      setScreen("account");
      return;
    }
    if (error instanceof Error && error.message === "FORBIDDEN") {
      setApiState("forbidden");
      setApiMessage("현재 계정 권한으로는 실행할 수 없습니다.");
      return;
    }
    setApiState("demo");
    setApiMessage("BE 연결 실패 · 데모 데이터 표시");
  }, []);

  const refreshFromBackend = useCallback(async () => {
    if (!hasStoredAuthTokens()) {
      setApiState("unauthorized");
      setApiMessage("로그인이 필요합니다.");
      return false;
    }

    setApiState("checking");
    try {
      const [wholesalerData, stockData] = await Promise.all([
        apiFetch<unknown[]>("/wholesalers"),
        apiFetch<unknown[]>("/stocks"),
      ]);
      setWholesalers(wholesalerData.map(normalizeWholesaler));
      setStocks(stockData.map(normalizeStock));
      setApiState("connected");
      setApiMessage("BE 연결됨");
      return true;
    } catch (error) {
      setApiFallback(error);
      return false;
    }
  }, [setApiFallback]);

  const bootstrapAuth = useCallback(async () => {
    if (!hasStoredAuthTokens()) {
      setApiState("unauthorized");
      setApiMessage("로그인이 필요합니다.");
      setScreen("account");
      return;
    }

    setApiState("checking");
    setApiMessage("자동 로그인 확인 중");
    try {
      await apiFetch<unknown>("/auth/me");
      const connected = await refreshFromBackend();
      if (connected) {
        setApiState("connected");
        setApiMessage("자동 로그인됨");
      }
      setScreen((current) => (current === "account" ? "wholesaler" : current));
    } catch (error) {
      setApiFallback(error);
    }
  }, [refreshFromBackend, setApiFallback]);

  useEffect(() => {
    void bootstrapAuth();
  }, [bootstrapAuth]);

  const stopCamera = useCallback(() => {
    scannerControlsRef.current?.stop();
    scannerControlsRef.current = null;

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute("src");
    }
  }, []);

  const addReceiptQr = useCallback(
    (qr: QrFields) => {
      const alreadyReceived = traces.some(
        (trace) => trace.pc === qr.pc && trace.sn === qr.sn,
      );
      const duplicated = receiptQueue.some(
        (item) => item.qr.pc === qr.pc && item.qr.sn === qr.sn,
      );

      if (alreadyReceived || duplicated) {
        setLastScanName("이미 스캔된 SN");
        setScanNotice("이미 입고됐거나 현재 목록에 있는 QR입니다.");
        return true;
      }

      const drug = resolveDrug(qr.pc);
      setReceiptQueue((current) => [
        { id: createId("Q"), qr, drug },
        ...current,
      ]);
      setLastScanName(drug.name);
      setScanNotice(
        drug.matchStatus === "MISSING"
          ? "기준 데이터 미등록 QR입니다. 매칭 결과에서 보정이 필요합니다."
          : `${drug.name} 입고 스캔 완료 · 목록에 추가했습니다.`,
      );
      return true;
    },
    [receiptQueue, traces],
  );

  const lookupReturn = useCallback(
    async (qr: QrFields) => {
      setLastScanName("반품 판매처 조회 중");
      setScanNotice("입고 이력과 구매 내역에서 판매처를 조회하고 있습니다.");
      try {
        const response = await apiFetch<unknown>("/returns/lookup", {
          method: "POST",
          body: JSON.stringify({
            pc: qr.pc,
            sn: qr.sn,
            lot: qr.lot,
            exp: qr.exp,
          }),
        });
        const lookup = normalizeLookup(response, qr);
        setReturnLookup(lookup);
        if (lookup.matchType === "CONFIRMED") {
          setLastScanName(`${lookup.drugName} · 확정`);
          setScanNotice("입고 이력에서 도매처를 확정했습니다.");
          setReturnQuantity(
            Math.max(1, Math.min(10, lookup.returnableQuantity)),
          );
          setScreen("returnConfirmed");
          return;
        }
        if (lookup.matchType === "ESTIMATED") {
          setLastScanName(`${lookup.drugName} · 추정`);
          setScanNotice("구매 내역 기준 판매처 후보를 찾았습니다.");
          setSelectedCandidateId(lookup.sellerCandidates[0]?.id ?? "");
          setReturnQuantity(
            Math.max(1, Math.min(10, lookup.returnableQuantity)),
          );
          setScreen("returnEstimated");
          return;
        }
        setLastScanName("판매처 후보 없음");
        setScanNotice(
          "입고 이력과 구매 내역에서 판매처 후보를 찾지 못했습니다.",
        );
        setScreen("returnNone");
      } catch (error) {
        setApiFallback(error);
        const lookup = lookupReturnDemo(qr, traces, stocks);
        setReturnLookup(lookup);
        if (lookup.matchType === "CONFIRMED") {
          setLastScanName(`${lookup.drugName} · 확정`);
          setScanNotice("데모 데이터의 입고 이력에서 도매처를 확정했습니다.");
          setReturnQuantity(
            Math.max(1, Math.min(10, lookup.returnableQuantity)),
          );
          setScreen("returnConfirmed");
        } else if (lookup.matchType === "ESTIMATED") {
          setLastScanName(`${lookup.drugName} · 추정`);
          setScanNotice("데모 구매 내역 기준 판매처 후보를 찾았습니다.");
          setSelectedCandidateId(lookup.sellerCandidates[0]?.id ?? "");
          setReturnQuantity(
            Math.max(1, Math.min(10, lookup.returnableQuantity)),
          );
          setScreen("returnEstimated");
        } else {
          setLastScanName("판매처 후보 없음");
          setScanNotice(
            "입고 이력과 구매 내역에서 판매처 후보를 찾지 못했습니다.",
          );
          setScreen("returnNone");
        }
      }
    },
    [setApiFallback, stocks, traces],
  );

  const handlePayload = useCallback(
    (payload: string) => {
      const qr = parseQrPayload(payload);
      if (qr.errors.length > 0) {
        setLastScanName(qr.errors.join(", "));
        setScanNotice("QR 값은 읽었지만 필수 필드를 파싱하지 못했습니다.");
        return false;
      }

      if (modeRef.current === "return") {
        void lookupReturn(qr);
        return true;
      } else {
        if (!selectedWholesaler) {
          setLastScanName("도매처 선택 필요");
          setScanNotice("입고 QR을 처리하려면 먼저 도매처를 선택해야 합니다.");
          setScreen("wholesaler");
          return false;
        }
        return addReceiptQr(qr);
      }
    },
    [addReceiptQr, lookupReturn, selectedWholesaler],
  );

  useEffect(() => {
    if (!cameraActive) {
      stopCamera();
      return;
    }

    let cancelled = false;

    async function startCamera() {
      setCameraError("");
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("카메라를 사용할 수 없는 환경입니다.");
        }

        const video = videoRef.current;
        if (!video) throw new Error("카메라 화면을 준비하지 못했습니다.");

        const reader = createScannerReader();
        setScanNotice("카메라 실행 중 · QR을 사각형 안에 맞춰주세요.");
        const controls = await reader.decodeFromConstraints(
          getCameraConstraints(),
          video,
          (result) => {
            const value = result?.getText();
            if (!value) return;

            const now = Date.now();
            const lastDetected = lastDetectedRef.current;
            if (value === lastDetected.value && now - lastDetected.at < 900) {
              return;
            }

            const accepted = handlePayload(value);
            if (accepted) {
              lastDetectedRef.current = { value, at: now };
              playScanSound();
            }
          },
        );

        if (cancelled) {
          controls.stop();
          return;
        }
        scannerControlsRef.current = controls;
      } catch (error) {
        if (cancelled) return;
        setCameraError(
          error instanceof Error ? error.message : "카메라 시작 실패",
        );
        setScanNotice(
          "카메라를 시작하지 못했습니다. 권한과 HTTPS 환경을 확인해 주세요.",
        );
        setCameraActive(false);
      }
    }

    void startCamera();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [cameraActive, handlePayload, playScanSound, stopCamera]);

  function chooseMode(nextMode: Mode) {
    if (nextMode === mode) return;
    if (
      mode === "receipt" &&
      (receiptQueue.length > 0 || cameraActive) &&
      !window.confirm(
        "모드를 변경하면 현재 스캔한 입고 목록이 삭제되고 카메라가 중지됩니다. 계속할까요?",
      )
    ) {
      return;
    }
    if (mode === "receipt") {
      setReceiptQueue([]);
      setCameraActive(false);
    }
    setMode(nextMode);
    setScreen(
      nextMode === "receipt" && !selectedWholesaler ? "wholesaler" : "scan",
    );
    setCameraActive(false);
    setScanNotice(
      nextMode === "receipt"
        ? "입고 모드입니다. 도매처 선택 후 QR을 스캔하세요."
        : "반품 모드입니다. QR을 스캔하면 판매처를 조회합니다.",
    );
  }

  function openWholesalerPicker() {
    if (
      (cameraActive || receiptQueue.length > 0) &&
      !window.confirm(
        "도매처를 변경하면 현재 스캔한 입고 목록이 삭제되고 카메라가 중지됩니다. 계속할까요?",
      )
    ) {
      return;
    }

    if (cameraActive || receiptQueue.length > 0) {
      setCameraActive(false);
      setReceiptQueue([]);
      setLastScanName("도매처 선택 필요");
      setScanNotice("도매처를 다시 선택하면 새 입고 스캔을 시작합니다.");
    }

    setMode("receipt");
    setPendingWholesalerId(selectedWholesalerId || pendingWholesalerId);
    setScreen("wholesaler");
  }

  function startReturnFirst() {
    setMode("return");
    setCameraActive(false);
    setScreen("scan");
    setScanNotice("반품 모드입니다. QR을 스캔하면 판매처를 조회합니다.");
  }

  function useSample() {
    const samples = mode === "receipt" ? receiptSamples : returnSamples;
    const sample = samples[sampleCursor % samples.length];
    setSampleCursor((value) => value + 1);
    setScanNotice("샘플 QR을 처리하고 있습니다.");
    handlePayload(sample);
  }

  function toggleCamera() {
    setCameraActive((current) => {
      const next = !current;
      if (next) {
        lastDetectedRef.current = { value: "", at: 0 };
        unlockScanAudio();
      }
      return next;
    });
  }

  function startReceipt() {
    if (!selectedWholesaler) {
      setScreen("wholesaler");
      return false;
    }
    return true;
  }

  async function commitReceipt() {
    const wholesaler = selectedWholesaler;
    if (!wholesaler || eligibleReceiptItems.length === 0) return;

    const requestItems = eligibleReceiptItems.map((item) => ({
      pc: item.qr.pc,
      sn: item.qr.sn,
      lot: item.qr.lot,
      exp: item.qr.exp,
    }));

    try {
      await apiFetch("/receipts", {
        method: "POST",
        body: JSON.stringify({
          wholesalerId: Number.isNaN(Number(wholesaler.id))
            ? wholesaler.id
            : Number(wholesaler.id),
          wholesalerName: wholesaler.name,
          items: requestItems,
        }),
      });
      setApiState("connected");
      setApiMessage("입고 반영 완료");
      void refreshFromBackend();
    } catch (error) {
      setApiFallback(error);
      commitReceiptDemo(eligibleReceiptItems, wholesaler);
    }

    setReceiptSummary({
      wholesalerName: wholesaler.name,
      count: eligibleReceiptItems.length,
      increase: receiptIncrease,
      missing: receiptQueue.length - eligibleReceiptItems.length,
    });
    setReceiptQueue([]);
    setScreen("receiptDone");
  }

  function commitReceiptDemo(
    items: ReceiptQueueItem[],
    wholesaler: Wholesaler,
  ) {
    setTraces((current) => [
      ...items.map((item) => ({
        id: createId("R"),
        pc: item.qr.pc,
        sn: item.qr.sn,
        lot: item.qr.lot,
        exp: item.qr.exp,
        drugName: item.drug.name,
        insuranceCode: item.drug.insuranceCode,
        productTotalQuantity: item.drug.productTotalQuantity,
        returnedQuantity: 0,
        wholesalerId: wholesaler.id,
        wholesalerName: wholesaler.name,
      })),
      ...current,
    ]);
    setStocks((current) => applyReceiptStocks(current, items));
  }

  async function commitReturn() {
    if (
      returnLookup?.matchType !== "CONFIRMED" &&
      returnLookup?.matchType !== "ESTIMATED"
    ) {
      return;
    }

    const quantity = Math.max(1, Math.min(returnQuantity, returnMax));
    if (quantity <= 0) return;

    try {
      await apiFetch("/returns", {
        method: "POST",
        body: JSON.stringify({
          pc: returnLookup.pc,
          sn: returnLookup.sn,
          lot: returnLookup.lot,
          exp: returnLookup.exp,
          matchType: returnLookup.matchType,
          purchaseHistoryId:
            returnLookup.matchType === "ESTIMATED"
              ? selectedCandidate?.id
              : undefined,
          returnQuantity: quantity,
          memo: returnMemo,
        }),
      });
      setApiState("connected");
      setApiMessage("반품 반영 완료");
      void refreshFromBackend();
    } catch (error) {
      setApiFallback(error);
      commitReturnDemo(returnLookup, quantity);
    }

    setReturnSummary({
      drugName: returnDrugName,
      wholesalerName: returnWholesalerName,
      quantity,
      stockAfter: Math.max(0, returnStockBefore - quantity),
    });
    setScreen("returnDone");
  }

  function commitReturnDemo(
    lookup: Exclude<ReturnLookup, { matchType: "NONE" }>,
    quantity: number,
  ) {
    setStocks((current) =>
      current.map((stock) =>
        stock.pc === lookup.pc
          ? { ...stock, quantity: Math.max(0, stock.quantity - quantity) }
          : stock,
      ),
    );
    if (lookup.matchType === "CONFIRMED") {
      setTraces((current) =>
        current.map((trace) =>
          trace.pc === lookup.pc && trace.sn === lookup.sn
            ? { ...trace, returnedQuantity: trace.returnedQuantity + quantity }
            : trace,
        ),
      );
    }
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setApiState("checking");
      setApiMessage("로그인 중");
      await login(loginId, password);
      const connected = await refreshFromBackend();
      if (connected) {
        setApiState("connected");
        setApiMessage("로그인 완료");
      }
      setPassword("");
      setScreen("wholesaler");
    } catch (error) {
      setApiState("unauthorized");
      setApiMessage(
        error instanceof Error ? error.message : "로그인에 실패했습니다.",
      );
    }
  }

  return (
    <main className={`phone ${screenClass(screen, mode)}`}>
      {screen === "wholesaler" && (
        <WholesalerScreen
          pendingId={pendingWholesalerId}
          wholesalers={wholesalers}
          onBack={selectedWholesaler ? () => setScreen("scan") : undefined}
          onChoose={setPendingWholesalerId}
          onReturnFirst={startReturnFirst}
          onStart={() => {
            setSelectedWholesalerId(pendingWholesaler.id);
            setLastScanName("스캔 준비 완료");
            setScanNotice(`${pendingWholesaler.name} 입고 스캔을 시작합니다.`);
            setScreen("scan");
          }}
        />
      )}

      {screen === "scan" && (
        <ScanScreen
          apiMessage={apiMessage}
          apiState={apiState}
          cameraActive={cameraActive}
          cameraError={cameraError}
          mode={mode}
          queueCount={receiptQueue.length}
          scanNotice={scanNotice}
          lastScanName={lastScanName}
          selectedWholesaler={selectedWholesaler}
          videoRef={videoRef}
          onAccount={() => setScreen("account")}
          onMode={chooseMode}
          onReview={() => {
            if (mode === "receipt") {
              if (startReceipt()) setScreen("receiptReview");
            } else {
              useSample();
            }
          }}
          onSample={useSample}
          onToggleCamera={toggleCamera}
          onWholesaler={openWholesalerPicker}
        />
      )}

      {screen === "receiptReview" && (
        <ReceiptReviewScreen
          increase={receiptIncrease}
          queue={receiptQueue}
          selectedWholesaler={selectedWholesaler}
          onBack={() => setScreen("scan")}
          onNext={() => setScreen("receiptMatch")}
        />
      )}

      {screen === "receiptMatch" && (
        <ReceiptMatchScreen
          eligibleCount={eligibleReceiptItems.length}
          queue={receiptQueue}
          onBack={() => setScreen("receiptReview")}
          onCommit={commitReceipt}
        />
      )}

      {screen === "receiptDone" && receiptSummary && (
        <DoneScreen
          kind="receipt"
          receiptSummary={receiptSummary}
          onPrimary={() => {
            setReceiptSummary(null);
            setScreen("scan");
          }}
          onSecondary={() => setScreen("stocks")}
        />
      )}

      {screen === "returnConfirmed" &&
        returnLookup?.matchType === "CONFIRMED" && (
          <ReturnConfirmedScreen
            lookup={returnLookup}
            onNext={() => {
              setReturnQuantity(
                Math.max(1, Math.min(returnQuantity, returnMax)),
              );
              setScreen("returnQty");
            }}
          />
        )}

      {screen === "returnEstimated" &&
        returnLookup?.matchType === "ESTIMATED" && (
          <ReturnEstimatedScreen
            lookup={returnLookup}
            selectedCandidateId={selectedCandidateId}
            onChoose={setSelectedCandidateId}
            onNext={() => setScreen("returnQty")}
          />
        )}

      {screen === "returnNone" && (
        <ReturnNoneScreen onClose={() => setScreen("scan")} />
      )}

      {screen === "returnQty" &&
        (returnLookup?.matchType === "CONFIRMED" ||
          returnLookup?.matchType === "ESTIMATED") && (
          <ReturnQtyScreen
            memo={returnMemo}
            quantity={returnQuantity}
            stockBefore={returnStockBefore}
            max={returnMax}
            drugName={returnDrugName}
            wholesalerName={returnWholesalerName}
            matchType={returnLookup.matchType}
            onBack={() =>
              setScreen(
                returnLookup.matchType === "CONFIRMED"
                  ? "returnConfirmed"
                  : "returnEstimated",
              )
            }
            onCommit={commitReturn}
            onMemo={setReturnMemo}
            onQuantity={(next) =>
              setReturnQuantity(Math.max(1, Math.min(returnMax || 1, next)))
            }
          />
        )}

      {screen === "returnDone" && returnSummary && (
        <DoneScreen
          kind="return"
          returnSummary={returnSummary}
          onPrimary={() => {
            setReturnLookup(null);
            setScreen("scan");
          }}
          onSecondary={() => {
            setMode("receipt");
            setScreen("scan");
          }}
        />
      )}

      {screen === "stocks" && (
        <StocksScreen stocks={stocks} onBack={() => setScreen("scan")} />
      )}

      {screen === "account" && (
        <AccountScreen
          apiBase={apiBase}
          apiMessage={apiMessage}
          apiState={apiState}
          loginId={loginId}
          password={password}
          onBack={
            hasStoredAuthTokens() ? () => setScreen("wholesaler") : undefined
          }
          onLoginId={setLoginId}
          onPassword={setPassword}
          onSubmit={submitLogin}
        />
      )}
    </main>
  );
}

function lookupReturnDemo(
  qr: QrFields,
  traces: ReceiptTrace[],
  stocks: StockItem[],
): ReturnLookup {
  const trace = traces.find((item) => item.pc === qr.pc && item.sn === qr.sn);

  if (trace) {
    const stock = stocks.find(
      (item) => item.insuranceCode === trace.insuranceCode,
    );
    return {
      matchType: "CONFIRMED",
      pc: qr.pc,
      sn: qr.sn,
      lot: qr.lot,
      exp: qr.exp,
      drugName: trace.drugName,
      wholesalerName: trace.wholesalerName,
      productTotalQuantity: trace.productTotalQuantity,
      returnedQuantity: trace.returnedQuantity,
      returnableQuantity: Math.max(
        0,
        trace.productTotalQuantity - trace.returnedQuantity,
      ),
      stockQuantity: stock?.quantity ?? 0,
    };
  }

  if (qr.pc === "8800000000000") {
    const stock = stocks.find((item) => item.pc === qr.pc);
    return {
      matchType: "ESTIMATED",
      pc: qr.pc,
      sn: qr.sn,
      lot: qr.lot,
      exp: qr.exp,
      drugName: "예시약 30T",
      sellerCandidates: demoPurchaseHistories,
      returnableQuantity: stock?.quantity ?? 0,
      stockQuantity: stock?.quantity ?? 0,
    };
  }

  return {
    matchType: "NONE",
    pc: qr.pc,
    sn: qr.sn,
    lot: qr.lot,
    exp: qr.exp,
    drugName: "미확인 약품",
    message: "입고·구매 내역에 근거가 없어 반품 대상으로 등록할 수 없습니다.",
  };
}

function applyReceiptStocks(current: StockItem[], items: ReceiptQueueItem[]) {
  const next = [...current];
  for (const item of items) {
    const stock = next.find(
      (candidate) => candidate.insuranceCode === item.drug.insuranceCode,
    );
    if (stock) {
      stock.quantity += item.drug.productTotalQuantity;
    } else {
      next.push({
        id: createId("S"),
        pc: item.qr.pc,
        insuranceCode: item.drug.insuranceCode,
        name: item.drug.name,
        quantity: item.drug.productTotalQuantity,
        price: item.drug.price,
        matchStatus: item.drug.matchStatus,
      });
    }
  }
  return next;
}

function screenClass(screen: Screen, mode: Mode) {
  if (
    screen === "scan" ||
    screen === "returnConfirmed" ||
    screen === "returnEstimated" ||
    screen === "returnNone"
  ) {
    return `is-dark is-${mode}`;
  }
  return "is-light";
}

function ScanScreen({
  apiMessage,
  apiState,
  cameraActive,
  cameraError,
  lastScanName,
  mode,
  queueCount,
  scanNotice,
  selectedWholesaler,
  videoRef,
  onAccount,
  onMode,
  onReview,
  onSample,
  onToggleCamera,
  onWholesaler,
}: {
  apiMessage: string;
  apiState: ApiState;
  cameraActive: boolean;
  cameraError: string;
  lastScanName: string;
  mode: Mode;
  queueCount: number;
  scanNotice: string;
  selectedWholesaler: Wholesaler | null;
  videoRef: RefObject<HTMLVideoElement>;
  onAccount: () => void;
  onMode: (mode: Mode) => void;
  onReview: () => void;
  onSample: () => void;
  onToggleCamera: () => void;
  onWholesaler: () => void;
}) {
  const isReceipt = mode === "receipt";
  const accent = isReceipt ? "#4D9AFF" : "#FFB44D";

  return (
    <>
      <div className="scan-top">
        {isReceipt ? (
          <button
            className={`glass-pill ${selectedWholesaler ? "blue" : "amber"}`}
            type="button"
            onClick={onWholesaler}
          >
            <span className="dot" />
            {selectedWholesaler?.name ?? "도매처 선택 필요"}
          </button>
        ) : (
          <strong className="dark-title">반품</strong>
        )}
        {isReceipt && queueCount > 0 ? (
          <button className="count-chip" type="button" onClick={onReview}>
            <b>{queueCount}</b>
            <span>장</span>
          </button>
        ) : (
          <button className="circle-help" type="button" onClick={onAccount}>
            ?
          </button>
        )}
      </div>

      <section className="scanner-zone">
        <video
          ref={videoRef}
          className={`camera-video ${cameraActive ? "is-active" : ""}`}
          muted
          playsInline
        />
        <button
          className={`scan-box ${cameraActive ? "is-active" : ""}`}
          style={{ "--accent": accent } as CSSProperties}
          type="button"
          onClick={cameraActive ? undefined : onToggleCamera}
        >
          <span className="corner tl" />
          <span className="corner tr" />
          <span className="corner bl" />
          <span className="corner br" />
          <span className="scan-line" />
        </button>
        <div className="scan-copy">
          <strong>
            {isReceipt
              ? "QR 코드를 사각형 안에 맞춰주세요"
              : "반품할 약품의 QR을 스캔하세요"}
          </strong>
          <span>
            {isReceipt
              ? "코드가 인식되면 자동으로 스캔됩니다"
              : "입고 이력 또는 구매 내역에서 판매처를 찾아드려요"}
          </span>
        </div>
        <div className={`scan-result ${cameraActive ? "is-live" : ""}`}>
          <span>{cameraActive ? "스캔 대기 중" : "최근 상태"}</span>
          <strong>{lastScanName}</strong>
          <em>{scanNotice}</em>
        </div>
      </section>

      {isReceipt && !selectedWholesaler && (
        <button className="scan-alert" type="button" onClick={onWholesaler}>
          <strong>먼저 도매처를 선택하세요</strong>
          <span>입고할 약품의 도매처를 선택해야 스캔할 수 있어요.</span>
        </button>
      )}

      {(cameraError || apiMessage) && (
        <button className="runtime-toast" type="button" onClick={onAccount}>
          {cameraError || `${apiStateLabel(apiState)} · ${apiMessage}`}
        </button>
      )}

      <div className="scan-actions">
        <button type="button" onClick={onToggleCamera}>
          {cameraActive ? "카메라 중지" : "카메라"}
        </button>
        <button type="button" onClick={onSample}>
          샘플
        </button>
      </div>

      <div className="modebar">
        <div className="segment">
          <button
            className={isReceipt ? "is-active" : ""}
            type="button"
            onClick={() => onMode("receipt")}
          >
            입고
          </button>
          <button
            className={!isReceipt ? "is-active" : ""}
            type="button"
            onClick={() => onMode("return")}
          >
            반품
          </button>
        </div>
      </div>
    </>
  );
}

function apiStateLabel(state: ApiState) {
  switch (state) {
    case "connected":
      return "온라인";
    case "unauthorized":
      return "인증";
    case "forbidden":
      return "권한";
    case "checking":
      return "확인";
    default:
      return "데모";
  }
}

function WholesalerScreen({
  pendingId,
  wholesalers,
  onBack,
  onChoose,
  onReturnFirst,
  onStart,
}: {
  pendingId: string;
  wholesalers: Wholesaler[];
  onBack?: () => void;
  onChoose: (id: string) => void;
  onReturnFirst: () => void;
  onStart: () => void;
}) {
  return (
    <>
      <Header title="도매처 선택" onBack={onBack} />
      <div className="search-field">
        <span className="search-icon" />
        <span>도매처 이름 검색</span>
      </div>
      <section className="scroll-body">
        <div className="section-label">공통 도매처</div>
        {wholesalers.slice(0, 3).map((wholesaler) => (
          <ChoiceRow
            key={wholesaler.id}
            active={pendingId === wholesaler.id}
            title={wholesaler.name}
            detail={wholesaler.meta}
            onClick={() => onChoose(wholesaler.id)}
          />
        ))}
        <div className="section-label">약국 등록 도매처</div>
        {wholesalers.slice(3).map((wholesaler) => (
          <ChoiceRow
            key={wholesaler.id}
            active={pendingId === wholesaler.id}
            title={wholesaler.name}
            detail={wholesaler.meta}
            onClick={() => onChoose(wholesaler.id)}
          />
        ))}
      </section>
      <BottomBar stack>
        <button className="primary-btn" type="button" onClick={onStart}>
          이 도매처로 입고 시작
        </button>
        <button className="secondary-btn" type="button" onClick={onReturnFirst}>
          반품 먼저 하기
        </button>
      </BottomBar>
    </>
  );
}

function ReceiptReviewScreen({
  increase,
  queue,
  selectedWholesaler,
  onBack,
  onNext,
}: {
  increase: number;
  queue: ReceiptQueueItem[];
  selectedWholesaler: Wholesaler | null;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <Header
        title="입고 확인"
        note={selectedWholesaler?.name ?? ""}
        onBack={onBack}
      />
      <section className="scroll-body">
        <div className="metrics">
          <Metric label="스캔 건수" value={`${queue.length}`} unit="건" />
          <Metric
            label="예상 재고 증가"
            value={`+${increase}`}
            unit="개"
            blue
          />
        </div>
        <div className="list-card">
          {queue.slice(0, 4).map((item) => (
            <DrugRow
              key={item.id}
              item={item}
              delta={item.drug.productTotalQuantity}
            />
          ))}
        </div>
        {queue.length > 4 && (
          <div className="more">+ {queue.length - 4}건 더 보기</div>
        )}
      </section>
      <BottomBar>
        <button className="primary-btn" type="button" onClick={onNext}>
          매칭 결과 확인
        </button>
      </BottomBar>
    </>
  );
}

function ReceiptMatchScreen({
  eligibleCount,
  queue,
  onBack,
  onCommit,
}: {
  eligibleCount: number;
  queue: ReceiptQueueItem[];
  onBack: () => void;
  onCommit: () => void;
}) {
  const normal = queue.filter((item) => item.drug.matchStatus === "NORMAL");
  const name = queue.filter((item) => item.drug.matchStatus === "NAME_MATCH");
  const virtual = queue.filter((item) => item.drug.matchStatus === "VIRTUAL");
  const missing = queue.filter((item) => item.drug.matchStatus === "MISSING");

  return (
    <>
      <Header title="매칭 결과" onBack={onBack} />
      <section className="scroll-body">
        <p className="guide-copy">
          기준 데이터 연결 상태입니다. 가상생성·미등록 항목은 CMS에서 보정할 수
          있어요.
        </p>
        <MatchBox title="정상매칭" count={normal.length} color="#0064FF" />
        <MatchBox title="이름매칭" count={name.length} color="#6B4EE6" />
        <MatchBox
          title="가상생성"
          count={virtual.length}
          color="#B07514"
          item={virtual[0]}
        />
        <MatchBox
          title="미등록"
          count={missing.length}
          color="#C13B2C"
          item={missing[0]}
          danger
        />
      </section>
      <BottomBar>
        <button
          className="primary-btn"
          type="button"
          disabled={eligibleCount === 0}
          onClick={onCommit}
        >
          {eligibleCount}건 입고 확정
        </button>
      </BottomBar>
    </>
  );
}

function ReturnConfirmedScreen({
  lookup,
  onNext,
}: {
  lookup: Extract<ReturnLookup, { matchType: "CONFIRMED" }>;
  onNext: () => void;
}) {
  return (
    <ReturnSheet height="confirmed">
      <span className="state-badge confirmed">
        <span />
        확정 · 입고 이력 있음
      </span>
      <h1>{lookup.drugName}</h1>
      <p className="code-line">
        PC {lookup.pc.slice(0, 4)}... · {lookup.sn} · {lookup.lot} · EXP{" "}
        {lookup.exp.slice(0, 7)}
      </p>
      <div className="info-card">
        <div className="kv">
          <span>도매처 (확정)</span>
          <strong>{lookup.wholesalerName}</strong>
        </div>
        <div className="triple">
          <MiniMetric label="제품총수량" value={lookup.productTotalQuantity} />
          <MiniMetric label="반품 누적" value={lookup.returnedQuantity} />
          <MiniMetric
            label="반품 가능"
            value={lookup.returnableQuantity}
            blue
          />
        </div>
      </div>
      <button className="primary-btn push" type="button" onClick={onNext}>
        반품 수량 입력
      </button>
    </ReturnSheet>
  );
}

function ReturnEstimatedScreen({
  lookup,
  selectedCandidateId,
  onChoose,
  onNext,
}: {
  lookup: Extract<ReturnLookup, { matchType: "ESTIMATED" }>;
  selectedCandidateId: string;
  onChoose: (id: string) => void;
  onNext: () => void;
}) {
  return (
    <ReturnSheet height="estimated">
      <span className="state-badge estimated">
        <span />
        추정 · 입고 이력 없음
      </span>
      <h1>{lookup.drugName}</h1>
      <p className="guide-copy">
        입고 이력은 없지만, 구매 내역 기준으로 아래 판매처가 추정됩니다. 하나를
        선택해 주세요.
      </p>
      <div className="section-label">
        판매처 후보 {lookup.sellerCandidates.length}
      </div>
      <div className="candidate-list">
        {lookup.sellerCandidates.map((candidate) => (
          <ChoiceRow
            key={candidate.id}
            active={selectedCandidateId === candidate.id}
            title={candidate.sellerName}
            detail={`${candidate.transactionDate} · ${candidate.orderItemName} · ${candidate.quantity}개`}
            onClick={() => onChoose(candidate.id)}
          />
        ))}
      </div>
      <button className="primary-btn" type="button" onClick={onNext}>
        선택한 판매처로 진행
      </button>
    </ReturnSheet>
  );
}

function ReturnNoneScreen({ onClose }: { onClose: () => void }) {
  return (
    <ReturnSheet height="none">
      <div className="none-body">
        <div className="none-icon" />
        <h1>판매처 후보를 찾지 못했습니다</h1>
        <p>
          입고·구매 내역에 근거가 없어 반품 대상으로 등록할 수 없습니다. 구매
          내역을 먼저 동기화하거나 코드를 다시 확인해 주세요.
        </p>
      </div>
      <div className="stack">
        <button className="primary-btn" type="button" onClick={onClose}>
          다시 스캔
        </button>
        <button className="secondary-btn" type="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </ReturnSheet>
  );
}

function ReturnQtyScreen({
  drugName,
  matchType,
  max,
  memo,
  quantity,
  stockBefore,
  wholesalerName,
  onBack,
  onCommit,
  onMemo,
  onQuantity,
}: {
  drugName: string;
  matchType: "CONFIRMED" | "ESTIMATED";
  max: number;
  memo: string;
  quantity: number;
  stockBefore: number;
  wholesalerName: string;
  onBack: () => void;
  onCommit: () => void;
  onMemo: (value: string) => void;
  onQuantity: (value: number) => void;
}) {
  return (
    <>
      <Header title="반품 수량" onBack={onBack} />
      <section className="scroll-body">
        <div className="drug-card">
          <strong>{drugName}</strong>
          <div>
            <span className="badge normal">
              {matchType === "CONFIRMED" ? "확정" : "추정"}
            </span>
            <span>{wholesalerName}</span>
          </div>
        </div>
        <div className="qty-card">
          <span>
            반품 수량 <b>(최대 {max})</b>
          </span>
          <div className="qty-row">
            <button type="button" onClick={() => onQuantity(quantity - 1)}>
              -
            </button>
            <strong>{quantity}</strong>
            <button type="button" onClick={() => onQuantity(quantity + 1)}>
              +
            </button>
          </div>
        </div>
        <label className="memo-field">
          <span>메모 (선택)</span>
          <input
            value={memo}
            onChange={(event) => onMemo(event.target.value)}
          />
        </label>
      </section>
      <BottomBar>
        <div className="after-row">
          <span>반품 후 재고</span>
          <strong>
            {stockBefore} → {Math.max(0, stockBefore - quantity)}개
          </strong>
        </div>
        <button
          className="primary-btn"
          type="button"
          disabled={max <= 0}
          onClick={onCommit}
        >
          {quantity}개 반품하기
        </button>
      </BottomBar>
    </>
  );
}

function DoneScreen({
  kind,
  receiptSummary,
  returnSummary,
  onPrimary,
  onSecondary,
}: {
  kind: "receipt" | "return";
  receiptSummary?: ReceiptSummary;
  returnSummary?: ReturnSummary;
  onPrimary: () => void;
  onSecondary: () => void;
}) {
  const isReceipt = kind === "receipt";
  return (
    <>
      <section className="done-body">
        <div className="done-icon" />
        <h1>{isReceipt ? "입고 완료" : "반품 완료"}</h1>
        <p>
          {isReceipt
            ? `${receiptSummary?.count ?? 0}건이 재고에 반영되었습니다.`
            : `${returnSummary?.quantity ?? 0}개가 재고에서 차감되었습니다.`}
        </p>
        <div className="summary-card">
          {isReceipt ? (
            <>
              <SummaryLine
                label="도매처"
                value={receiptSummary?.wholesalerName}
              />
              <SummaryLine
                label="입고 품목"
                value={`${receiptSummary?.count ?? 0}종`}
              />
              <SummaryLine
                label="재고 증가"
                value={`+${receiptSummary?.increase ?? 0}개`}
                blue
              />
              <SummaryLine
                label="보정 필요"
                value={`미등록 ${receiptSummary?.missing ?? 0}건`}
                red
              />
            </>
          ) : (
            <>
              <SummaryLine label="약품" value={returnSummary?.drugName} />
              <SummaryLine
                label="도매처"
                value={returnSummary?.wholesalerName}
              />
              <SummaryLine
                label="반품 수량"
                value={`-${returnSummary?.quantity ?? 0}개`}
                red
              />
              <SummaryLine
                label="현재 재고"
                value={`${returnSummary?.stockAfter ?? 0}개`}
              />
            </>
          )}
        </div>
      </section>
      <BottomBar stack>
        <button className="primary-btn" type="button" onClick={onPrimary}>
          {isReceipt ? "계속 스캔하기" : "계속 반품하기"}
        </button>
        <button className="secondary-btn" type="button" onClick={onSecondary}>
          {isReceipt ? "재고 목록 보기" : "홈으로"}
        </button>
      </BottomBar>
    </>
  );
}

function StocksScreen({
  stocks,
  onBack,
}: {
  stocks: StockItem[];
  onBack: () => void;
}) {
  return (
    <>
      <Header title="재고 목록" onBack={onBack} />
      <section className="scroll-body">
        <div className="list-card">
          {stocks.map((stock) => (
            <div className="stock-row" key={stock.id}>
              <div>
                <strong>{stock.name}</strong>
                <span>
                  {stock.insuranceCode} · 예상{" "}
                  {currency(stock.quantity * stock.price)}원
                </span>
              </div>
              <span className={`badge ${statusClass(stock.matchStatus)}`}>
                {statusText(stock.matchStatus)}
              </span>
              <b>{stock.quantity}개</b>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function AccountScreen({
  apiBase,
  apiMessage,
  apiState,
  loginId,
  password,
  onBack,
  onLoginId,
  onPassword,
  onSubmit,
}: {
  apiBase: string;
  apiMessage: string;
  apiState: ApiState;
  loginId: string;
  password: string;
  onBack?: () => void;
  onLoginId: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      <Header title="계정" onBack={onBack} />
      <section className="scroll-body account-body">
        <div className="account-card">
          <span>API</span>
          <strong>{apiBase}</strong>
          <em>
            {apiStateLabel(apiState)} · {apiMessage || "대기"}
          </em>
        </div>
        <form className="login-form" onSubmit={onSubmit}>
          <label>
            <span>아이디</span>
            <input
              value={loginId}
              onChange={(event) => onLoginId(event.target.value)}
            />
          </label>
          <label>
            <span>비밀번호</span>
            <input
              type="password"
              value={password}
              onChange={(event) => onPassword(event.target.value)}
            />
          </label>
          <button className="primary-btn" type="submit">
            로그인
          </button>
        </form>
      </section>
    </>
  );
}

function Header({
  note,
  title,
  onBack,
}: {
  note?: string;
  title: string;
  onBack?: () => void;
}) {
  return (
    <header className="page-header">
      {onBack ? (
        <button className="back-btn" type="button" onClick={onBack} />
      ) : (
        <span className="back-spacer" />
      )}
      <strong>{title}</strong>
      {note && <span>{note}</span>}
    </header>
  );
}

function BottomBar({
  children,
  stack,
}: {
  children: ReactNode;
  stack?: boolean;
}) {
  return (
    <footer className={`bottom-bar ${stack ? "stack" : ""}`}>{children}</footer>
  );
}

function ChoiceRow({
  active,
  detail,
  title,
  onClick,
}: {
  active: boolean;
  detail: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`choice-row ${active ? "is-active" : ""}`}
      type="button"
      onClick={onClick}
    >
      <span className="radio" />
      <span>
        <strong>{title}</strong>
        <em>{detail}</em>
      </span>
    </button>
  );
}

function Metric({
  blue,
  label,
  unit,
  value,
}: {
  blue?: boolean;
  label: string;
  unit: string;
  value: string;
}) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong className={blue ? "blue" : ""}>
        {value}
        <em>{unit}</em>
      </strong>
    </div>
  );
}

function DrugRow({ delta, item }: { delta: number; item: ReceiptQueueItem }) {
  return (
    <div className="drug-row">
      <div>
        <strong>{item.drug.name}</strong>
        <span>
          PC {item.qr.pc.slice(0, 4)}... · {item.qr.sn}
        </span>
      </div>
      <b>{delta > 0 ? `+${delta}` : "-"}</b>
      <span className={`badge ${statusClass(item.drug.matchStatus)}`}>
        {statusText(item.drug.matchStatus)}
      </span>
    </div>
  );
}

function MatchBox({
  color,
  count,
  danger,
  item,
  title,
}: {
  color: string;
  count: number;
  danger?: boolean;
  item?: ReceiptQueueItem;
  title: string;
}) {
  return (
    <div className={`match-box ${danger ? "danger" : ""}`}>
      <div>
        <span>
          <i style={{ backgroundColor: color }} />
          {title}
        </span>
        <strong style={{ color }}>{count}건</strong>
      </div>
      {item && (
        <div className={`match-detail ${danger ? "danger" : ""}`}>
          <span>
            <b>{item.drug.name}</b>
            <em>
              {item.drug.matchStatus === "MISSING"
                ? "기준 데이터 없음"
                : `${item.drug.insuranceCode} · 가격 ${currency(item.drug.price)}원`}
            </em>
          </span>
          <button type="button">{danger ? "재시도" : "수정"}</button>
        </div>
      )}
    </div>
  );
}

function ReturnSheet({
  children,
  height,
}: {
  children: ReactNode;
  height: "confirmed" | "estimated" | "none";
}) {
  return (
    <>
      <div className="return-backdrop">
        <div
          className="mini-scan"
          style={{ "--accent": "#4D9AFF" } as CSSProperties}
        >
          <span className="corner tl" />
          <span className="corner tr" />
          <span className="corner bl" />
          <span className="corner br" />
        </div>
      </div>
      <section className={`return-sheet ${height}`}>
        <div className="sheet-handle" />
        {children}
      </section>
    </>
  );
}

function MiniMetric({
  blue,
  label,
  value,
}: {
  blue?: boolean;
  label: string;
  value: number;
}) {
  return (
    <div className={`mini-metric ${blue ? "blue" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SummaryLine({
  blue,
  label,
  red,
  value,
}: {
  blue?: boolean;
  label: string;
  red?: boolean;
  value?: string;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={blue ? "blue" : red ? "red" : ""}>
        {value ?? "-"}
      </strong>
    </div>
  );
}

type CmsPage =
  | "dashboard"
  | "master"
  | "import"
  | "inventory"
  | "dispense"
  | "purchase";

type CmsMaster = {
  id: string;
  standardCode: string;
  insuranceCode: string;
  name: string;
  spec: string;
  productTotalQuantity: number;
  price: number;
  status: MatchStatus;
};

type CmsImportJob = {
  id: string;
  dataType: "1번" | "2번";
  fileName: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  progress: number;
  processedRows: number;
  totalRows: number;
  newCount: number;
  updatedCount: number;
  inactiveCount: number;
  duplicateCount: number;
  failedCount: number;
  message: string;
};

type CmsPurchaseHistory = {
  id: string;
  sellerName: string;
  transactionDate: string;
  orderItemName: string;
  productName: string;
  quantity: number;
  source: string;
};

type CmsSyncJob = {
  id: string;
  status: "RUNNING" | "SUCCESS" | "AUTH_FAILED" | "PARTIAL_AUTH_FAILED";
  startDate: string;
  endDate: string;
  lastSuccessPage: number;
  totalPages: number;
  message: string;
};

type CmsDeductionFailure = {
  id: string;
  prescriptionCode: string;
  lineNo: number;
  drugName: string;
  totalQuantity: number;
  status: "FAILED" | "RESOLVED";
  reason: string;
};

const demoCmsMasters: CmsMaster[] = [
  {
    id: "M-001",
    standardCode: "8806400017004",
    insuranceCode: "640001700",
    name: "타이레놀정 500mg",
    spec: "500mg",
    productTotalQuantity: 30,
    price: 86,
    status: "NORMAL",
  },
  {
    id: "M-002",
    standardCode: "8806526045210",
    insuranceCode: "652604520",
    name: "아목시실린캡슐 250mg",
    spec: "250mg",
    productTotalQuantity: 100,
    price: 53,
    status: "NAME_MATCH",
  },
  {
    id: "M-003",
    standardCode: "8899000000201",
    insuranceCode: "3PF000124",
    name: "비급여 연고 20g",
    spec: "20g",
    productTotalQuantity: 30,
    price: 0,
    status: "VIRTUAL",
  },
  {
    id: "M-004",
    standardCode: "0000000000000",
    insuranceCode: "",
    name: "미확인 약품",
    spec: "-",
    productTotalQuantity: 0,
    price: 0,
    status: "MISSING",
  },
  {
    id: "M-005",
    standardCode: "8807000118005",
    insuranceCode: "670001180",
    name: "세토펜건조시럽",
    spec: "10mL",
    productTotalQuantity: 50,
    price: 120,
    status: "NORMAL",
  },
];

const demoImportJobs: CmsImportJob[] = [
  {
    id: "J-301",
    dataType: "1번",
    fileName: "1번기준데이터.csv",
    status: "RUNNING",
    progress: 64,
    processedRows: 192400,
    totalRows: 300000,
    newCount: 0,
    updatedCount: 0,
    inactiveCount: 0,
    duplicateCount: 0,
    failedCount: 0,
    message: "staging 적재 중",
  },
  {
    id: "J-300",
    dataType: "2번",
    fileName: "2번 기준 데이터.csv",
    status: "SUCCESS",
    progress: 100,
    processedRows: 248000,
    totalRows: 248000,
    newCount: 1204,
    updatedCount: 88,
    inactiveCount: 6,
    duplicateCount: 12,
    failedCount: 0,
    message: "master 반영 완료",
  },
  {
    id: "J-299",
    dataType: "1번",
    fileName: "drug_master_0612.csv",
    status: "FAILED",
    progress: 38,
    processedRows: 5002,
    totalRows: 13000,
    newCount: 0,
    updatedCount: 0,
    inactiveCount: 0,
    duplicateCount: 4,
    failedCount: 14,
    message: "표준코드 누락 · master 미반영",
  },
];

const demoPurchaseSyncJobs: CmsSyncJob[] = [
  {
    id: "P-118",
    status: "PARTIAL_AUTH_FAILED",
    startDate: "2022-07-25",
    endDate: "2025-07-25",
    lastSuccessPage: 8,
    totalPages: 14,
    message: "cookie 인증 만료 · 재등록 후 재개 필요",
  },
  {
    id: "P-117",
    status: "SUCCESS",
    startDate: "2026-01-01",
    endDate: "2026-06-18",
    lastSuccessPage: 6,
    totalPages: 6,
    message: "신규/수정 반영 완료",
  },
];

const demoCmsPurchaseHistories: CmsPurchaseHistory[] = [
  {
    id: "PH-100",
    sellerName: "한미약품 A도매",
    transactionDate: "2026-01-10 12:56",
    orderItemName: "타이레놀정 500mg 30T",
    productName: "타이레놀정",
    quantity: 30,
    source: "BAROPHARM",
  },
  {
    id: "PH-101",
    sellerName: "지오영 도매",
    transactionDate: "2025-11-22 09:12",
    orderItemName: "예시약 30정",
    productName: "예시약",
    quantity: 60,
    source: "BAROPHARM",
  },
];

const demoDeductionFailures: CmsDeductionFailure[] = [
  {
    id: "D-501",
    prescriptionCode: "RX-20260618-001",
    lineNo: 3,
    drugName: "세토펜건조시럽",
    totalQuantity: 3,
    status: "FAILED",
    reason: "보험코드 기준 재고 미조회",
  },
  {
    id: "D-502",
    prescriptionCode: "RX-20260618-006",
    lineNo: 1,
    drugName: "미등록 감기약",
    totalQuantity: 2,
    status: "FAILED",
    reason: "기준 데이터 미등록",
  },
];

function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    window.history.pushState(null, "", nextPath);
    setPath(nextPath);
  }, []);

  if (path.startsWith("/cms")) {
    return <CmsApp path={path} navigate={navigate} />;
  }

  return <MobileApp />;
}

function getCmsPage(path: string): CmsPage {
  const segment = path.split("/").filter(Boolean)[1];
  if (
    segment === "master" ||
    segment === "import" ||
    segment === "inventory" ||
    segment === "dispense" ||
    segment === "purchase"
  ) {
    return segment;
  }
  return "dashboard";
}

function CmsApp({
  navigate,
  path,
}: {
  navigate: (path: string) => void;
  path: string;
}) {
  const page = getCmsPage(path);
  const [apiState, setApiState] = useState<ApiState>("checking");
  const [apiMessage, setApiMessage] = useState("CMS 데이터 확인 중");
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [masters, setMasters] = useState(demoCmsMasters);
  const [stocks, setStocks] = useState(initialStocks);
  const [importJobs, setImportJobs] = useState(demoImportJobs);
  const [purchaseHistories, setPurchaseHistories] = useState(
    demoCmsPurchaseHistories,
  );
  const [syncJobs, setSyncJobs] = useState(demoPurchaseSyncJobs);
  const [deductionFailures, setDeductionFailures] = useState(
    demoDeductionFailures,
  );
  const [selectedMasterId, setSelectedMasterId] = useState(
    demoCmsMasters[2].id,
  );
  const [selectedStockId, setSelectedStockId] = useState(initialStocks[0].id);
  const [adjustQuantity, setAdjustQuantity] = useState(5);
  const [adjustDirection, setAdjustDirection] = useState<
    "INCREASE" | "DECREASE"
  >("INCREASE");
  const [adjustMemo, setAdjustMemo] = useState("실사 후 수량 보정");

  const selectedMaster =
    masters.find((master) => master.id === selectedMasterId) ?? masters[0];
  const selectedStock =
    stocks.find((stock) => stock.id === selectedStockId) ?? stocks[0];

  const cmsFallback = useCallback((error: unknown) => {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      clearAuthTokens();
      setApiState("unauthorized");
      setApiMessage("CMS 로그인이 필요합니다.");
      return;
    }
    if (error instanceof Error && error.message === "FORBIDDEN") {
      setApiState("forbidden");
      setApiMessage("현재 계정에 CMS 실행 권한이 없습니다.");
      return;
    }
    setApiState("demo");
    setApiMessage("CMS API 연결 실패 · 데모 데이터 표시");
  }, []);

  const refreshCms = useCallback(async () => {
    if (!hasStoredAuthTokens()) {
      setApiState("unauthorized");
      setApiMessage("CMS 로그인이 필요합니다.");
      return false;
    }

    setApiState("checking");
    try {
      const [
        masterResult,
        stockResult,
        purchaseResult,
        syncResult,
        failureResult,
      ] = await Promise.allSettled([
        apiFetch<unknown>("/drug-masters"),
        apiFetch<unknown>("/stocks"),
        apiFetch<unknown>("/purchase-histories"),
        apiFetch<unknown>("/purchase-histories/sync-jobs"),
        apiFetch<unknown>("/prescription-deductions/failed"),
      ]);

      if (masterResult.status === "fulfilled") {
        setMasters(arrayPayload(masterResult.value).map(normalizeCmsMaster));
      }
      if (stockResult.status === "fulfilled") {
        setStocks(arrayPayload(stockResult.value).map(normalizeStock));
      }
      if (purchaseResult.status === "fulfilled") {
        setPurchaseHistories(
          arrayPayload(purchaseResult.value).map(normalizeCmsPurchase),
        );
      }
      if (syncResult.status === "fulfilled") {
        setSyncJobs(arrayPayload(syncResult.value).map(normalizeCmsSyncJob));
      }
      if (failureResult.status === "fulfilled") {
        setDeductionFailures(
          arrayPayload(failureResult.value).map(normalizeCmsFailure),
        );
      }

      const rejected = [
        masterResult,
        stockResult,
        purchaseResult,
        syncResult,
        failureResult,
      ].find((result) => result.status === "rejected");

      if (rejected?.status === "rejected") {
        cmsFallback(rejected.reason);
        return false;
      } else {
        setApiState("connected");
        setApiMessage("CMS API 연결됨");
        return true;
      }
    } catch (error) {
      cmsFallback(error);
      return false;
    }
  }, [cmsFallback]);

  useEffect(() => {
    void refreshCms();
  }, [refreshCms]);

  async function submitCmsLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setApiState("checking");
      setApiMessage("CMS 로그인 중");
      await login(loginId, password);
      const connected = await refreshCms();
      if (connected) {
        setApiState("connected");
        setApiMessage("CMS 로그인 완료");
      }
      setPassword("");
    } catch (error) {
      setApiState("unauthorized");
      setApiMessage(
        error instanceof Error ? error.message : "CMS 로그인에 실패했습니다.",
      );
    }
  }

  function logoutCms() {
    clearAuthTokens();
    setApiState("unauthorized");
    setApiMessage("CMS 로그인이 필요합니다.");
  }

  async function uploadMasterCsv(kind: "drug" | "price", file: File | null) {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      await apiFetch(
        kind === "drug" ? "/drug-masters/import" : "/price-masters/import",
        {
          method: "POST",
          body: formData,
        },
      );
      setApiState("connected");
      setApiMessage(`${file.name} import job 생성 완료`);
      setImportJobs((current) => [
        {
          id: createId("J"),
          dataType: kind === "drug" ? "1번" : "2번",
          fileName: file.name,
          status: "PENDING",
          progress: 0,
          processedRows: 0,
          totalRows: 0,
          newCount: 0,
          updatedCount: 0,
          inactiveCount: 0,
          duplicateCount: 0,
          failedCount: 0,
          message: "서버 job 생성됨",
        },
        ...current,
      ]);
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function saveMaster(master: CmsMaster) {
    try {
      await apiFetch(`/drug-masters/${master.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          standardCode: master.standardCode,
          insuranceCode: master.insuranceCode,
          name: master.name,
          spec: master.spec,
          productTotalQuantity: master.productTotalQuantity,
        }),
      });
      setApiState("connected");
      setApiMessage("기준 데이터 수정 완료");
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function rematchMaster(master: CmsMaster) {
    try {
      await apiFetch(`/drug-masters/${master.id}/rematch`, { method: "POST" });
      setApiState("connected");
      setApiMessage("매칭 재시도 요청 완료");
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function adjustStock() {
    if (!selectedStock) return;
    const signedQuantity =
      adjustDirection === "INCREASE" ? adjustQuantity : -adjustQuantity;
    try {
      await apiFetch(`/stocks/${selectedStock.id}/adjustments`, {
        method: "POST",
        body: JSON.stringify({
          changeQuantity: signedQuantity,
          memo: adjustMemo,
        }),
      });
      setApiState("connected");
      setApiMessage("수동 재고 조정 완료");
    } catch (error) {
      cmsFallback(error);
      setStocks((current) =>
        current.map((stock) =>
          stock.id === selectedStock.id
            ? {
                ...stock,
                quantity: Math.max(0, stock.quantity + signedQuantity),
              }
            : stock,
        ),
      );
    }
  }

  async function startPurchaseSync() {
    try {
      await apiFetch("/purchase-histories/sync", {
        method: "POST",
        body: JSON.stringify({
          startDate: "2022-07-25",
          endDate: "2025-07-25",
        }),
      });
      setApiState("connected");
      setApiMessage("바로팜 구매내역 동기화 job 생성 완료");
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function resolveDeduction(
    failure: CmsDeductionFailure,
    resolutionType: "VIRTUAL_DRUG" | "EXISTING_STOCK" | "UNREGISTERED_DRUG",
  ) {
    try {
      await apiFetch(`/prescription-deductions/${failure.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          resolutionType,
          stockId:
            resolutionType === "EXISTING_STOCK" ? selectedStock?.id : undefined,
          memo: "CMS 수동 처리",
        }),
      });
      setApiState("connected");
      setApiMessage("처방전 차감 실패 항목 처리 완료");
      setDeductionFailures((current) =>
        current.map((item) =>
          item.id === failure.id ? { ...item, status: "RESOLVED" } : item,
        ),
      );
    } catch (error) {
      cmsFallback(error);
    }
  }

  return (
    <div className="cms-shell">
      <CmsSidebar page={page} navigate={navigate} />
      <main className="cms-main">
        <CmsHeader
          apiMessage={apiMessage}
          apiState={apiState}
          onLogout={hasStoredAuthTokens() ? logoutCms : undefined}
          page={page}
          onRefresh={refreshCms}
        />
        {apiState === "unauthorized" ? (
          <CmsLoginPage
            apiBase={apiBase}
            apiMessage={apiMessage}
            apiState={apiState}
            loginId={loginId}
            password={password}
            onLoginId={setLoginId}
            onPassword={setPassword}
            onSubmit={submitCmsLogin}
          />
        ) : (
          <>
            {page === "dashboard" && (
              <CmsDashboard
                importJobs={importJobs}
                stocks={stocks}
                masters={masters}
                syncJobs={syncJobs}
                navigate={navigate}
              />
            )}
            {page === "master" && (
              <CmsMasterPage
                masters={masters}
                selectedMaster={selectedMaster}
                onRematch={rematchMaster}
                onSave={saveMaster}
                onSelect={setSelectedMasterId}
                onUpload={uploadMasterCsv}
              />
            )}
            {page === "import" && (
              <CmsImportPage jobs={importJobs} onUpload={uploadMasterCsv} />
            )}
            {page === "inventory" && (
              <CmsInventoryPage
                adjustDirection={adjustDirection}
                adjustMemo={adjustMemo}
                adjustQuantity={adjustQuantity}
                selectedStock={selectedStock}
                stocks={stocks}
                onAdjust={adjustStock}
                onAdjustDirection={setAdjustDirection}
                onAdjustMemo={setAdjustMemo}
                onAdjustQuantity={(value) =>
                  setAdjustQuantity(Math.max(1, Math.min(999, value)))
                }
                onSelect={setSelectedStockId}
              />
            )}
            {page === "dispense" && (
              <CmsDispensePage
                failures={deductionFailures}
                stocks={stocks}
                onResolve={resolveDeduction}
              />
            )}
            {page === "purchase" && (
              <CmsPurchasePage
                histories={purchaseHistories}
                syncJobs={syncJobs}
                onSync={startPurchaseSync}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function arrayPayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const item = raw as Record<string, unknown>;
  if (Array.isArray(item.content)) return item.content;
  if (Array.isArray(item.items)) return item.items;
  if (Array.isArray(item.data)) return item.data;
  return [];
}

function normalizeCmsMaster(raw: unknown, index: number): CmsMaster {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? item.masterId ?? index),
    standardCode: String(
      item.standardCode ?? item.pc ?? item.standard_code ?? "",
    ),
    insuranceCode: String(
      item.insuranceCode ?? item.productCode ?? item.insurance_code ?? "",
    ),
    name: String(
      item.name ?? item.drugName ?? item.koreanName ?? "미확인 약품",
    ),
    spec: String(item.spec ?? item.drugSpec ?? item.standard ?? "-"),
    productTotalQuantity: Number(
      item.productTotalQuantity ??
        item.totalQuantity ??
        item.packageQuantity ??
        0,
    ),
    price: Number(item.price ?? item.upperPrice ?? item.maxPrice ?? 0),
    status: normalizeMatchStatus(item.matchStatus ?? item.status),
  };
}

function normalizeCmsPurchase(raw: unknown, index: number): CmsPurchaseHistory {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? item.purchaseHistoryId ?? index),
    sellerName: String(item.sellerName ?? item.wholesalerName ?? "-"),
    transactionDate: String(item.transactionDate ?? item.orderDate ?? "-"),
    orderItemName: String(item.orderItemName ?? item.inventoryName ?? "-"),
    productName: String(item.productName ?? item.name ?? "-"),
    quantity: Number(item.quantity ?? 0),
    source: String(item.source ?? "BAROPHARM"),
  };
}

function normalizeCmsSyncJob(raw: unknown, index: number): CmsSyncJob {
  const item = raw as Record<string, unknown>;
  const status = String(item.status ?? "SUCCESS") as CmsSyncJob["status"];
  return {
    id: String(item.id ?? item.jobId ?? index),
    status,
    startDate: String(item.startDate ?? "-"),
    endDate: String(item.endDate ?? "-"),
    lastSuccessPage: Number(item.lastSuccessPage ?? item.currentPage ?? 0),
    totalPages: Number(item.totalPages ?? item.lastPage ?? 0),
    message: String(item.message ?? status),
  };
}

function normalizeCmsFailure(raw: unknown, index: number): CmsDeductionFailure {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? item.deductionId ?? index),
    prescriptionCode: String(item.prescriptionCode ?? "-"),
    lineNo: Number(item.lineNo ?? item.lineNumber ?? 0),
    drugName: String(item.drugName ?? item.name ?? "미확인 약품"),
    totalQuantity: Number(item.totalQuantity ?? item.quantity ?? 0),
    status:
      String(item.status ?? "FAILED") === "RESOLVED" ? "RESOLVED" : "FAILED",
    reason: String(item.reason ?? item.message ?? "자동 차감 실패"),
  };
}

function CmsSidebar({
  navigate,
  page,
}: {
  navigate: (path: string) => void;
  page: CmsPage;
}) {
  const items: Array<[CmsPage, string, string]> = [
    ["dashboard", "대시보드", "/cms"],
    ["master", "기준 데이터", "/cms/master"],
    ["import", "Import", "/cms/import"],
    ["inventory", "재고", "/cms/inventory"],
    ["dispense", "처방전 차감", "/cms/dispense"],
    ["purchase", "구매 내역", "/cms/purchase"],
  ];
  return (
    <aside className="cms-sidebar">
      <div className="cms-brand">
        <span className="cms-logo" />
        <div>
          <strong>PharmFarm</strong>
          <em>CMS</em>
        </div>
      </div>
      <nav className="cms-nav">
        {items.map(([key, label, href]) => (
          <button
            key={key}
            className={page === key ? "is-active" : ""}
            type="button"
            onClick={() => navigate(href)}
          >
            <span className={`cms-nav-icon ${key}`} />
            {label}
          </button>
        ))}
      </nav>
      <div className="cms-account">
        <span>이</span>
        <div>
          <strong>이층약국</strong>
          <em>주계정 · pharmacy01</em>
        </div>
      </div>
    </aside>
  );
}

function CmsHeader({
  apiMessage,
  apiState,
  onLogout,
  page,
  onRefresh,
}: {
  apiMessage: string;
  apiState: ApiState;
  onLogout?: () => void;
  page: CmsPage;
  onRefresh: () => void;
}) {
  const titles: Record<CmsPage, string> = {
    dashboard: "대시보드",
    master: "기준 데이터",
    import: "기준 데이터 Import",
    inventory: "재고",
    dispense: "처방전 차감 실패",
    purchase: "구매 내역",
  };
  return (
    <header className="cms-header">
      <div>
        <strong>{titles[page]}</strong>
        <span>
          {apiStateLabel(apiState)} · {apiMessage}
        </span>
      </div>
      <div className="cms-header-actions">
        <button type="button" onClick={onRefresh}>
          연결 확인
        </button>
        {onLogout && (
          <button type="button" onClick={onLogout}>
            로그아웃
          </button>
        )}
      </div>
    </header>
  );
}

function CmsLoginPage({
  apiBase,
  apiMessage,
  apiState,
  loginId,
  password,
  onLoginId,
  onPassword,
  onSubmit,
}: {
  apiBase: string;
  apiMessage: string;
  apiState: ApiState;
  loginId: string;
  password: string;
  onLoginId: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="cms-content cms-login">
      <form className="cms-login-card" onSubmit={onSubmit}>
        <div>
          <span>CMS 로그인</span>
          <strong>실제 API 계정으로 접속</strong>
          <em>
            {apiStateLabel(apiState)} · {apiMessage || "로그인이 필요합니다."}
          </em>
        </div>
        <label>
          <span>API Base</span>
          <input readOnly value={apiBase} />
        </label>
        <label>
          <span>아이디</span>
          <input
            value={loginId}
            onChange={(event) => onLoginId(event.target.value)}
          />
        </label>
        <label>
          <span>비밀번호</span>
          <input
            type="password"
            value={password}
            onChange={(event) => onPassword(event.target.value)}
          />
        </label>
        <button className="cms-primary" type="submit">
          로그인
        </button>
      </form>
    </section>
  );
}

function CmsDashboard({
  importJobs,
  masters,
  navigate,
  stocks,
  syncJobs,
}: {
  importJobs: CmsImportJob[];
  masters: CmsMaster[];
  navigate: (path: string) => void;
  stocks: StockItem[];
  syncJobs: CmsSyncJob[];
}) {
  const normalCount = masters.filter((item) => item.status === "NORMAL").length;
  const needsCare = masters.filter((item) => item.status !== "NORMAL").length;
  const stockQuantity = stocks.reduce((sum, item) => sum + item.quantity, 0);
  const runningJob = importJobs.find((job) => job.status === "RUNNING");
  return (
    <section className="cms-content">
      <div className="cms-kpis">
        <CmsKpi label="보유 재고 품목" value={`${stocks.length}`} unit="종" />
        <CmsKpi
          label="총 보유 수량"
          value={currency(stockQuantity)}
          unit="개"
        />
        <CmsKpi
          label="정상 매칭"
          value={`${normalCount}`}
          unit="건"
          tone="blue"
        />
        <CmsKpi label="보정 필요" value={`${needsCare}`} unit="건" tone="red" />
      </div>
      <div className="cms-grid two">
        <CmsPanel
          title="기준 데이터 Import 현황"
          action="전체 보기"
          onAction={() => navigate("/cms/import")}
        >
          {importJobs.map((job) => (
            <CmsJobRow key={job.id} job={job} />
          ))}
        </CmsPanel>
        <CmsPanel title="운영 상태">
          <div className="cms-match-bar">
            <span style={{ width: "72%", background: "#0064FF" }} />
            <span style={{ width: "14%", background: "#6B4EE6" }} />
            <span style={{ width: "9%", background: "#B07514" }} />
            <span style={{ width: "5%", background: "#C13B2C" }} />
          </div>
          <CmsMiniList
            items={[
              ["정상매칭", `${normalCount}건`],
              [
                "이름매칭",
                `${masters.filter((item) => item.status === "NAME_MATCH").length}건`,
              ],
              [
                "가상생성",
                `${masters.filter((item) => item.status === "VIRTUAL").length}건`,
              ],
              [
                "미등록",
                `${masters.filter((item) => item.status === "MISSING").length}건`,
              ],
              [
                "진행 중 Import",
                runningJob ? `${runningJob.progress}%` : "없음",
              ],
              ["구매내역 동기화", syncJobs[0]?.status ?? "-"],
            ]}
          />
        </CmsPanel>
      </div>
    </section>
  );
}

function CmsMasterPage({
  masters,
  selectedMaster,
  onRematch,
  onSave,
  onSelect,
  onUpload,
}: {
  masters: CmsMaster[];
  selectedMaster?: CmsMaster;
  onRematch: (master: CmsMaster) => void;
  onSave: (master: CmsMaster) => void;
  onSelect: (id: string) => void;
  onUpload: (kind: "drug" | "price", file: File | null) => void;
}) {
  return (
    <section className="cms-content cms-split">
      <div className="cms-table-card">
        <div className="cms-toolbar">
          <div className="cms-pills">
            <span>전체 {masters.length}</span>
            <span>
              정상 {masters.filter((item) => item.status === "NORMAL").length}
            </span>
            <span>
              보정 {masters.filter((item) => item.status !== "NORMAL").length}
            </span>
          </div>
          <label className="cms-upload-btn">
            CSV Import
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) =>
                onUpload("drug", event.target.files?.[0] ?? null)
              }
            />
          </label>
        </div>
        <div className="cms-table master">
          <div className="cms-tr cms-th">
            <span>표준코드</span>
            <span>보험코드</span>
            <span>한글상품명</span>
            <span>규격</span>
            <span>총수량</span>
            <span>가격</span>
            <span>매칭</span>
          </div>
          {masters.map((master) => (
            <button
              key={master.id}
              className={`cms-tr ${selectedMaster?.id === master.id ? "is-selected" : ""}`}
              type="button"
              onClick={() => onSelect(master.id)}
            >
              <span>{shortCode(master.standardCode)}</span>
              <span>{master.insuranceCode || "-"}</span>
              <strong>{master.name}</strong>
              <span>{master.spec}</span>
              <span>{master.productTotalQuantity}</span>
              <span>{currency(master.price)}원</span>
              <span className={`cms-badge ${statusClass(master.status)}`}>
                {statusText(master.status)}
              </span>
            </button>
          ))}
        </div>
      </div>
      {selectedMaster && (
        <aside className="cms-edit-panel">
          <span className={`cms-badge ${statusClass(selectedMaster.status)}`}>
            {statusText(selectedMaster.status)}
          </span>
          <h2>{selectedMaster.name}</h2>
          <CmsField label="표준코드" value={selectedMaster.standardCode} mono />
          <CmsField
            label="보험코드"
            value={selectedMaster.insuranceCode || "미입력"}
            mono
          />
          <div className="cms-field-grid">
            <CmsField label="약품규격" value={selectedMaster.spec} />
            <CmsField
              label="제품총수량"
              value={`${selectedMaster.productTotalQuantity}`}
            />
          </div>
          <CmsField
            label="가격"
            value={`${currency(selectedMaster.price)}원`}
          />
          <div className="cms-actions">
            <button type="button" onClick={() => onRematch(selectedMaster)}>
              매칭 재시도
            </button>
            <button type="button" onClick={() => onSave(selectedMaster)}>
              저장
            </button>
          </div>
        </aside>
      )}
    </section>
  );
}

function CmsImportPage({
  jobs,
  onUpload,
}: {
  jobs: CmsImportJob[];
  onUpload: (kind: "drug" | "price", file: File | null) => void;
}) {
  const failedJob = jobs.find((job) => job.status === "FAILED");
  return (
    <section className="cms-content">
      <div className="cms-import-cards">
        <label>
          <strong>1번 기준 데이터</strong>
          <span>표준코드 기반 약품 마스터 CSV</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) =>
              onUpload("drug", event.target.files?.[0] ?? null)
            }
          />
        </label>
        <label>
          <strong>2번 기준 데이터</strong>
          <span>보험코드/가격 마스터 CSV</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) =>
              onUpload("price", event.target.files?.[0] ?? null)
            }
          />
        </label>
      </div>
      <div className="cms-grid two">
        <CmsPanel title="Import job">
          {jobs.map((job) => (
            <CmsJobRow key={job.id} job={job} />
          ))}
        </CmsPanel>
        <CmsPanel title="실패 상세">
          {failedJob ? (
            <CmsMiniList
              items={[
                ["파일", failedJob.fileName],
                ["실패", `${failedJob.failedCount}행`],
                ["중복 제외", `${failedJob.duplicateCount}행`],
                ["처리", failedJob.message],
              ]}
            />
          ) : (
            <p className="cms-empty">검증 실패 job이 없습니다.</p>
          )}
        </CmsPanel>
      </div>
    </section>
  );
}

function CmsInventoryPage({
  adjustDirection,
  adjustMemo,
  adjustQuantity,
  selectedStock,
  stocks,
  onAdjust,
  onAdjustDirection,
  onAdjustMemo,
  onAdjustQuantity,
  onSelect,
}: {
  adjustDirection: "INCREASE" | "DECREASE";
  adjustMemo: string;
  adjustQuantity: number;
  selectedStock?: StockItem;
  stocks: StockItem[];
  onAdjust: () => void;
  onAdjustDirection: (value: "INCREASE" | "DECREASE") => void;
  onAdjustMemo: (value: string) => void;
  onAdjustQuantity: (value: number) => void;
  onSelect: (id: string) => void;
}) {
  const stockValue = stocks.reduce(
    (sum, item) => sum + item.quantity * item.price,
    0,
  );
  const signedQuantity =
    adjustDirection === "INCREASE" ? adjustQuantity : -adjustQuantity;
  return (
    <section className="cms-content cms-split">
      <div className="cms-table-card">
        <div className="cms-kpis compact">
          <CmsKpi label="보유 품목" value={`${stocks.length}`} unit="종" />
          <CmsKpi
            label="총 보유 수량"
            value={currency(
              stocks.reduce((sum, item) => sum + item.quantity, 0),
            )}
            unit="개"
          />
          <CmsKpi
            label="예상 재고 금액"
            value={currency(stockValue)}
            unit="원"
          />
        </div>
        <div className="cms-table inventory">
          <div className="cms-tr cms-th">
            <span>약품명</span>
            <span>보험코드</span>
            <span>가격</span>
            <span>보유수량</span>
            <span>예상금액</span>
            <span>매칭</span>
          </div>
          {stocks.map((stock) => (
            <button
              key={stock.id}
              className={`cms-tr ${selectedStock?.id === stock.id ? "is-selected" : ""}`}
              type="button"
              onClick={() => onSelect(stock.id)}
            >
              <strong>{stock.name}</strong>
              <span>{stock.insuranceCode}</span>
              <span>{currency(stock.price)}원</span>
              <span>{stock.quantity}</span>
              <span>{currency(stock.quantity * stock.price)}원</span>
              <span className={`cms-badge ${statusClass(stock.matchStatus)}`}>
                {statusText(stock.matchStatus)}
              </span>
            </button>
          ))}
        </div>
      </div>
      {selectedStock && (
        <aside className="cms-edit-panel">
          <h2>수동 재고 조정</h2>
          <strong className="cms-selected-name">{selectedStock.name}</strong>
          <CmsField label="현재 재고" value={`${selectedStock.quantity}개`} />
          <div className="cms-segment">
            <button
              className={adjustDirection === "INCREASE" ? "is-active" : ""}
              type="button"
              onClick={() => onAdjustDirection("INCREASE")}
            >
              증가
            </button>
            <button
              className={adjustDirection === "DECREASE" ? "is-active" : ""}
              type="button"
              onClick={() => onAdjustDirection("DECREASE")}
            >
              감소
            </button>
          </div>
          <div className="cms-stepper">
            <button
              type="button"
              onClick={() => onAdjustQuantity(adjustQuantity - 1)}
            >
              -
            </button>
            <strong>{adjustQuantity}</strong>
            <button
              type="button"
              onClick={() => onAdjustQuantity(adjustQuantity + 1)}
            >
              +
            </button>
          </div>
          <label className="cms-input">
            <span>조정 사유</span>
            <input
              value={adjustMemo}
              onChange={(event) => onAdjustMemo(event.target.value)}
            />
          </label>
          <div className="cms-after">
            <span>조정 후 재고</span>
            <strong>
              {Math.max(0, selectedStock.quantity + signedQuantity)}개
            </strong>
          </div>
          <button className="cms-primary" type="button" onClick={onAdjust}>
            조정 저장
          </button>
        </aside>
      )}
    </section>
  );
}

function CmsDispensePage({
  failures,
  onResolve,
  stocks,
}: {
  failures: CmsDeductionFailure[];
  stocks: StockItem[];
  onResolve: (
    failure: CmsDeductionFailure,
    resolutionType: "VIRTUAL_DRUG" | "EXISTING_STOCK" | "UNREGISTERED_DRUG",
  ) => void;
}) {
  return (
    <section className="cms-content">
      <div className="cms-grid two">
        <CmsPanel title="처방전 차감 실패">
          <div className="cms-list">
            {failures.map((failure) => (
              <div className="cms-list-row" key={failure.id}>
                <div>
                  <strong>{failure.drugName}</strong>
                  <span>
                    {failure.prescriptionCode} · line {failure.lineNo} ·{" "}
                    {failure.reason}
                  </span>
                </div>
                <b>{failure.totalQuantity}개</b>
                <span
                  className={`cms-badge ${failure.status === "FAILED" ? "missing" : "normal"}`}
                >
                  {failure.status}
                </span>
              </div>
            ))}
          </div>
        </CmsPanel>
        <CmsPanel title="수동 처리">
          {failures[0] ? (
            <>
              <CmsField label="대상" value={failures[0].drugName} />
              <CmsField label="기존 재고 후보" value={stocks[0]?.name ?? "-"} />
              <div className="cms-actions vertical">
                <button
                  type="button"
                  onClick={() => onResolve(failures[0], "EXISTING_STOCK")}
                >
                  기존 재고로 차감
                </button>
                <button
                  type="button"
                  onClick={() => onResolve(failures[0], "VIRTUAL_DRUG")}
                >
                  가상 약 생성 후 차감
                </button>
                <button
                  type="button"
                  onClick={() => onResolve(failures[0], "UNREGISTERED_DRUG")}
                >
                  등록안된약 처리
                </button>
              </div>
            </>
          ) : (
            <p className="cms-empty">처리할 실패 항목이 없습니다.</p>
          )}
        </CmsPanel>
      </div>
    </section>
  );
}

function CmsPurchasePage({
  histories,
  onSync,
  syncJobs,
}: {
  histories: CmsPurchaseHistory[];
  syncJobs: CmsSyncJob[];
  onSync: () => void;
}) {
  return (
    <section className="cms-content">
      <div className="cms-grid two">
        <CmsPanel
          title="바로팜 구매내역 동기화"
          action="동기화 시작"
          onAction={onSync}
        >
          {syncJobs.map((job) => (
            <div className="cms-sync-card" key={job.id}>
              <div>
                <strong>{job.status}</strong>
                <span>
                  {job.startDate} ~ {job.endDate}
                </span>
              </div>
              <b>
                {job.lastSuccessPage}/{job.totalPages} page
              </b>
              <p>{job.message}</p>
            </div>
          ))}
        </CmsPanel>
        <CmsPanel title="구매 내역">
          <div className="cms-list">
            {histories.map((history) => (
              <div className="cms-list-row" key={history.id}>
                <div>
                  <strong>{history.orderItemName}</strong>
                  <span>
                    {history.sellerName} · {history.transactionDate} ·{" "}
                    {history.source}
                  </span>
                </div>
                <b>{history.quantity}개</b>
              </div>
            ))}
          </div>
        </CmsPanel>
      </div>
    </section>
  );
}

function CmsKpi({
  label,
  tone,
  unit,
  value,
}: {
  label: string;
  tone?: "blue" | "red";
  unit?: string;
  value: string;
}) {
  return (
    <div className="cms-kpi">
      <span>{label}</span>
      <strong className={tone ?? ""}>
        {value}
        {unit && <em>{unit}</em>}
      </strong>
    </div>
  );
}

function CmsPanel({
  action,
  children,
  onAction,
  title,
}: {
  action?: string;
  children: ReactNode;
  onAction?: () => void;
  title: string;
}) {
  return (
    <section className="cms-panel">
      <header>
        <strong>{title}</strong>
        {action && (
          <button type="button" onClick={onAction}>
            {action}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

function CmsJobRow({ job }: { job: CmsImportJob }) {
  return (
    <div className="cms-job-row">
      <div>
        <span>{job.dataType}</span>
        <strong>{job.fileName}</strong>
        <em>{job.message}</em>
      </div>
      <b className={`status-${job.status.toLowerCase()}`}>{job.status}</b>
      <div className="cms-progress">
        <span style={{ width: `${job.progress}%` }} />
      </div>
      <small>
        {currency(job.processedRows)} / {currency(job.totalRows)} 행 · 신규{" "}
        {job.newCount} · 수정 {job.updatedCount} · 중복 {job.duplicateCount}
      </small>
    </div>
  );
}

function CmsMiniList({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="cms-mini-list">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function CmsField({
  label,
  mono,
  value,
}: {
  label: string;
  mono?: boolean;
  value: string;
}) {
  return (
    <label className="cms-field">
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </label>
  );
}

function shortCode(value: string) {
  if (!value) return "-";
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export default App;
