import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Barcode,
  Camera,
  CheckCircle2,
  ClipboardPaste,
  DatabaseZap,
  FileSpreadsheet,
  Package,
  PackageCheck,
  PackagePlus,
  Pause,
  Play,
  RotateCcw,
  ScanLine,
  Search,
  ShieldCheck,
  Smartphone,
  Truck,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  BrowserMultiFormatReader,
  type IScannerControls,
} from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";

type ViewKey = "receipt" | "return" | "inventory" | "sync";
type EventTone = "ok" | "warn" | "error" | "info";

type QrFields = {
  pc: string;
  sn: string;
  lot: string;
  exp: string;
  raw: string;
  format: "query" | "gs1" | "text";
  errors: string[];
};

type DrugMaster = {
  pc: string;
  insuranceCode: string;
  name: string;
  company: string;
  packageQuantity: number;
  price: number;
  matchStatus: "정상" | "가상 생성";
};

type ReceiptQueueItem = {
  id: string;
  qr: QrFields;
  drug: DrugMaster;
};

type ReceiptTrace = {
  id: string;
  pc: string;
  sn: string;
  lot: string;
  exp: string;
  drugName: string;
  insuranceCode: string;
  packageQuantity: number;
  returnedQuantity: number;
  wholesalerId: string;
  wholesalerName: string;
  receivedAt: string;
};

type InventoryItem = {
  id: string;
  pc: string;
  insuranceCode: string;
  name: string;
  quantity: number;
  price: number;
  matchStatus: DrugMaster["matchStatus"];
};

type ReturnCandidate = {
  trace: ReceiptTrace;
  stock?: InventoryItem;
  availableQuantity: number;
  status: "ok" | "stock-short" | "empty" | "mismatch";
};

type ActivityEvent = {
  id: string;
  tone: EventTone;
  title: string;
  detail: string;
  time: string;
};

type SyncJob = {
  id: string;
  kind: "입고" | "반품";
  count: number;
  status: "ready" | "offline";
  createdAt: string;
};

const views: Array<{ key: ViewKey; label: string; icon: typeof ScanLine }> = [
  { key: "receipt", label: "입고 스캔", icon: ScanLine },
  { key: "return", label: "반품 조회", icon: RotateCcw },
  { key: "inventory", label: "재고", icon: Package },
  { key: "sync", label: "동기화", icon: DatabaseZap },
];

const wholesalers = [
  { id: "W-100", name: "지오영" },
  { id: "W-210", name: "백제약품" },
  { id: "W-330", name: "동원약품" },
];

const drugMasters: DrugMaster[] = [
  {
    pc: "8806400039301",
    insuranceCode: "640003930",
    name: "리피토정 10mg",
    company: "한국화이자제약",
    packageQuantity: 28,
    price: 712,
    matchStatus: "정상",
  },
  {
    pc: "8806498008500",
    insuranceCode: "649800850",
    name: "아모잘탄정 5/50mg",
    company: "한미약품",
    packageQuantity: 30,
    price: 853,
    matchStatus: "정상",
  },
  {
    pc: "8806705005409",
    insuranceCode: "670500540",
    name: "크레스토정 10mg",
    company: "한국아스트라제네카",
    packageQuantity: 30,
    price: 991,
    matchStatus: "정상",
  },
];

const initialInventory: InventoryItem[] = [
  {
    id: "S-001",
    pc: "8806400039301",
    insuranceCode: "640003930",
    name: "리피토정 10mg",
    quantity: 112,
    price: 712,
    matchStatus: "정상",
  },
  {
    id: "S-002",
    pc: "8806498008500",
    insuranceCode: "649800850",
    name: "아모잘탄정 5/50mg",
    quantity: 42,
    price: 853,
    matchStatus: "정상",
  },
  {
    id: "S-003",
    pc: "8806705005409",
    insuranceCode: "670500540",
    name: "크레스토정 10mg",
    quantity: 60,
    price: 991,
    matchStatus: "정상",
  },
];

