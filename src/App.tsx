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

type ApiState = "checking" | "connected" | "demo" | "unauthorized";

const apiBase = (
  import.meta.env.VITE_PHARMFARM_API_BASE ??
  "https://api.solusi.co.kr/api/v1/pharmfarm"
).replace(/\/$/, "");

const storageKeys = {
  accessToken: "pharmfarm.accessToken",
  refreshToken: "pharmfarm.refreshToken",
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
    delayBetweenScanAttempts: 120,
    delayBetweenScanSuccess: 650,
    tryPlayVideoTimeout: 5000,
  });
}

function getCameraConstraints(): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  };
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = localStorage.getItem(storageKeys.accessToken);
  const headers = new Headers(options.headers);

  if (!headers.has("Content-Type") && options.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error("UNAUTHORIZED");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

async function login(loginId: string, password: string) {
  const data = await apiFetch<{
    accessToken: string;
    refreshToken?: string;
  }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ loginId, password }),
  });
  localStorage.setItem(storageKeys.accessToken, data.accessToken);
  if (data.refreshToken) {
    localStorage.setItem(storageKeys.refreshToken, data.refreshToken);
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
  const quantity = Number(item.quantity ?? item.count ?? item.stockQuantity ?? 0);
  const price = Number(item.price ?? item.unitPrice ?? item.upperPrice ?? 0);

  return {
    id: String(item.id ?? item.stockId ?? index),
    pc: String(item.pc ?? item.standardCode ?? ""),
    insuranceCode: String(item.insuranceCode ?? item.productCode ?? ""),
    name: String(item.name ?? item.drugName ?? item.productName ?? "미확인 약품"),
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
      returnableQuantity: Number(item.returnableQuantity ?? item.stockQuantity ?? 0),
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
    pc: fields.pc,
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

  return null;
}

function parseTextQr(raw: string) {
  const read = (key: string) => {
    const match = raw.match(new RegExp(`${key}\\s*[:=]\\s*([^\\s,;|]+)`, "i"));
    return match?.[1] ?? "";
  };

  return {
    pc: read("pc"),
    sn: read("sn"),
    lot: read("lot"),
    exp: read("exp"),
  };
}

function normalizeExp(value: string) {
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

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const lastDetectedRef = useRef({ value: "", at: 0 });
  const modeRef = useRef<Mode>("receipt");

  const [screen, setScreen] = useState<Screen>("scan");
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
  const [receiptSummary, setReceiptSummary] = useState<ReceiptSummary | null>(
    null,
  );
  const [returnLookup, setReturnLookup] = useState<ReturnLookup | null>(null);
  const [returnQuantity, setReturnQuantity] = useState(10);
  const [returnMemo, setReturnMemo] = useState("유통기한 임박 반품");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [returnSummary, setReturnSummary] = useState<ReturnSummary | null>(null);
  const [sampleCursor, setSampleCursor] = useState(0);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const selectedWholesaler = useMemo(
    () =>
      wholesalers.find((wholesaler) => wholesaler.id === selectedWholesalerId) ??
      null,
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
      : selectedCandidate?.sellerName ?? "";
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
      setApiState("unauthorized");
      setApiMessage("로그인이 필요합니다.");
      return;
    }
    setApiState("demo");
    setApiMessage("BE 연결 실패 · 데모 데이터 표시");
  }, []);

  const refreshFromBackend = useCallback(async () => {
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
    } catch (error) {
      setApiFallback(error);
    }
  }, [setApiFallback]);

  useEffect(() => {
    refreshFromBackend();
  }, [refreshFromBackend]);

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
        return;
      }

      const drug = resolveDrug(qr.pc);
      setReceiptQueue((current) => [
        { id: createId("Q"), qr, drug },
        ...current,
      ]);
      setLastScanName(drug.name);
    },
    [receiptQueue, traces],
  );

  const lookupReturn = useCallback(
    async (qr: QrFields) => {
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
          setReturnQuantity(Math.max(1, Math.min(10, lookup.returnableQuantity)));
          setScreen("returnConfirmed");
          return;
        }
        if (lookup.matchType === "ESTIMATED") {
          setSelectedCandidateId(lookup.sellerCandidates[0]?.id ?? "");
          setReturnQuantity(Math.max(1, Math.min(10, lookup.returnableQuantity)));
          setScreen("returnEstimated");
          return;
        }
        setScreen("returnNone");
      } catch (error) {
        setApiFallback(error);
        const lookup = lookupReturnDemo(qr, traces, stocks);
        setReturnLookup(lookup);
        if (lookup.matchType === "CONFIRMED") {
          setReturnQuantity(Math.max(1, Math.min(10, lookup.returnableQuantity)));
          setScreen("returnConfirmed");
        } else if (lookup.matchType === "ESTIMATED") {
          setSelectedCandidateId(lookup.sellerCandidates[0]?.id ?? "");
          setReturnQuantity(Math.max(1, Math.min(10, lookup.returnableQuantity)));
          setScreen("returnEstimated");
        } else {
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
        return;
      }

      if (modeRef.current === "return") {
        void lookupReturn(qr);
      } else {
        if (!selectedWholesaler) {
          setScreen("wholesaler");
          return;
        }
        addReceiptQr(qr);
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
        const controls = await reader.decodeFromConstraints(
          getCameraConstraints(),
          video,
          (result) => {
            const value = result?.getText();
            if (!value) return;

            const now = Date.now();
            const lastDetected = lastDetectedRef.current;
            if (value === lastDetected.value && now - lastDetected.at < 1500) {
              return;
            }

            lastDetectedRef.current = { value, at: now };
            handlePayload(value);
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
        setCameraActive(false);
      }
    }

    void startCamera();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [cameraActive, handlePayload, stopCamera]);

  function chooseMode(nextMode: Mode) {
    setMode(nextMode);
    setScreen("scan");
    setCameraActive(false);
  }

  function useSample() {
    const samples = mode === "receipt" ? receiptSamples : returnSamples;
    const sample = samples[sampleCursor % samples.length];
    setSampleCursor((value) => value + 1);
    handlePayload(sample);
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

  function commitReceiptDemo(items: ReceiptQueueItem[], wholesaler: Wholesaler) {
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

  function commitReturnDemo(lookup: Exclude<ReturnLookup, { matchType: "NONE" }>, quantity: number) {
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
      await login(loginId, password);
      await refreshFromBackend();
      setScreen("scan");
    } catch (error) {
      setApiState("unauthorized");
      setApiMessage(
        error instanceof Error ? error.message : "로그인에 실패했습니다.",
      );
    }
  }

  function logout() {
    localStorage.removeItem(storageKeys.accessToken);
    localStorage.removeItem(storageKeys.refreshToken);
    setApiState("unauthorized");
    setApiMessage("로그인이 필요합니다.");
    setScreen("account");
  }

  return (
    <main className={`phone ${screenClass(screen, mode)}`}>
      {screen === "wholesaler" && (
        <WholesalerScreen
          pendingId={pendingWholesalerId}
          wholesalers={wholesalers}
          onBack={() => setScreen("scan")}
          onChoose={setPendingWholesalerId}
          onStart={() => {
            setSelectedWholesalerId(pendingWholesaler.id);
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
          onToggleCamera={() => setCameraActive((value) => !value)}
          onWholesaler={() => setScreen("wholesaler")}
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
              setReturnQuantity(Math.max(1, Math.min(returnQuantity, returnMax)));
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
          onBack={() => setScreen("scan")}
          onLoginId={setLoginId}
          onLogout={logout}
          onPassword={setPassword}
          onRefresh={refreshFromBackend}
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
    const stock = stocks.find((item) => item.insuranceCode === trace.insuranceCode);
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
    message:
      "입고·구매 내역에 근거가 없어 반품 대상으로 등록할 수 없습니다.",
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

function StatusBar({ dark = true }: { dark?: boolean }) {
  return (
    <div className={`status-bar ${dark ? "is-dark-text" : ""}`}>
      <span>9:41</span>
      <span className="system">
        <span>5G</span>
        <span className="battery" />
      </span>
    </div>
  );
}

function ScanScreen({
  apiMessage,
  apiState,
  cameraActive,
  cameraError,
  mode,
  queueCount,
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
  mode: Mode;
  queueCount: number;
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
      <StatusBar dark={false} />
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
          className="scan-box"
          style={{ "--accent": accent } as CSSProperties}
          type="button"
          onClick={cameraActive ? onSample : onToggleCamera}
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
  onStart,
}: {
  pendingId: string;
  wholesalers: Wholesaler[];
  onBack: () => void;
  onChoose: (id: string) => void;
  onStart: () => void;
}) {
  return (
    <>
      <StatusBar />
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
      <BottomBar>
        <button className="primary-btn" type="button" onClick={onStart}>
          이 도매처로 입고 시작
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
      <StatusBar />
      <Header
        title="입고 확인"
        note={selectedWholesaler?.name ?? ""}
        onBack={onBack}
      />
      <section className="scroll-body">
        <div className="metrics">
          <Metric label="스캔 건수" value={`${queue.length}`} unit="건" />
          <Metric label="예상 재고 증가" value={`+${increase}`} unit="개" blue />
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
        {queue.length > 4 && <div className="more">+ {queue.length - 4}건 더 보기</div>}
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
      <StatusBar />
      <Header title="매칭 결과" onBack={onBack} />
      <section className="scroll-body">
        <p className="guide-copy">
          기준 데이터 연결 상태입니다. 가상생성·미등록 항목은 CMS에서 보정할 수 있어요.
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
        <span />확정 · 입고 이력 있음
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
          <MiniMetric label="반품 가능" value={lookup.returnableQuantity} blue />
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
        <span />추정 · 입고 이력 없음
      </span>
      <h1>{lookup.drugName}</h1>
      <p className="guide-copy">
        입고 이력은 없지만, 구매 내역 기준으로 아래 판매처가 추정됩니다. 하나를 선택해 주세요.
      </p>
      <div className="section-label">판매처 후보 {lookup.sellerCandidates.length}</div>
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
          입고·구매 내역에 근거가 없어 반품 대상으로 등록할 수 없습니다. 구매 내역을 먼저
          동기화하거나 코드를 다시 확인해 주세요.
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
      <StatusBar />
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
      <StatusBar />
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
              <SummaryLine label="도매처" value={receiptSummary?.wholesalerName} />
              <SummaryLine label="입고 품목" value={`${receiptSummary?.count ?? 0}종`} />
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
              <SummaryLine label="도매처" value={returnSummary?.wholesalerName} />
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
      <StatusBar />
      <Header title="재고 목록" onBack={onBack} />
      <section className="scroll-body">
        <div className="list-card">
          {stocks.map((stock) => (
            <div className="stock-row" key={stock.id}>
              <div>
                <strong>{stock.name}</strong>
                <span>
                  {stock.insuranceCode} · 예상 {currency(stock.quantity * stock.price)}원
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
  onLogout,
  onPassword,
  onRefresh,
  onSubmit,
}: {
  apiBase: string;
  apiMessage: string;
  apiState: ApiState;
  loginId: string;
  password: string;
  onBack: () => void;
  onLoginId: (value: string) => void;
  onLogout: () => void;
  onPassword: (value: string) => void;
  onRefresh: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      <StatusBar />
      <Header title="계정" onBack={onBack} />
      <section className="scroll-body">
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
            <input value={loginId} onChange={(event) => onLoginId(event.target.value)} />
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
      <BottomBar stack>
        <button className="secondary-btn" type="button" onClick={onRefresh}>
          연결 확인
        </button>
        <button className="secondary-btn" type="button" onClick={onLogout}>
          로그아웃
        </button>
      </BottomBar>
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
  onBack: () => void;
}) {
  return (
    <header className="page-header">
      <button className="back-btn" type="button" onClick={onBack} />
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
  return <footer className={`bottom-bar ${stack ? "stack" : ""}`}>{children}</footer>;
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

function DrugRow({
  delta,
  item,
}: {
  delta: number;
  item: ReceiptQueueItem;
}) {
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
      <strong className={blue ? "blue" : red ? "red" : ""}>{value ?? "-"}</strong>
    </div>
  );
}

export default App;