const initialReceiptHistory: ReceiptTrace[] = [
  {
    id: "R-1001",
    pc: "8806400039301",
    sn: "SN-R0031",
    lot: "BT2601",
    exp: "2028-01-31",
    drugName: "리피토정 10mg",
    insuranceCode: "640003930",
    packageQuantity: 28,
    returnedQuantity: 0,
    wholesalerId: "W-100",
    wholesalerName: "지오영",
    receivedAt: "2026-06-18 09:32",
  },
  {
    id: "R-1002",
    pc: "8806498008500",
    sn: "SN-A10029",
    lot: "LOT2506",
    exp: "2027-12-31",
    drugName: "아모잘탄정 5/50mg",
    insuranceCode: "649800850",
    packageQuantity: 30,
    returnedQuantity: 12,
    wholesalerId: "W-210",
    wholesalerName: "백제약품",
    receivedAt: "2026-06-17 15:08",
  },
];

const sampleQr =
  "https://inpharm.local/scan?pc=8806400039301&sn=SN-R0031&lot=BT2601&exp=2028-01-31";
const sampleGs1 = "(01)8806498008500(21)SN-A10029(10)LOT2506(17)271231";

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function nowTime() {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
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
    const params = url.searchParams;
    return {
      pc: firstParam(params, ["pc", "PC", "01", "gtin"]) ?? "",
      sn: firstParam(params, ["sn", "SN", "21", "serial"]) ?? "",
      lot: firstParam(params, ["lot", "LOT", "10"]) ?? "",
      exp: firstParam(params, ["exp", "EXP", "17"]) ?? "",
    };
  } catch {
    if (!raw.includes("=")) return null;

    const params = new URLSearchParams(raw.replace(/^[?#]/, ""));
    return {
      pc: firstParam(params, ["pc", "PC", "01", "gtin"]) ?? "",
      sn: firstParam(params, ["sn", "SN", "21", "serial"]) ?? "",
      lot: firstParam(params, ["lot", "LOT", "10"]) ?? "",
      exp: firstParam(params, ["exp", "EXP", "17"]) ?? "",
    };
  }
}

function firstParam(params: URLSearchParams, keys: string[]) {
  for (const key of keys) {
    const value = params.get(key);
    if (value) return value.trim();
  }
  return null;
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

  const compact = raw.replace(/\s/g, "");
  if (!compact.startsWith("01")) return null;

  const parts = compact.split(/\u001d|\x1d/);
  const joined = parts.join("\u001d");

  return {
    pc: joined.match(/01(\d{13,14})/)?.[1] ?? "",
    sn: joined.match(/21([^\u001d]+)/)?.[1]?.replace(/10.*$/, "") ?? "",
    lot: joined.match(/10([^\u001d]+)/)?.[1]?.replace(/17.*$/, "") ?? "",
    exp: joined.match(/17(\d{6})/)?.[1] ?? "",
  };
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
  const match = drugMasters.find((drug) => drug.pc === pc);
  if (match) return match;

  return {
    pc,
    insuranceCode: `P001PF${pc.slice(-5).padStart(5, "0")}`,
    name: `미등록 약품 ${pc.slice(-4)}`,
    company: "확인 필요",
    packageQuantity: 1,
    price: 0,
    matchStatus: "가상 생성",
  };
}

function returnStatusText(status: ReturnCandidate["status"]) {
  switch (status) {
    case "mismatch":
      return "LOT 또는 EXP가 입고 이력과 다릅니다.";
    case "stock-short":
      return "현재고가 부족합니다.";
    case "empty":
      return "반품 가능 수량이 없습니다.";
    default:
      return "";
  }
}

function currency(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

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

function getPreferredCameraConstraints(): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
  };
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const lastDetectedRef = useRef({ value: "", at: 0 });
  const activeViewRef = useRef<ViewKey>("receipt");
  const receiptQueueRef = useRef<ReceiptQueueItem[]>([]);
  const receiptHistoryRef = useRef<ReceiptTrace[]>(initialReceiptHistory);
  const inventoryRef = useRef<InventoryItem[]>(initialInventory);

  const [activeView, setActiveView] = useState<ViewKey>("receipt");
  const [selectedWholesaler, setSelectedWholesaler] = useState(
    wholesalers[0].id,
  );
  const [manualPayload, setManualPayload] = useState(sampleQr);
  const [lastScan, setLastScan] = useState<QrFields | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [receiptQueue, setReceiptQueue] = useState<ReceiptQueueItem[]>([]);
  const [receiptHistory, setReceiptHistory] = useState<ReceiptTrace[]>(
    initialReceiptHistory,
  );
  const [inventory, setInventory] = useState<InventoryItem[]>(initialInventory);
  const [returnCandidate, setReturnCandidate] =
    useState<ReturnCandidate | null>(null);
  const [returnQuantity, setReturnQuantity] = useState(1);
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([
    {
      id: "SYNC-001",
      kind: "입고",
      count: 2,
      status: "offline",
      createdAt: "09:42",
    },
  ]);
  const [events, setEvents] = useState<ActivityEvent[]>([
    {
      id: "EV-001",
      tone: "ok",
      title: "입고 확정",
      detail: "지오영 · 2개 QR 반영",
      time: "09:32",
    },
    {
      id: "EV-002",
      tone: "warn",
      title: "기준 데이터 보류",
      detail: "가상 보험코드 생성 대기 1건",
      time: "09:14",
    },
  ]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    receiptQueueRef.current = receiptQueue;
  }, [receiptQueue]);

  useEffect(() => {
    receiptHistoryRef.current = receiptHistory;
  }, [receiptHistory]);

  useEffect(() => {
    inventoryRef.current = inventory;
  }, [inventory]);

  const selectedWholesalerName =
    wholesalers.find((wholesaler) => wholesaler.id === selectedWholesaler)
      ?.name ?? wholesalers[0].name;

  const addEvent = useCallback(
    (tone: EventTone, title: string, detail: string) => {
      setEvents((current) =>
        [
          {
            id: createId("EV"),
            tone,
            title,
            detail,
            time: nowTime(),
          },
          ...current,
        ].slice(0, 8),
      );
    },
    [],
  );

  const addSyncJob = useCallback((kind: SyncJob["kind"], count: number) => {
    setSyncJobs((current) => [
      {
        id: createId("SYNC"),
        kind,
        count,
        status: navigator.onLine ? "ready" : "offline",
        createdAt: nowTime(),
      },
      ...current,
    ]);
  }, []);

  const lookupReturn = useCallback(
    (qr: QrFields) => {
      const trace = receiptHistoryRef.current.find(
        (item) => item.pc === qr.pc && item.sn === qr.sn,
      );

      if (!trace) {
        setReturnCandidate(null);
        addEvent(
          "error",
          "반품 조회 실패",
          `${qr.pc || "PC 없음"} · ${qr.sn || "SN 없음"}`,
        );
        return;
      }

      const stock = inventoryRef.current.find((item) => item.pc === trace.pc);
      const availableQuantity = Math.max(
        0,
        trace.packageQuantity - trace.returnedQuantity,
      );
      const hasMismatch = trace.lot !== qr.lot || trace.exp !== qr.exp;
      const status: ReturnCandidate["status"] = hasMismatch
        ? "mismatch"
        : availableQuantity <= 0
          ? "empty"
          : !stock || stock.quantity < 1
            ? "stock-short"
            : "ok";

      setReturnCandidate({ trace, stock, availableQuantity, status });
      setReturnQuantity(Math.min(availableQuantity || 1, 1));
      addEvent(
        status === "ok" ? "ok" : "warn",
        status === "ok" ? "반품 공급처 조회" : "반품 검증 필요",
        `${trace.wholesalerName} · ${availableQuantity}개 가능`,
      );
    },
    [addEvent],
  );

  const handlePayload = useCallback(
    (payload: string, source: "camera" | "manual") => {
      if (!payload.trim()) return;

      const parsed = parseQrPayload(payload);
      setLastScan(parsed);

      if (parsed.errors.length > 0) {
        addEvent("error", "QR 파싱 실패", parsed.errors.join(", "));
        return;
      }

      if (activeViewRef.current === "return") {
        lookupReturn(parsed);
        return;
      }

      const alreadyReceived = receiptHistoryRef.current.some(
        (item) => item.pc === parsed.pc && item.sn === parsed.sn,
      );

      if (alreadyReceived) {
        addEvent("error", "이미 입고된 SN", `${parsed.pc} · ${parsed.sn}`);
        return;
      }

      const duplicate = receiptQueueRef.current.some(
        (item) => item.qr.pc === parsed.pc && item.qr.sn === parsed.sn,
      );

      if (duplicate) {
        addEvent("warn", "중복 스캔", `${parsed.pc} · ${parsed.sn}`);
        return;
      }

      const drug = resolveDrug(parsed.pc);
      const item: ReceiptQueueItem = {
        id: createId(source === "camera" ? "CAM" : "MAN"),
        qr: parsed,
        drug,
      };

      setReceiptQueue((current) => [item, ...current]);
      addEvent(
        drug.matchStatus === "정상" ? "ok" : "warn",
        "입고 QR 추가",
        `${drug.name} · ${parsed.sn}`,
      );
    },
    [addEvent, lookupReturn],
  );

  const stopCamera = useCallback(() => {
    scannerControlsRef.current?.stop();
    scannerControlsRef.current = null;

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute("src");
    }
  }, []);

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
          throw new Error(
            "카메라는 HTTPS 또는 localhost 환경에서만 사용할 수 있습니다.",
          );
        }

        const video = videoRef.current;

        if (!video) {
          throw new Error("카메라 화면을 준비하지 못했습니다.");
        }

        const reader = createScannerReader();
        const controls = await reader.decodeFromConstraints(
          getPreferredCameraConstraints(),
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
            setManualPayload(value);
            handlePayload(value, "camera");
          },
        );

        if (cancelled) {
          controls.stop();
          return;
        }

        scannerControlsRef.current = controls;
      } catch (error) {
        if (cancelled) return;

        if (error instanceof Error && error.name === "NotAllowedError") {
          setCameraError(
            "카메라 권한이 거부되었습니다. 브라우저 권한을 확인하세요.",
          );
        } else {
          setCameraError(
            error instanceof Error
              ? error.message
              : "카메라를 시작하지 못했습니다.",
          );
        }

        setCameraActive(false);
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [cameraActive, handlePayload, stopCamera]);

  function commitReceipt() {
    if (receiptQueue.length === 0) return;

    const traces: ReceiptTrace[] = receiptQueue.map((item) => ({
      id: createId("R"),
      pc: item.qr.pc,
      sn: item.qr.sn,
      lot: item.qr.lot,
      exp: item.qr.exp,
      drugName: item.drug.name,
      insuranceCode: item.drug.insuranceCode,
      packageQuantity: item.drug.packageQuantity,
      returnedQuantity: 0,
      wholesalerId: selectedWholesaler,
      wholesalerName: selectedWholesalerName,
      receivedAt: `2026-06-18 ${nowTime()}`,
    }));

    setReceiptHistory((current) => [...traces, ...current]);
    setInventory((current) => {
      const next = [...current];

      for (const item of receiptQueue) {
        const existing = next.find((stock) => stock.pc === item.qr.pc);

        if (existing) {
          existing.quantity += item.drug.packageQuantity;
        } else {
          next.push({
            id: createId("S"),
            pc: item.qr.pc,
            insuranceCode: item.drug.insuranceCode,
            name: item.drug.name,
            quantity: item.drug.packageQuantity,
            price: item.drug.price,
            matchStatus: item.drug.matchStatus,
          });
        }
      }

      return next;
    });

    addSyncJob("입고", receiptQueue.length);
    addEvent(
      "ok",
      "입고 확정",
      `${selectedWholesalerName} · ${receiptQueue.length}개 QR`,
    );
    setReceiptQueue([]);
  }

  function commitReturn() {
    if (!returnCandidate) return;

    const quantity = Math.max(
      1,
      Math.min(returnQuantity, returnCandidate.availableQuantity),
    );

    if (
      returnCandidate.availableQuantity < quantity ||
      !returnCandidate.stock ||
      returnCandidate.stock.quantity < quantity
    ) {
      addEvent("error", "반품 차감 실패", "반품 가능 수량 또는 현재고 부족");
      return;
    }

    setReceiptHistory((current) =>
      current.map((trace) =>
        trace.id === returnCandidate.trace.id
          ? { ...trace, returnedQuantity: trace.returnedQuantity + quantity }
          : trace,
      ),
    );
    setInventory((current) =>
      current.map((stock) =>
        stock.id === returnCandidate.stock?.id
          ? { ...stock, quantity: stock.quantity - quantity }
          : stock,
      ),
    );
    addSyncJob("반품", 1);
    addEvent(
      "ok",
      "반품 등록",
      `${returnCandidate.trace.wholesalerName} · ${quantity}개`,
    );
    setReturnCandidate(null);
    setReturnQuantity(1);
  }

  function clearQueue() {
    setReceiptQueue([]);
    addEvent("info", "스캔 대기열 초기화", "입고 확정 전 항목 삭제");
  }

  const filteredInventory = useMemo(() => {
    const query = inventoryQuery.trim().toLocaleLowerCase();
    if (!query) return inventory;

    return inventory.filter((item) =>
      `${item.name} ${item.insuranceCode} ${item.pc}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [inventory, inventoryQuery]);

  const totalValue = useMemo(
    () => inventory.reduce((sum, item) => sum + item.quantity * item.price, 0),
    [inventory],
  );

  const returnableCount = useMemo(
    () =>
      receiptHistory.reduce(
        (sum, trace) =>
          sum + Math.max(0, trace.packageQuantity - trace.returnedQuantity),
        0,
      ),
    [receiptHistory],
  );

  return (
    <div className="product-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-symbol">
            <PackageCheck size={22} />
          </div>
          <div>
            <h1>인팜 재고 스캔</h1>
            <p>튼튼약국 본점</p>
          </div>
        </div>
        <div className="runtime-badges">
          <span className="runtime-badge">
            <Smartphone size={15} />
            Web/PWA
          </span>
          <span
            className={`runtime-badge ${navigator.onLine ? "online" : "offline"}`}
          >
            {navigator.onLine ? <Wifi size={15} /> : <WifiOff size={15} />}
            {navigator.onLine ? "온라인" : "오프라인"}
          </span>
        </div>
      </header>

      <nav className="tabbar" aria-label="주요 화면">
        {views.map((view) => {
          const Icon = view.icon;
          return (
            <button
              key={view.key}
              className={activeView === view.key ? "is-active" : ""}
              type="button"
              onClick={() => setActiveView(view.key)}
            >
              <Icon size={18} />
              {view.label}
            </button>
          );
        })}
      </nav>

      <main className="workspace">
        <section className="summary-strip">
          <Metric
            icon={Barcode}
            label="스캔 대기"
            value={`${receiptQueue.length}건`}
            tone="blue"
          />
          <Metric
            icon={Package}
            label="보유 재고"
            value={`${inventory.length}품목`}
            tone="green"
          />
          <Metric
            icon={RotateCcw}
            label="반품 가능"
            value={`${returnableCount}개`}
            tone="amber"
          />
          <Metric
            icon={DatabaseZap}
            label="동기화 대기"
            value={`${syncJobs.length}건`}
            tone="red"
          />
        </section>

        {(activeView === "receipt" || activeView === "return") && (
          <section className="scanner-layout">
            <div className="scan-panel">
              <div className="panel-title">
                <div>
                  <span className="eyebrow">QR/Data Matrix</span>
                  <h2>
                    {activeView === "receipt" ? "입고 스캔" : "반품 조회"}
                  </h2>
                </div>
                <button
                  className={`primary-action ${cameraActive ? "is-paused" : ""}`}
                  type="button"
                  onClick={() => setCameraActive((value) => !value)}
                >
                  {cameraActive ? <Pause size={17} /> : <Camera size={17} />}
                  {cameraActive ? "중지" : "카메라"}
                </button>
              </div>

              <div className="camera-frame">
                <video ref={videoRef} muted playsInline />
                {!cameraActive && (
                  <div className="camera-placeholder">
                    <ScanLine size={34} />
                    <span>대기</span>
                  </div>
                )}
              </div>
              {cameraError && <div className="inline-alert">{cameraError}</div>}

              <label className="field-label" htmlFor="manual-qr">
                수동 입력
              </label>
              <textarea
                id="manual-qr"
                className="qr-input"
                value={manualPayload}
                onChange={(event) => setManualPayload(event.target.value)}
              />
              <div className="scan-actions">
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => setManualPayload(sampleQr)}
                >
                  <ClipboardPaste size={16} />
                  URL 샘플
                </button>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => setManualPayload(sampleGs1)}
                >
                  <FileSpreadsheet size={16} />
                  GS1 샘플
                </button>
                <button
                  className="primary-action"
                  type="button"
                  onClick={() => handlePayload(manualPayload, "manual")}
                >
                  <Play size={17} />
                  적용
                </button>
              </div>

              {lastScan && (
                <div
                  className={`scan-result ${lastScan.errors.length ? "has-error" : ""}`}
                >
                  <Field label="PC" value={lastScan.pc || "-"} />
                  <Field label="SN" value={lastScan.sn || "-"} />
                  <Field label="LOT" value={lastScan.lot || "-"} />
                  <Field label="EXP" value={lastScan.exp || "-"} />
                </div>
              )}
            </div>

            {activeView === "receipt" ? (
              <ReceiptPanel
                queue={receiptQueue}
                selectedWholesaler={selectedWholesaler}
                onWholesalerChange={setSelectedWholesaler}
                onCommit={commitReceipt}
                onClear={clearQueue}
              />
            ) : (
              <ReturnPanel
                candidate={returnCandidate}
                quantity={returnQuantity}
                onQuantityChange={setReturnQuantity}
                onCommit={commitReturn}
              />
            )}
          </section>
        )}

        {activeView === "inventory" && (
          <section className="inventory-panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Stock</span>
                <h2>재고 현황</h2>
              </div>
              <div className="total-value">
                예상 금액 {currency(totalValue)}원
              </div>
            </div>
            <label className="search-field">
              <Search size={17} />
              <input
                value={inventoryQuery}
                onChange={(event) => setInventoryQuery(event.target.value)}
                placeholder="약명, 보험코드, PC"
              />
            </label>
            <div className="data-table">
              <div className="table-row table-head">
                <span>약품</span>
                <span>보험코드</span>
                <span>수량</span>
                <span>금액</span>
                <span>상태</span>
              </div>
              {filteredInventory.map((item) => (
                <div className="table-row" key={item.id}>
                  <span>{item.name}</span>
                  <span>{item.insuranceCode}</span>
                  <span>{item.quantity}</span>
                  <span>{currency(item.quantity * item.price)}원</span>
                  <span
                    className={`status-pill ${item.matchStatus === "정상" ? "ok" : "warn"}`}
                  >
                    {item.matchStatus}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeView === "sync" && (
          <section className="sync-panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Queue</span>
                <h2>동기화 대기열</h2>
              </div>
              <button
                className="secondary-action"
                type="button"
                onClick={() => setSyncJobs([])}
              >
                <CheckCircle2 size={16} />
                모두 처리
              </button>
            </div>
            <div className="sync-list">
              {syncJobs.length === 0 ? (
                <div className="empty-state">대기 중인 작업 없음</div>
              ) : (
                syncJobs.map((job) => (
                  <div className="sync-row" key={job.id}>
                    <div className={`sync-icon ${job.status}`}>
                      {job.status === "ready" ? (
                        <Wifi size={18} />
                      ) : (
                        <WifiOff size={18} />
                      )}
                    </div>
                    <div>
                      <strong>{job.kind}</strong>
                      <span>
                        {job.count}건 · {job.createdAt}
                      </span>
                    </div>
                    <span
                      className={`status-pill ${job.status === "ready" ? "ok" : "warn"}`}
                    >
                      {job.status === "ready" ? "전송 가능" : "오프라인"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        <aside className="activity-panel">
          <div className="panel-title compact">
            <div>
              <span className="eyebrow">Log</span>
              <h2>최근 작업</h2>
            </div>
            <ShieldCheck size={19} />
          </div>
          <div className="activity-list">
            {events.map((event) => (
              <div className="activity-row" key={event.id}>
                <span className={`activity-dot ${event.tone}`} />
                <div>
                  <strong>{event.title}</strong>
                  <span>{event.detail}</span>
                </div>
                <time>{event.time}</time>
              </div>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Barcode;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className={`metric ${tone}`}>
      <Icon size={19} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReceiptPanel({
  queue,
  selectedWholesaler,
  onWholesalerChange,
  onCommit,
  onClear,
}: {
  queue: ReceiptQueueItem[];
  selectedWholesaler: string;
  onWholesalerChange: (value: string) => void;
  onCommit: () => void;
  onClear: () => void;
}) {
  return (
    <div className="work-panel">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Receipt</span>
          <h2>입고 대기열</h2>
        </div>
        <PackagePlus size={20} />
      </div>
      <label className="field-label" htmlFor="wholesaler">
        도매처
      </label>
      <select
        id="wholesaler"
        className="select-field"
        value={selectedWholesaler}
        onChange={(event) => onWholesalerChange(event.target.value)}
      >
        {wholesalers.map((wholesaler) => (
          <option key={wholesaler.id} value={wholesaler.id}>
            {wholesaler.name}
          </option>
        ))}
      </select>
      <div className="queue-list">
        {queue.length === 0 ? (
          <div className="empty-state">입고 대기 항목 없음</div>
        ) : (
          queue.map((item) => (
            <div className="queue-item" key={item.id}>
              <div className="queue-icon">
                <Barcode size={18} />
              </div>
              <div>
                <strong>{item.drug.name}</strong>
                <span>
                  {item.qr.sn} · {item.qr.lot} · {item.qr.exp}
                </span>
              </div>
              <span
                className={`status-pill ${item.drug.matchStatus === "정상" ? "ok" : "warn"}`}
              >
                {item.drug.packageQuantity}개
              </span>
            </div>
          ))
        )}
      </div>
      <div className="panel-actions">
        <button
          className="secondary-action"
          type="button"
          onClick={onClear}
          disabled={queue.length === 0}
        >
          <AlertTriangle size={16} />
          초기화
        </button>
        <button
          className="primary-action"
          type="button"
          onClick={onCommit}
          disabled={queue.length === 0}
        >
          <Truck size={17} />
          입고 확정
        </button>
      </div>
    </div>
  );
}

function ReturnPanel({
  candidate,
  quantity,
  onQuantityChange,
  onCommit,
}: {
  candidate: ReturnCandidate | null;
  quantity: number;
  onQuantityChange: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <div className="work-panel">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Return</span>
          <h2>공급처 조회</h2>
        </div>
        <RotateCcw size={20} />
      </div>
      {!candidate ? (
        <div className="empty-state tall">조회 결과 없음</div>
      ) : (
        <>
          <div className="return-card">
            <div>
              <span>도매처</span>
              <strong>{candidate.trace.wholesalerName}</strong>
            </div>
            <div>
              <span>약품</span>
              <strong>{candidate.trace.drugName}</strong>
            </div>
            <div>
              <span>반품 가능</span>
              <strong>{candidate.availableQuantity}개</strong>
            </div>
            <div>
              <span>현재고</span>
              <strong>{candidate.stock?.quantity ?? 0}개</strong>
            </div>
          </div>
          {candidate.status !== "ok" && (
            <div className="inline-alert">
              {returnStatusText(candidate.status)}
            </div>
          )}
          <label className="field-label" htmlFor="return-quantity">
            반품 수량
          </label>
          <input
            id="return-quantity"
            className="number-field"
            max={candidate.availableQuantity}
            min={1}
            type="number"
            value={quantity}
            onChange={(event) => onQuantityChange(Number(event.target.value))}
          />
          <button
            className="primary-action full"
            type="button"
            onClick={onCommit}
            disabled={
              candidate.status !== "ok" || candidate.availableQuantity <= 0
            }
          >
            <PackageCheck size={17} />
            반품 등록
          </button>
        </>
      )}
    </div>
  );
}

export default App;
