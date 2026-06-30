import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode, RefObject } from "react";
import {
  BrowserDatamatrixCodeReader,
  BrowserMultiFormatOneDReader,
  type IScannerControls,
} from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  CircleHelp,
  Focus,
  HardDriveDownload,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  ShieldCheck,
  SwitchCamera,
  Trash2,
  WifiOff,
  X,
  Zap,
  ZapOff,
} from "lucide-react";
import barGraphIcon from "../icons/20px/bargraph.svg";
import briefcaseIcon from "../icons/20px/briefcase.svg";
import fileTextIcon from "../icons/20px/filetext.svg";
import homeIcon from "../icons/20px/home.svg";
import pieGraphIcon from "../icons/20px/pieGraph.svg";
import viewGridIcon from "../icons/20px/view_grid-filled.svg";
import viewListIcon from "../icons/20px/view_list-filled.svg";
import pharmfarmLogo from "../logo_1.png";

const APP_BUILD_TIME = __APP_BUILD_TIME__;
const APP_COMMIT_SHA = __APP_COMMIT_SHA__;

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
  format: "query" | "gs1" | "text" | "barcode";
  errors: string[];
};

type ScanHandleResult =
  | { kind: "accepted"; qr: QrFields; cooldownMs?: number }
  | { kind: "handled"; cooldownMs?: number }
  | null;

type Wholesaler = {
  id: string;
  name: string;
  meta: string;
};

type PriceMaster = {
  id: string;
  productCode: string;
  productName: string;
  spec: string;
  unit: string;
  maxPrice: number;
};

type DrugMaster = {
  pc: string;
  drugMasterId?: string;
  insuranceCode: string;
  priceMasterId?: string;
  priceMasters?: PriceMaster[];
  name: string;
  productTotalQuantity: number;
  price: number;
  matchStatus: MatchStatus;
  virtualDrugName?: string;
  virtualInsuranceCode?: string;
  insuranceCodeExists?: boolean | null;
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
  virtualStock?: boolean;
  controlledDrug: ControlledDrugInfo;
};

type ControlledDrugInfo = {
  controlled: boolean;
  habitGroup?: string;
  habitNo?: string;
  habitKind?: string;
  shortName?: string;
  remark?: string;
  appliedDate?: string;
  locate?: string;
  unitNo?: string;
  storeCode?: string;
};

type CmsStockCreateTag = "EXISTING" | "VIRTUAL";

type CmsStockCreateDraft = {
  stockTag: CmsStockCreateTag;
  insuranceCode: string;
  name: string;
  price: number;
  quantity: number;
  productTotalQuantity: number;
  memo: string;
};

function emptyCmsStockCreateDraft(): CmsStockCreateDraft {
  return {
    stockTag: "EXISTING",
    insuranceCode: "",
    name: "",
    price: 0,
    quantity: 0,
    productTotalQuantity: 1,
    memo: "관리자 직접 생성",
  };
}

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
  transactionAt: string;
  orderItemName: string;
  productName: string;
  quantity: number;
};

type ReturnReceiptCandidate = {
  id: string;
  wholesalerName: string;
  receivedAt: string;
  productTotalQuantity: number;
  returnedQuantity: number;
  returnableQuantity: number;
};

type ReturnLookup =
  | {
      matchType: "CONFIRMED";
      pc: string;
      sn: string;
      lot: string;
      exp: string;
      drugName: string;
      insuranceCode: string;
      wholesalerName: string;
      productTotalQuantity: number;
      returnedQuantity: number;
      returnableQuantity: number;
      stockQuantity: number;
      receiptCandidates: ReturnReceiptCandidate[];
    }
  | {
      matchType: "ESTIMATED";
      pc: string;
      sn: string;
      lot: string;
      exp: string;
      drugName: string;
      insuranceCode: string;
      message?: string;
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
      insuranceCode: string;
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

type ScanExpiryNotice = {
  display: string;
  year: number | null;
  month: number | null;
};

type CameraConstraintSet = MediaTrackConstraintSet & {
  exposureMode?: string;
  focusMode?: string;
  torch?: boolean;
  whiteBalanceMode?: string;
  zoom?: number;
};

type CameraTrackCapabilities = MediaTrackCapabilities & {
  exposureMode?: string[];
  focusMode?: string[];
  torch?: boolean;
  whiteBalanceMode?: string[];
  zoom?: {
    min?: number;
    max?: number;
    step?: number;
  };
};

type CameraTrackConstraints = MediaTrackConstraints & {
  advanced?: CameraConstraintSet[];
};

type ApiState =
  | "checking"
  | "connected"
  | "demo"
  | "unauthorized"
  | "forbidden";
type ScanPerformanceMode = "performance" | "quality";
type ScannerEngine = "web" | "native";
type ScanCodeMode = "qr" | "barcode";
type WebScannerReader =
  | BrowserDatamatrixCodeReader
  | BrowserMultiFormatOneDReader;
type VideoInputDevice = {
  deviceId: string;
  label: string;
};

const apiBase = (
  import.meta.env.VITE_PHARMFARM_API_BASE ??
  "https://api.solusi.co.kr/api/v1/pharmfarm"
).replace(/\/$/, "");
const debugToolsEnabled =
  import.meta.env.DEV || import.meta.env.VITE_PHARMFARM_DEBUG_TOOLS === "true";

const storageKeys = {
  accessToken: "pharmfarm.accessToken",
  refreshToken: "pharmfarm.refreshToken",
  authAccount: "pharmfarm.authAccount",
  cmsSidebarCollapsed: "pharmfarm.cmsSidebarCollapsed",
  scanPerformanceMode: "pharmfarm.scanPerformanceMode",
  scannerEngine: "pharmfarm.scannerEngine",
  scanCodeMode: "pharmfarm.scanCodeMode",
};
const cmsCompactNavQuery = "(max-width: 980px), (max-height: 560px)";

const alreadyProcessedAudioSrc =
  "/audio/%EC%9D%B4%EB%AF%B8_%EC%B2%98%EB%A6%AC%EB%90%9C_%EC%95%BD%ED%92%88%EC%9E%85%EB%8B%88%EB%8B%A4.mp3";
const defaultScanCooldownMs = 900;
const duplicateScanCooldownMs = 2500;
const retakeScanCooldownMs = 2800;
const minimumReliableSnLength = 6;
const virtualInsuranceCodeGenerationAttempts = 40;
const missingExpiryReceiptNotice = "약통에 있는 유효기간을 확인해주세요";
const missingExpiryAudioSrc = `/audio/${encodeURIComponent(
  "유효기간 정보가 없습니다.포장용기를 확인해주세요.mp3",
)}`;

function getMediaQueryMatches(query: string) {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => getMediaQueryMatches(query));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia(query);
    const syncMatches = () => setMatches(mediaQuery.matches);

    syncMatches();
    mediaQuery.addEventListener("change", syncMatches);
    return () => mediaQuery.removeEventListener("change", syncMatches);
  }, [query]);

  return matches;
}

function createDefaultCmsSignupDraft(): CmsSignupDraft {
  return {
    adminPassword: "",
    pharmacyName: "",
    ownerName: "",
    phone: "",
    businessRegistrationNumber: "",
    address: "",
    addressDetail: "",
    primaryLoginId: "",
    primaryPassword: "",
    limitedLoginId: "",
    limitedPassword: "",
  };
}

type TokenResponse = {
  accessToken?: string;
  refreshToken?: string;
  token?: string;
  account?: unknown;
  user?: unknown;
  data?: {
    accessToken?: string;
    refreshToken?: string;
    token?: string;
    account?: unknown;
    user?: unknown;
  };
};

type AuthAccount = {
  accountId?: string;
  pharmacyId?: string;
  pharmacyName?: string;
  loginId?: string;
  accountName?: string;
  role?: string;
  accountType?: string;
};

type CmsSignupDraft = {
  adminPassword: string;
  pharmacyName: string;
  ownerName: string;
  phone: string;
  businessRegistrationNumber: string;
  address: string;
  addressDetail: string;
  primaryLoginId: string;
  primaryPassword: string;
  limitedLoginId: string;
  limitedPassword: string;
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
    controlledDrug: { controlled: false },
  },
  {
    id: "S-002",
    pc: "669803820",
    insuranceCode: "669803820",
    name: "구주디아제팜주사",
    quantity: 12,
    price: 0,
    matchStatus: "NORMAL",
    controlledDrug: {
      controlled: true,
      habitGroup: "PDF",
      habitKind: "PDF_REFERENCE",
      shortName: "구주디아제팜주사",
      remark: "약품기본정보.pdf 기준 향정신성 의약품",
    },
  },
  {
    id: "S-003",
    pc: "8899000000201",
    insuranceCode: "3PF000124",
    name: "비급여 연고 20g",
    quantity: 8,
    price: 0,
    matchStatus: "VIRTUAL",
    controlledDrug: { controlled: false },
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
    transactionAt: "2026-01-10",
    orderItemName: "예시약 30T",
    productName: "예시약",
    quantity: 30,
  },
  {
    id: "200",
    sellerName: "지오영 도매",
    transactionAt: "2025-11-22",
    orderItemName: "예시약 30정",
    productName: "예시약",
    quantity: 60,
  },
];

function isScanPerformanceMode(mode: ScanPerformanceMode) {
  return mode === "performance";
}

function getStoredScanPerformanceMode(): ScanPerformanceMode {
  return localStorage.getItem(storageKeys.scanPerformanceMode) === "quality"
    ? "quality"
    : "performance";
}

function storeScanPerformanceMode(mode: ScanPerformanceMode) {
  localStorage.setItem(storageKeys.scanPerformanceMode, mode);
}

function getStoredScannerEngine(): ScannerEngine {
  return localStorage.getItem(storageKeys.scannerEngine) === "native"
    ? "native"
    : "web";
}

function storeScannerEngine(engine: ScannerEngine) {
  localStorage.setItem(storageKeys.scannerEngine, engine);
}

function getStoredScanCodeMode(): ScanCodeMode {
  return localStorage.getItem(storageKeys.scanCodeMode) === "barcode"
    ? "barcode"
    : "qr";
}

function storeScanCodeMode(mode: ScanCodeMode) {
  localStorage.setItem(storageKeys.scanCodeMode, mode);
}

function scanCodeModeLabel(mode: ScanCodeMode) {
  return mode === "barcode" ? "바코드" : "QR";
}

function getNativeWindow() {
  return window as Window & {
    ReactNativeWebView?: { postMessage: (message: string) => void };
    __PHARMFARM_NATIVE_APP?: boolean;
  };
}

function getReactNativeWebView() {
  const bridge = getNativeWindow().ReactNativeWebView;
  return typeof bridge?.postMessage === "function" ? bridge : null;
}

function isNativeAppShell() {
  return Boolean(
    getReactNativeWebView() || getNativeWindow().__PHARMFARM_NATIVE_APP,
  );
}

function getNativeBarcodeTypes(scanCodeMode: ScanCodeMode) {
  return scanCodeMode === "barcode"
    ? [
        "ean13",
        "ean8",
        "upc_a",
        "upc_e",
        "code128",
        "code39",
        "code93",
        "itf14",
        "codabar",
      ]
    : ["datamatrix", "qr"];
}

function postNativeScannerMessage(
  action: "start" | "stop",
  scanCodeMode: ScanCodeMode = "qr",
  attempt = 0,
) {
  const bridge = getReactNativeWebView();
  if (!bridge) {
    if (isNativeAppShell() && attempt < 8) {
      window.setTimeout(
        () => postNativeScannerMessage(action, scanCodeMode, attempt + 1),
        120,
      );
    }
    return false;
  }

  bridge.postMessage(
    JSON.stringify({
      action,
      barcodeTypes: getNativeBarcodeTypes(scanCodeMode),
      scanCodeMode,
      type: "pharmfarm-native-scanner",
    }),
  );
  return true;
}

function createScannerReader(
  scanPerformanceMode: ScanPerformanceMode,
  scanCodeMode: ScanCodeMode,
) {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.CHARACTER_SET, "UTF-8");
  const performanceMode = isScanPerformanceMode(scanPerformanceMode);
  const options = {
    delayBetweenScanAttempts: performanceMode ? 140 : 70,
    delayBetweenScanSuccess: performanceMode ? 420 : 220,
    tryPlayVideoTimeout: 5000,
  };

  if (scanCodeMode === "barcode") {
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_93,
      BarcodeFormat.ITF,
      BarcodeFormat.CODABAR,
    ]);
    return new BrowserMultiFormatOneDReader(hints, options);
  }

  return new BrowserDatamatrixCodeReader(hints, options);
}

function getCameraConstraints(
  scanPerformanceMode: ScanPerformanceMode,
  deviceId?: string,
): MediaStreamConstraints {
  const performanceMode = isScanPerformanceMode(scanPerformanceMode);
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
      ...(deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: "environment" } }),
      width: { ideal: performanceMode ? 1280 : 1920 },
      height: { ideal: performanceMode ? 720 : 1080 },
      frameRate: performanceMode
        ? { ideal: 24, max: 24, min: 10 }
        : { ideal: 30, min: 15 },
      advanced,
    },
  };
}

async function listVideoInputDevices(): Promise<VideoInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "videoinput" && device.deviceId)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `카메라 ${index + 1}`,
    }));
}

function isBackCameraLabel(label: string) {
  const normalized = label.toLowerCase();
  return /back|rear|environment|후면/.test(normalized);
}

function cameraLabelPenalty(label: string) {
  const normalized = label.toLowerCase();
  let penalty = 0;
  if (/front|user|selfie|전면/.test(normalized)) penalty += 100;
  if (/ultra|0\.5|wide angle|초광각/.test(normalized)) penalty += 18;
  if (/macro|close|근접/.test(normalized)) penalty -= 4;
  if (/back|rear|environment|후면/.test(normalized)) penalty -= 12;
  return penalty;
}

function getPreferredVideoInputDeviceId(devices: VideoInputDevice[]) {
  const labeledBackDevices = devices.filter((device) =>
    isBackCameraLabel(device.label),
  );
  if (labeledBackDevices.length === 0) return "";

  return (
    [...labeledBackDevices].sort(
      (left, right) =>
        cameraLabelPenalty(left.label) - cameraLabelPenalty(right.label),
    )[0]?.deviceId ?? ""
  );
}

function formatVideoInputLabel(device: VideoInputDevice, index: number) {
  return device.label || `카메라 ${index + 1}`;
}

function getGuidedScanSourceRect(
  video: HTMLVideoElement,
  guideElement: HTMLElement | null,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const videoRect = video.getBoundingClientRect();
  if (!sourceWidth || !sourceHeight || !videoRect.width || !videoRect.height) {
    return null;
  }

  const guideRect = guideElement?.getBoundingClientRect();
  const targetRect = guideRect
    ? {
        height: guideRect.height,
        left: guideRect.left - videoRect.left,
        top: guideRect.top - videoRect.top,
        width: guideRect.width,
      }
    : {
        height: Math.min(videoRect.width, videoRect.height) * 0.62,
        left:
          (videoRect.width -
            Math.min(videoRect.width, videoRect.height) * 0.62) /
          2,
        top:
          (videoRect.height -
            Math.min(videoRect.width, videoRect.height) * 0.62) /
          2,
        width: Math.min(videoRect.width, videoRect.height) * 0.62,
      };

  const scale = Math.max(
    videoRect.width / sourceWidth,
    videoRect.height / sourceHeight,
  );
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const cropLeftOffset = (renderedWidth - videoRect.width) / 2;
  const cropTopOffset = (renderedHeight - videoRect.height) / 2;

  const sourceLeft = (targetRect.left + cropLeftOffset) / scale;
  const sourceTop = (targetRect.top + cropTopOffset) / scale;
  const sourceCropWidth = targetRect.width / scale;
  const sourceCropHeight = targetRect.height / scale;

  const left = Math.max(0, Math.min(sourceWidth - 1, sourceLeft));
  const top = Math.max(0, Math.min(sourceHeight - 1, sourceTop));
  const right = Math.max(
    left + 1,
    Math.min(sourceWidth, sourceLeft + sourceCropWidth),
  );
  const bottom = Math.max(
    top + 1,
    Math.min(sourceHeight, sourceTop + sourceCropHeight),
  );

  return {
    height: Math.round(bottom - top),
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(right - left),
  };
}

async function waitForVideoReady(video: HTMLVideoElement) {
  if (video.readyState >= video.HAVE_METADATA) return;

  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("카메라 화면을 불러오지 못했습니다."));
    }, 5000);

    function cleanup() {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", handleReady);
      video.removeEventListener("loadeddata", handleReady);
    }

    function handleReady() {
      cleanup();
      resolve();
    }

    video.addEventListener("loadedmetadata", handleReady, { once: true });
    video.addEventListener("loadeddata", handleReady, { once: true });
  });
}

async function startGuidedWebScanner({
  constraints,
  guideElement,
  onResult,
  reader,
  scanPerformanceMode,
  video,
}: {
  constraints: MediaStreamConstraints;
  guideElement: HTMLElement | null;
  onResult: (value: string) => void;
  reader: WebScannerReader;
  scanPerformanceMode: ScanPerformanceMode;
  video: HTMLVideoElement;
}): Promise<IScannerControls> {
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const videoTracks = stream.getVideoTracks();
  const performanceMode = isScanPerformanceMode(scanPerformanceMode);
  const scanDelay = performanceMode ? 140 : 70;
  const successDelay = performanceMode ? 420 : 220;
  const cropCanvas = document.createElement("canvas");
  const cropContext = cropCanvas.getContext("2d", {
    willReadFrequently: true,
  });
  if (!cropContext) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("스캔 캔버스를 준비하지 못했습니다.");
  }
  const context = cropContext;

  let stopped = false;
  let timerId: number | null = null;

  function clearTimer() {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  }

  function scheduleScan(delay: number) {
    clearTimer();
    if (!stopped) {
      timerId = window.setTimeout(scanFrame, delay);
    }
  }

  function scanFrame() {
    if (stopped) return;

    const sourceRect = getGuidedScanSourceRect(video, guideElement);
    if (!sourceRect) {
      scheduleScan(scanDelay);
      return;
    }

    cropCanvas.width = sourceRect.width;
    cropCanvas.height = sourceRect.height;
    context.drawImage(
      video,
      sourceRect.left,
      sourceRect.top,
      sourceRect.width,
      sourceRect.height,
      0,
      0,
      sourceRect.width,
      sourceRect.height,
    );

    try {
      const value = reader.decodeFromCanvas(cropCanvas).getText();
      if (value) {
        onResult(value);
        scheduleScan(successDelay);
        return;
      }
    } catch {
      // No code in the guided area yet.
    }

    scheduleScan(scanDelay);
  }

  try {
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await waitForVideoReady(video);
    await video.play();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    throw error;
  }

  scheduleScan(0);

  const controls: IScannerControls = {
    stop() {
      stopped = true;
      clearTimer();
      stream.getTracks().forEach((track) => track.stop());
      cropCanvas.width = 1;
      cropCanvas.height = 1;
      video.pause();
      video.srcObject = null;
      video.removeAttribute("src");
    },
    streamVideoCapabilitiesGet(trackFilter) {
      return videoTracks.find(trackFilter)?.getCapabilities() ?? {};
    },
    streamVideoConstraintsApply(constraintsToApply, trackFilter) {
      const tracks = trackFilter
        ? videoTracks.filter(trackFilter)
        : videoTracks;
      void Promise.all(
        tracks.map((track) => track.applyConstraints(constraintsToApply)),
      );
    },
    streamVideoConstraintsGet(trackFilter) {
      return videoTracks.find(trackFilter)?.getConstraints() ?? {};
    },
    streamVideoSettingsGet(trackFilter) {
      return videoTracks.find(trackFilter)?.getSettings() ?? {};
    },
  };

  const torchTrack = videoTracks.find((track) => {
    const capabilities =
      typeof track.getCapabilities === "function"
        ? (track.getCapabilities() as CameraTrackCapabilities)
        : ({} as CameraTrackCapabilities);
    return Boolean(capabilities.torch);
  });

  if (torchTrack) {
    controls.switchTorch = (onOff: boolean) =>
      torchTrack.applyConstraints({
        advanced: [{ torch: onOff }],
      } as CameraTrackConstraints);
  }

  return controls;
}

function cameraCapabilityIncludes(
  capabilities: CameraTrackCapabilities,
  key: "exposureMode" | "focusMode" | "whiteBalanceMode",
  value: string,
) {
  return capabilities[key]?.includes(value) ?? false;
}

function getCameraZoomConstraint(capabilities: CameraTrackCapabilities) {
  const zoom = capabilities.zoom;
  if (!zoom) return null;

  const min = Number.isFinite(zoom.min) ? Number(zoom.min) : 1;
  const max = Number.isFinite(zoom.max) ? Number(zoom.max) : min;
  if (max <= 1.1) return null;

  const lowerBound = Math.max(min, 1);
  const target = Math.min(Math.max(1.35, lowerBound), max);
  const step = Number.isFinite(zoom.step) && zoom.step ? Number(zoom.step) : 0;
  const stepped = step
    ? Math.round((target - lowerBound) / step) * step + lowerBound
    : target;

  return Number(Math.min(max, Math.max(lowerBound, stepped)).toFixed(2));
}

function getCameraTrack(video: HTMLVideoElement) {
  const stream = video.srcObject;
  if (!(stream instanceof MediaStream)) return null;

  return stream.getVideoTracks().find((track) => track.readyState === "live");
}

async function tuneCameraTrack(
  video: HTMLVideoElement,
  mode: "startup" | "refocus" = "startup",
) {
  const track = getCameraTrack(video);
  if (!track?.applyConstraints) return "unsupported";

  const capabilities =
    typeof track.getCapabilities === "function"
      ? (track.getCapabilities() as CameraTrackCapabilities)
      : ({} as CameraTrackCapabilities);

  const advanced: CameraConstraintSet[] = [];
  if (
    mode === "refocus" &&
    cameraCapabilityIncludes(capabilities, "focusMode", "single-shot")
  ) {
    advanced.push({ focusMode: "single-shot" });
  } else if (
    cameraCapabilityIncludes(capabilities, "focusMode", "continuous")
  ) {
    advanced.push({ focusMode: "continuous" });
  }

  if (cameraCapabilityIncludes(capabilities, "exposureMode", "continuous")) {
    advanced.push({ exposureMode: "continuous" });
  }

  if (
    cameraCapabilityIncludes(capabilities, "whiteBalanceMode", "continuous")
  ) {
    advanced.push({ whiteBalanceMode: "continuous" });
  }

  const zoom = getCameraZoomConstraint(capabilities);
  if (zoom) advanced.push({ zoom });

  if (advanced.length === 0) return "unsupported";

  try {
    await track.applyConstraints({ advanced } as CameraTrackConstraints);

    if (
      mode === "refocus" &&
      cameraCapabilityIncludes(capabilities, "focusMode", "continuous")
    ) {
      window.setTimeout(() => {
        void track
          .applyConstraints({
            advanced: [{ focusMode: "continuous" }],
          } as CameraTrackConstraints)
          .catch(() => undefined);
      }, 700);
    }

    return "applied";
  } catch {
    return "failed";
  }
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

function getStoredAuthAccount(): AuthAccount | null {
  const stored = localStorage.getItem(storageKeys.authAccount);
  if (!stored) return null;

  try {
    return JSON.parse(stored) as AuthAccount;
  } catch {
    localStorage.removeItem(storageKeys.authAccount);
    return null;
  }
}

function clearAuthTokens() {
  localStorage.removeItem(storageKeys.accessToken);
  localStorage.removeItem(storageKeys.refreshToken);
  localStorage.removeItem(storageKeys.authAccount);
}

function compactAuthAccount(account: AuthAccount): AuthAccount {
  return Object.fromEntries(
    Object.entries(account).filter(
      ([, value]) => value !== undefined && value !== "",
    ),
  ) as AuthAccount;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) return {};

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = window.atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function normalizeAuthAccount(
  raw: unknown,
  token?: string,
): AuthAccount | null {
  const item = asRecord(raw);
  const data = asRecord(item.data);
  const jwt = token ? decodeJwtPayload(token) : {};
  const account = asRecord(
    item.account ?? data.account ?? item.user ?? data.user ?? item,
  );
  const pharmacy = asRecord(account.pharmacy ?? item.pharmacy ?? data.pharmacy);
  const source = {
    ...jwt,
    ...item,
    ...data,
    ...account,
    pharmacyName:
      account.pharmacyName ??
      account.pharmacy_name ??
      pharmacy.pharmacyName ??
      pharmacy.pharmacy_name ??
      pharmacy.name ??
      item.pharmacyName ??
      data.pharmacyName ??
      jwt.pharmacyName,
    pharmacyId:
      account.pharmacyId ??
      account.pharmacy_id ??
      pharmacy.pharmacyId ??
      pharmacy.pharmacy_id ??
      pharmacy.id ??
      item.pharmacyId ??
      data.pharmacyId ??
      jwt.pharmacyId,
  } as Record<string, unknown>;

  const normalized = compactAuthAccount({
    accountId:
      source.accountId !== undefined || source.sub !== undefined
        ? String(source.accountId ?? source.sub)
        : undefined,
    pharmacyId:
      source.pharmacyId !== undefined ? String(source.pharmacyId) : undefined,
    pharmacyName:
      source.pharmacyName !== undefined
        ? String(source.pharmacyName)
        : undefined,
    loginId: source.loginId !== undefined ? String(source.loginId) : undefined,
    accountName:
      source.accountName !== undefined
        ? String(source.accountName)
        : source.name !== undefined
          ? String(source.name)
          : undefined,
    role: source.role !== undefined ? String(source.role) : undefined,
    accountType:
      source.accountType !== undefined
        ? String(source.accountType)
        : source.account_type !== undefined
          ? String(source.account_type)
          : undefined,
  });

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function storeAuthAccount(account: AuthAccount | null) {
  if (!account) return getStoredAuthAccount();

  const merged = compactAuthAccount({
    ...(getStoredAuthAccount() ?? {}),
    ...account,
  });

  localStorage.setItem(storageKeys.authAccount, JSON.stringify(merged));
  return merged;
}

function storeTokenResponse(raw: TokenResponse) {
  const accessToken =
    raw.accessToken ?? raw.token ?? raw.data?.accessToken ?? raw.data?.token;
  const refreshToken = raw.refreshToken ?? raw.data?.refreshToken;

  if (!accessToken) return false;

  localStorage.setItem(storageKeys.accessToken, accessToken);
  if (refreshToken) {
    localStorage.setItem(storageKeys.refreshToken, refreshToken);
  }
  storeAuthAccount(normalizeAuthAccount(raw, accessToken));
  return true;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;

  return JSON.parse(text) as T;
}

class ApiError extends Error {
  status: number;
  code: unknown;

  constructor(message: string, status: number, code?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function getApiEnvelopeError(raw: unknown, status: number) {
  const item = asRecord(raw);
  if (item.success !== false) return null;

  const payload = asRecord(item.data);
  const message = String(
    item.message ?? payload.message ?? `HTTP ${status}`,
  ).trim();

  return new ApiError(message || `HTTP ${status}`, status, item.code);
}

async function createApiErrorFromResponse(response: Response) {
  const fallback = `HTTP ${response.status}`;

  try {
    const text = await response.text();
    if (!text) return new ApiError(fallback, response.status);

    const data = JSON.parse(text) as unknown;
    const envelopeError = getApiEnvelopeError(data, response.status);
    if (envelopeError) return envelopeError;

    const item = asRecord(data);
    const payload = asRecord(item.data);
    const message = String(item.message ?? payload.message ?? "").trim();

    return new ApiError(message || fallback, response.status, item.code);
  } catch {
    return new ApiError(fallback, response.status);
  }
}

async function parseApiResponse<T>(response: Response) {
  const data = await parseJsonResponse<T>(response);
  const envelopeError = getApiEnvelopeError(data, response.status);
  if (envelopeError) throw envelopeError;

  return data;
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
    throw await createApiErrorFromResponse(response);
  }

  return parseApiResponse<T>(response);
}

let refreshAccessTokenRequest: Promise<boolean> | null = null;

async function performRefreshAccessToken() {
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

async function refreshAccessToken() {
  refreshAccessTokenRequest ??= performRefreshAccessToken().finally(() => {
    refreshAccessTokenRequest = null;
  });

  return refreshAccessTokenRequest;
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
    throw await createApiErrorFromResponse(response);
  }

  return parseApiResponse<T>(response);
}

async function optionalCmsApiFetch<T>(path: string): Promise<T | null> {
  try {
    return await apiFetch<T>(path);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "UNAUTHORIZED" || error.message === "FORBIDDEN")
    ) {
      throw error;
    }
    return null;
  }
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

async function requestVirtualInsuranceCode() {
  const data = await apiFetch<unknown>("/insurance-codes/generate-virtual", {
    method: "POST",
  });
  const item = asRecord(data);
  const payload = asRecord(item.data);
  const insuranceCode = String(
    payload.insuranceCode ??
      payload.virtualInsuranceCode ??
      payload.code ??
      item.insuranceCode ??
      item.virtualInsuranceCode ??
      item.code ??
      "",
  );
  if (!insuranceCode) throw new Error("임의 보험코드 응답이 비어 있습니다.");
  return insuranceCode;
}

async function checkInsuranceCodeExists(insuranceCode: string) {
  const params = new URLSearchParams({ insuranceCode });
  const data = await apiFetch<unknown>(`/insurance-codes/exists?${params}`);
  const item = asRecord(data);
  const payload = asRecord(item.data);

  return normalizeBoolean(payload.exists ?? item.exists);
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0" || normalized === "") {
      return false;
    }
  }

  return false;
}

function normalizeControlledDrug(
  raw: unknown,
  fallbackControlled = false,
): ControlledDrugInfo {
  const item = asRecord(raw);
  const controlled = normalizeBoolean(
    item.controlled ?? item.isControlled ?? item.controlledDrug ?? raw,
  );

  if (!controlled && !fallbackControlled) {
    return { controlled: false };
  }

  return {
    controlled: true,
    habitGroup: optionalText(item.habitGroup),
    habitNo: optionalText(item.habitNo),
    habitKind: optionalText(item.habitKind),
    shortName: optionalText(item.shortName),
    remark: optionalText(item.remark),
    appliedDate: optionalText(item.appliedDate),
    locate: optionalText(item.locate),
    unitNo: optionalText(item.unitNo),
    storeCode: optionalText(item.storeCode),
  };
}

function optionalText(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (text.length === 0) return undefined;
  const normalized = text.toLowerCase();
  return normalized === "undefined" || normalized === "null" ? undefined : text;
}

function normalizeWholesaler(raw: unknown, index: number): Wholesaler {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? item.wholesalerId ?? index),
    name: String(item.name ?? item.wholesalerName ?? item.sellerName ?? "-"),
    meta: String(item.meta ?? item.typeName ?? item.address ?? "공통"),
  };
}

function mergeWholesalers(current: Wholesaler[], incoming: Wholesaler[]) {
  const next = new Map(
    current.map((wholesaler) => [wholesaler.id, wholesaler]),
  );

  incoming.forEach((wholesaler) => {
    next.set(wholesaler.id, wholesaler);
  });

  return [...next.values()];
}

function normalizeStock(raw: unknown, index: number): StockItem {
  const item = raw as Record<string, unknown>;
  const quantity = finiteNumber(
    item.quantity ?? item.count ?? item.stockQuantity ?? 0,
  );
  const price = finiteNumber(item.price ?? item.unitPrice ?? item.upperPrice);
  const controlledDrug = normalizeControlledDrug(
    item.controlledDrug,
    normalizeBoolean(
      item.controlled ??
        item.isControlled ??
        item.controlledDrugYn ??
        item.psychotropic,
    ),
  );
  const matchStatus = normalizeMatchStatus(item.matchStatus);
  const virtualStock =
    normalizeBoolean(
      item.virtualStock ?? item.isVirtualStock ?? item.virtual ?? false,
    ) || matchStatus === "VIRTUAL";

  return {
    id: String(item.id ?? item.stockId ?? index),
    pc: String(item.pc ?? item.standardCode ?? ""),
    insuranceCode: String(item.insuranceCode ?? item.productCode ?? ""),
    name: String(
      item.name ?? item.drugName ?? item.productName ?? "미확인 약품",
    ),
    quantity,
    price,
    matchStatus,
    virtualStock,
    controlledDrug,
  };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function unwrapObjectPayload(raw: unknown): Record<string, unknown> {
  const item = asRecord(raw);

  for (const key of ["data", "result", "payload", "item"]) {
    const value = item[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return asRecord(value);
    }
  }

  return item;
}

function firstArrayPayload(raw: unknown, keys: string[]) {
  if (Array.isArray(raw)) return raw;

  const item = asRecord(raw);
  for (const key of keys) {
    const value = item[key];
    if (Array.isArray(value)) return value;
  }

  return [];
}

function optionalId(value: string | number | undefined | null) {
  if (value === undefined || value === null || value === "") return undefined;
  const numericValue = Number(value);
  return Number.isNaN(numericValue) ? String(value) : numericValue;
}

function normalizePriceMaster(raw: unknown, index: number): PriceMaster {
  const item = asRecord(raw);
  return {
    id: String(item.id ?? item.priceMasterId ?? item.productCode ?? index),
    productCode: String(
      item.productCode ?? item.insuranceCode ?? item.code ?? "",
    ),
    productName: String(
      item.productName ??
        item.name ??
        item.drugName ??
        item["제품명"] ??
        "미확인 약품",
    ),
    spec: String(item.spec ?? item.standard ?? item.drugSpec ?? "-"),
    unit: String(item.unit ?? "-"),
    maxPrice: Number(
      item.maxPrice ??
        item.price ??
        item.upperPrice ??
        item.ceilingPrice ??
        item["상한금액표금액"] ??
        item["상한금액표 금액"] ??
        0,
    ),
  };
}

function normalizeReceiptValidation(raw: unknown, qr: QrFields): DrugMaster {
  const item = unwrapObjectPayload(raw);
  const priceMasters = firstArrayPayload(item, [
    "priceMasters",
    "priceMasterCandidates",
    "candidates",
    "items",
    "content",
    "data",
  ]).map(normalizePriceMaster);
  const firstPrice = priceMasters[0];
  const rawDrugMasterId = item.drugMasterId ?? item.masterId ?? item.id;
  const insuranceCode = String(
    item.insuranceCode ?? item.productCode ?? item["제품코드(개정후)"] ?? "",
  );
  const name = String(
    item.drugName ??
      item.name ??
      item.koreanName ??
      item.koreanProductName ??
      item["한글상품명"] ??
      firstPrice?.productName ??
      "미확인 약품",
  );
  const productTotalQuantity = Number(
    item.totalQuantity ??
      item.productTotalQuantity ??
      item.packageQuantity ??
      item["제품총수량"] ??
      0,
  );
  const hasDrugMaster = Boolean(
    rawDrugMasterId ||
    insuranceCode ||
    productTotalQuantity > 0 ||
    (name && name !== "미확인 약품"),
  );
  const exactPrice = priceMasters.find(
    (price) => price.productCode && price.productCode === insuranceCode,
  );
  const selectedPrice =
    exactPrice ?? (priceMasters.length === 1 ? firstPrice : undefined);
  const matchStatus: MatchStatus = selectedPrice
    ? exactPrice
      ? "NORMAL"
      : "NAME_MATCH"
    : priceMasters.length > 0
      ? "NAME_MATCH"
      : !hasDrugMaster
        ? "MISSING"
        : "VIRTUAL";

  return {
    pc: String(item.pc ?? item.standardCode ?? qr.pc),
    drugMasterId:
      rawDrugMasterId === undefined || rawDrugMasterId === null
        ? undefined
        : String(rawDrugMasterId),
    insuranceCode: selectedPrice?.productCode ?? insuranceCode,
    priceMasterId: selectedPrice?.id,
    priceMasters,
    name: selectedPrice?.productName ?? name,
    productTotalQuantity,
    price: selectedPrice?.maxPrice ?? Number(item.price ?? item.maxPrice ?? 0),
    matchStatus,
    virtualDrugName: selectedPrice ? "" : name,
    virtualInsuranceCode: selectedPrice ? "" : insuranceCode,
    insuranceCodeExists: null,
  };
}

function normalizeMatchStatus(value: unknown): MatchStatus {
  const raw = String(value ?? "NORMAL").toUpperCase();
  if (raw.includes("NAME") || raw.includes("이름")) return "NAME_MATCH";
  if (raw.includes("VIRTUAL") || raw.includes("가상") || raw.includes("임의")) {
    return "VIRTUAL";
  }
  if (raw.includes("MISSING") || raw.includes("미등록")) return "MISSING";
  return "NORMAL";
}

function normalizeLookupSn(value: unknown, fallback: string) {
  const sn = String(value ?? fallback ?? "").trim();
  return sn.startsWith("PC_ONLY:") ? "" : sn;
}

function normalizeLookup(raw: unknown, qr: QrFields): ReturnLookup {
  const item = unwrapObjectPayload(raw);
  const sellerCandidates = firstArrayPayload(item, [
    "sellerCandidates",
    "purchaseHistoryCandidates",
    "purchaseHistoryCandidateList",
    "sellerCandidateList",
    "candidates",
    "purchaseHistories",
    "purchaseHistoryList",
    "histories",
    "data",
  ]).map(normalizeCandidate);
  const rawMatchType = String(
    item.matchType ?? item.type ?? item.resultType ?? item.status ?? "NONE",
  ).toUpperCase();
  const matchType = rawMatchType.includes("CONFIRM")
    ? "CONFIRMED"
    : rawMatchType.includes("ESTIMAT") ||
        rawMatchType.includes("CANDIDATE") ||
        rawMatchType.includes("PURCHASE") ||
        sellerCandidates.length > 0
      ? "ESTIMATED"
      : "NONE";

  if (matchType === "CONFIRMED") {
    const receiptCandidates = firstArrayPayload(item, [
      "receiptCandidates",
      "stockItemCandidates",
      "stockItems",
      "items",
    ]).map(normalizeReturnReceiptCandidate);
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
      sn: normalizeLookupSn(item.sn, qr.sn),
      lot: String(item.lot ?? qr.lot),
      exp: String(item.exp ?? qr.exp),
      drugName: String(item.drugName ?? item.name ?? "미확인 약품"),
      insuranceCode: String(item.insuranceCode ?? item.productCode ?? ""),
      wholesalerName: String(item.wholesalerName ?? item.sellerName ?? "-"),
      productTotalQuantity,
      returnedQuantity,
      returnableQuantity,
      stockQuantity: Number(item.stockQuantity ?? returnableQuantity),
      receiptCandidates,
    };
  }

  if (matchType === "ESTIMATED") {
    return {
      matchType: "ESTIMATED",
      pc: String(item.pc ?? qr.pc),
      sn: String(item.sn ?? qr.sn),
      lot: String(item.lot ?? qr.lot),
      exp: String(item.exp ?? qr.exp),
      drugName: String(item.drugName ?? item.name ?? "미확인 약품"),
      insuranceCode: String(item.insuranceCode ?? item.productCode ?? ""),
      message: String(
        item.message ??
          "입고 이력은 없지만 구매 내역 기준 판매처 후보가 있습니다.",
      ),
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
    insuranceCode: String(item.insuranceCode ?? item.productCode ?? ""),
    message: String(item.message ?? "입고 내역이 확인되지 않는 상품입니다."),
  };
}

function noReceiptHistoryLookup(
  lookup: ReturnLookup,
): Extract<ReturnLookup, { matchType: "NONE" }> {
  return {
    matchType: "NONE",
    pc: lookup.pc,
    sn: lookup.sn,
    lot: lookup.lot,
    exp: lookup.exp,
    drugName: lookup.drugName,
    insuranceCode: lookup.insuranceCode,
    message: "입고 내역이 확인되지 않는 상품입니다.",
  };
}

function formatTransactionAt(value: unknown, fallback = "-") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  if (raw === "-" || raw === "공통") return raw;

  const match = raw.match(
    /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2}))?/,
  );

  if (!match) return raw;

  const [, year, month, day, hour, minute] = match;
  const date = `${year}.${month.padStart(2, "0")}.${day.padStart(2, "0")}`;
  if (!hour || !minute) return date;

  return `${date} ${hour.padStart(2, "0")}:${minute}`;
}

function normalizeCandidate(raw: unknown, index: number): SellerCandidate {
  const item = asRecord(raw);
  const sellerName = String(
    item.sellerName ??
      item.wholesalerName ??
      item.vendorName ??
      item.companyName ??
      item.name ??
      "-",
  );
  const orderItemName = String(
    item.orderItemName ??
      item.inventoryName ??
      item.orderProductName ??
      (item.common === true ? "공통 도매처" : "판매처 후보"),
  );

  return {
    id: String(
      item.id ??
        item.purchaseHistoryId ??
        item.wholesalerId ??
        item.sellerId ??
        index,
    ),
    sellerName,
    transactionAt: formatTransactionAt(
      item.transactionAt ??
        item.orderDate ??
        item.purchaseDate ??
        item.createdAt ??
        (item.common === true ? "공통" : "-"),
    ),
    orderItemName,
    productName: String(
      item.productName ??
        item.drugName ??
        item.inventoryProductName ??
        item.inventoryName ??
        item.orderItemName ??
        "",
    ),
    quantity: Number(item.quantity ?? item.productTotalQuantity ?? 0),
  };
}

function normalizeReturnReceiptCandidate(
  raw: unknown,
  index: number,
): ReturnReceiptCandidate {
  const item = asRecord(raw);
  return {
    id: String(item.id ?? item.stockItemId ?? index),
    wholesalerName: String(item.wholesalerName ?? item.sellerName ?? "-"),
    receivedAt: formatTransactionAt(item.receivedAt ?? item.createdAt),
    productTotalQuantity: Number(
      item.productTotalQuantity ?? item.packageQuantity ?? 0,
    ),
    returnedQuantity: Number(item.returnedQuantity ?? 0),
    returnableQuantity: Number(
      item.returnableQuantity ?? item.availableQuantity ?? 0,
    ),
  };
}

function parseQrPayload(rawValue: string): QrFields {
  const raw = rawValue.trim();
  const queryFields = parseQueryQr(raw);
  const gs1Fields = parseGs1Qr(raw);
  const plainPcFields = parsePlainPcQr(raw);
  const textFields = parseTextQr(raw);
  const fields = queryFields ?? gs1Fields ?? plainPcFields ?? textFields;
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

  return result;
}

function parseBarcodePayload(rawValue: string): QrFields {
  const raw = rawValue.trim();
  const structured = parseQrPayload(raw);
  if (structured.pc) {
    return {
      ...structured,
      format: "barcode",
    };
  }

  const digits = raw.replace(/\D/g, "");
  const pc = normalizePc(digits || raw);
  const result: QrFields = {
    pc,
    sn: "",
    lot: "",
    exp: "",
    raw,
    format: "barcode",
    errors: [],
  };

  if (!result.pc) result.errors.push("PC 없음");

  return result;
}

function getLowConfidenceSnReason(qr: QrFields) {
  const sn = qr.sn.trim();
  if (!sn) return "";

  const comparableSn = sn.replace(/[^0-9A-Za-z]/g, "");
  if (
    comparableSn.length > 0 &&
    comparableSn.length < minimumReliableSnLength
  ) {
    return `SN이 ${sn}로 너무 짧게 인식되었습니다.`;
  }

  return "";
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

function parsePlainPcQr(raw: string) {
  const compact = raw.trim();
  if (!/^\d{13,14}$/.test(compact)) return null;

  return {
    pc: compact,
    sn: "",
    lot: "",
    exp: "",
  };
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
  const lot = readVariableGs1Ai(compact, "10", expEnd, {
    stopAtVariableAis: ["21"],
  });
  const sn = readVariableGs1Ai(compact, "21", expEnd, {
    stopAtFixedAis: false,
    stopAtVariableAis: [],
  });
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

function readVariableGs1Ai(
  raw: string,
  ai: string,
  start: number,
  options: {
    stopAtFixedAis?: boolean;
    stopAtVariableAis?: string[];
  } = {},
) {
  const index = raw.indexOf(ai, Math.max(0, start));
  if (index < 0) return "";

  const valueStart = index + 2;
  const separatorIndex = raw.indexOf("\x1d", valueStart);
  const nextAiIndex =
    separatorIndex >= 0
      ? separatorIndex
      : findNextGs1Ai(raw, valueStart, options);
  const valueEnd = nextAiIndex >= 0 ? nextAiIndex : raw.length;

  return raw.slice(valueStart, valueEnd).replace(/\x1d/g, "").trim();
}

function findNextGs1Ai(
  raw: string,
  start: number,
  {
    stopAtFixedAis = true,
    stopAtVariableAis = ["10", "21"],
  }: {
    stopAtFixedAis?: boolean;
    stopAtVariableAis?: string[];
  } = {},
) {
  for (let index = start + 1; index < raw.length - 1; index += 1) {
    const ai = raw.slice(index, index + 2);

    if (
      stopAtFixedAis &&
      ai === "01" &&
      /^\d{14}/.test(raw.slice(index + 2, index + 16))
    ) {
      return index;
    }
    if (
      stopAtFixedAis &&
      ai === "17" &&
      /^\d{6}/.test(raw.slice(index + 2, index + 8))
    ) {
      return index;
    }
    if (stopAtVariableAis.includes(ai)) {
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

function formatExpiryNotice(exp: string): ScanExpiryNotice {
  const trimmed = exp.trim();
  const parts = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!parts) {
    return {
      display: trimmed || missingExpiryReceiptNotice,
      year: null,
      month: null,
    };
  }

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const validDate = new Date(Date.UTC(year, month - 1, day));
  const isValid =
    validDate.getUTCFullYear() === year &&
    validDate.getUTCMonth() === month - 1 &&
    validDate.getUTCDate() === day;

  if (!isValid) {
    return {
      display: trimmed,
      year: null,
      month: null,
    };
  }

  return {
    display: `${parts[1]}.${parts[2]}`,
    year,
    month,
  };
}

function getExpiryAudioSources(notice: ScanExpiryNotice) {
  if (!notice.year || !notice.month) {
    return notice.display === missingExpiryReceiptNotice
      ? [missingExpiryAudioSrc]
      : [];
  }

  return [
    `/audio/year/${notice.year}.mp3`,
    `/audio/month/${String(notice.month).padStart(2, "0")}.mp3`,
  ];
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
      return "임의";
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

function deductionStatusText(status: CmsDeductionStatus) {
  switch (status) {
    case "DEDUCTED":
      return "자동 차감";
    case "PARTIAL_DEDUCTED":
      return "부분 차감";
    case "SHORTAGE":
      return "초과 처방";
    case "RESOLVED":
      return "처리 완료";
    case "PENDING":
      return "대기";
    default:
      return "실패";
  }
}

function deductionStatusClass(status: CmsDeductionStatus) {
  switch (status) {
    case "DEDUCTED":
      return "normal";
    case "PARTIAL_DEDUCTED":
      return "virtual";
    case "SHORTAGE":
      return "missing";
    case "RESOLVED":
      return "name";
    case "PENDING":
      return "virtual";
    default:
      return "missing";
  }
}

function shortageStatusText(status?: CmsShortageStatus) {
  switch (status) {
    case "ORDERED":
      return "주문 완료";
    case "HOLD":
    case "RESOLVED":
    case "IGNORED":
      return "보류";
    default:
      return "주문 필요";
  }
}

function isHoldShortageStatus(status?: CmsShortageStatus) {
  return status === "HOLD" || status === "RESOLVED" || status === "IGNORED";
}

function isOpenShortageStatus(status?: CmsShortageStatus) {
  return !status || status === "OPEN";
}

function returnReviewStatusText(status?: CmsReturnReviewStatus) {
  switch (status) {
    case "HOLD":
      return "보류";
    case "RESOLVED":
      return "처리 완료";
    default:
      return "확인 필요";
  }
}

function returnReviewWholesalerCandidates(summary: string) {
  const unique = new Map<string, string>();

  summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const candidate = line
        .split("·")[0]
        .replace(/^[-•\s]+/, "")
        .trim();
      if (!candidate || candidate === "-" || candidate === "없음") return;
      const key = normalizeSearchText(candidate);
      if (!key || unique.has(key)) return;
      unique.set(key, candidate);
    });

  return Array.from(unique.values());
}

function resolutionText(resolutionType: CmsDeductionResolution) {
  switch (resolutionType) {
    case "EXISTING_STOCK":
      return "재고가 있는 약으로 차감";
    case "VIRTUAL_DRUG":
      return "임의 약품으로 차감";
    case "UNREGISTERED_DRUG":
      return "재고 반영 없이 완료";
    default:
      return resolutionType;
  }
}

function priceCandidateKey(price: PriceMaster) {
  return `${normalizeSearchText(price.productName)}|${normalizeSearchText(
    price.productCode,
  )}`;
}

function uniquePriceMasters(prices: PriceMaster[], selectedId?: string) {
  const unique = new Map<string, PriceMaster>();

  for (const price of prices) {
    const key = priceCandidateKey(price);
    const current = unique.get(key);
    if (!current || price.id === selectedId) {
      unique.set(key, price);
    }
  }

  return Array.from(unique.values());
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function isPersistedImportJobId(jobId: string) {
  return /^\d+$/.test(jobId.trim());
}

function finiteNumber(value: unknown, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Object.is(numericValue, -0) ? 0 : numericValue;
}

function optionalFiniteNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return undefined;
  return Object.is(numericValue, -0) ? 0 : numericValue;
}

function currency(value: number) {
  return new Intl.NumberFormat("ko-KR").format(finiteNumber(value));
}

function compactKoreanCurrency(value: number) {
  const amount = finiteNumber(value);
  const absAmount = Math.abs(amount);
  const units = [
    { label: "억", value: 100_000_000 },
    { label: "만", value: 10_000 },
  ];
  const unit = units.find((item) => absAmount >= item.value);

  if (!unit) return currency(amount);

  const scaled = amount / unit.value;
  const absScaled = Math.abs(scaled);
  const maximumFractionDigits = absScaled >= 100 ? 0 : absScaled >= 10 ? 1 : 2;
  const formatted = new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits,
  }).format(scaled);

  return `${formatted}${unit.label}`;
}

function clampReturnQuantity(value: number, max: number) {
  if (max <= 0) return 0;
  const normalized = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(1, Math.min(max, normalized));
}

function normalizeSearchText(value: string) {
  return value.replace(/\s+/g, "").toLowerCase();
}

function userFacingConnectionMessage(value: unknown) {
  return String(value ?? "")
    .replace(/baropharm_session/gi, "구매내역 인증 정보")
    .replace(/cookie/gi, "연결 정보")
    .replace(/쿠키/g, "연결 정보");
}

function extractCookieTokenValue(
  value: string,
  key: "sessionid" | "csrftoken",
) {
  const normalized = value.replace(/^Cookie:\s*/i, "").trim();
  const pair = normalized
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.toLowerCase().startsWith(`${key}=`));

  if (pair) return pair.slice(pair.indexOf("=") + 1).trim();
  return normalized.replace(new RegExp(`^${key}\\s*=\\s*`, "i"), "").trim();
}

function buildBaropharmCookie(draft: BaropharmCookieDraft) {
  const sessionId = extractCookieTokenValue(draft.sessionId, "sessionid");
  const csrfToken = extractCookieTokenValue(draft.csrfToken, "csrftoken");
  if (!sessionId || !csrfToken) return "";
  return `sessionid=${sessionId}; csrftoken=${csrfToken};`;
}

function normalizeInsuranceCode(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

function isMeaningfulInsuranceCode(value: string | undefined) {
  const normalized = normalizeInsuranceCode(value);
  return normalized.length > 0 && normalized !== "-";
}

function stockNameMatchesRecord(stock: StockItem, record: CmsDeductionRecord) {
  const stockName = normalizeSearchText(stock.name);
  const recordName = normalizeSearchText(record.drugName);
  if (!stockName || !recordName) return false;
  return stockName.includes(recordName) || recordName.includes(stockName);
}

function prescriptionCandidateDefaultQuery(record: CmsDeductionRecord) {
  const drugName = record.drugName.trim();
  if (
    drugName &&
    normalizeSearchText(drugName).length >= 2 &&
    drugName !== "-"
  ) {
    return drugName;
  }
  return isMeaningfulInsuranceCode(record.insuranceCode)
    ? record.insuranceCode.trim()
    : drugName || record.insuranceCode.trim();
}

function prescriptionCandidateQueries(
  record: CmsDeductionRecord,
  query: string,
) {
  const trimmed = query.trim();
  if (normalizeSearchText(trimmed).length < 2) return [];

  const queries = [trimmed];
  const isDefaultQuery =
    normalizeSearchText(trimmed) ===
    normalizeSearchText(prescriptionCandidateDefaultQuery(record));

  if (isDefaultQuery) {
    if (isMeaningfulInsuranceCode(record.insuranceCode)) {
      queries.unshift(record.insuranceCode);
    }
    if (record.drugName.trim()) {
      queries.push(record.drugName);
    }
  }

  const unique = new Map<string, string>();
  queries.forEach((candidate) => {
    const key = normalizeSearchText(candidate);
    if (key) unique.set(key, candidate);
  });
  return [...unique.values()];
}

function stockCandidateScore(
  stock: StockItem,
  record: CmsDeductionRecord,
  query: string,
) {
  const stockCode = normalizeInsuranceCode(stock.insuranceCode);
  const recordCode = normalizeInsuranceCode(record.insuranceCode);
  const queryText = normalizeSearchText(query);
  const queryCode = normalizeInsuranceCode(query);
  const stockName = normalizeSearchText(stock.name);
  const recordName = normalizeSearchText(record.drugName);
  let score = 0;

  if (
    isMeaningfulInsuranceCode(record.insuranceCode) &&
    stockCode === recordCode
  ) {
    score += 100;
  }
  if (stockName && recordName && stockName === recordName) score += 80;
  if (stockNameMatchesRecord(stock, record)) score += 55;
  if (queryCode && stockCode.includes(queryCode)) score += 35;
  if (queryText && stockName.includes(queryText)) score += 25;
  if (stock.quantity > 0) score += 5;
  return score;
}

function stockCandidateLabel(stock: StockItem, record: CmsDeductionRecord) {
  const stockCode = normalizeInsuranceCode(stock.insuranceCode);
  const recordCode = normalizeInsuranceCode(record.insuranceCode);
  const codeMatched =
    isMeaningfulInsuranceCode(record.insuranceCode) && stockCode === recordCode;
  const nameMatched = stockNameMatchesRecord(stock, record);

  if (codeMatched && nameMatched) return "보험코드/약명 일치";
  if (codeMatched) return "보험코드 일치";
  if (nameMatched) return "약명 유사";
  return "검색 결과";
}

function mergeStockCandidates(stocks: StockItem[]) {
  const unique = new Map<string, StockItem>();
  stocks.forEach((stock) => {
    if (!unique.has(stock.id)) unique.set(stock.id, stock);
  });
  return [...unique.values()];
}

function localStockCandidates(
  stocks: StockItem[],
  record: CmsDeductionRecord,
  query: string,
) {
  const queryText = normalizeSearchText(query);
  const queryCode = normalizeInsuranceCode(query);
  return stocks.filter((stock) => {
    const stockCode = normalizeInsuranceCode(stock.insuranceCode);
    const stockText = normalizeSearchText(
      `${stock.name} ${stock.insuranceCode}`,
    );
    return (
      stockCandidateScore(stock, record, query) >= 55 ||
      (queryText.length >= 2 && stockText.includes(queryText)) ||
      (queryCode.length >= 2 && stockCode.includes(queryCode))
    );
  });
}

function filterStocksByControlledFilter(
  stocks: StockItem[],
  controlledFilter: CmsStockControlledFilter,
) {
  if (controlledFilter === "CONTROLLED") {
    return stocks.filter((stock) => stock.controlledDrug.controlled);
  }
  if (controlledFilter === "NON_CONTROLLED") {
    return stocks.filter((stock) => !stock.controlledDrug.controlled);
  }
  if (controlledFilter === "VIRTUAL") {
    return stocks.filter(isVirtualStock);
  }
  return stocks;
}

function sortStockItems(
  stocks: StockItem[],
  sortKey: CmsStockSortKey,
  sortDirection: CmsStockSortDirection,
) {
  const direction = sortDirection === "asc" ? 1 : -1;

  return [...stocks].sort((left, right) => {
    const compared =
      sortKey === "name"
        ? left.name.localeCompare(right.name, "ko")
        : left.quantity - right.quantity;

    if (compared !== 0) return compared * direction;
    return left.name.localeCompare(right.name, "ko");
  });
}

function nextStockSortDirection(
  currentKey: CmsStockSortKey,
  currentDirection: CmsStockSortDirection,
  nextKey: CmsStockSortKey,
) {
  if (currentKey === nextKey) {
    return currentDirection === "asc" ? "desc" : "asc";
  }
  return nextKey === "quantity" ? "desc" : "asc";
}

function stockSortAriaLabel(
  label: string,
  key: CmsStockSortKey,
  sortKey: CmsStockSortKey,
  sortDirection: CmsStockSortDirection,
) {
  if (sortKey !== key) return `${label} 정렬`;
  return `${label} ${sortDirection === "asc" ? "오름차순" : "내림차순"} 정렬`;
}

function StockSortIcon({
  active,
  direction,
}: {
  active: boolean;
  direction: CmsStockSortDirection;
}) {
  if (!active) {
    return (
      <ArrowUpDown
        aria-hidden="true"
        className="cms-sort-icon"
        size={14}
        strokeWidth={2.4}
      />
    );
  }

  const Icon = direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <Icon
      aria-hidden="true"
      className="cms-sort-icon"
      size={14}
      strokeWidth={2.6}
    />
  );
}

function isVirtualStock(stock: StockItem) {
  return Boolean(stock.virtualStock) || stock.matchStatus === "VIRTUAL";
}

function stockControlledFilterText(filter: CmsStockControlledFilter) {
  switch (filter) {
    case "CONTROLLED":
      return "향정";
    case "NON_CONTROLLED":
      return "비향정";
    case "VIRTUAL":
      return "임의";
    default:
      return "전체";
  }
}

function stockSearchMessage(
  controlledFilter: CmsStockControlledFilter,
  searched: boolean,
) {
  const filterText = stockControlledFilterText(controlledFilter);
  if (controlledFilter === "ALL") {
    return searched ? "재고 검색 완료" : "재고 목록 갱신 완료";
  }
  return searched
    ? `${filterText} 재고 검색 완료`
    : `${filterText} 재고 목록 갱신 완료`;
}

function createVirtualInsuranceCodeCandidate(
  baseCode: string,
  attempt: number,
) {
  const normalized = normalizeInsuranceCode(baseCode);
  if (attempt === 0) return normalized;

  const match = normalized.match(/^(.*?)(\d+)$/);
  if (!match) {
    return `${normalized}${attempt + 1}`;
  }

  const [, prefix, digits] = match;
  const next = BigInt(digits) + BigInt(attempt);

  return `${prefix}${next.toString().padStart(digits.length, "0")}`;
}

function getUiPreviewMode() {
  const preview = new URLSearchParams(window.location.search).get("preview");
  return preview === "receipt-match" ? preview : null;
}

function previewPriceMaster(
  id: string,
  productName: string,
  productCode: string,
  maxPrice: number,
): PriceMaster {
  return {
    id,
    maxPrice,
    productCode,
    productName,
    spec: "30정",
    unit: "정",
  };
}

function createReceiptPreviewBatchId() {
  return `${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`.toUpperCase();
}

const initialReceiptPreviewBatchId = createReceiptPreviewBatchId();

function previewQr(
  id: string,
  pc: string,
  batchId = initialReceiptPreviewBatchId,
): QrFields {
  const serialId = id
    .replace(/^PREVIEW-/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 12)
    .toUpperCase();

  return {
    errors: [],
    exp: "2027-12-31",
    format: "gs1",
    lot: `LOT-UI-${batchId}`,
    pc,
    raw: `preview-${batchId}-${id}-${pc}`,
    sn: `SN-UI-${batchId}-${serialId}`,
  };
}

function previewReceiptItem(
  id: string,
  status: MatchStatus,
  name: string,
  pc: string,
  options: {
    drugMasterId?: string;
    insuranceCode?: string;
    priceMasterId?: string;
    priceMasters?: PriceMaster[];
    productTotalQuantity?: number;
    virtualCode?: string;
  } = {},
): ReceiptQueueItem {
  const insuranceCode = options.insuranceCode ?? pc.slice(-9);

  return {
    id,
    drug: {
      insuranceCode: options.virtualCode ?? insuranceCode,
      insuranceCodeExists: status === "MISSING" ? null : false,
      drugMasterId: options.drugMasterId,
      matchStatus: status,
      name,
      pc,
      price: status === "MISSING" ? 0 : 120,
      priceMasterId: options.priceMasterId,
      priceMasters: options.priceMasters,
      productTotalQuantity: options.productTotalQuantity ?? 30,
      virtualDrugName: status === "VIRTUAL" ? `${name} 임의 재고` : undefined,
      virtualInsuranceCode: options.virtualCode,
    },
    qr: previewQr(id, pc),
  };
}

function createReceiptMatchPreviewQueue(): ReceiptQueueItem[] {
  const duplicatedAmoxi = [
    previewPriceMaster(
      "698505110",
      "페노피타정(피타바스타틴칼슘,페노피브레이트)",
      "698505110",
      0,
    ),
    previewPriceMaster(
      "698505100",
      "페노피브정160밀리그램(페노피브레이트)",
      "698505100",
      0,
    ),
    previewPriceMaster(
      "698504990",
      "테독시움정(도베실산칼슘수화물)",
      "698504990",
      0,
    ),
  ];

  return [
    previewReceiptItem(
      "PREVIEW-NORMAL-1",
      "NORMAL",
      "푸란투스정(프란루카스트수화물)",
      "8806985051929",
      {
        drugMasterId: "90",
        insuranceCode: "698505190",
        priceMasterId: "698505190",
        productTotalQuantity: 300,
      },
    ),
    previewReceiptItem(
      "PREVIEW-NORMAL-2",
      "NORMAL",
      "가바민서방정150밀리그램(레바미피드)",
      "8806985051813",
      {
        drugMasterId: "94",
        insuranceCode: "698505180",
        priceMasterId: "698505180",
        productTotalQuantity: 30,
      },
    ),
    previewReceiptItem(
      "PREVIEW-NORMAL-3",
      "NORMAL",
      "가바텍스캡슐100밀리그램(가바펜틴)",
      "8806985051615",
      {
        drugMasterId: "97",
        insuranceCode: "698505160",
        priceMasterId: "698505160",
        productTotalQuantity: 30,
      },
    ),
    previewReceiptItem(
      "PREVIEW-NORMAL-4",
      "NORMAL",
      "메만젠정5밀리그램(메만틴염산염)",
      "8806985051417",
      {
        drugMasterId: "103",
        insuranceCode: "698505140",
        priceMasterId: "698505140",
        productTotalQuantity: 30,
      },
    ),
    previewReceiptItem(
      "PREVIEW-NAME-1",
      "NAME_MATCH",
      "페노피타정",
      "8806985051110",
      {
        drugMasterId: "112",
        insuranceCode: "698505110",
        priceMasters: duplicatedAmoxi,
        productTotalQuantity: 30,
      },
    ),
    previewReceiptItem(
      "PREVIEW-NAME-2",
      "NAME_MATCH",
      "에페시나서방정",
      "8806985050915",
      {
        drugMasterId: "117",
        insuranceCode: "698505090",
        priceMasters: duplicatedAmoxi,
        productTotalQuantity: 30,
      },
    ),
    previewReceiptItem(
      "PREVIEW-NAME-3",
      "NAME_MATCH",
      "트라졸정",
      "8806985050816",
      {
        drugMasterId: "120",
        insuranceCode: "698505080",
        priceMasters: [
          previewPriceMaster(
            "698505080",
            "트라졸정(이트라코나졸)",
            "698505080",
            0,
          ),
          previewPriceMaster(
            "698505090",
            "에페시나서방정(에페리손염산염)",
            "698505090",
            0,
          ),
        ],
        productTotalQuantity: 30,
      },
    ),
    previewReceiptItem(
      "PREVIEW-NAME-4",
      "NAME_MATCH",
      "코로잘탄정10/50밀리그램",
      "8806985050519",
      {
        drugMasterId: "122",
        insuranceCode: "698505050",
        priceMasters: [
          previewPriceMaster(
            "698505050",
            "코로잘탄정10/50밀리그램(암로디핀,로사르탄칼륨)",
            "698505050",
            0,
          ),
          previewPriceMaster(
            "698505040",
            "코로잘탄정5/50밀리그램(암로디핀,로사르탄칼륨)",
            "698505040",
            0,
          ),
        ],
        productTotalQuantity: 30,
      },
    ),
    previewReceiptItem(
      "PREVIEW-VIRTUAL-1",
      "VIRTUAL",
      "코로잘탄정5/50밀리그램",
      "8806985050410",
      {
        drugMasterId: "124",
        productTotalQuantity: 30,
        virtualCode: "3PF000124",
      },
    ),
    previewReceiptItem(
      "PREVIEW-VIRTUAL-2",
      "VIRTUAL",
      "피나스카정(피나스테리드)",
      "8806985050113",
      {
        drugMasterId: "131",
        productTotalQuantity: 30,
        virtualCode: "3PF000125",
      },
    ),
    previewReceiptItem(
      "PREVIEW-VIRTUAL-3",
      "VIRTUAL",
      "이름매칭 실패 입력 테스트",
      "8806985049919",
      {
        drugMasterId: "139",
        insuranceCode: "",
        productTotalQuantity: 10,
      },
    ),
    previewReceiptItem(
      "PREVIEW-MISSING-1",
      "MISSING",
      "메만젠정(메만틴염산염)",
      "8806985050014",
      {
        drugMasterId: "134",
        insuranceCode: "698505000",
        productTotalQuantity: 30,
      },
    ),
  ];
}

function MobileApp() {
  const uiPreviewMode = getUiPreviewMode();
  const receiptMatchPreview = uiPreviewMode === "receipt-match";
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanGuideRef = useRef<HTMLButtonElement>(null);
  const scanAudioRef = useRef<HTMLAudioElement | null>(null);
  const expiryAudioRef = useRef<HTMLAudioElement | null>(null);
  const alreadyProcessedAudioRef = useRef<HTMLAudioElement | null>(null);
  const scannerControlsRef = useRef<IScannerControls | null>(null);
  const wholesalerSearchRequestRef = useRef(0);
  const lastDetectedRef = useRef({
    value: "",
    at: 0,
    cooldownMs: defaultScanCooldownMs,
  });
  const expiryDismissTimerRef = useRef<number | null>(null);
  const expirySpeechTimerRef = useRef<number | null>(null);
  const expirySpeechRequestRef = useRef(0);
  const cameraDevicesRef = useRef<VideoInputDevice[]>([]);
  const selectedCameraDeviceIdRef = useRef("");
  const modeRef = useRef<Mode>("receipt");

  const [screen, setScreen] = useState<Screen>(() =>
    receiptMatchPreview
      ? "receiptMatch"
      : hasStoredAuthTokens()
        ? "wholesaler"
        : "account",
  );
  const [mode, setMode] = useState<Mode>("receipt");
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraRestartKey, setCameraRestartKey] = useState(0);
  const [cameraError, setCameraError] = useState("");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [scanPerformanceMode, setScanPerformanceMode] =
    useState<ScanPerformanceMode>(() => getStoredScanPerformanceMode());
  const [scannerEngine, setScannerEngine] = useState<ScannerEngine>(() =>
    getStoredScannerEngine(),
  );
  const [scanCodeMode, setScanCodeMode] = useState<ScanCodeMode>(() =>
    getStoredScanCodeMode(),
  );
  const [apiState, setApiState] = useState<ApiState>(() =>
    receiptMatchPreview ? "demo" : "checking",
  );
  const [apiMessage, setApiMessage] = useState(
    receiptMatchPreview ? "UI 프리뷰 더미 데이터" : "",
  );
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [wholesalers, setWholesalers] = useState<Wholesaler[]>(() =>
    receiptMatchPreview ? demoWholesalers : [],
  );
  const [wholesalerSearchResults, setWholesalerSearchResults] = useState<
    Wholesaler[]
  >([]);
  const [wholesalerSearchStatus, setWholesalerSearchStatus] = useState<
    "idle" | "short" | "loading" | "done" | "error"
  >("idle");
  const [selectedWholesalerId, setSelectedWholesalerId] = useState(
    receiptMatchPreview ? (demoWholesalers[0]?.id ?? "") : "",
  );
  const [pendingWholesalerId, setPendingWholesalerId] = useState("");
  const [stocks, setStocks] = useState(initialStocks);
  const [stocksLoading, setStocksLoading] = useState(false);
  const [stocksMessage, setStocksMessage] = useState("");
  const [traces, setTraces] = useState(initialTraces);
  const [receiptQueue, setReceiptQueue] = useState<ReceiptQueueItem[]>(() =>
    receiptMatchPreview ? createReceiptMatchPreviewQueue() : [],
  );
  const [lastScanName, setLastScanName] = useState(
    receiptMatchPreview ? "UI 프리뷰" : "QR 스캔 대기",
  );
  const [scanNotice, setScanNotice] = useState(
    receiptMatchPreview
      ? "더미 데이터로 매칭 결과 UI를 확인 중입니다."
      : "카메라를 시작하면 QR이 자동으로 인식됩니다.",
  );
  const [receiptSummary, setReceiptSummary] = useState<ReceiptSummary | null>(
    null,
  );
  const [receiptSubmitError, setReceiptSubmitError] = useState("");
  const [returnLookup, setReturnLookup] = useState<ReturnLookup | null>(null);
  const [returnQuantity, setReturnQuantity] = useState(10);
  const [returnMemo, setReturnMemo] = useState("유통기한 임박 반품");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [returnReviewMessage, setReturnReviewMessage] = useState("");
  const [returnSummary, setReturnSummary] = useState<ReturnSummary | null>(
    null,
  );
  const [scanExpiryNotice, setScanExpiryNotice] =
    useState<ScanExpiryNotice | null>(null);

  const resetWholesalerDraft = useCallback(() => {
    wholesalerSearchRequestRef.current += 1;
    setPendingWholesalerId("");
    setWholesalerSearchResults([]);
    setWholesalerSearchStatus("idle");
  }, []);

  const resetWholesalerSelection = useCallback(() => {
    setSelectedWholesalerId("");
    resetWholesalerDraft();
    setWholesalers([]);
  }, [resetWholesalerDraft]);

  const resetReturnFlow = useCallback(() => {
    setReturnLookup(null);
    setReturnQuantity(10);
    setReturnMemo("유통기한 임박 반품");
    setSelectedCandidateId("");
    setReturnReviewMessage("");
    setReturnSummary(null);
  }, []);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const audio = new Audio("/barcode_sound.mp3");
    const expiryAudio = new Audio();
    const alreadyProcessedAudio = new Audio(alreadyProcessedAudioSrc);
    audio.preload = "auto";
    expiryAudio.preload = "auto";
    alreadyProcessedAudio.preload = "auto";
    scanAudioRef.current = audio;
    expiryAudioRef.current = expiryAudio;
    alreadyProcessedAudioRef.current = alreadyProcessedAudio;

    return () => {
      audio.pause();
      expiryAudio.pause();
      alreadyProcessedAudio.pause();
      scanAudioRef.current = null;
      expiryAudioRef.current = null;
      alreadyProcessedAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (expiryDismissTimerRef.current) {
        window.clearTimeout(expiryDismissTimerRef.current);
      }
      if (expirySpeechTimerRef.current) {
        window.clearTimeout(expirySpeechTimerRef.current);
      }
      expirySpeechRequestRef.current += 1;
      expiryAudioRef.current?.pause();
    };
  }, []);

  const playScanSound = useCallback(() => {
    const audio = scanAudioRef.current;
    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    void audio.play().catch(() => undefined);
  }, []);

  const playAlreadyProcessedAudio = useCallback(() => {
    const audio = alreadyProcessedAudioRef.current;
    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    void audio.play().catch(() => undefined);
  }, []);

  const clearExpiryAudio = useCallback(() => {
    const audio = expiryAudioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute("src");
    audio.load();
  }, []);

  const clearScanExpiryFeedback = useCallback(() => {
    if (expiryDismissTimerRef.current) {
      window.clearTimeout(expiryDismissTimerRef.current);
      expiryDismissTimerRef.current = null;
    }
    if (expirySpeechTimerRef.current) {
      window.clearTimeout(expirySpeechTimerRef.current);
      expirySpeechTimerRef.current = null;
    }

    expirySpeechRequestRef.current += 1;
    setScanExpiryNotice(null);
    clearExpiryAudio();
  }, [clearExpiryAudio]);

  const playExpiryAudioFile = useCallback(
    (src: string, requestId: number) =>
      new Promise<void>((resolve, reject) => {
        if (requestId !== expirySpeechRequestRef.current) {
          resolve();
          return;
        }

        const audio = expiryAudioRef.current;
        if (!audio) {
          reject(new Error("EXPIRY_AUDIO_NOT_READY"));
          return;
        }

        const cleanup = () => {
          audio.removeEventListener("ended", handleEnded);
          audio.removeEventListener("error", handleError);
        };
        const handleEnded = () => {
          cleanup();
          resolve();
        };
        const handleError = () => {
          cleanup();
          reject(new Error(`AUDIO_LOAD_FAILED: ${src}`));
        };

        audio.addEventListener("ended", handleEnded);
        audio.addEventListener("error", handleError);
        audio.pause();
        audio.currentTime = 0;
        audio.src = src;
        audio.load();
        audio.volume = 1;
        void audio.play().catch((error) => {
          cleanup();
          reject(error);
        });
      }),
    [],
  );

  const playExpiryAudio = useCallback(
    async (notice: ScanExpiryNotice) => {
      const sources = getExpiryAudioSources(notice);
      if (sources.length === 0) return;

      const requestId = expirySpeechRequestRef.current + 1;
      expirySpeechRequestRef.current = requestId;
      clearExpiryAudio();

      try {
        for (const source of sources) {
          if (requestId !== expirySpeechRequestRef.current) return;
          await playExpiryAudioFile(source, requestId);
        }
      } catch {
        clearExpiryAudio();
      }
    },
    [clearExpiryAudio, playExpiryAudioFile],
  );

  const presentScanExpiry = useCallback(
    (qr: QrFields) => {
      if (modeRef.current !== "receipt") {
        clearScanExpiryFeedback();
        return;
      }

      const notice = formatExpiryNotice(qr.exp);
      setScanExpiryNotice(notice);

      if (expiryDismissTimerRef.current) {
        window.clearTimeout(expiryDismissTimerRef.current);
      }
      expiryDismissTimerRef.current = window.setTimeout(() => {
        setScanExpiryNotice(null);
        expiryDismissTimerRef.current = null;
      }, 2300);

      if (expirySpeechTimerRef.current) {
        window.clearTimeout(expirySpeechTimerRef.current);
      }
      expirySpeechTimerRef.current = window.setTimeout(() => {
        void playExpiryAudio(notice);
        expirySpeechTimerRef.current = null;
      }, 460);
    },
    [clearScanExpiryFeedback, playExpiryAudio],
  );

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
      null,
    [pendingWholesalerId, wholesalers],
  );

  const virtualInsuranceCodeCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const item of receiptQueue) {
      if (item.drug.priceMasterId) continue;

      const code = normalizeInsuranceCode(
        item.drug.virtualInsuranceCode || item.drug.insuranceCode,
      );
      if (!code) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }

    return counts;
  }, [receiptQueue]);

  const isVirtualInsuranceCodeDuplicatedInQueue = useCallback(
    (item: ReceiptQueueItem) => {
      const code = normalizeInsuranceCode(
        item.drug.virtualInsuranceCode || item.drug.insuranceCode,
      );

      return Boolean(code && (virtualInsuranceCodeCounts.get(code) ?? 0) > 1);
    },
    [virtualInsuranceCodeCounts],
  );

  const findAvailableVirtualInsuranceCode = useCallback(
    async (itemId?: string) => {
      const baseInsuranceCode = await requestVirtualInsuranceCode();
      const baseNormalized = normalizeInsuranceCode(baseInsuranceCode);
      const checkedCodes = new Set<string>();

      for (
        let attempt = 0;
        attempt < virtualInsuranceCodeGenerationAttempts;
        attempt += 1
      ) {
        const insuranceCode = createVirtualInsuranceCodeCandidate(
          baseNormalized,
          attempt,
        );

        if (!insuranceCode || checkedCodes.has(insuranceCode)) continue;
        checkedCodes.add(insuranceCode);

        const duplicatedInQueue = receiptQueue.some(
          (item) =>
            item.id !== itemId &&
            !item.drug.priceMasterId &&
            normalizeInsuranceCode(
              item.drug.virtualInsuranceCode || item.drug.insuranceCode,
            ) === insuranceCode,
        );

        if (duplicatedInQueue) continue;

        const exists = await checkInsuranceCodeExists(insuranceCode);
        if (!exists) {
          return {
            baseInsuranceCode: baseNormalized,
            insuranceCode,
            attemptCount: attempt + 1,
          };
        }
      }

      throw new Error("사용 가능한 임의 보험코드를 찾지 못했습니다.");
    },
    [receiptQueue],
  );

  const isReceiptItemReady = useCallback(
    (item: ReceiptQueueItem) => {
      if (item.qr.errors.length > 0) return false;
      if (item.drug.priceMasterId) return true;

      return Boolean(
        item.drug.virtualDrugName?.trim() &&
        item.drug.virtualInsuranceCode?.trim() &&
        item.drug.insuranceCodeExists === false &&
        !isVirtualInsuranceCodeDuplicatedInQueue(item),
      );
    },
    [isVirtualInsuranceCodeDuplicatedInQueue],
  );

  const hasManualVirtualReceiptInput = useCallback((item: ReceiptQueueItem) => {
    const candidateCount = item.drug.priceMasters?.length ?? 0;

    return Boolean(
      !item.drug.priceMasterId &&
      candidateCount === 0 &&
      item.drug.virtualDrugName?.trim() &&
      item.drug.virtualInsuranceCode?.trim(),
    );
  }, []);

  const eligibleReceiptItems = useMemo(
    () => receiptQueue.filter(isReceiptItemReady),
    [isReceiptItemReady, receiptQueue],
  );

  const receiptCommitBlockedReason = useMemo(() => {
    if (receiptQueue.length === 0) return "";

    const unselectedNameMatchCount = receiptQueue.filter(
      (item) =>
        !item.drug.priceMasterId && (item.drug.priceMasters?.length ?? 0) > 0,
    ).length;

    if (unselectedNameMatchCount > 0) {
      return `이름매칭 ${unselectedNameMatchCount}건의 약품을 선택해야 입고 확정할 수 있습니다.`;
    }

    const invalidQrCount = receiptQueue.filter(
      (item) => item.qr.errors.length > 0,
    ).length;

    if (invalidQrCount > 0) {
      return `QR 필드 오류 ${invalidQrCount}건을 삭제하거나 다시 스캔해야 합니다.`;
    }

    const pendingVirtualCount = receiptQueue.filter(
      (item) => !isReceiptItemReady(item),
    ).length;

    if (pendingVirtualCount > 0) {
      return `임의/미등록 ${pendingVirtualCount}건의 약명, 보험코드, 중복 확인이 필요합니다.`;
    }

    return "";
  }, [isReceiptItemReady, receiptQueue]);

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
    setApiMessage("데이터 연결 실패 · 예시 데이터 표시");
  }, []);

  const loadStocks = useCallback(async () => {
    if (!hasStoredAuthTokens()) {
      setApiState("unauthorized");
      setApiMessage("로그인이 필요합니다.");
      setStocksMessage("로그인이 필요합니다.");
      return false;
    }

    setStocksLoading(true);
    setStocksMessage("재고 목록을 불러오는 중입니다.");
    try {
      const stockData = await apiFetch<unknown>("/stocks");
      const nextStocks = arrayPayload(stockData).map(normalizeStock);
      setStocks(nextStocks);
      setStocksMessage(`${nextStocks.length}건의 재고를 불러왔습니다.`);
      setApiState("connected");
      setApiMessage("재고 목록 연동 완료");
      return true;
    } catch (error) {
      setStocksMessage("재고 목록을 불러오지 못했습니다.");
      setApiFallback(error);
      return false;
    } finally {
      setStocksLoading(false);
    }
  }, [setApiFallback]);

  const refreshFromBackend = useCallback(async () => {
    setApiState("checking");
    setApiMessage("데이터 확인 중");
    return loadStocks();
  }, [loadStocks]);

  const validateReceiptQr = useCallback(
    async (qr: QrFields) => {
      const response = await apiFetch<unknown>("/receipts/validate-qr", {
        method: "POST",
        body: JSON.stringify({ pc: qr.pc }),
      });
      const drug = normalizeReceiptValidation(response, qr);

      if (drug.matchStatus === "MISSING" && !drug.virtualInsuranceCode) {
        try {
          const generated = await findAvailableVirtualInsuranceCode();
          drug.virtualInsuranceCode = generated.insuranceCode;
          drug.insuranceCode = drug.virtualInsuranceCode;
          drug.insuranceCodeExists = false;
          drug.matchStatus = "VIRTUAL";
        } catch {
          drug.virtualInsuranceCode = `3PF${qr.pc.slice(-6).padStart(6, "0")}`;
          drug.insuranceCode = drug.virtualInsuranceCode;
          drug.matchStatus = "VIRTUAL";
        }
      }

      return drug;
    },
    [findAvailableVirtualInsuranceCode],
  );

  const searchWholesalers = useCallback(
    async (keyword: string) => {
      const requestId = (wholesalerSearchRequestRef.current += 1);
      const trimmed = keyword.trim();

      if (normalizeSearchText(trimmed).length < 2) {
        setWholesalerSearchResults([]);
        setWholesalerSearchStatus(trimmed ? "short" : "idle");
        return;
      }

      setWholesalerSearchStatus("loading");
      try {
        const params = new URLSearchParams({ keyword: trimmed });
        const response = await apiFetch<unknown>(`/wholesalers?${params}`);
        const results = arrayPayload(response).map(normalizeWholesaler);
        if (requestId !== wholesalerSearchRequestRef.current) return;

        setWholesalerSearchResults(results);
        setWholesalers((current) => mergeWholesalers(current, results));
        setWholesalerSearchStatus("done");
        setApiState("connected");
        setApiMessage("도매처 검색 완료");
      } catch (error) {
        if (requestId !== wholesalerSearchRequestRef.current) return;
        setApiFallback(error);
        const fallbackResults = demoWholesalers.filter((wholesaler) =>
          normalizeSearchText(`${wholesaler.name} ${wholesaler.meta}`).includes(
            normalizeSearchText(trimmed),
          ),
        );
        setWholesalerSearchResults(fallbackResults);
        setWholesalers((current) => mergeWholesalers(current, fallbackResults));
        setWholesalerSearchStatus("error");
      }
    },
    [setApiFallback],
  );

  const bootstrapAuth = useCallback(async () => {
    if (receiptMatchPreview) {
      setApiState("demo");
      setApiMessage("UI 프리뷰 더미 데이터");
      return;
    }

    if (!hasStoredAuthTokens()) {
      setApiState("unauthorized");
      setApiMessage("로그인이 필요합니다.");
      setScreen("account");
      return;
    }

    setApiState("checking");
    setApiMessage("자동 로그인 확인 중");
    try {
      const authData = await apiFetch<unknown>("/auth/me");
      storeAuthAccount(
        normalizeAuthAccount(authData, getStoredAccessToken() ?? undefined),
      );
      const connected = await refreshFromBackend();
      if (connected) {
        setApiState("connected");
        setApiMessage("자동 로그인됨");
      }
      resetWholesalerSelection();
      resetReturnFlow();
      setReceiptQueue([]);
      setReceiptSummary(null);
      setLastScanName("QR 스캔 대기");
      setMode("receipt");
      setScreen("wholesaler");
    } catch (error) {
      setApiFallback(error);
    }
  }, [
    refreshFromBackend,
    receiptMatchPreview,
    resetReturnFlow,
    resetWholesalerSelection,
    setApiFallback,
  ]);

  useEffect(() => {
    void bootstrapAuth();
  }, [bootstrapAuth]);

  const stopCamera = useCallback(() => {
    scannerControlsRef.current?.stop();
    scannerControlsRef.current = null;
    setTorchAvailable(false);
    setTorchOn(false);

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute("src");
    }
  }, []);

  const patchReceiptDrug = useCallback(
    (itemId: string, patch: Partial<DrugMaster>) => {
      setReceiptSubmitError("");
      setReceiptQueue((current) =>
        current.map((item) =>
          item.id === itemId
            ? { ...item, drug: { ...item.drug, ...patch } }
            : item,
        ),
      );
    },
    [],
  );

  const selectReceiptPriceMaster = useCallback(
    (itemId: string, priceMasterId: string) => {
      setReceiptSubmitError("");
      setReceiptQueue((current) =>
        current.map((item) => {
          if (item.id !== itemId) return item;

          const price = item.drug.priceMasters?.find(
            (candidate) => candidate.id === priceMasterId,
          );
          if (!price) return item;

          return {
            ...item,
            drug: {
              ...item.drug,
              insuranceCode: price.productCode,
              priceMasterId: price.id,
              name: price.productName,
              price: price.maxPrice,
              matchStatus:
                item.drug.matchStatus === "NAME_MATCH"
                  ? "NAME_MATCH"
                  : item.drug.insuranceCode === price.productCode
                    ? "NORMAL"
                    : "NAME_MATCH",
              virtualDrugName: "",
              virtualInsuranceCode: "",
              insuranceCodeExists: null,
            },
          };
        }),
      );
    },
    [],
  );

  const removeReceiptItem = useCallback((itemId: string) => {
    setReceiptSubmitError("");
    setReceiptQueue((current) => current.filter((item) => item.id !== itemId));
  }, []);

  const regenerateReceiptPreviewSerials = useCallback(() => {
    const batchId = createReceiptPreviewBatchId();

    setReceiptQueue((current) =>
      current.map((item) => ({
        ...item,
        qr: previewQr(item.id, item.qr.pc, batchId),
      })),
    );
    setLastScanName("테스트 SN 재생성");
    setScanNotice(`프리뷰 SN/LOT을 새 배치 ${batchId}로 변경했습니다.`);
  }, []);

  const generateVirtualForReceiptItem = useCallback(
    async (itemId: string) => {
      try {
        const generated = await findAvailableVirtualInsuranceCode(itemId);
        const { baseInsuranceCode, insuranceCode } = generated;
        patchReceiptDrug(itemId, {
          insuranceCode,
          virtualInsuranceCode: insuranceCode,
          insuranceCodeExists: false,
        });
        setApiState("connected");
        setApiMessage(
          insuranceCode === baseInsuranceCode
            ? "임의 보험코드 생성 완료"
            : "중복 없는 임의 보험코드로 자동 변경했습니다.",
        );
      } catch (error) {
        setApiFallback(error);
      }
    },
    [findAvailableVirtualInsuranceCode, patchReceiptDrug, setApiFallback],
  );

  const checkVirtualForReceiptItem = useCallback(
    async (itemId: string, insuranceCode: string) => {
      const trimmed = insuranceCode.trim();
      if (!trimmed) return;
      const normalized = normalizeInsuranceCode(trimmed);
      const duplicatedInQueue = receiptQueue.some(
        (item) =>
          item.id !== itemId &&
          !item.drug.priceMasterId &&
          normalizeInsuranceCode(
            item.drug.virtualInsuranceCode || item.drug.insuranceCode,
          ) === normalized,
      );

      if (duplicatedInQueue) {
        patchReceiptDrug(itemId, { insuranceCodeExists: true });
        setApiState("connected");
        setApiMessage("현재 입고 목록에 같은 임의 보험코드가 있습니다.");
        return;
      }

      try {
        const exists = await checkInsuranceCodeExists(trimmed);
        patchReceiptDrug(itemId, { insuranceCodeExists: exists });
        setApiState("connected");
        setApiMessage(exists ? "보험코드 중복" : "사용 가능한 보험코드");
      } catch (error) {
        setApiFallback(error);
      }
    },
    [patchReceiptDrug, receiptQueue, setApiFallback],
  );

  const notifyDuplicateReceiptQr = useCallback(() => {
    setLastScanName("이미 처리된 약품입니다");
    setScanNotice("이미 입고됐거나 현재 목록에 있는 QR입니다.");
    playScanSound();
    window.setTimeout(playAlreadyProcessedAudio, 120);
  }, [playAlreadyProcessedAudio, playScanSound]);

  const addReceiptQr = useCallback(
    async (qr: QrFields) => {
      const alreadyReceived = traces.some(
        (trace) => Boolean(qr.sn) && trace.pc === qr.pc && trace.sn === qr.sn,
      );
      const duplicated = receiptQueue.some(
        (item) =>
          Boolean(qr.sn) && item.qr.pc === qr.pc && item.qr.sn === qr.sn,
      );

      if (alreadyReceived || duplicated) {
        notifyDuplicateReceiptQr();
        return true;
      }

      setLastScanName("기준 데이터 조회 중");
      setScanNotice("QR의 PC로 1번/2번 기준 데이터를 검증하고 있습니다.");

      let drug: DrugMaster;
      try {
        drug = await validateReceiptQr(qr);
        setApiState("connected");
        setApiMessage("QR 검증 완료");
      } catch (error) {
        setApiFallback(error);
        drug = resolveDrug(qr.pc);
      }

      setReceiptQueue((current) => [
        { id: createId("Q"), qr, drug },
        ...current,
      ]);
      setLastScanName(drug.name);
      setScanNotice(
        !qr.exp
          ? missingExpiryReceiptNotice
          : drug.matchStatus === "MISSING"
            ? "기준 데이터 미등록 QR입니다. 임의 약품 정보 입력 후 입고할 수 있습니다."
            : `${drug.name} 입고 스캔 완료 · 목록에 추가했습니다.`,
      );
      return true;
    },
    [
      notifyDuplicateReceiptQr,
      receiptQueue,
      setApiFallback,
      traces,
      validateReceiptQr,
    ],
  );

  const createReturnReview = useCallback(
    async (
      lookup: Extract<ReturnLookup, { matchType: "ESTIMATED" | "NONE" }>,
    ) => {
      setReturnReviewMessage("관리자 반품 확인 목록에 등록 중입니다.");
      const sellerCandidates =
        lookup.matchType === "ESTIMATED" ? lookup.sellerCandidates : [];
      const sellerCandidateSummary = sellerCandidates
        .slice(0, 6)
        .map((candidate) =>
          [
            candidate.sellerName,
            candidate.transactionAt,
            candidate.productName || candidate.orderItemName,
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n");

      try {
        const response = await apiFetch<unknown>("/returns/reviews", {
          method: "POST",
          body: JSON.stringify({
            pc: lookup.pc,
            sn: lookup.sn || undefined,
            lot: lookup.lot || undefined,
            exp: lookup.exp || undefined,
            drugName: lookup.drugName,
            insuranceCode: lookup.insuranceCode || undefined,
            matchType: lookup.matchType,
            message: lookup.message,
            sellerCandidateCount: sellerCandidates.length,
            sellerCandidateSummary,
            requestedQuantity:
              lookup.matchType === "ESTIMATED" && lookup.returnableQuantity > 0
                ? lookup.returnableQuantity
                : undefined,
          }),
        });
        const item = unwrapObjectPayload(response);
        const id = optionalText(item.id ?? item.reviewId);
        const message = id
          ? `관리자 반품 확인 #${id}에 등록했습니다.`
          : "관리자 반품 확인 목록에 등록했습니다.";
        setReturnReviewMessage(message);
        setScanNotice(
          `${message} 관리자 페이지에서 재고를 선택해 처리해 주세요.`,
        );
      } catch (error) {
        const message =
          "관리자 반품 확인 등록에 실패했습니다. 다시 스캔해 주세요.";
        setReturnReviewMessage(message);
        setScanNotice(message);
      }
    },
    [],
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
            ...(qr.sn ? { sn: qr.sn } : {}),
            ...(qr.lot ? { lot: qr.lot } : {}),
            ...(qr.exp ? { exp: qr.exp } : {}),
          }),
        });
        const lookup = normalizeLookup(response, qr);
        if (lookup.matchType === "CONFIRMED") {
          setReturnLookup(lookup);
          setLastScanName(`${lookup.drugName} · 확정`);
          setScanNotice(
            lookup.sn
              ? "입고 이력에서 도매처를 확정했습니다."
              : "보험코드 기준 보유 재고에서 반품 대상을 확인했습니다.",
          );
          setReturnQuantity(
            clampReturnQuantity(
              lookup.returnableQuantity,
              lookup.returnableQuantity,
            ),
          );
          setScreen("returnConfirmed");
          return;
        }
        if (lookup.matchType === "ESTIMATED") {
          if (lookup.sellerCandidates.length === 0) {
            const noHistoryLookup = noReceiptHistoryLookup(lookup);
            setReturnLookup(noHistoryLookup);
            setLastScanName(`${lookup.drugName} · 판매처 후보 없음`);
            setScanNotice("관리자 반품 확인 목록에 등록하고 있습니다.");
            void createReturnReview(noHistoryLookup);
            setScreen("returnNone");
            return;
          }

          setReturnLookup(lookup);
          setSelectedCandidateId(lookup.sellerCandidates[0]?.id ?? "");
          setLastScanName(
            `${lookup.drugName} · 판매처 후보 ${lookup.sellerCandidates.length}건`,
          );
          setScanNotice("관리자 반품 확인 목록에 등록하고 있습니다.");
          void createReturnReview(lookup);
          setScreen("returnEstimated");
          return;
        }
        setReturnLookup(lookup);
        setLastScanName("입고 이력 없음");
        setScanNotice("관리자 반품 확인 목록에 등록하고 있습니다.");
        void createReturnReview(lookup);
        setScreen("returnNone");
      } catch (error) {
        setApiFallback(error);
        setApiMessage(
          error instanceof Error
            ? `반품 조회 실패 · ${error.message}`
            : "반품 조회 실패",
        );
        setScanNotice(
          error instanceof Error
            ? `반품 조회 실패: ${error.message}`
            : "반품 조회에 실패했습니다.",
        );
        const lookup = lookupReturnDemo(qr, traces, stocks);
        if (lookup.matchType === "CONFIRMED") {
          setReturnLookup(lookup);
          setLastScanName(`${lookup.drugName} · 확정`);
          setScanNotice(
            lookup.sn
              ? "데모 데이터의 입고 이력에서 도매처를 확정했습니다."
              : "보험코드 기준 보유 재고에서 반품 대상을 확인했습니다.",
          );
          setReturnQuantity(
            clampReturnQuantity(
              lookup.returnableQuantity,
              lookup.returnableQuantity,
            ),
          );
          setScreen("returnConfirmed");
        } else if (lookup.matchType === "ESTIMATED") {
          if (lookup.sellerCandidates.length === 0) {
            const noHistoryLookup = noReceiptHistoryLookup(lookup);
            setReturnLookup(noHistoryLookup);
            setLastScanName(`${lookup.drugName} · 판매처 후보 없음`);
            setScanNotice(noHistoryLookup.message);
            setScreen("returnNone");
            return;
          }

          setReturnLookup(lookup);
          setSelectedCandidateId(lookup.sellerCandidates[0]?.id ?? "");
          setLastScanName(
            `${lookup.drugName} · 판매처 후보 ${lookup.sellerCandidates.length}건`,
          );
          setScanNotice(
            lookup.message ??
              "입고 이력은 없지만 구매 내역 기준 판매처 후보가 있습니다.",
          );
          setScreen("returnEstimated");
        } else {
          setReturnLookup(lookup);
          setLastScanName("입고 이력 없음");
          setScanNotice(lookup.message);
          setScreen("returnNone");
        }
      }
    },
    [createReturnReview, setApiFallback, stocks, traces],
  );

  const handlePayload = useCallback(
    (payload: string): ScanHandleResult => {
      const qr =
        scanCodeMode === "barcode"
          ? parseBarcodePayload(payload)
          : parseQrPayload(payload);
      const lowConfidenceSnReason = getLowConfidenceSnReason(qr);
      const codeLabel = scanCodeModeLabel(scanCodeMode);

      if (lowConfidenceSnReason) {
        setLastScanName("SN 재촬영 필요");
        setScanNotice(
          `${lowConfidenceSnReason}\n카메라를 조금 떨어뜨리고 ${codeLabel} 전체를 다시 맞춰주세요.`,
        );
        return { kind: "handled", cooldownMs: retakeScanCooldownMs };
      }

      if (modeRef.current === "return") {
        if (!qr.pc) {
          setLastScanName("PC 없음");
          setScanNotice("반품 조회에는 최소 PC 값이 필요합니다.");
          return null;
        }
        void lookupReturn(qr);
        return { kind: "accepted", qr };
      }

      if (qr.errors.length > 0) {
        setLastScanName(qr.errors.join(", "));
        setScanNotice(
          `${codeLabel} 값은 읽었지만 PC 값을 파싱하지 못했습니다.`,
        );
        return null;
      }

      if (!selectedWholesaler) {
        setLastScanName("도매처 선택 필요");
        setScanNotice(
          `입고 ${codeLabel}을 처리하려면 먼저 도매처를 선택해야 합니다.`,
        );
        setScreen("wholesaler");
        return null;
      }
      const alreadyReceived = traces.some(
        (trace) => Boolean(qr.sn) && trace.pc === qr.pc && trace.sn === qr.sn,
      );
      const duplicated = receiptQueue.some(
        (item) =>
          Boolean(qr.sn) && item.qr.pc === qr.pc && item.qr.sn === qr.sn,
      );

      if (alreadyReceived || duplicated) {
        notifyDuplicateReceiptQr();
        return { kind: "handled", cooldownMs: duplicateScanCooldownMs };
      }

      void addReceiptQr(qr);
      return { kind: "accepted", qr };
    },
    [
      addReceiptQr,
      lookupReturn,
      notifyDuplicateReceiptQr,
      receiptQueue,
      scanCodeMode,
      selectedWholesaler,
      traces,
    ],
  );

  useEffect(() => {
    function handleNativeScannerMessage(event: MessageEvent) {
      if (typeof event.data !== "string") return;

      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      const item = asRecord(message);
      if (item.type === "pharmfarm-native-scanner-closed") {
        storeScannerEngine("web");
        setScannerEngine("web");
        setScanNotice("네이티브 리더를 종료하고 웹 리더로 돌아왔습니다.");
        return;
      }

      if (item.type !== "pharmfarm-native-scan-result") return;

      const value = String(item.value ?? item.data ?? "");
      if (!value) return;

      const now = Date.now();
      const lastDetected = lastDetectedRef.current;
      if (
        value === lastDetected.value &&
        now - lastDetected.at < lastDetected.cooldownMs
      ) {
        return;
      }

      const handled = handlePayload(value);
      if (handled) {
        lastDetectedRef.current = {
          value,
          at: now,
          cooldownMs: handled.cooldownMs ?? defaultScanCooldownMs,
        };
      }

      if (handled?.kind === "accepted") {
        playScanSound();
        presentScanExpiry(handled.qr);
      }
    }

    window.addEventListener("message", handleNativeScannerMessage);
    return () => {
      window.removeEventListener("message", handleNativeScannerMessage);
    };
  }, [handlePayload, playScanSound, presentScanExpiry]);

  const activateCamera = useCallback(() => {
    lastDetectedRef.current = {
      value: "",
      at: 0,
      cooldownMs: defaultScanCooldownMs,
    };
    setCameraActive(true);
  }, []);

  const refreshCamera = useCallback(() => {
    lastDetectedRef.current = {
      value: "",
      at: 0,
      cooldownMs: defaultScanCooldownMs,
    };
    setCameraError("");
    setScanNotice("카메라를 새로고침하고 있습니다.");
    stopCamera();
    setCameraActive(true);
    setCameraRestartKey((value) => value + 1);
  }, [stopCamera]);

  const refreshCameraDevices = useCallback(async (activeDeviceId?: string) => {
    try {
      const devices = await listVideoInputDevices();
      cameraDevicesRef.current = devices;
      if (
        activeDeviceId &&
        devices.some((device) => device.deviceId === activeDeviceId)
      ) {
        selectedCameraDeviceIdRef.current = activeDeviceId;
      }
      return devices;
    } catch {
      return [];
    }
  }, []);

  const switchCameraDevice = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setScanNotice("이 기기에서는 카메라 전환 정보를 가져올 수 없습니다.");
      return;
    }

    const currentTrack = videoRef.current
      ? getCameraTrack(videoRef.current)
      : null;
    const activeDeviceId =
      currentTrack?.getSettings().deviceId ?? selectedCameraDeviceIdRef.current;
    const devices = await refreshCameraDevices(activeDeviceId);
    if (devices.length <= 1) {
      setScanNotice("전환할 다른 카메라가 없습니다.");
      return;
    }

    const currentIndex = devices.findIndex(
      (device) => device.deviceId === activeDeviceId,
    );
    const nextIndex =
      currentIndex >= 0 ? (currentIndex + 1) % devices.length : 0;
    const nextDevice = devices[nextIndex];

    selectedCameraDeviceIdRef.current = nextDevice.deviceId;
    lastDetectedRef.current = {
      value: "",
      at: 0,
      cooldownMs: defaultScanCooldownMs,
    };
    setScanNotice(
      `${formatVideoInputLabel(nextDevice, nextIndex)}로 전환합니다.`,
    );

    if (cameraActive) {
      setCameraRestartKey((value) => value + 1);
    } else {
      activateCamera();
    }
  }, [activateCamera, cameraActive, refreshCameraDevices]);

  const toggleScanPerformanceMode = useCallback(() => {
    setScanPerformanceMode((current) => {
      const next = current === "performance" ? "quality" : "performance";
      storeScanPerformanceMode(next);
      lastDetectedRef.current = {
        value: "",
        at: 0,
        cooldownMs: defaultScanCooldownMs,
      };
      setScanNotice(
        next === "performance"
          ? "저사양 스캔 모드로 전환했습니다. 카메라를 가볍게 다시 맞춥니다."
          : "정밀 스캔 모드로 전환했습니다. 작은 QR 인식에 더 집중합니다.",
      );
      return next;
    });
  }, []);

  const chooseScanCodeMode = useCallback(
    (next: ScanCodeMode) => {
      setScanCodeMode((current) => {
        if (current === next) return current;

        storeScanCodeMode(next);
        lastDetectedRef.current = {
          value: "",
          at: 0,
          cooldownMs: defaultScanCooldownMs,
        };
        setScanNotice(
          next === "barcode"
            ? "바코드 인식 모드로 전환했습니다. 가로 프레임 안에 바코드를 맞춰주세요."
            : "QR 인식 모드로 전환했습니다. 코드를 사각형 안에 맞춰주세요.",
        );
        if (cameraActive) {
          setCameraRestartKey((value) => value + 1);
        }
        return next;
      });
    },
    [cameraActive],
  );

  const toggleScannerEngine = useCallback(() => {
    if (!isNativeAppShell()) {
      storeScannerEngine("web");
      setScannerEngine("web");
      setScanNotice("네이티브 리더는 앱에서만 사용할 수 있습니다.");
      return;
    }

    setScannerEngine((current) => {
      const next = current === "native" ? "web" : "native";

      storeScannerEngine(next);
      lastDetectedRef.current = {
        value: "",
        at: 0,
        cooldownMs: defaultScanCooldownMs,
      };

      if (next === "native") {
        postNativeScannerMessage("stop", scanCodeMode);
        setScanNotice("네이티브 리더 모드를 기본값으로 저장했습니다.");
      } else {
        postNativeScannerMessage("stop", scanCodeMode);
        setScanNotice(
          `웹 ${scanCodeModeLabel(scanCodeMode)} 리더로 전환했습니다.`,
        );
      }

      return next;
    });
  }, [scanCodeMode]);

  useEffect(() => {
    if (scannerEngine !== "native" || isNativeAppShell()) return;

    setScannerEngine("web");
  }, [scannerEngine]);

  const refocusCamera = useCallback(() => {
    const video = videoRef.current;
    if (!cameraActive || !video) {
      setScanNotice("카메라가 켜진 뒤 초점을 다시 맞출 수 있습니다.");
      return;
    }

    setScanNotice("초점을 다시 맞추고 있습니다.");
    void tuneCameraTrack(video, "refocus").then((status) => {
      if (status === "applied") {
        setScanNotice(
          "초점 재조정 완료 · QR과 카메라를 15~20cm 거리로 맞춰주세요.",
        );
        return;
      }

      setScanNotice(
        "이 기기는 수동 초점 제어가 제한됩니다. QR을 조금 더 멀리 두고 밝은 곳에서 다시 시도해 주세요.",
      );
    });
  }, [cameraActive]);

  const toggleTorch = useCallback(() => {
    const controls = scannerControlsRef.current;
    if (!cameraActive || !controls?.switchTorch) {
      setTorchAvailable(false);
      setTorchOn(false);
      setScanNotice("이 기기에서는 플래시 제어가 지원되지 않습니다.");
      return;
    }

    const nextTorchOn = !torchOn;
    void controls
      .switchTorch(nextTorchOn)
      .then(() => {
        setTorchOn(nextTorchOn);
        setScanNotice(
          nextTorchOn
            ? "플래시를 켰습니다. 반사가 심하면 다시 꺼주세요."
            : "플래시를 껐습니다.",
        );
      })
      .catch(() => {
        setTorchAvailable(false);
        setTorchOn(false);
        setScanNotice("이 기기에서는 플래시 제어가 제한됩니다.");
      });
  }, [cameraActive, torchOn]);

  useEffect(() => {
    if (screen !== "scan") {
      if (cameraActive) setCameraActive(false);
      return;
    }

    if (mode === "receipt" && !selectedWholesaler) {
      if (cameraActive) setCameraActive(false);
      return;
    }

    if (!cameraActive) activateCamera();
  }, [
    activateCamera,
    cameraActive,
    mode,
    scannerEngine,
    screen,
    selectedWholesaler?.id,
  ]);

  useEffect(() => {
    postNativeScannerMessage("stop", scanCodeMode);
  }, [scanCodeMode, scannerEngine]);

  useEffect(() => {
    if (screen === "stocks") {
      void loadStocks();
    }
  }, [loadStocks, screen]);

  useEffect(() => {
    if (!cameraActive) {
      stopCamera();
      return;
    }

    let cancelled = false;
    let focusHintTimer: number | null = null;

    async function startCamera() {
      setCameraError("");
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("카메라를 사용할 수 없는 환경입니다.");
        }

        const video = videoRef.current;
        if (!video) throw new Error("카메라 화면을 준비하지 못했습니다.");

        const reader = createScannerReader(scanPerformanceMode, scanCodeMode);
        const codeModeLabel = scanCodeModeLabel(scanCodeMode);
        const selectedCameraDeviceId = selectedCameraDeviceIdRef.current;
        const availableDevices = selectedCameraDeviceId
          ? cameraDevicesRef.current
          : await refreshCameraDevices();
        const preferredDeviceId =
          selectedCameraDeviceId ||
          getPreferredVideoInputDeviceId(availableDevices);
        if (preferredDeviceId && preferredDeviceId !== selectedCameraDeviceId) {
          selectedCameraDeviceIdRef.current = preferredDeviceId;
        }
        setScanNotice(`${codeModeLabel} 카메라 실행 중`);
        const handleScannerResult = (value: string) => {
          if (!value) return;
          if (focusHintTimer) {
            window.clearTimeout(focusHintTimer);
            focusHintTimer = null;
          }

          const now = Date.now();
          const lastDetected = lastDetectedRef.current;
          if (
            value === lastDetected.value &&
            now - lastDetected.at < lastDetected.cooldownMs
          ) {
            return;
          }

          const handled = handlePayload(value);
          if (handled) {
            lastDetectedRef.current = {
              value,
              at: now,
              cooldownMs: handled.cooldownMs ?? defaultScanCooldownMs,
            };
          }

          if (handled?.kind === "accepted") {
            playScanSound();
            presentScanExpiry(handled.qr);
          }
        };
        let controls: IScannerControls;
        try {
          controls = await startGuidedWebScanner({
            constraints: getCameraConstraints(
              scanPerformanceMode,
              preferredDeviceId,
            ),
            guideElement: scanGuideRef.current,
            reader,
            scanPerformanceMode,
            video,
            onResult: handleScannerResult,
          });
        } catch (error) {
          if (!preferredDeviceId) throw error;
          selectedCameraDeviceIdRef.current = "";
          controls = await startGuidedWebScanner({
            constraints: getCameraConstraints(scanPerformanceMode),
            guideElement: scanGuideRef.current,
            reader,
            scanPerformanceMode,
            video,
            onResult: handleScannerResult,
          });
        }

        if (cancelled) {
          controls.stop();
          return;
        }
        scannerControlsRef.current = controls;
        setTorchAvailable(Boolean(controls.switchTorch));
        setTorchOn(false);
        const activeDeviceId = getCameraTrack(video)?.getSettings().deviceId;
        void refreshCameraDevices(activeDeviceId);
        const tuningStatus = await tuneCameraTrack(video, "startup");
        if (cancelled) return;

        if (tuningStatus === "applied") {
          setScanNotice(
            scanCodeMode === "barcode"
              ? "카메라 초점과 줌을 최적화했습니다. 바코드를 가로 프레임 안에 맞춰주세요."
              : "카메라 초점과 줌을 최적화했습니다. QR을 사각형 안에 맞춰주세요.",
          );
        }

        focusHintTimer = window.setTimeout(() => {
          setScanNotice(
            scanCodeMode === "barcode"
              ? "인식이 늦으면 바코드를 가로로 맞추고\n초점 버튼을 눌러주세요."
              : "인식이 늦으면 카메라를 조금 떨어뜨리고\n초점 버튼을 눌러주세요.",
          );
        }, 4500);
      } catch (error) {
        if (cancelled) return;
        setCameraError(
          error instanceof Error ? error.message : "카메라 시작 실패",
        );
        setScanNotice(
          "카메라를 시작하지 못했습니다. 권한과 HTTPS 환경을 확인해 주세요.",
        );
        setTorchAvailable(false);
        setTorchOn(false);
        setCameraActive(false);
      }
    }

    void startCamera();

    return () => {
      cancelled = true;
      if (focusHintTimer) {
        window.clearTimeout(focusHintTimer);
      }
      stopCamera();
    };
  }, [
    cameraActive,
    cameraRestartKey,
    handlePayload,
    playScanSound,
    presentScanExpiry,
    refreshCameraDevices,
    scanCodeMode,
    scanPerformanceMode,
    stopCamera,
  ]);

  function chooseMode(nextMode: Mode) {
    if (nextMode === mode) return;
    const hasReceiptDraft = receiptQueue.length > 0;
    if (
      mode === "receipt" &&
      hasReceiptDraft &&
      !window.confirm(
        "모드를 변경하면 현재 스캔한 입고 목록이 삭제됩니다. 계속할까요?",
      )
    ) {
      return;
    }
    if (mode === "receipt") {
      if (hasReceiptDraft) setReceiptQueue([]);
      setCameraActive(false);
    }
    clearScanExpiryFeedback();
    resetWholesalerDraft();
    resetReturnFlow();
    setMode(nextMode);
    setLastScanName("QR 스캔 대기");
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
    const hasReceiptDraft = receiptQueue.length > 0;
    if (
      hasReceiptDraft &&
      !window.confirm(
        "도매처를 변경하면 현재 스캔한 입고 목록이 삭제됩니다. 계속할까요?",
      )
    ) {
      return;
    }

    if (cameraActive) {
      setCameraActive(false);
    }

    if (hasReceiptDraft) {
      setReceiptQueue([]);
      setLastScanName("도매처 선택 필요");
      setScanNotice("도매처를 다시 선택하면 새 입고 스캔을 시작합니다.");
    }

    resetWholesalerDraft();
    setMode("receipt");
    setPendingWholesalerId(selectedWholesalerId);
    setScreen("wholesaler");
  }

  function startReturnFirst() {
    resetWholesalerDraft();
    resetReturnFlow();
    clearScanExpiryFeedback();
    setMode("return");
    setCameraActive(false);
    setScreen("scan");
    setLastScanName("QR 스캔 대기");
    setScanNotice("반품 모드입니다. QR을 스캔하면 판매처를 조회합니다.");
  }

  function toggleCamera() {
    if (cameraActive) {
      setCameraActive(false);
    } else {
      activateCamera();
    }
  }

  function startReceipt() {
    if (!selectedWholesaler) {
      resetWholesalerDraft();
      setScreen("wholesaler");
      return false;
    }
    return true;
  }

  async function commitReceipt() {
    const wholesaler = selectedWholesaler;
    if (!wholesaler || receiptQueue.length === 0) return;

    if (receiptCommitBlockedReason) {
      setApiState(receiptMatchPreview ? "demo" : "connected");
      setApiMessage(receiptCommitBlockedReason);
      setScanNotice(receiptCommitBlockedReason);
      return;
    }

    setReceiptSubmitError("");

    try {
      const requestItems = await Promise.all(
        eligibleReceiptItems.map(async (item) => {
          const keepManualVirtualInput = hasManualVirtualReceiptInput(item);
          const drug =
            receiptMatchPreview && !keepManualVirtualInput
              ? await validateReceiptQr(item.qr)
              : item.drug;

          return {
            pc: item.qr.pc,
            sn: item.qr.sn,
            lot: item.qr.lot,
            exp: item.qr.exp,
            drugMasterId: optionalId(drug.drugMasterId),
            insuranceCode: drug.insuranceCode || undefined,
            priceMasterId: optionalId(drug.priceMasterId),
            virtualDrugName: drug.priceMasterId
              ? null
              : drug.virtualDrugName || drug.name,
            virtualInsuranceCode: drug.priceMasterId
              ? null
              : drug.virtualInsuranceCode || drug.insuranceCode,
          };
        }),
      );

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
      if (error instanceof ApiError) {
        const message = error.message || "입고 요청에 실패했습니다.";
        setReceiptSubmitError(message);
        setApiState("connected");
        setApiMessage(message);
        setScanNotice(message);
        return;
      }

      setApiFallback(error);
      if (receiptMatchPreview) return;
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

  async function commitReturn(quantityOverride?: number) {
    if (returnLookup?.matchType !== "CONFIRMED") {
      return;
    }

    const quantity = clampReturnQuantity(
      quantityOverride ?? returnQuantity,
      returnMax,
    );
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
      resetWholesalerSelection();
      resetReturnFlow();
      setReceiptQueue([]);
      setReceiptSummary(null);
      setLastScanName("QR 스캔 대기");
      setMode("receipt");
      setScreen("wholesaler");
    } catch (error) {
      setApiState("unauthorized");
      setApiMessage(
        error instanceof Error ? error.message : "로그인에 실패했습니다.",
      );
    }
  }

  function logoutMobile() {
    clearAuthTokens();
    setCameraActive(false);
    setApiState("unauthorized");
    setApiMessage("로그아웃됨");
    setPassword("");
    resetWholesalerSelection();
    resetReturnFlow();
    setReceiptQueue([]);
    setReceiptSummary(null);
    setLastScanName("QR 스캔 대기");
    setScreen("account");
  }

  return (
    <main
      className={`phone ${screenClass(screen, mode)} ${
        scanPerformanceMode === "performance" ? "is-scan-performance" : ""
      } ${scanCodeMode === "barcode" ? "is-barcode-scan" : ""}`}
    >
      {screen === "wholesaler" && (
        <WholesalerScreen
          pendingId={pendingWholesalerId}
          searchResults={wholesalerSearchResults}
          searchStatus={wholesalerSearchStatus}
          wholesalers={wholesalers}
          onBack={
            selectedWholesaler
              ? () => {
                  resetWholesalerDraft();
                  setScreen("scan");
                }
              : undefined
          }
          onChoose={setPendingWholesalerId}
          onReturnFirst={startReturnFirst}
          onSearch={searchWholesalers}
          onStart={() => {
            if (!pendingWholesaler) return;
            const wholesaler = pendingWholesaler;
            resetWholesalerDraft();
            setSelectedWholesalerId(wholesaler.id);
            setMode("receipt");
            setLastScanName("스캔 준비 완료");
            setScanNotice(`${wholesaler.name} 입고 스캔을 시작합니다.`);
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
          lastScanName={lastScanName}
          scanCodeMode={scanCodeMode}
          scanPerformanceMode={scanPerformanceMode}
          scannerEngine={scannerEngine}
          scanNotice={scanNotice}
          selectedWholesaler={selectedWholesaler}
          scanGuideRef={scanGuideRef}
          torchAvailable={torchAvailable}
          torchOn={torchOn}
          videoRef={videoRef}
          onLogout={logoutMobile}
          onMode={chooseMode}
          onReview={() => {
            if (startReceipt()) setScreen("receiptReview");
          }}
          onRefocusCamera={refocusCamera}
          onRefreshCamera={refreshCamera}
          onScanCodeMode={chooseScanCodeMode}
          onScanPerformanceMode={toggleScanPerformanceMode}
          onScannerEngine={toggleScannerEngine}
          onSwitchCamera={switchCameraDevice}
          onStocks={() => setScreen("stocks")}
          onToggleCamera={toggleCamera}
          onToggleTorch={toggleTorch}
          onWholesaler={openWholesalerPicker}
        />
      )}

      {screen === "receiptReview" && (
        <ReceiptReviewScreen
          increase={receiptIncrease}
          queue={receiptQueue}
          selectedWholesaler={selectedWholesaler}
          onBack={() => setScreen("scan")}
          onRemove={removeReceiptItem}
          onNext={() => setScreen("receiptMatch")}
        />
      )}

      {screen === "receiptMatch" && (
        <ReceiptMatchScreen
          commitBlockedReason={receiptCommitBlockedReason}
          eligibleCount={eligibleReceiptItems.length}
          queue={receiptQueue}
          submitErrorMessage={receiptSubmitError}
          onBack={() => setScreen("receiptReview")}
          onCheckVirtual={checkVirtualForReceiptItem}
          onCommit={commitReceipt}
          onGenerateVirtual={generateVirtualForReceiptItem}
          onRegeneratePreviewSerials={
            receiptMatchPreview && debugToolsEnabled
              ? regenerateReceiptPreviewSerials
              : undefined
          }
          onSelectPrice={selectReceiptPriceMaster}
          onVirtualCode={(itemId, value) =>
            patchReceiptDrug(itemId, {
              virtualInsuranceCode: value,
              insuranceCode: value,
              insuranceCodeExists: null,
            })
          }
          onVirtualName={(itemId, value) =>
            patchReceiptDrug(itemId, {
              virtualDrugName: value,
              name: value || "미확인 약품",
            })
          }
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
            onClose={() => {
              resetReturnFlow();
              setLastScanName("QR 스캔 대기");
              setScreen("scan");
            }}
            onFullReturn={() => {
              const fullQuantity = returnLookup.productTotalQuantity;
              if (fullQuantity <= 0 || fullQuantity > returnMax) return;
              setReturnQuantity(fullQuantity);
              void commitReturn(fullQuantity);
            }}
            onNext={() => {
              setReturnQuantity(clampReturnQuantity(returnMax, returnMax));
              setScreen("returnQty");
            }}
          />
        )}

      {screen === "returnEstimated" &&
        returnLookup?.matchType === "ESTIMATED" && (
          <ReturnEstimatedScreen
            lookup={returnLookup}
            reviewMessage={returnReviewMessage}
            onClose={() => {
              resetReturnFlow();
              setLastScanName("QR 스캔 대기");
              setScreen("scan");
            }}
          />
        )}

      {screen === "returnNone" && (
        <ReturnNoneScreen
          lookup={returnLookup?.matchType === "NONE" ? returnLookup : null}
          reviewMessage={returnReviewMessage}
          onClose={() => {
            resetReturnFlow();
            setLastScanName("QR 스캔 대기");
            setScreen("scan");
          }}
        />
      )}

      {screen === "returnQty" && returnLookup?.matchType === "CONFIRMED" && (
        <ReturnQtyScreen
          memo={returnMemo}
          quantity={returnQuantity}
          stockBefore={returnStockBefore}
          max={returnMax}
          drugName={returnDrugName}
          wholesalerName={returnWholesalerName}
          matchType={returnLookup.matchType}
          onBack={() => setScreen("returnConfirmed")}
          onCommit={() => void commitReturn()}
          onMemo={setReturnMemo}
          onQuantity={(next) =>
            setReturnQuantity(clampReturnQuantity(next, returnMax))
          }
        />
      )}

      {screen === "returnDone" && returnSummary && (
        <DoneScreen
          kind="return"
          returnSummary={returnSummary}
          onPrimary={() => {
            resetReturnFlow();
            setLastScanName("QR 스캔 대기");
            setScreen("scan");
          }}
          onSecondary={() => {
            resetReturnFlow();
            resetWholesalerDraft();
            setMode("receipt");
            setLastScanName("QR 스캔 대기");
            setScanNotice(
              selectedWholesaler
                ? "입고 모드입니다. QR을 스캔하세요."
                : "입고 모드입니다. 도매처 선택 후 QR을 스캔하세요.",
            );
            setScreen(selectedWholesaler ? "scan" : "wholesaler");
          }}
        />
      )}

      {screen === "stocks" && (
        <StocksScreen
          loading={stocksLoading}
          message={stocksMessage}
          stocks={stocks}
          onBack={() => setScreen("scan")}
          onRefresh={loadStocks}
        />
      )}

      {screen === "account" && (
        <AccountScreen
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

      {mode === "receipt" && scanExpiryNotice && (
        <div className="scan-expiry-modal" role="status" aria-live="polite">
          <span>유효기간</span>
          <strong>{scanExpiryNotice.display}</strong>
          <em>스캔 완료</em>
        </div>
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
      insuranceCode: trace.insuranceCode,
      wholesalerName: trace.wholesalerName,
      productTotalQuantity: trace.productTotalQuantity,
      returnedQuantity: trace.returnedQuantity,
      returnableQuantity: Math.max(
        0,
        trace.productTotalQuantity - trace.returnedQuantity,
      ),
      stockQuantity: stock?.quantity ?? 0,
      receiptCandidates: [],
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
      insuranceCode: stock?.insuranceCode ?? "",
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
    insuranceCode: "",
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
        controlledDrug: { controlled: false },
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
  scanCodeMode,
  scanPerformanceMode,
  scannerEngine,
  scanNotice,
  selectedWholesaler,
  scanGuideRef,
  torchAvailable,
  torchOn,
  videoRef,
  onLogout,
  onMode,
  onRefocusCamera,
  onRefreshCamera,
  onReview,
  onScanCodeMode,
  onScanPerformanceMode,
  onScannerEngine,
  onStocks,
  onSwitchCamera,
  onToggleCamera,
  onToggleTorch,
  onWholesaler,
}: {
  apiMessage: string;
  apiState: ApiState;
  cameraActive: boolean;
  cameraError: string;
  lastScanName: string;
  mode: Mode;
  queueCount: number;
  scanCodeMode: ScanCodeMode;
  scanPerformanceMode: ScanPerformanceMode;
  scannerEngine: ScannerEngine;
  scanNotice: string;
  selectedWholesaler: Wholesaler | null;
  scanGuideRef: RefObject<HTMLButtonElement>;
  torchAvailable: boolean;
  torchOn: boolean;
  videoRef: RefObject<HTMLVideoElement>;
  onLogout: () => void;
  onMode: (mode: Mode) => void;
  onRefocusCamera: () => void;
  onRefreshCamera: () => void;
  onReview: () => void;
  onScanCodeMode: (mode: ScanCodeMode) => void;
  onScanPerformanceMode: () => void;
  onScannerEngine: () => void;
  onStocks: () => void;
  onSwitchCamera: () => void;
  onToggleCamera: () => void;
  onToggleTorch: () => void;
  onWholesaler: () => void;
}) {
  const isReceipt = mode === "receipt";
  const accent = isReceipt ? "#4D9AFF" : "#FFB44D";
  const canUseCamera = !isReceipt || Boolean(selectedWholesaler);
  const scannerActive = cameraActive;
  const codeLabel = scanCodeModeLabel(scanCodeMode);
  const scanStatusText =
    scanNotice ||
    (isReceipt
      ? `${codeLabel}가 인식되면 자동으로 스캔됩니다`
      : "입고 이력 또는 구매 내역에서 판매처를 찾아드려요");
  const [menuOpen, setMenuOpen] = useState(false);

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
        <div className="scan-menu-wrap">
          <button
            className="count-chip status-menu-btn"
            type="button"
            onClick={() => setMenuOpen((current) => !current)}
          >
            {isReceipt && queueCount > 0 ? (
              <>
                <b>{queueCount}</b>
                <span>장</span>
              </>
            ) : (
              <span>상태</span>
            )}
          </button>
          {menuOpen && (
            <div className="scan-dropdown">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onStocks();
                }}
              >
                품목 확인 페이지
              </button>
              <button
                type="button"
                disabled={!isReceipt || queueCount === 0}
                onClick={() => {
                  setMenuOpen(false);
                  onReview();
                }}
              >
                입고 확인 리스트
              </button>
              {/* {nativeAppBridgeAvailable && (
                <> */}
              <label className="scan-toggle-row">
                <input
                  checked={scannerEngine === "native"}
                  type="checkbox"
                  onChange={() => {
                    setMenuOpen(false);
                    onScannerEngine();
                  }}
                />
                <span>네이티브 리더 사용</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onScanPerformanceMode();
                }}
              >
                {scanPerformanceMode === "performance"
                  ? "정밀 스캔 모드"
                  : "저사양 스캔 모드"}
              </button>
              {/* </>
              )} */}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
              >
                로그아웃
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="scan-code-mode-row">
        <div
          className="scan-code-mode-switch"
          role="group"
          aria-label="스캔 코드 종류"
        >
          <button
            className={scanCodeMode === "qr" ? "is-active" : ""}
            type="button"
            onClick={() => onScanCodeMode("qr")}
          >
            QR
          </button>
          <button
            className={scanCodeMode === "barcode" ? "is-active" : ""}
            type="button"
            onClick={() => onScanCodeMode("barcode")}
          >
            바코드
          </button>
        </div>
      </div>

      <section className="scanner-zone">
        {canUseCamera && (
          <div className="camera-actions">
            <button
              type="button"
              className={torchOn ? "is-active" : ""}
              disabled={!torchAvailable}
              onClick={onToggleTorch}
            >
              {torchOn ? (
                <ZapOff size={15} strokeWidth={2.4} />
              ) : (
                <Zap size={15} strokeWidth={2.4} />
              )}
              {torchOn ? "끄기" : "플래시"}
            </button>
            <button type="button" onClick={onRefocusCamera}>
              <Focus size={15} strokeWidth={2.4} />
              초점
            </button>
            <button type="button" onClick={onSwitchCamera}>
              <SwitchCamera size={15} strokeWidth={2.4} />
              전환
            </button>
            <button type="button" onClick={onRefreshCamera}>
              <RefreshCw size={15} strokeWidth={2.4} />
              새로고침
            </button>
          </div>
        )}
        <div className="scan-status-copy">
          <span>{scanStatusText}</span>
        </div>
        <video
          ref={videoRef}
          className={`camera-video ${cameraActive ? "is-active" : ""}`}
          autoPlay
          muted
          playsInline
        />
        <button
          ref={scanGuideRef}
          className={`scan-box ${scannerActive ? "is-active" : ""} ${
            scanCodeMode === "barcode" ? "is-barcode" : ""
          }`}
          style={{ "--accent": accent } as CSSProperties}
          type="button"
          onClick={scannerActive ? undefined : onToggleCamera}
        >
          <span className="corner tl" />
          <span className="corner tr" />
          <span className="corner br" />
          <span className="corner bl" />
          <span className="scan-line" />
        </button>
        <div className="scan-copy">
          <strong>
            {scanCodeMode === "barcode"
              ? isReceipt
                ? "바코드를 가로 프레임 안에 맞춰주세요"
                : "반품할 약품의 바코드를 스캔하세요"
              : isReceipt
                ? "QR을 사각형 안에 맞춰주세요"
                : "반품할 약품의 QR을 스캔하세요"}
          </strong>
        </div>
        <div className="scan-result-stack">
          <div className="scan-result">
            <strong>{lastScanName}</strong>
          </div>
          {isReceipt && queueCount > 0 && (
            <button
              className="scan-receipt-button"
              type="button"
              onClick={onReview}
            >
              <span>입고 신청</span>
            </button>
          )}
        </div>
      </section>

      {isReceipt && !selectedWholesaler && (
        <button className="scan-alert" type="button" onClick={onWholesaler}>
          <strong>먼저 도매처를 선택하세요</strong>
          <span>입고할 약품의 도매처를 선택해야 스캔할 수 있어요.</span>
        </button>
      )}

      {/* {(cameraError || apiMessage) && (
        <div className="runtime-toast">
          {cameraError || `${apiStateLabel(apiState)} · ${apiMessage}`}
        </div>
      )} */}

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
  searchResults,
  searchStatus,
  wholesalers,
  onBack,
  onChoose,
  onReturnFirst,
  onSearch,
  onStart,
}: {
  pendingId: string;
  searchResults: Wholesaler[];
  searchStatus: "idle" | "short" | "loading" | "done" | "error";
  wholesalers: Wholesaler[];
  onBack?: () => void;
  onChoose: (id: string) => void;
  onReturnFirst: () => void;
  onSearch: (keyword: string) => void;
  onStart: () => void;
}) {
  const selected = wholesalers.find((item) => item.id === pendingId);
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeSearchText(query);
  const canSearch = normalizedQuery.length >= 2;

  useEffect(() => {
    if (!canSearch) {
      onSearch(query);
      return;
    }

    const timer = window.setTimeout(() => {
      onSearch(query);
    }, 250);

    return () => window.clearTimeout(timer);
  }, [canSearch, onSearch, query]);

  return (
    <>
      <Header title="도매처 선택" onBack={onBack} />
      <label className="search-field">
        <span className="search-icon" />
        <input
          autoFocus
          placeholder="도매처 이름 검색"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <section className="scroll-body">
        {selected && (
          <div className="selected-wholesaler">
            <span>선택됨</span>
            <strong>{selected.name}</strong>
            <em>{selected.meta}</em>
          </div>
        )}
        <div className="section-label">
          검색 결과 {canSearch ? searchResults.length : 0}
        </div>
        {!canSearch && (
          <div className="empty-state compact">
            <strong>2글자 이상 검색하세요</strong>
          </div>
        )}
        {canSearch && (
          <>
            {searchStatus === "loading" && (
              <div className="empty-state compact">
                <strong>검색 중</strong>
                <span>도매처 목록을 불러오고 있습니다.</span>
              </div>
            )}
            {searchStatus !== "loading" &&
              searchResults.map((wholesaler) => (
                <ChoiceRow
                  key={wholesaler.id}
                  active={pendingId === wholesaler.id}
                  title={wholesaler.name}
                  detail={wholesaler.meta}
                  onClick={() => onChoose(wholesaler.id)}
                />
              ))}
            {searchStatus !== "loading" && searchResults.length === 0 && (
              <div className="empty-state compact">
                <strong>검색 결과가 없습니다</strong>
                <span>도매처 등록과 수정은 관리자페이지에서 진행합니다.</span>
              </div>
            )}
          </>
        )}
      </section>
      <BottomBar stack>
        <button
          className="primary-btn"
          type="button"
          disabled={!selected}
          onClick={onStart}
        >
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
  onRemove,
}: {
  increase: number;
  queue: ReceiptQueueItem[];
  selectedWholesaler: Wholesaler | null;
  onBack: () => void;
  onNext: () => void;
  onRemove: (itemId: string) => void;
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
        {queue.length > 0 ? (
          <div className="list-card">
            {queue.map((item) => (
              <DrugRow
                key={item.id}
                item={item}
                delta={item.drug.productTotalQuantity}
                onRemove={onRemove}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state compact">
            <strong>입고할 QR이 없습니다</strong>
            <span>스캔 화면에서 다시 QR을 추가하세요.</span>
          </div>
        )}
      </section>
      <BottomBar>
        <button
          className="primary-btn"
          type="button"
          disabled={queue.length === 0}
          onClick={onNext}
        >
          매칭 결과 확인
        </button>
      </BottomBar>
    </>
  );
}

function ReceiptMatchScreen({
  commitBlockedReason,
  eligibleCount,
  queue,
  submitErrorMessage,
  onBack,
  onCheckVirtual,
  onCommit,
  onGenerateVirtual,
  onRegeneratePreviewSerials,
  onSelectPrice,
  onVirtualCode,
  onVirtualName,
}: {
  commitBlockedReason: string;
  eligibleCount: number;
  queue: ReceiptQueueItem[];
  submitErrorMessage: string;
  onBack: () => void;
  onCheckVirtual: (itemId: string, insuranceCode: string) => void;
  onCommit: () => void;
  onGenerateVirtual: (itemId: string) => void;
  onRegeneratePreviewSerials?: () => void;
  onSelectPrice: (itemId: string, priceMasterId: string) => void;
  onVirtualCode: (itemId: string, value: string) => void;
  onVirtualName: (itemId: string, value: string) => void;
}) {
  const normal = queue.filter((item) => item.drug.matchStatus === "NORMAL");
  const name = queue.filter((item) => item.drug.matchStatus === "NAME_MATCH");
  const virtual = queue.filter((item) => item.drug.matchStatus === "VIRTUAL");
  const missing = queue.filter((item) => item.drug.matchStatus === "MISSING");
  const commitBlocked = Boolean(commitBlockedReason);
  const [expandedGroups, setExpandedGroups] = useState<
    Record<MatchStatus, boolean>
  >({
    MISSING: true,
    NAME_MATCH: true,
    NORMAL: true,
    VIRTUAL: true,
  });
  const groups: Array<{
    color: string;
    danger?: boolean;
    items: ReceiptQueueItem[];
    status: MatchStatus;
    title: string;
  }> = [
    { color: "#0064FF", items: normal, status: "NORMAL", title: "정상매칭" },
    { color: "#6B4EE6", items: name, status: "NAME_MATCH", title: "이름매칭" },
    { color: "#B07514", items: virtual, status: "VIRTUAL", title: "임의" },
    {
      color: "#C13B2C",
      danger: true,
      items: missing,
      status: "MISSING",
      title: "미등록",
    },
  ];

  return (
    <>
      <Header title="매칭 결과" onBack={onBack} />
      <section className="scroll-body">
        {queue.length > 0 ? (
          groups.map((group) => (
            <ReceiptMatchGroup
              key={group.title}
              color={group.color}
              danger={group.danger}
              expanded={expandedGroups[group.status]}
              items={group.items}
              title={group.title}
              onCheckVirtual={onCheckVirtual}
              onGenerateVirtual={onGenerateVirtual}
              onSelectPrice={onSelectPrice}
              onToggle={() =>
                setExpandedGroups((current) => ({
                  ...current,
                  [group.status]: !current[group.status],
                }))
              }
              onVirtualCode={onVirtualCode}
              onVirtualName={onVirtualName}
            />
          ))
        ) : (
          <div className="empty-state compact">
            <strong>입고할 QR이 없습니다</strong>
            <span>스캔 화면에서 다시 QR을 추가하세요.</span>
          </div>
        )}
      </section>
      <BottomBar stack={Boolean(onRegeneratePreviewSerials)}>
        {onRegeneratePreviewSerials && (
          <button
            className="secondary-btn"
            type="button"
            onClick={onRegeneratePreviewSerials}
          >
            테스트 SN 재생성
          </button>
        )}
        {commitBlocked && (
          <p className="receipt-bottom-warning">{commitBlockedReason}</p>
        )}
        {!commitBlocked && submitErrorMessage && (
          <p className="receipt-bottom-error">{submitErrorMessage}</p>
        )}
        <button
          className="primary-btn"
          type="button"
          disabled={queue.length === 0 || commitBlocked}
          onClick={onCommit}
        >
          {commitBlocked ? "선택 후 입고 확정" : `${eligibleCount}건 입고 확정`}
        </button>
      </BottomBar>
    </>
  );
}

function ReceiptMatchGroup({
  color,
  danger,
  expanded,
  items,
  title,
  onCheckVirtual,
  onGenerateVirtual,
  onSelectPrice,
  onToggle,
  onVirtualCode,
  onVirtualName,
}: {
  color: string;
  danger?: boolean;
  expanded: boolean;
  items: ReceiptQueueItem[];
  title: string;
  onCheckVirtual: (itemId: string, insuranceCode: string) => void;
  onGenerateVirtual: (itemId: string) => void;
  onSelectPrice: (itemId: string, priceMasterId: string) => void;
  onToggle: () => void;
  onVirtualCode: (itemId: string, value: string) => void;
  onVirtualName: (itemId: string, value: string) => void;
}) {
  return (
    <section className={`match-box ${danger ? "danger" : ""}`}>
      <button
        className="match-box-head"
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span>
          <i style={{ backgroundColor: color }} />
          {title}
        </span>
        <span className="match-box-count">
          <strong style={{ color }}>{items.length}건</strong>
          <ChevronDown
            className={expanded ? "is-open" : ""}
            size={16}
            strokeWidth={2.4}
          />
        </span>
      </button>
      {expanded && items.length > 0 && (
        <div
          className={`receipt-fix-list ${
            items.length >= 3 ? "is-scrollable" : ""
          }`}
        >
          {items.map((item) => (
            <ReceiptMatchItem
              key={item.id}
              item={item}
              onCheckVirtual={onCheckVirtual}
              onGenerateVirtual={onGenerateVirtual}
              onSelectPrice={onSelectPrice}
              onVirtualCode={onVirtualCode}
              onVirtualName={onVirtualName}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReceiptMatchItem({
  item,
  onCheckVirtual,
  onGenerateVirtual,
  onSelectPrice,
  onVirtualCode,
  onVirtualName,
}: {
  item: ReceiptQueueItem;
  onCheckVirtual: (itemId: string, insuranceCode: string) => void;
  onGenerateVirtual: (itemId: string) => void;
  onSelectPrice: (itemId: string, priceMasterId: string) => void;
  onVirtualCode: (itemId: string, value: string) => void;
  onVirtualName: (itemId: string, value: string) => void;
}) {
  const candidatePrices = uniquePriceMasters(
    item.drug.priceMasters ?? [],
    item.drug.priceMasterId,
  );
  const hasPriceCandidates = candidatePrices.length > 0;
  const needsVirtualFields = !item.drug.priceMasterId && !hasPriceCandidates;

  return (
    <div className="receipt-fix-card">
      <div className="receipt-fix-head">
        <div>
          <strong>{item.drug.name}</strong>
        </div>
        <div className="receipt-fix-actions">
          <span className={`badge ${statusClass(item.drug.matchStatus)}`}>
            {statusText(item.drug.matchStatus)}
          </span>
        </div>
      </div>
      {hasPriceCandidates && (
        <div className="candidate-chips">
          {candidatePrices.map((price) => (
            <button
              key={price.id}
              className={
                item.drug.priceMasterId === price.id ? "is-active" : ""
              }
              disabled={item.drug.priceMasterId === price.id}
              type="button"
              onClick={() => onSelectPrice(item.id, price.id)}
            >
              <span className="candidate-code">{price.productCode}</span>
              <span className="candidate-name">{price.productName}</span>
            </button>
          ))}
        </div>
      )}
      {!item.drug.priceMasterId && hasPriceCandidates && (
        <p className="candidate-help">
          실제 입고할 약 정보를 선택하면 입고 확정에 포함됩니다.
        </p>
      )}
      {needsVirtualFields && (
        <div className="virtual-fields">
          <label>
            <span>임의 약품명</span>
            <input
              value={item.drug.virtualDrugName ?? item.drug.name}
              onChange={(event) => onVirtualName(item.id, event.target.value)}
            />
          </label>
          <label>
            <span>임의 보험코드</span>
            <input
              value={item.drug.virtualInsuranceCode ?? item.drug.insuranceCode}
              onChange={(event) => onVirtualCode(item.id, event.target.value)}
            />
          </label>
          <div className="virtual-actions">
            <button type="button" onClick={() => onGenerateVirtual(item.id)}>
              자동 생성
            </button>
            <button
              type="button"
              onClick={() =>
                onCheckVirtual(
                  item.id,
                  item.drug.virtualInsuranceCode ?? item.drug.insuranceCode,
                )
              }
            >
              중복 확인
            </button>
            <span
              className={
                item.drug.insuranceCodeExists === true
                  ? "is-duplicated"
                  : item.drug.insuranceCodeExists === false
                    ? "is-available"
                    : ""
              }
            >
              {item.drug.insuranceCodeExists === true
                ? "중복"
                : item.drug.insuranceCodeExists === false
                  ? "사용 가능"
                  : "확인 대기"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function ReturnConfirmedScreen({
  lookup,
  onClose,
  onFullReturn,
  onNext,
}: {
  lookup: Extract<ReturnLookup, { matchType: "CONFIRMED" }>;
  onClose: () => void;
  onFullReturn: () => void;
  onNext: () => void;
}) {
  const fullQuantity = lookup.productTotalQuantity;
  const canReturnFullBottle =
    fullQuantity > 0 && fullQuantity <= lookup.returnableQuantity;
  const isPcOnlyReturn = !lookup.sn;
  const snLabel = lookup.sn || "SN 없음";
  const lotLabel = lookup.lot || "LOT 없음";
  const expLabel = lookup.exp ? `EXP ${lookup.exp.slice(0, 7)}` : "EXP 없음";

  return (
    <ReturnSheet
      height="confirmed"
      variant={isPcOnlyReturn ? "pc-only" : undefined}
    >
      <span className="state-badge confirmed">
        <span />
        {isPcOnlyReturn ? "확정 · 보험코드 재고" : "확정 · 입고 이력 있음"}
      </span>
      <div className="seller-card">
        <span>{isPcOnlyReturn ? "반품 기준" : "확정 도매처"}</span>
        <strong>
          {isPcOnlyReturn ? "보험코드 합산 재고" : lookup.wholesalerName}
        </strong>
      </div>
      <h1>{lookup.drugName}</h1>
      {/* <p className="code-line">
        {snLabel} · {lotLabel} · {expLabel}
      </p> */}
      <div className="info-card">
        <div className="triple">
          <MiniMetric label="제품총수량" value={lookup.productTotalQuantity} />
          <MiniMetric
            label={isPcOnlyReturn ? "현재 재고" : "반품 누적"}
            value={
              isPcOnlyReturn ? lookup.stockQuantity : lookup.returnedQuantity
            }
          />
          <MiniMetric
            label="반품 가능"
            value={lookup.returnableQuantity}
            blue
          />
        </div>
      </div>
      {isPcOnlyReturn && lookup.receiptCandidates.length > 0 && (
        <div className="return-receipt-candidates">
          <span>입고 이력</span>
          <div>
            {lookup.receiptCandidates.slice(0, 5).map((candidate) => (
              <p key={candidate.id}>
                <strong>{candidate.receivedAt}</strong>
                <em>{candidate.wholesalerName}</em>
                <b>{candidate.returnableQuantity}개</b>
              </p>
            ))}
          </div>
        </div>
      )}
      <div className="return-confirm-actions push">
        <button
          className="primary-btn"
          type="button"
          disabled={!canReturnFullBottle}
          onClick={onFullReturn}
        >
          완통 반품
        </button>
        <button className="primary-btn" type="button" onClick={onNext}>
          수량 입력
        </button>
      </div>
      <button
        className="secondary-btn return-close-btn"
        type="button"
        onClick={onClose}
      >
        취소
      </button>
    </ReturnSheet>
  );
}

function ReturnEstimatedScreen({
  lookup,
  reviewMessage,
  onClose,
}: {
  lookup: Extract<ReturnLookup, { matchType: "ESTIMATED" }>;
  reviewMessage: string;
  onClose: () => void;
}) {
  const snLabel = lookup.sn || "SN 없음";
  const lotLabel = lookup.lot || "LOT 없음";
  const expLabel = lookup.exp ? `EXP ${lookup.exp.slice(0, 7)}` : "EXP 없음";

  return (
    <ReturnSheet height="estimated">
      <span className="state-badge estimated">
        <span />
        관리자 확인 필요
      </span>
      <h1>{lookup.drugName}</h1>
      {/* <p className="code-line">
        {snLabel} · {lotLabel} · {expLabel}
      </p> */}
      <p className="estimated-copy">
        {reviewMessage ||
          "입고 이력으로 확정되지 않아 관리자 반품 확인에서 재고를 선택해 처리해야 합니다."}
      </p>
      <div className="candidate-list return-candidate-list">
        {lookup.sellerCandidates.map((candidate) => {
          const productName =
            candidate.productName && candidate.productName !== "-"
              ? candidate.productName
              : "";
          const metaParts = [
            candidate.orderItemName && candidate.orderItemName !== "-"
              ? candidate.orderItemName
              : "",
            candidate.quantity > 0 ? `${candidate.quantity}개` : "",
          ].filter(Boolean);

          return (
            <div key={candidate.id} className="return-candidate">
              <span className="return-candidate-main">
                <strong>{candidate.sellerName}</strong>
                <em>{candidate.transactionAt}</em>
              </span>
              {productName && (
                <span className="return-candidate-product">{productName}</span>
              )}
              {metaParts.length > 0 && (
                <span className="return-candidate-meta">
                  {metaParts.join(" · ")}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <button className="primary-btn push" type="button" onClick={onClose}>
        다시 스캔
      </button>
      <button
        className="secondary-btn return-close-btn"
        type="button"
        onClick={onClose}
      >
        닫기
      </button>
    </ReturnSheet>
  );
}

function ReturnNoneScreen({
  lookup,
  reviewMessage,
  onClose,
}: {
  lookup: Extract<ReturnLookup, { matchType: "NONE" }> | null;
  reviewMessage: string;
  onClose: () => void;
}) {
  const drugName =
    lookup?.drugName && lookup.drugName !== "미확인 약품"
      ? lookup.drugName
      : "";

  return (
    <ReturnSheet height="none">
      <div className="none-body">
        <div className="none-icon" />
        <h1>{lookup?.message ?? "입고 내역이 확인되지 않는 상품입니다."}</h1>
        <p>
          {reviewMessage ||
            (drugName
              ? `${drugName}은 관리자 반품 확인에서 재고를 선택해 처리해야 합니다.`
              : "관리자 반품 확인에서 재고를 선택해 처리해야 합니다.")}
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
            <button
              type="button"
              disabled={max <= 0 || quantity <= 1}
              onClick={() => onQuantity(quantity - 1)}
            >
              -
            </button>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="0"
              value={quantity > 0 ? String(quantity) : ""}
              disabled={max <= 0}
              onChange={(event) => {
                const next = Number(event.target.value.replace(/\D/g, ""));
                onQuantity(next);
              }}
            />
            <button
              type="button"
              disabled={max <= 0 || quantity >= max}
              onClick={() => onQuantity(quantity + 1)}
            >
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
          disabled={max <= 0 || quantity <= 0}
          onClick={onCommit}
        >
          {Math.max(0, quantity)}개 반품하기
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
  loading,
  message,
  stocks,
  onBack,
  onRefresh,
}: {
  loading: boolean;
  message: string;
  stocks: StockItem[];
  onBack: () => void;
  onRefresh: () => Promise<boolean>;
}) {
  return (
    <>
      <Header title="재고 목록" note={`${stocks.length}건`} onBack={onBack} />
      <section className="scroll-body">
        <div className="list-toolbar">
          <span>{message || "서버 재고 목록을 표시합니다."}</span>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              void onRefresh();
            }}
          >
            새로고침
          </button>
        </div>
        {loading && (
          <div className="empty-state compact">
            <strong>재고 목록 불러오는 중</strong>
            <span>현재 재고를 불러오고 있습니다.</span>
          </div>
        )}
        {!loading && stocks.length === 0 && (
          <div className="empty-state compact">
            <strong>재고가 없습니다</strong>
            <span>
              입고를 확정하거나 관리자 페이지에서 재고를 확인해 주세요.
            </span>
          </div>
        )}
        {stocks.length > 0 && (
          <div className="list-card stock-list">
            {stocks.map((stock) => (
              <div className="stock-row" key={stock.id}>
                <div className="stock-main">
                  <strong className="stock-name">{stock.name}</strong>
                  <div className="stock-meta">
                    <span>{stock.insuranceCode || "보험코드 없음"}</span>
                    <span>예상 {currency(stock.quantity * stock.price)}원</span>
                  </div>
                </div>
                <div className="stock-side">
                  <span className={`badge ${statusClass(stock.matchStatus)}`}>
                    {statusText(stock.matchStatus)}
                  </span>
                  <b>{stock.quantity}개</b>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function AccountScreen({
  loginId,
  password,
  onBack,
  onLoginId,
  onPassword,
  onSubmit,
}: {
  loginId: string;
  password: string;
  onBack?: () => void;
  onLoginId: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      {onBack && <Header title="계정" onBack={onBack} />}
      <section className="scroll-body account-body">
        <div className="login-panel">
          <div className="app-login-hero">
            <div className="app-login-logo">
              <img src={pharmfarmLogo} alt="" />
            </div>
            <span>약품 재고를 스캔으로 간편하게</span>
          </div>
          <form className="login-form" onSubmit={onSubmit}>
            <label>
              <span>약국 아이디</span>
              <input
                autoComplete="username"
                value={loginId}
                onChange={(event) => onLoginId(event.target.value)}
              />
            </label>
            <label>
              <span>비밀번호</span>
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => onPassword(event.target.value)}
              />
            </label>
            <button className="primary-btn" type="submit">
              로그인
            </button>
            <div className="login-links">
              <span>비밀번호 찾기</span>
              <i />
              <span>약국 등록 문의</span>
            </div>
          </form>
        </div>
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
  const hasBack = Boolean(onBack);

  return (
    <header className={`page-header ${hasBack ? "has-back" : "no-back"}`}>
      {onBack && <button className="back-btn" type="button" onClick={onBack} />}
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

function DrugRow({
  delta,
  item,
  onRemove,
}: {
  delta: number;
  item: ReceiptQueueItem;
  onRemove?: (itemId: string) => void;
}) {
  return (
    <div className="drug-row">
      <div>
        <strong>{item.drug.name}</strong>
        <span>{receiptDrugDetail(item)}</span>
      </div>
      <b>{delta > 0 ? `+${delta}` : "-"}</b>
      <span className={`badge ${statusClass(item.drug.matchStatus)}`}>
        {statusText(item.drug.matchStatus)}
      </span>
      {onRemove && (
        <button
          className="icon-delete-btn"
          type="button"
          aria-label={`${item.drug.name} 삭제`}
          title="삭제"
          onClick={() => onRemove(item.id)}
        >
          <Trash2 size={15} strokeWidth={2.3} />
        </button>
      )}
    </div>
  );
}

function receiptDrugDetail(item: ReceiptQueueItem) {
  const parts = [`SN ${item.qr.sn || "-"}`];
  const candidateCount = item.drug.priceMasters?.length ?? 0;

  if (item.drug.priceMasterId) {
    parts.push(item.drug.insuranceCode || "보험코드 없음");
    parts.push(`가격 ${currency(item.drug.price)}원`);
  } else if (candidateCount > 0) {
    parts.push(`가격 후보 ${candidateCount}건`);
    if (item.drug.insuranceCode) parts.push(item.drug.insuranceCode);
  } else if (item.drug.virtualInsuranceCode || item.drug.insuranceCode) {
    parts.push(
      `임의 ${item.drug.virtualInsuranceCode || item.drug.insuranceCode}`,
    );
  } else {
    parts.push("보험코드 보정 필요");
  }

  parts.push(`총수량 ${item.drug.productTotalQuantity}`);
  return parts.join(" · ");
}

function ReturnSheet({
  children,
  height,
  variant,
}: {
  children: ReactNode;
  height: "confirmed" | "estimated" | "none";
  variant?: "pc-only";
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
      <section
        className={`return-sheet ${height} ${variant ? `is-${variant}` : ""}`}
      >
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
  | "signup"
  | "inventory"
  | "inventory-shortages"
  | "return-reviews"
  | "wholesaler"
  | "prescriptions"
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
  active: boolean;
};

type CmsImportJob = {
  id: string;
  dataType: "1번" | "2번";
  fileName: string;
  status:
    | "PENDING"
    | "RUNNING"
    | "SUCCESS"
    | "FAILED"
    | "AUTH_FAILED"
    | "PARTIAL_AUTH_FAILED";
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

type CmsCookieState = {
  registered: boolean;
  status: "VALID" | "AUTH_FAILED" | "UNKNOWN";
  maskedCookie: string;
  message: string;
};

type BaropharmCookieDraft = {
  sessionId: string;
  csrfToken: string;
};

type CmsPurchaseHistory = {
  id: string;
  sellerName: string;
  transactionAt: string;
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

type CmsDeductionStatus =
  | "DEDUCTED"
  | "PARTIAL_DEDUCTED"
  | "SHORTAGE"
  | "FAILED"
  | "RESOLVED"
  | "PENDING";
type CmsDeductionFilter = "ALL" | "SHORTAGE_ITEMS" | CmsDeductionStatus;
type CmsStockControlledFilter =
  | "ALL"
  | "CONTROLLED"
  | "NON_CONTROLLED"
  | "VIRTUAL";
type CmsStockSortKey = "name" | "quantity";
type CmsStockSortDirection = "asc" | "desc";
type CmsStockSearchStatus = "idle" | "short" | "loading" | "done" | "error";
type CmsStockSnapshotSyncSummary = {
  type: string;
  pharmacyId: string;
  synced: number;
  snapshotRows: number;
  snapshotDrugCount: number;
  positiveDrugCount: number;
  zeroDrugCount: number;
  negativeDrugCount: number;
};
type CmsDeductionResolution =
  | "VIRTUAL_DRUG"
  | "EXISTING_STOCK"
  | "UNREGISTERED_DRUG";
type CmsShortageStatus = "OPEN" | "ORDERED" | "HOLD" | "RESOLVED" | "IGNORED";
type CmsShortageListFilter = "OPEN" | "ORDERED" | "HOLD";
type CmsReturnReviewStatus = "OPEN" | "HOLD" | "RESOLVED";
type CmsReturnReviewFilter = CmsReturnReviewStatus;

type CmsReturnReview = {
  id: string;
  pc: string;
  sn: string;
  lot: string;
  exp: string;
  drugName: string;
  insuranceCode: string;
  matchType: "ESTIMATED" | "NO_SELLER_CANDIDATE" | "CONFIRMED";
  status: CmsReturnReviewStatus;
  message: string;
  sellerCandidateCount: number;
  sellerCandidateSummary: string;
  requestedQuantity: number;
  returnQuantity: number;
  stockId?: string;
  stockName?: string;
  stockBefore?: number;
  stockAfter?: number;
  memo?: string;
  createdAt: string;
  resolvedAt?: string;
};

type CmsDeductionRecord = {
  id: string;
  prescriptionCode: string;
  lineNo: number;
  insuranceCode: string;
  drugName: string;
  totalQuantity: number;
  deductedQuantity: number;
  shortageQuantity: number;
  status: CmsDeductionStatus;
  reason: string;
  resolutionType?: CmsDeductionResolution;
  shortageStatus?: CmsShortageStatus;
  stockId?: string;
  stockName?: string;
  stockBefore?: number;
  stockAfter?: number;
  displayAfter?: number;
  memo?: string;
  createdAt: string;
  resolvedAt?: string;
};

type CmsPrescriptionDrugLine = {
  lineNo: number;
  insuranceCode: string;
  drugName: string;
  quantityPerDose: number;
  dailyFrequency: number;
  medicationDays: number;
  totalQuantity: number;
  memo: string;
};

type CmsShortageDetail = {
  deduction: CmsDeductionRecord;
  prescriptionId: string;
  prescriptionCode: string;
  prescriptionGroupLabel: string;
  source: string;
  drugCount: number;
  capturedAt: string;
  createdAt: string;
  drugs: CmsPrescriptionDrugLine[];
};

type CmsDashboardData = {
  tasks: {
    failedDeductions: number;
    virtualStocks: number;
    zeroStocks: number;
    controlledCandidates: number;
    baropharmNeedsAction: boolean;
    agentNeedsAction: boolean;
  };
  todayMovements: {
    receivedQuantity: number;
    returnedQuantity: number;
    prescriptionDeductedQuantity: number;
    manualAdjustedQuantity: number;
  };
  stockSummary: {
    stockCount: number;
    totalQuantity: number;
    estimatedAmount: number;
    zeroStockCount: number;
    virtualStockCount: number;
    controlledStockCount: number;
  };
  traceSummary: {
    returnableItemCount: number;
    missingExpiryItemCount: number;
    expiringSoonItemCount: number;
  };
  integrationStatus: {
    agentLastSeenAt: string;
    agentLastPayloadType: string;
    baropharmCookieRegistered: boolean;
    lastPurchaseSyncStatus: string;
    lastPurchaseSyncAt: string;
  };
  recentActivities: CmsDashboardActivity[];
};

type CmsDashboardActivity = {
  id: string;
  type: string;
  title: string;
  description: string;
  tone: "blue" | "amber" | "red";
  occurredAt: string;
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
    active: true,
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
    active: true,
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
    active: true,
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
    active: false,
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
    active: true,
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
    message: "구매내역 인증 만료 · 연결 정보 확인 후 재개 필요",
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

const demoCookieState: CmsCookieState = {
  registered: true,
  status: "AUTH_FAILED",
  maskedCookie: "구매내역 인증 정보 보관됨",
  message: "구매내역 인증 만료 · 연결 정보 확인 필요",
};

const demoCmsPurchaseHistories: CmsPurchaseHistory[] = [
  {
    id: "PH-100",
    sellerName: "한미약품 A도매",
    transactionAt: "2026-01-10 12:56",
    orderItemName: "타이레놀정 500mg 30T",
    productName: "타이레놀정",
    quantity: 30,
    source: "BAROPHARM",
  },
  {
    id: "PH-101",
    sellerName: "지오영 도매",
    transactionAt: "2025-11-22 09:12",
    orderItemName: "예시약 30정",
    productName: "예시약",
    quantity: 60,
    source: "BAROPHARM",
  },
];

const demoDeductionRecords: CmsDeductionRecord[] = [
  {
    id: "D-500",
    prescriptionCode: "RX-20260618-000",
    lineNo: 1,
    insuranceCode: "640001700",
    drugName: "타이레놀정 500mg",
    totalQuantity: 6,
    deductedQuantity: 6,
    shortageQuantity: 0,
    status: "DEDUCTED",
    reason: "처방 약명과 보유 재고명이 일치해 자동 차감",
    stockId: "S-001",
    stockName: "타이레놀정 500mg",
    stockBefore: 30,
    stockAfter: 24,
    displayAfter: 24,
    createdAt: "2026.06.18 09:20",
  },
  {
    id: "D-504",
    prescriptionCode: "RX-20260618-003",
    lineNo: 2,
    insuranceCode: "643102120",
    drugName: "리리카캡슐 75mg",
    totalQuantity: 180,
    deductedQuantity: 100,
    shortageQuantity: 80,
    status: "PARTIAL_DEDUCTED",
    reason: "재고 부족으로 일부만 차감되었습니다.",
    shortageStatus: "OPEN",
    stockId: "S-004",
    stockName: "리리카캡슐 75mg",
    stockBefore: 100,
    stockAfter: 0,
    displayAfter: -80,
    createdAt: "2026.06.18 09:22",
  },
  {
    id: "D-501",
    prescriptionCode: "RX-20260618-001",
    lineNo: 3,
    insuranceCode: "670001180",
    drugName: "세토펜건조시럽",
    totalQuantity: 3,
    deductedQuantity: 0,
    shortageQuantity: 0,
    status: "FAILED",
    reason: "보험코드 기준 재고 미조회",
    createdAt: "2026.06.18 09:24",
  },
  {
    id: "D-502",
    prescriptionCode: "RX-20260618-006",
    lineNo: 1,
    insuranceCode: "-",
    drugName: "미등록 감기약",
    totalQuantity: 2,
    deductedQuantity: 0,
    shortageQuantity: 0,
    status: "FAILED",
    reason: "기준 데이터 미등록",
    createdAt: "2026.06.18 09:37",
  },
  {
    id: "D-503",
    prescriptionCode: "RX-20260617-022",
    lineNo: 2,
    insuranceCode: "3PF000124",
    drugName: "비급여 연고 20g",
    totalQuantity: 1,
    deductedQuantity: 1,
    shortageQuantity: 0,
    status: "RESOLVED",
    reason: "임의 항목을 임의 약품으로 처리",
    resolutionType: "VIRTUAL_DRUG",
    stockName: "비급여 연고 20g",
    stockBefore: 8,
    stockAfter: 7,
    displayAfter: 7,
    createdAt: "2026.06.17 16:12",
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

  if (path.startsWith("/agent")) {
    return <AgentLanding navigate={navigate} />;
  }

  if (path.startsWith("/cms")) {
    return <CmsApp path={path} navigate={navigate} />;
  }

  return <MobileApp />;
}

function AgentLanding({ navigate }: { navigate: (path: string) => void }) {
  const buildDate = new Date(APP_BUILD_TIME);
  const buildTimeLabel = Number.isNaN(buildDate.getTime())
    ? APP_BUILD_TIME
    : new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(buildDate);
  const commitLabel = APP_COMMIT_SHA ? APP_COMMIT_SHA.slice(0, 7) : "local";

  return (
    <main className="agent-download-page">
      <section className="agent-download-hero">
        <div className="agent-brand-row">
          <img src={pharmfarmLogo} alt="PharmFarm" />
          <span>PharmFarm</span>
        </div>
        <div className="agent-build-badge" aria-label="배포 버전 정보">
          <span>최근 업데이트 {buildTimeLabel}</span>
          <span>build {commitLabel}</span>
        </div>
        <p className="agent-eyebrow">Windows Production Agent</p>
        <h1>약국 PC에 설치하는 처방 수집 에이전트</h1>
        <p>
          이팜 로컬 SQL Server에서 처방 조제약, 현재 재고, 약품 마스터, 바코드,
          도매처 데이터를 읽어 PharmFarm 서버로 전송합니다. 설치 시 관리자 약국
          ID를 입력해 계정과 기기를 연결하고, 네트워크가 끊기면 로컬 큐에 보관한
          뒤 자동 재시도합니다.
        </p>
        <div className="agent-download-actions">
          <a
            className="agent-primary-button"
            href="/pharmfarm-agent-production.zip"
            download
          >
            <HardDriveDownload size={20} />
            Windows 설치 파일 다운로드
          </a>
          <button
            type="button"
            className="agent-secondary-button"
            onClick={() => navigate("/cms")}
          >
            관리자로 이동
          </button>
        </div>
      </section>

      <section className="agent-feature-grid" aria-label="에이전트 주요 기준">
        <div>
          <ShieldCheck size={24} />
          <strong>보안 기본값</strong>
          <span>
            환자 직접 식별자는 수집하지 않고 QR 원문은 운영 기본값에서 전송하지
            않습니다.
          </span>
        </div>
        <div>
          <WifiOff size={24} />
          <strong>오프라인 큐</strong>
          <span>
            연결 장애나 네트워크 단절 시 큐에 보관하고 성공할 때까지
            재시도합니다.
          </span>
        </div>
        <div>
          <RefreshCw size={24} />
          <strong>자동 실행</strong>
          <span>
            Windows 예약 작업과 트레이 아이콘을 등록해 로그인 시 자동
            실행합니다.
          </span>
        </div>
      </section>

      <section className="agent-steps-panel">
        <h2>설치 순서</h2>
        <ol>
          <li>설치 파일을 다운로드하고 압축을 해제합니다.</li>
          <li>
            <b>install-pharmfarm-agent.bat</b>을 실행합니다.
          </li>
          <li>
            서버 주소는 기본값을 유지하고 SQL Server는 <b>.\\EPHARM_DB</b>를
            사용합니다.
          </li>
          <li>
            관리자 페이지에서 확인한 <b>약국 ID</b>를 입력해 서버 계정과 기기를
            연결합니다.
          </li>
          <li>
            <b>디버깅용 QR 원문 포함</b>은 체크하지 않습니다.
          </li>
          <li>
            <b>약품 마스터</b>와 <b>현재 재고/바코드/도매처 1회 동기화</b>를
            선택합니다.
          </li>
          <li>
            이팜에서 QR을 등록한 뒤 PharmFarm 처방/리스트에서 수신 여부를
            확인합니다.
          </li>
        </ol>
      </section>
    </main>
  );
}

function getCmsPage(path: string): CmsPage {
  const segments = path.split("/").filter(Boolean);
  const segment = segments[1];
  const subSegment = segments[2];
  if (segment === "inventory" && subSegment === "shortages") {
    return "inventory-shortages";
  }
  if (segment === "inventory" && subSegment === "returns") {
    return "return-reviews";
  }
  if (
    segment === "master" ||
    segment === "import" ||
    segment === "signup" ||
    segment === "inventory" ||
    segment === "wholesaler" ||
    segment === "dispense" ||
    segment === "prescriptions" ||
    segment === "purchase"
  ) {
    return segment === "dispense" ? "prescriptions" : segment;
  }
  return "dashboard";
}

function getCmsShortageId(path: string) {
  const segments = path.split("/").filter(Boolean);
  if (segments[1] !== "inventory" || segments[2] !== "shortages") return "";
  return decodeURIComponent(segments[3] ?? "");
}

function getCmsReturnReviewId(path: string) {
  const segments = path.split("/").filter(Boolean);
  if (segments[1] !== "inventory" || segments[2] !== "returns") return "";
  return decodeURIComponent(segments[3] ?? "");
}

const ROOT_CMS_LOGIN_ID = "root";

function canAccessRootCms(account?: AuthAccount | null) {
  return account?.loginId?.trim().toLowerCase() === ROOT_CMS_LOGIN_ID;
}

function canAccessMasterDataCms(account?: AuthAccount | null) {
  return canAccessRootCms(account);
}

function canViewAmountCms(account?: AuthAccount | null) {
  const role = account?.role?.toUpperCase();
  const accountType = account?.accountType?.toUpperCase();
  return (
    role === "ADMIN" || role === "PHARMACY_OWNER" || accountType === "PRIMARY"
  );
}

function canSyncStockSnapshotCms(account?: AuthAccount | null) {
  return canAccessRootCms(account) || account?.role?.toUpperCase() === "ADMIN";
}

function cmsGreetingRoleLabel(account?: AuthAccount | null) {
  const role = account?.role?.toUpperCase();
  const accountType = account?.accountType?.toUpperCase();

  if (role === "ADMIN") return "관리자님";
  if (accountType === "PRIMARY" || role === "PHARMACY_OWNER") {
    return "약국장님";
  }
  return "약사님";
}

function isRestrictedCmsPage(page: CmsPage) {
  return (
    page === "master" ||
    page === "import" ||
    page === "signup" ||
    page === "wholesaler"
  );
}

function CmsApp({
  navigate,
  path,
}: {
  navigate: (path: string) => void;
  path: string;
}) {
  const page = getCmsPage(path);
  const shortageRouteId = getCmsShortageId(path);
  const returnReviewRouteId = getCmsReturnReviewId(path);
  const isCmsLoginRoute = path === "/cms/login";
  const [postLoginPath, setPostLoginPath] = useState(
    path === "/cms/login" ? "/cms" : path,
  );
  const [apiState, setApiState] = useState<ApiState>(() =>
    hasStoredAuthTokens() ? "checking" : "unauthorized",
  );
  const [apiMessage, setApiMessage] = useState(() =>
    hasStoredAuthTokens()
      ? "관리자 데이터 확인 중"
      : "관리자 로그인이 필요합니다.",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(storageKeys.cmsSidebarCollapsed) === "true",
  );
  const compactCmsNav = useMediaQuery(cmsCompactNavQuery);
  const [cmsReady, setCmsReady] = useState(() => !hasStoredAuthTokens());
  const [authAccount, setAuthAccount] = useState<AuthAccount | null>(() =>
    getStoredAuthAccount(),
  );
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [signupDraft, setSignupDraft] = useState<CmsSignupDraft>(
    createDefaultCmsSignupDraft,
  );
  const [signupSubmitting, setSignupSubmitting] = useState(false);
  const [dashboardData, setDashboardData] = useState<CmsDashboardData | null>(
    null,
  );
  const [masterQuery, setMasterQuery] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [masters, setMasters] = useState<CmsMaster[]>([]);
  const [stocks, setStocks] = useState<StockItem[]>([]);
  const [stockQuery, setStockQuery] = useState("");
  const [stockControlledFilter, setStockControlledFilter] =
    useState<CmsStockControlledFilter>("ALL");
  const [stockSortKey, setStockSortKey] = useState<CmsStockSortKey>("quantity");
  const [stockSortDirection, setStockSortDirection] =
    useState<CmsStockSortDirection>("desc");
  const [cmsStockSearchStatus, setCmsStockSearchStatus] =
    useState<CmsStockSearchStatus>("idle");
  const [wholesalers, setWholesalers] = useState<Wholesaler[]>([]);
  const [cmsWholesalerSearchStatus, setCmsWholesalerSearchStatus] = useState<
    "idle" | "short" | "loading" | "done" | "error"
  >("idle");
  const [wholesalerQuery, setWholesalerQuery] = useState("");
  const [newWholesalerName, setNewWholesalerName] = useState("");
  const [selectedWholesalerId, setSelectedWholesalerId] = useState("");
  const [editingWholesalerName, setEditingWholesalerName] = useState("");
  const [importJobs, setImportJobs] = useState<CmsImportJob[]>([]);
  const [cookieState, setCookieState] = useState<CmsCookieState>({
    registered: false,
    status: "UNKNOWN",
    maskedCookie: "",
    message: "구매내역 연결 정보를 확인하기 전입니다.",
  });
  const [baropharmCookieDraft, setBaropharmCookieDraft] =
    useState<BaropharmCookieDraft>({
      sessionId: "",
      csrfToken: "",
    });
  const [syncStartDate, setSyncStartDate] = useState(
    new Date().toISOString().split("T")[0],
  );
  const [syncEndDate, setSyncEndDate] = useState(
    new Date().toISOString().split("T")[0],
  );
  const [purchaseHistories, setPurchaseHistories] = useState<
    CmsPurchaseHistory[]
  >([]);
  const [syncJobs, setSyncJobs] = useState<CmsSyncJob[]>([]);
  const [deductionRecords, setDeductionRecords] = useState<
    CmsDeductionRecord[]
  >([]);
  const [returnReviews, setReturnReviews] = useState<CmsReturnReview[]>([]);
  const [deductionFilter, setDeductionFilter] =
    useState<CmsDeductionFilter>("FAILED");
  const [selectedMasterId, setSelectedMasterId] = useState("");
  const [selectedDeductionId, setSelectedDeductionId] = useState("");
  const [selectedShortageId, setSelectedShortageId] = useState("");
  const [selectedReturnReviewId, setSelectedReturnReviewId] = useState("");
  const [selectedShortageDetail, setSelectedShortageDetail] =
    useState<CmsShortageDetail | null>(null);
  const [shortageDetailLoading, setShortageDetailLoading] = useState(false);
  const [selectedStockId, setSelectedStockId] = useState("");
  const [adjustQuantity, setAdjustQuantity] = useState(5);
  const [adjustDirection, setAdjustDirection] = useState<
    "INCREASE" | "DECREASE"
  >("INCREASE");
  const [adjustMemo, setAdjustMemo] = useState("실사 후 수량 보정");
  const [mergeInsuranceCode, setMergeInsuranceCode] = useState("643102120");
  const [prescriptionId, setPrescriptionId] = useState("");
  const canAccessMasterData = canAccessMasterDataCms(authAccount);
  const visiblePage =
    canAccessMasterData || !isRestrictedCmsPage(page) ? page : "dashboard";
  const previousVisiblePageRef = useRef(visiblePage);
  const previousShortageRouteIdRef = useRef(shortageRouteId);
  const previousReturnReviewRouteIdRef = useRef(returnReviewRouteId);

  const selectedMaster =
    masters.find((master) => master.id === selectedMasterId) ?? masters[0];
  const selectedStock =
    stocks.find((stock) => stock.id === selectedStockId) ?? stocks[0];
  const selectedWholesaler =
    wholesalers.find((wholesaler) => wholesaler.id === selectedWholesalerId) ??
    wholesalers[0];
  const filteredDeductionRecords = useMemo(
    () =>
      deductionFilter === "ALL"
        ? deductionRecords
        : deductionFilter === "SHORTAGE_ITEMS"
          ? deductionRecords.filter((record) => record.shortageQuantity > 0)
          : deductionRecords.filter(
              (record) => record.status === deductionFilter,
            ),
    [deductionFilter, deductionRecords],
  );
  const selectedDeduction =
    filteredDeductionRecords.find(
      (record) => record.id === selectedDeductionId,
    ) ?? filteredDeductionRecords[0];
  const shortageRecords = useMemo(
    () => deductionRecords.filter((record) => record.shortageQuantity > 0),
    [deductionRecords],
  );
  const activeShortageId = shortageRouteId || selectedShortageId;
  const selectedShortage =
    shortageRecords.find((record) => record.id === activeShortageId);
  const activeReturnReviewId = returnReviewRouteId || selectedReturnReviewId;
  const selectedReturnReview =
    returnReviews.find((record) => record.id === activeReturnReviewId);
  const hasCmsSession = hasStoredAuthTokens();
  const effectiveSidebarCollapsed = sidebarCollapsed && !compactCmsNav;

  useEffect(() => {
    localStorage.setItem(
      storageKeys.cmsSidebarCollapsed,
      sidebarCollapsed ? "true" : "false",
    );
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (masters.length === 0) {
      if (selectedMasterId) setSelectedMasterId("");
      return;
    }
    if (!masters.some((master) => master.id === selectedMasterId)) {
      setSelectedMasterId(masters[0].id);
    }
  }, [masters, selectedMasterId]);

  useEffect(() => {
    if (stocks.length === 0) {
      if (selectedStockId) setSelectedStockId("");
      return;
    }
    if (!stocks.some((stock) => stock.id === selectedStockId)) {
      setSelectedStockId(stocks[0].id);
    }
  }, [selectedStockId, stocks]);

  useEffect(() => {
    if (filteredDeductionRecords.length === 0) {
      if (selectedDeductionId) setSelectedDeductionId("");
      return;
    }
    if (
      !filteredDeductionRecords.some(
        (record) => record.id === selectedDeductionId,
      )
    ) {
      setSelectedDeductionId(filteredDeductionRecords[0].id);
    }
  }, [filteredDeductionRecords, selectedDeductionId]);

  useEffect(() => {
    if (shortageRecords.length === 0) {
      if (selectedShortageId) setSelectedShortageId("");
      setSelectedShortageDetail(null);
      return;
    }
    if (shortageRouteId) {
      if (selectedShortageId !== shortageRouteId) {
        setSelectedShortageId(shortageRouteId);
      }
      return;
    }
    if (!shortageRecords.some((record) => record.id === selectedShortageId)) {
      setSelectedShortageId("");
    }
  }, [selectedShortageId, shortageRecords, shortageRouteId]);

  useEffect(() => {
    if (returnReviews.length === 0) {
      if (selectedReturnReviewId) setSelectedReturnReviewId("");
      return;
    }
    if (returnReviewRouteId) {
      if (selectedReturnReviewId !== returnReviewRouteId) {
        setSelectedReturnReviewId(returnReviewRouteId);
      }
      return;
    }
    if (!returnReviews.some((record) => record.id === selectedReturnReviewId)) {
      setSelectedReturnReviewId("");
    }
  }, [returnReviewRouteId, returnReviews, selectedReturnReviewId]);

  useEffect(() => {
    const previousVisiblePage = previousVisiblePageRef.current;
    const previousShortageRouteId = previousShortageRouteIdRef.current;
    const previousReturnReviewRouteId = previousReturnReviewRouteIdRef.current;

    previousVisiblePageRef.current = visiblePage;
    previousShortageRouteIdRef.current = shortageRouteId;
    previousReturnReviewRouteIdRef.current = returnReviewRouteId;

    if (
      visiblePage === "inventory-shortages" &&
      !shortageRouteId &&
      (previousVisiblePage !== "inventory-shortages" || previousShortageRouteId)
    ) {
      setSelectedShortageId("");
      setSelectedShortageDetail(null);
    }

    if (
      visiblePage === "return-reviews" &&
      !returnReviewRouteId &&
      (previousVisiblePage !== "return-reviews" || previousReturnReviewRouteId)
    ) {
      setSelectedReturnReviewId("");
    }
  }, [returnReviewRouteId, shortageRouteId, visiblePage]);

  useEffect(() => {
    setEditingWholesalerName(selectedWholesaler?.name ?? "");
  }, [selectedWholesaler?.name]);

  useEffect(() => {
    if (apiState !== "unauthorized" || isCmsLoginRoute) return;

    setPostLoginPath(path);
    navigate("/cms/login");
  }, [apiState, isCmsLoginRoute, navigate, path]);

  useEffect(() => {
    if (!isCmsLoginRoute || !hasCmsSession || apiState === "unauthorized") {
      return;
    }

    const nextPage = getCmsPage(postLoginPath);
    const nextPath =
      postLoginPath === "/cms/login" ||
      (!canAccessMasterData && isRestrictedCmsPage(nextPage))
        ? "/cms"
        : postLoginPath;
    navigate(nextPath);
  }, [
    apiState,
    canAccessMasterData,
    hasCmsSession,
    isCmsLoginRoute,
    navigate,
    postLoginPath,
  ]);

  useEffect(() => {
    if (
      isCmsLoginRoute ||
      apiState === "unauthorized" ||
      canAccessMasterData ||
      !isRestrictedCmsPage(page)
    ) {
      return;
    }

    navigate("/cms");
  }, [apiState, canAccessMasterData, isCmsLoginRoute, navigate, page]);

  const applyCmsDemoData = useCallback(() => {
    setMasters((current) => (current.length > 0 ? current : demoCmsMasters));
    setStocks((current) => (current.length > 0 ? current : initialStocks));
    setImportJobs((current) => (current.length > 0 ? current : demoImportJobs));
    setCookieState((current) =>
      current.registered ? current : demoCookieState,
    );
    setPurchaseHistories((current) =>
      current.length > 0 ? current : demoCmsPurchaseHistories,
    );
    setSyncJobs((current) =>
      current.length > 0 ? current : demoPurchaseSyncJobs,
    );
    setDeductionRecords((current) =>
      current.length > 0 ? current : demoDeductionRecords,
    );
  }, []);

  const cmsFallback = useCallback(
    (error: unknown) => {
      setCmsReady(true);
      if (error instanceof Error && error.message === "UNAUTHORIZED") {
        clearAuthTokens();
        setAuthAccount(null);
        setApiState("unauthorized");
        setApiMessage("관리자 로그인이 필요합니다.");
        return;
      }
      if (error instanceof Error && error.message === "FORBIDDEN") {
        setApiState("forbidden");
        setApiMessage("현재 계정에 관리자 실행 권한이 없습니다.");
        return;
      }
      applyCmsDemoData();
      setApiState("demo");
      setApiMessage("데이터 연결 실패 · 실제 데이터를 불러오지 못했습니다.");
    },
    [applyCmsDemoData],
  );

  const refreshCms = useCallback(async () => {
    if (!hasStoredAuthTokens()) {
      setAuthAccount(null);
      setApiState("unauthorized");
      setApiMessage("관리자 로그인이 필요합니다.");
      setCmsReady(true);
      return false;
    }

    setApiState("checking");
    try {
      const accountResponse = await apiFetch<unknown>("/auth/me");
      const nextAccount = storeAuthAccount(
        normalizeAuthAccount(
          accountResponse,
          getStoredAccessToken() ?? undefined,
        ),
      );
      setAuthAccount(nextAccount);

      const targetPage =
        canAccessMasterDataCms(nextAccount) || !isRestrictedCmsPage(page)
          ? page
          : "dashboard";
      const throwRejected = (results: PromiseSettledResult<unknown>[]) => {
        const rejected = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (rejected) throw rejected.reason;
      };

      if (targetPage === "dashboard") {
        const [dashboardResult, failureResult, shortageResult] =
          await Promise.allSettled([
            optionalCmsApiFetch<unknown>("/dashboard"),
            apiFetch<unknown>("/prescription-deductions/failed"),
            optionalCmsApiFetch<unknown>("/prescription-shortages"),
          ]);
        throwRejected([dashboardResult, failureResult, shortageResult]);

        if (dashboardResult.status === "fulfilled") {
          setDashboardData(
            dashboardResult.value
              ? normalizeCmsDashboard(dashboardResult.value)
              : null,
          );
        }

        const failures =
          failureResult.status === "fulfilled"
            ? deductionPayload(failureResult.value).map(normalizeCmsDeduction)
            : [];
        const shortages =
          shortageResult.status === "fulfilled" && shortageResult.value
            ? deductionPayload(shortageResult.value).map(normalizeCmsDeduction)
            : [];
        setDeductionRecords(mergeDeductionRecords(failures, shortages));
      } else if (targetPage === "master") {
        const masterParams = new URLSearchParams();
        if (masterQuery.trim()) {
          masterParams.set("keyword", masterQuery.trim());
        }
        if (includeInactive) masterParams.set("includeInactive", "true");
        const response = await apiFetch<unknown>(
          `/drug-masters${masterParams.toString() ? `?${masterParams}` : ""}`,
        );
        setMasters(arrayPayload(response).map(normalizeCmsMaster));
      } else if (targetPage === "inventory") {
        const trimmed = stockQuery.trim();
        const normalizedKeyword = normalizeSearchText(trimmed);
        if (normalizedKeyword.length === 1) {
          setCmsStockSearchStatus("short");
          setApiMessage("재고 검색어는 2글자 이상 입력해 주세요.");
        } else {
          const stockParams = new URLSearchParams({
            sortBy: stockSortKey,
            sortDirection: stockSortDirection,
          });
          if (trimmed) stockParams.set("keyword", trimmed);
          if (stockControlledFilter === "CONTROLLED") {
            stockParams.set("controlledOnly", "true");
          }
          setCmsStockSearchStatus("loading");
          const response = await apiFetch<unknown>(`/stocks?${stockParams}`);
          const results = sortStockItems(
            filterStocksByControlledFilter(
              arrayPayload(response).map(normalizeStock),
              stockControlledFilter,
            ),
            stockSortKey,
            stockSortDirection,
          );
          setStocks(results);
          setSelectedStockId((current) =>
            results.some((stock) => stock.id === current)
              ? current
              : (results[0]?.id ?? ""),
          );
          setCmsStockSearchStatus("done");
        }
      } else if (targetPage === "inventory-shortages") {
        const response = await optionalCmsApiFetch<unknown>(
          "/prescription-shortages",
        );
        setDeductionRecords(
          response ? deductionPayload(response).map(normalizeCmsDeduction) : [],
        );
      } else if (targetPage === "return-reviews") {
        const [reviewResult, stockResult] = await Promise.allSettled([
          apiFetch<unknown>("/returns/reviews"),
          apiFetch<unknown>(
            "/stocks?includeZero=false&sortBy=name&sortDirection=asc",
          ),
        ]);
        throwRejected([reviewResult, stockResult]);

        if (reviewResult.status === "fulfilled") {
          setReturnReviews(
            returnReviewPayload(reviewResult.value).map(
              normalizeCmsReturnReview,
            ),
          );
        }
        if (stockResult.status === "fulfilled") {
          setStocks(arrayPayload(stockResult.value).map(normalizeStock));
        }
      } else if (targetPage === "prescriptions") {
        const [deductionResult, shortageResult] = await Promise.allSettled([
          apiFetch<unknown>("/prescription-deductions"),
          optionalCmsApiFetch<unknown>("/prescription-shortages"),
        ]);
        throwRejected([deductionResult, shortageResult]);

        const deductions =
          deductionResult.status === "fulfilled"
            ? deductionPayload(deductionResult.value).map(normalizeCmsDeduction)
            : [];
        const shortages =
          shortageResult.status === "fulfilled" && shortageResult.value
            ? deductionPayload(shortageResult.value).map(normalizeCmsDeduction)
            : [];
        setDeductionRecords(mergeDeductionRecords(deductions, shortages));
      } else if (targetPage === "purchase") {
        const [cookieResult, purchaseResult, syncResult] =
          await Promise.allSettled([
            apiFetch<unknown>("/baropharm/cookie"),
            apiFetch<unknown>("/purchase-histories"),
            apiFetch<unknown>("/purchase-histories/sync-jobs"),
          ]);
        throwRejected([cookieResult, purchaseResult, syncResult]);

        if (cookieResult.status === "fulfilled") {
          setCookieState(normalizeCmsCookie(cookieResult.value));
        }
        if (purchaseResult.status === "fulfilled") {
          setPurchaseHistories(
            arrayPayload(purchaseResult.value).map(normalizeCmsPurchase),
          );
        }
        if (syncResult.status === "fulfilled") {
          setSyncJobs(arrayPayload(syncResult.value).map(normalizeCmsSyncJob));
        }
      } else if (targetPage === "wholesaler") {
        if (normalizeSearchText(wholesalerQuery).length >= 2) {
          const params = new URLSearchParams({ keyword: wholesalerQuery });
          const response = await apiFetch<unknown>(`/wholesalers?${params}`);
          const results = arrayPayload(response).map(normalizeWholesaler);
          setWholesalers(results);
          setSelectedWholesalerId((current) =>
            results.some((wholesaler) => wholesaler.id === current)
              ? current
              : (results[0]?.id ?? ""),
          );
          setCmsWholesalerSearchStatus("done");
        } else {
          setWholesalers([]);
          setSelectedWholesalerId("");
          setCmsWholesalerSearchStatus("idle");
        }
      }

      setApiState("connected");
      setApiMessage("현재 화면 데이터 갱신 완료");
      setCmsReady(true);
      return true;
    } catch (error) {
      cmsFallback(error);
      return false;
    }
  }, [
    cmsFallback,
    includeInactive,
    masterQuery,
    page,
    stockControlledFilter,
    stockSortDirection,
    stockSortKey,
    stockQuery,
    wholesalerQuery,
  ]);

  useEffect(() => {
    void refreshCms();
  }, [visiblePage]);

  useEffect(() => {
    if (visiblePage !== "master" || !hasStoredAuthTokens()) return;

    const timer = window.setTimeout(() => {
      void refreshCms();
    }, 250);

    return () => window.clearTimeout(timer);
  }, [includeInactive, masterQuery, visiblePage]);

  async function submitCmsLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setApiState("checking");
      setApiMessage("관리자 로그인 중");
      await login(loginId, password);
      setAuthAccount(getStoredAuthAccount());
      const connected = await refreshCms();
      if (connected) {
        setApiState("connected");
        setApiMessage("관리자 로그인 완료");
        navigate(postLoginPath === "/cms/login" ? "/cms" : postLoginPath);
      }
      setPassword("");
    } catch (error) {
      setApiState("unauthorized");
      setApiMessage(
        error instanceof Error
          ? error.message
          : "관리자 로그인에 실패했습니다.",
      );
    }
  }

  function logoutCms() {
    clearAuthTokens();
    setAuthAccount(null);
    setApiState("unauthorized");
    setApiMessage("관리자 로그인이 필요합니다.");
  }

  function updateSignupDraft(patch: Partial<CmsSignupDraft>) {
    setSignupDraft((current) => ({ ...current, ...patch }));
  }

  async function submitSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAccessRootCms(authAccount) || signupSubmitting) return;

    const requiredFields = [
      signupDraft.adminPassword,
      signupDraft.pharmacyName,
      signupDraft.primaryLoginId,
      signupDraft.primaryPassword,
      signupDraft.limitedLoginId,
      signupDraft.limitedPassword,
    ];
    if (requiredFields.some((value) => value.trim().length === 0)) {
      setApiState("connected");
      setApiMessage("필수 가입 정보를 입력해 주세요.");
      return;
    }

    setSignupSubmitting(true);
    try {
      await apiFetch<unknown>("/auth/pharmacies", {
        method: "POST",
        body: JSON.stringify({
          adminPassword: signupDraft.adminPassword.trim(),
          pharmacyName: signupDraft.pharmacyName.trim(),
          ownerName: signupDraft.ownerName.trim(),
          phone: signupDraft.phone.trim(),
          businessRegistrationNumber:
            signupDraft.businessRegistrationNumber.trim(),
          address: signupDraft.address.trim(),
          addressDetail: signupDraft.addressDetail.trim(),
          accounts: [
            {
              loginId: signupDraft.primaryLoginId.trim(),
              password: signupDraft.primaryPassword,
            },
            {
              loginId: signupDraft.limitedLoginId.trim(),
              password: signupDraft.limitedPassword,
            },
          ],
        }),
      });
      setSignupDraft(createDefaultCmsSignupDraft());
      setApiState("connected");
      setApiMessage("약국 계정 생성 완료");
    } catch (error) {
      cmsFallback(error);
    } finally {
      setSignupSubmitting(false);
    }
  }

  const refreshImportJob = useCallback(
    async (jobId: string) => {
      if (!isPersistedImportJobId(jobId)) return;
      try {
        const response = await apiFetch<unknown>(`/import-jobs/${jobId}`);
        const nextJob = normalizeCmsImportJob(response, 0);
        setImportJobs((current) =>
          current.map((job) => (job.id === jobId ? nextJob : job)),
        );
      } catch (error) {
        cmsFallback(error);
      }
    },
    [cmsFallback],
  );

  useEffect(() => {
    const activeJobs = importJobs.filter(
      (job) =>
        isPersistedImportJobId(job.id) &&
        (job.status === "PENDING" || job.status === "RUNNING"),
    );
    if (
      activeJobs.length === 0 ||
      !hasStoredAuthTokens() ||
      !canAccessMasterData ||
      visiblePage !== "import"
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      activeJobs.forEach((job) => {
        void refreshImportJob(job.id);
      });
    }, 5000);

    return () => window.clearInterval(timer);
  }, [canAccessMasterData, importJobs, refreshImportJob, visiblePage]);

  async function uploadMasterCsv(kind: "drug" | "price", file: File | null) {
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const response = await apiFetch<unknown>(
        kind === "drug" ? "/drug-masters/import" : "/price-masters/import",
        {
          method: "POST",
          body: formData,
        },
      );
      const job = normalizeCmsImportJob(response, 0, {
        dataType: kind === "drug" ? "1번" : "2번",
        fileName: file.name,
      });
      setApiState("connected");
      setApiMessage(`${file.name} import job 생성 완료`);
      setImportJobs((current) => [job, ...current]);
      void refreshImportJob(job.id);
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
          koreanProductName: master.name,
          drugSpec: master.spec,
          productTotalQuantity: master.productTotalQuantity,
          active: master.active,
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

  function updateMaster(masterId: string, patch: Partial<CmsMaster>) {
    setMasters((current) =>
      current.map((master) =>
        master.id === masterId ? { ...master, ...patch } : master,
      ),
    );
  }

  const searchCmsWholesalers = useCallback(
    async (keyword: string) => {
      const trimmed = keyword.trim();

      if (normalizeSearchText(trimmed).length < 2) {
        setWholesalers([]);
        setSelectedWholesalerId("");
        setCmsWholesalerSearchStatus(trimmed ? "short" : "idle");
        return;
      }

      setCmsWholesalerSearchStatus("loading");
      try {
        const params = new URLSearchParams({ keyword: trimmed });
        const response = await apiFetch<unknown>(`/wholesalers?${params}`);
        const results = arrayPayload(response).map(normalizeWholesaler);

        setWholesalers(results);
        setSelectedWholesalerId((current) =>
          results.some((wholesaler) => wholesaler.id === current)
            ? current
            : (results[0]?.id ?? ""),
        );
        setCmsWholesalerSearchStatus("done");
        setApiState("connected");
        setApiMessage("도매처 검색 완료");
      } catch (error) {
        cmsFallback(error);
        const fallbackResults = demoWholesalers.filter((wholesaler) =>
          normalizeSearchText(`${wholesaler.name} ${wholesaler.meta}`).includes(
            normalizeSearchText(trimmed),
          ),
        );

        setWholesalers(fallbackResults);
        setSelectedWholesalerId(fallbackResults[0]?.id ?? "");
        setCmsWholesalerSearchStatus("error");
      }
    },
    [cmsFallback],
  );

  const searchCmsStocks = useCallback(
    async (
      keyword: string,
      controlledFilter: CmsStockControlledFilter = "ALL",
      sortKey: CmsStockSortKey = stockSortKey,
      sortDirection: CmsStockSortDirection = stockSortDirection,
    ) => {
      const trimmed = keyword.trim();
      const normalizedKeyword = normalizeSearchText(trimmed);
      if (normalizedKeyword.length === 1) {
        setCmsStockSearchStatus("short");
        setApiState("connected");
        setApiMessage("재고 검색어는 2글자 이상 입력해 주세요.");
        return;
      }

      const params = new URLSearchParams();
      if (trimmed) params.set("keyword", trimmed);
      if (controlledFilter === "CONTROLLED") {
        params.set("controlledOnly", "true");
      }
      params.set("sortBy", sortKey);
      params.set("sortDirection", sortDirection);

      setCmsStockSearchStatus("loading");
      try {
        const response = await apiFetch<unknown>(
          `/stocks${params.toString() ? `?${params}` : ""}`,
        );
        const results = sortStockItems(
          filterStocksByControlledFilter(
            arrayPayload(response).map(normalizeStock),
            controlledFilter,
          ),
          sortKey,
          sortDirection,
        );

        setStocks(results);
        setSelectedStockId((current) =>
          results.some((stock) => stock.id === current)
            ? current
            : (results[0]?.id ?? ""),
        );
        setCmsStockSearchStatus("done");
        setApiState("connected");
        setApiMessage(stockSearchMessage(controlledFilter, Boolean(trimmed)));
      } catch (error) {
        cmsFallback(error);
        const fallbackBase = filterStocksByControlledFilter(
          initialStocks.filter((stock) => stock.quantity !== 0),
          controlledFilter,
        );
        const fallbackResults = fallbackBase.filter((stock) =>
          normalizeSearchText(
            `${stock.name} ${stock.insuranceCode} ${stock.pc} ${
              stock.controlledDrug.shortName ?? ""
            } ${stock.controlledDrug.habitKind ?? ""}`,
          ).includes(normalizeSearchText(trimmed)),
        );
        const nextStocks = sortStockItems(
          trimmed ? fallbackResults : fallbackBase,
          sortKey,
          sortDirection,
        );

        setStocks(nextStocks);
        setSelectedStockId(nextStocks[0]?.id ?? "");
        setCmsStockSearchStatus("error");
      }
    },
    [cmsFallback, stockSortDirection, stockSortKey],
  );

  async function syncStocksFromSnapshot(targetPharmacyId?: string) {
    try {
      const params = new URLSearchParams();
      const trimmedPharmacyId = targetPharmacyId?.trim();
      if (trimmedPharmacyId) params.set("pharmacyId", trimmedPharmacyId);
      const response = await apiFetch<unknown>(
        `/stocks/sync-snapshot${params.toString() ? `?${params}` : ""}`,
        {
          method: "POST",
        },
      );
      const summary = normalizeStockSnapshotSyncSummary(response);
      const refreshKeyword =
        normalizeSearchText(stockQuery).length === 1 ? "" : stockQuery;
      await searchCmsStocks(refreshKeyword, stockControlledFilter);
      setApiState("connected");
      setApiMessage(
        `에이전트 재고 재동기화 완료 · ${currency(summary.synced)}종 반영`,
      );
      return summary;
    } catch (error) {
      cmsFallback(error);
      throw error;
    }
  }

  async function createCmsStock(draft: CmsStockCreateDraft) {
    try {
      const response = await apiFetch<unknown>("/stocks", {
        method: "POST",
        body: JSON.stringify({
          stockTag: draft.stockTag,
          insuranceCode: draft.insuranceCode.trim(),
          drugName: draft.name.trim(),
          price: draft.price,
          quantity: draft.quantity,
          productTotalQuantity: draft.productTotalQuantity,
          memo: draft.memo.trim(),
        }),
      });
      const stock = normalizeStock(
        unwrapObjectPayload(response),
        stocks.length,
      );

      setStocks((current) =>
        stock.quantity === 0
          ? current.filter((item) => item.id !== stock.id)
          : sortStockItems(
              [stock, ...current.filter((item) => item.id !== stock.id)],
              stockSortKey,
              stockSortDirection,
            ),
      );
      setSelectedStockId(stock.quantity === 0 ? "" : stock.id);
      setApiState("connected");
      setApiMessage("재고 약품 생성 완료");
      return true;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        setApiState("connected");
        setApiMessage(error.message);
        return false;
      }
      cmsFallback(error);
      return false;
    }
  }

  async function updateCmsStockPrice(stock: StockItem, price: number) {
    try {
      const response = await apiFetch<unknown>(`/stocks/${stock.id}/price`, {
        method: "PATCH",
        body: JSON.stringify({
          price: Math.max(0, finiteNumber(price)),
          memo: "관리자 임의 재고 가격 수정",
        }),
      });
      const updatedStock = normalizeStock(
        unwrapObjectPayload(response),
        stocks.length,
      );
      setStocks((current) =>
        current.map((item) => (item.id === stock.id ? updatedStock : item)),
      );
      setSelectedStockId(updatedStock.id);
      setApiState("connected");
      setApiMessage("임의 재고 가격 저장 완료");
      void refreshCms();
      return true;
    } catch (error) {
      cmsFallback(error);
      return false;
    }
  }

  async function createCmsWholesaler() {
    const trimmed = newWholesalerName.trim();
    if (!trimmed) return;

    try {
      const response = await apiFetch<unknown>("/wholesalers", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, wholesalerName: trimmed }),
      });
      const wholesaler = normalizeWholesaler(
        unwrapObjectPayload(response),
        wholesalers.length,
      );
      setWholesalers((current) => [wholesaler, ...current]);
      setSelectedWholesalerId(wholesaler.id);
      setNewWholesalerName("");
      setApiState("connected");
      setApiMessage("도매처 등록 완료");
    } catch (error) {
      cmsFallback(error);
      const wholesaler = {
        id: createId("W"),
        name: trimmed,
        meta: "약국 등록 · 임시",
      };
      setWholesalers((current) => [wholesaler, ...current]);
      setSelectedWholesalerId(wholesaler.id);
      setNewWholesalerName("");
    }
  }

  async function saveCmsWholesaler() {
    if (!selectedWholesaler) return;
    const trimmed = editingWholesalerName.trim();
    if (!trimmed) return;

    try {
      await apiFetch(`/wholesalers/${selectedWholesaler.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed, wholesalerName: trimmed }),
      });
      setApiState("connected");
      setApiMessage("도매처 수정 완료");
    } catch (error) {
      cmsFallback(error);
    }

    setWholesalers((current) =>
      current.map((wholesaler) =>
        wholesaler.id === selectedWholesaler.id
          ? { ...wholesaler, name: trimmed }
          : wholesaler,
      ),
    );
  }

  async function adjustStock() {
    if (!selectedStock) return;
    const signedQuantity =
      adjustDirection === "INCREASE" ? adjustQuantity : -adjustQuantity;
    try {
      const response = await apiFetch<unknown>(
        `/stocks/${selectedStock.id}/adjustments`,
        {
          method: "POST",
          body: JSON.stringify({
            changeQuantity: signedQuantity,
            reason: adjustMemo,
          }),
        },
      );
      const adjustedStock = normalizeStock(
        unwrapObjectPayload(response),
        stocks.findIndex((stock) => stock.id === selectedStock.id),
      );
      setStocks((current) =>
        adjustedStock.quantity === 0
          ? current.filter((stock) => stock.id !== selectedStock.id)
          : sortStockItems(
              current.map((stock) =>
                stock.id === selectedStock.id ? adjustedStock : stock,
              ),
              stockSortKey,
              stockSortDirection,
            ),
      );
      setSelectedStockId(adjustedStock.quantity === 0 ? "" : adjustedStock.id);
      setAdjustQuantity(1);
      setApiState("connected");
      setApiMessage("수동 재고 조정 완료");
    } catch (error) {
      cmsFallback(error);
      setStocks((current) =>
        current
          .map((stock) =>
            stock.id === selectedStock.id
              ? {
                  ...stock,
                  quantity: Math.max(0, stock.quantity + signedQuantity),
                }
              : stock,
          )
          .filter((stock) => stock.quantity !== 0),
      );
    }
  }

  async function mergeVirtualStock() {
    if (!selectedStock || !mergeInsuranceCode.trim()) return;

    try {
      await apiFetch(`/stocks/${selectedStock.id}/merge-virtual`, {
        method: "POST",
        body: JSON.stringify({
          insuranceCode: mergeInsuranceCode.trim(),
          memo: "관리자 임의 재고 보험코드 보정",
        }),
      });
      setApiState("connected");
      setApiMessage("임의 재고 병합/전환 요청 완료");
      void refreshCms();
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function startPurchaseSync() {
    try {
      const response = await apiFetch<unknown>("/purchase-histories/sync", {
        method: "POST",
        body: JSON.stringify({
          startDate: syncStartDate,
          endDate: syncEndDate,
        }),
      });
      setApiState("connected");
      setApiMessage("구매내역 불러오기 작업 생성 완료");
      const job = normalizeCmsSyncJob(response, 0);
      setSyncJobs((current) => [job, ...current]);
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function registerBaropharmCookie() {
    const cookie = buildBaropharmCookie(baropharmCookieDraft);
    if (!cookie) return;

    try {
      await apiFetch("/baropharm/cookie", {
        method: "POST",
        body: JSON.stringify({ cookie }),
      });
      setBaropharmCookieDraft({ sessionId: "", csrfToken: "" });
      setCookieState({
        registered: true,
        status: "VALID",
        maskedCookie: "구매내역 인증 정보 보관됨",
        message: "구매내역 연결 정보 등록 완료",
      });
      setApiState("connected");
      setApiMessage("구매내역 연결 정보 등록 완료");
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function resumePurchaseSync(jobId: string) {
    try {
      const response = await apiFetch<unknown>(
        `/purchase-histories/sync-jobs/${jobId}/resume`,
        { method: "POST" },
      );
      const nextJob = normalizeCmsSyncJob(response, 0);
      setSyncJobs((current) =>
        current.map((job) => (job.id === jobId ? nextJob : job)),
      );
      setApiState("connected");
      setApiMessage("구매내역 동기화 재개 요청 완료");
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function deductPrescriptionStock() {
    if (!prescriptionId.trim()) return;

    try {
      const response = await apiFetch<unknown>(
        `/prescriptions/${prescriptionId.trim()}/deduct-stock`,
        {
          method: "POST",
        },
      );
      const records = deductionPayload(response).map(normalizeCmsDeduction);
      if (records.length > 0) {
        setDeductionRecords((current) =>
          mergeDeductionRecords(current, records),
        );
        setSelectedDeductionId(records[0].id);
      }
      setApiState("connected");
      setApiMessage("처방전 재고 차감 요청 완료");
      void refreshCms();
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function resolveDeduction(
    record: CmsDeductionRecord,
    resolutionType: CmsDeductionResolution,
  ) {
    if (record.status !== "FAILED") return;

    try {
      const response = await apiFetch<unknown>(
        `/prescription-deductions/${record.id}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            resolutionType,
            stockId:
              resolutionType === "EXISTING_STOCK"
                ? selectedStock?.id
                : undefined,
            memo: "관리자 수동 처리",
          }),
        },
      );
      const resolvedRecord =
        deductionPayload(response).map(normalizeCmsDeduction)[0] ??
        normalizeCmsDeduction(response, 0);
      setDeductionRecords((current) =>
        current.map((item) =>
          item.id === record.id
            ? {
                ...item,
                ...resolvedRecord,
                id: record.id,
                status: "RESOLVED",
                resolutionType,
              }
            : item,
        ),
      );
      setDeductionFilter("ALL");
      setApiState("connected");
      setApiMessage("처방전 차감 실패 항목 처리 완료");
      void refreshCms();
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function updateShortageStatus(
    record: CmsDeductionRecord,
    shortageStatus: CmsShortageStatus,
  ) {
    if (record.shortageQuantity <= 0) return;

    try {
      const response = await apiFetch<unknown>(
        `/prescription-shortages/${record.id}/status`,
        {
          method: "POST",
          body: JSON.stringify({
            shortageStatus,
            memo: `관리자 부족분 상태 변경: ${shortageStatusText(shortageStatus)}`,
          }),
        },
      );
      const nextRecord =
        deductionPayload(response).map(normalizeCmsDeduction)[0] ??
        normalizeCmsDeduction(response, 0);
      setDeductionRecords((current) =>
        current.map((item) =>
          item.id === record.id
            ? { ...item, ...nextRecord, id: item.id }
            : item,
        ),
      );
      setSelectedShortageDetail((current) =>
        current?.deduction.id === record.id
          ? {
              ...current,
              deduction: {
                ...current.deduction,
                ...nextRecord,
                id: current.deduction.id,
              },
            }
          : current,
      );
      setApiState("connected");
      setApiMessage("초과 처방 상태 변경 완료");
      void refreshCms();
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function updateReturnReviewStatus(
    record: CmsReturnReview,
    status: CmsReturnReviewStatus,
  ) {
    if (status === "RESOLVED") return;

    try {
      const response = await apiFetch<unknown>(
        `/returns/reviews/${record.id}/status`,
        {
          method: "POST",
          body: JSON.stringify({
            status,
            memo: `관리자 반품 확인 상태 변경: ${returnReviewStatusText(status)}`,
          }),
        },
      );
      const nextRecord = normalizeCmsReturnReview(response, 0);
      setReturnReviews((current) =>
        current.map((item) =>
          item.id === record.id
            ? { ...item, ...nextRecord, id: item.id }
            : item,
        ),
      );
      setApiState("connected");
      setApiMessage("반품 확인 상태 변경 완료");
      void refreshCms();
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function resolveReturnReview(
    record: CmsReturnReview,
    stockId: string,
    returnQuantity: number,
    memo: string,
  ) {
    if (!stockId || returnQuantity <= 0) return;

    try {
      const response = await apiFetch<unknown>(
        `/returns/reviews/${record.id}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            stockId,
            returnQuantity,
            memo: memo || "관리자 반품 확인 처리",
          }),
        },
      );
      const nextRecord = normalizeCmsReturnReview(response, 0);
      setReturnReviews((current) =>
        current.map((item) =>
          item.id === record.id
            ? { ...item, ...nextRecord, id: item.id }
            : item,
        ),
      );
      setSelectedReturnReviewId(record.id);
      setApiState("connected");
      setApiMessage("반품 확인 항목 처리 완료");
      void refreshCms();
    } catch (error) {
      cmsFallback(error);
    }
  }

  async function loadShortageDetail(record: CmsDeductionRecord) {
    setSelectedShortageId(record.id);
    setShortageDetailLoading(true);
    try {
      const response = await apiFetch<unknown>(
        `/prescription-shortages/${record.id}`,
      );
      setSelectedShortageDetail(normalizeCmsShortageDetail(response, record));
      setApiState("connected");
    } catch (error) {
      setSelectedShortageDetail(createFallbackShortageDetail(record));
      setApiState("connected");
      setApiMessage("초과 처방 상세를 불러오지 못했습니다.");
    } finally {
      setShortageDetailLoading(false);
    }
  }

  useEffect(() => {
    if (visiblePage !== "inventory-shortages" || !selectedShortage) return;
    if (selectedShortageDetail?.deduction.id === selectedShortage.id) return;
    void loadShortageDetail(selectedShortage);
  }, [selectedShortage?.id, selectedShortageDetail?.deduction.id, visiblePage]);

  if (apiState === "unauthorized" || (isCmsLoginRoute && !hasCmsSession)) {
    return (
      <CmsLoginPage
        apiMessage={apiMessage}
        apiState={apiState}
        loginId={loginId}
        password={password}
        onLoginId={setLoginId}
        onPassword={setPassword}
        onSubmit={submitCmsLogin}
      />
    );
  }

  if (!cmsReady && apiState === "checking") {
    return <CmsLoadingPage apiMessage={apiMessage} />;
  }

  return (
    <div
      className={`cms-shell ${
        effectiveSidebarCollapsed ? "is-sidebar-collapsed" : ""
      }`}
    >
      <CmsSidebar
        account={authAccount}
        canAccessMasterData={canAccessMasterData}
        collapsed={effectiveSidebarCollapsed}
        page={visiblePage}
        navigate={navigate}
        onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
      />
      <main className="cms-main">
        <CmsHeader
          onLogout={hasStoredAuthTokens() ? logoutCms : undefined}
          page={visiblePage}
          onRefresh={refreshCms}
        />
        <>
          {visiblePage === "dashboard" && (
            <CmsDashboard
              account={authAccount}
              cookieState={cookieState}
              dashboard={dashboardData}
              deductionRecords={deductionRecords}
              stocks={stocks}
              syncJobs={syncJobs}
              navigate={navigate}
            />
          )}
          {visiblePage === "master" && (
            <CmsMasterPage
              includeInactive={includeInactive}
              masterQuery={masterQuery}
              masters={masters}
              selectedMaster={selectedMaster}
              onIncludeInactive={setIncludeInactive}
              onMasterChange={updateMaster}
              onQuery={setMasterQuery}
              onRematch={rematchMaster}
              onSave={saveMaster}
              onSelect={setSelectedMasterId}
              onUpload={uploadMasterCsv}
            />
          )}
          {visiblePage === "import" && (
            <CmsImportPage jobs={importJobs} onUpload={uploadMasterCsv} />
          )}
          {visiblePage === "signup" && (
            <CmsSignupPage
              draft={signupDraft}
              submitting={signupSubmitting}
              onChange={updateSignupDraft}
              onSubmit={submitSignup}
            />
          )}
          {visiblePage === "inventory" && (
            <CmsInventoryPage
              adjustDirection={adjustDirection}
              adjustMemo={adjustMemo}
              adjustQuantity={adjustQuantity}
              mergeInsuranceCode={mergeInsuranceCode}
              controlledFilter={stockControlledFilter}
              query={stockQuery}
              searchStatus={cmsStockSearchStatus}
              selectedStock={selectedStock}
              sortDirection={stockSortDirection}
              sortKey={stockSortKey}
              stocks={stocks}
              canSyncSnapshot={canSyncStockSnapshotCms(authAccount)}
              syncSnapshotDefaultPharmacyId={authAccount?.pharmacyId ?? ""}
              onAdjust={adjustStock}
              onAdjustDirection={setAdjustDirection}
              onAdjustMemo={setAdjustMemo}
              onAdjustQuantity={(value) =>
                setAdjustQuantity(Math.max(1, Math.min(999, value)))
              }
              onCreateStock={createCmsStock}
              onControlledFilter={setStockControlledFilter}
              onMergeInsuranceCode={setMergeInsuranceCode}
              onMergeVirtual={mergeVirtualStock}
              onQuery={setStockQuery}
              onSearch={searchCmsStocks}
              onSelect={setSelectedStockId}
              onSort={(nextKey) => {
                setStockSortDirection((currentDirection) =>
                  nextStockSortDirection(
                    stockSortKey,
                    currentDirection,
                    nextKey,
                  ),
                );
                setStockSortKey(nextKey);
              }}
              onSyncSnapshot={syncStocksFromSnapshot}
              onUpdatePrice={updateCmsStockPrice}
            />
          )}
          {visiblePage === "inventory-shortages" && (
            <CmsInventoryShortagePage
              detail={selectedShortageDetail}
              detailLoading={shortageDetailLoading}
              detailMode={Boolean(shortageRouteId)}
              records={shortageRecords}
              selectedRecord={selectedShortage}
              onBack={() =>
                shortageRouteId
                  ? navigate("/cms/inventory/shortages")
                  : setSelectedShortageId("")
              }
              onOpenDetail={(record) =>
                navigate(
                  `/cms/inventory/shortages/${encodeURIComponent(record.id)}`,
                )
              }
              onSelect={(record) => setSelectedShortageId(record.id)}
              onShortageStatus={updateShortageStatus}
            />
          )}
          {visiblePage === "return-reviews" && (
            <CmsReturnReviewPage
              detailMode={Boolean(returnReviewRouteId)}
              records={returnReviews}
              selectedRecord={selectedReturnReview}
              stocks={stocks}
              onBack={() =>
                returnReviewRouteId
                  ? navigate("/cms/inventory/returns")
                  : setSelectedReturnReviewId("")
              }
              onOpenDetail={(record) =>
                navigate(
                  `/cms/inventory/returns/${encodeURIComponent(record.id)}`,
                )
              }
              onResolve={resolveReturnReview}
              onSelect={(record) => setSelectedReturnReviewId(record.id)}
              onStatus={updateReturnReviewStatus}
            />
          )}
          {visiblePage === "wholesaler" && (
            <CmsWholesalerPage
              editingName={editingWholesalerName}
              newName={newWholesalerName}
              query={wholesalerQuery}
              searchStatus={cmsWholesalerSearchStatus}
              selectedWholesaler={selectedWholesaler}
              wholesalers={wholesalers}
              onCreate={createCmsWholesaler}
              onEditingName={setEditingWholesalerName}
              onNewName={setNewWholesalerName}
              onQuery={setWholesalerQuery}
              onSave={saveCmsWholesaler}
              onSearch={searchCmsWholesalers}
              onSelect={setSelectedWholesalerId}
            />
          )}
          {visiblePage === "prescriptions" && (
            <CmsPrescriptionPage
              filter={deductionFilter}
              prescriptionId={prescriptionId}
              records={deductionRecords}
              selectedRecord={selectedDeduction}
              selectedStockId={selectedStockId}
              stocks={stocks}
              onDeduct={deductPrescriptionStock}
              onFilter={(nextFilter) => {
                setDeductionFilter(nextFilter);
                const nextRecord =
                  nextFilter === "ALL"
                    ? deductionRecords[0]
                    : nextFilter === "SHORTAGE_ITEMS"
                      ? deductionRecords.find(
                          (record) => record.shortageQuantity > 0,
                        )
                      : deductionRecords.find(
                          (record) => record.status === nextFilter,
                        );
                setSelectedDeductionId(nextRecord?.id ?? "");
              }}
              onPrescriptionId={setPrescriptionId}
              onResolve={resolveDeduction}
              onSelectRecord={setSelectedDeductionId}
              onSelectStock={setSelectedStockId}
              onShortageStatus={updateShortageStatus}
            />
          )}
          {visiblePage === "purchase" && (
            <CmsPurchasePage
              cookieDraft={baropharmCookieDraft}
              cookieState={cookieState}
              histories={purchaseHistories}
              syncEndDate={syncEndDate}
              syncJobs={syncJobs}
              syncStartDate={syncStartDate}
              onCookieDraftChange={setBaropharmCookieDraft}
              onRegisterCookie={registerBaropharmCookie}
              onResume={resumePurchaseSync}
              onSync={startPurchaseSync}
              onSyncEndDate={setSyncEndDate}
              onSyncStartDate={setSyncStartDate}
            />
          )}
        </>
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

function deductionPayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const item = asRecord(raw);
  for (const key of [
    "deductions",
    "prescriptionDeductions",
    "shortages",
    "failedDeductions",
    "failures",
    "results",
    "content",
    "items",
    "data",
  ]) {
    const value = item[key];
    if (Array.isArray(value)) return value;
  }

  const payload = unwrapObjectPayload(raw);
  if (payload !== item) {
    const nestedPayload = deductionPayload(payload);
    if (nestedPayload.length > 0) return nestedPayload;
    return isDeductionLikePayload(payload) ? [payload] : [];
  }

  if (isDeductionLikePayload(item)) return [item];
  return [];
}

function returnReviewPayload(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const item = asRecord(raw);
  for (const key of ["returnReviews", "reviews", "items", "content", "data"]) {
    const value = item[key];
    if (Array.isArray(value)) return value;
  }

  const payload = unwrapObjectPayload(raw);
  if (payload !== item) {
    const nestedPayload = returnReviewPayload(payload);
    if (nestedPayload.length > 0) return nestedPayload;
    return isReturnReviewLikePayload(payload) ? [payload] : [];
  }

  if (isReturnReviewLikePayload(item)) return [item];
  return [];
}

function normalizeStockSnapshotSyncSummary(
  raw: unknown,
): CmsStockSnapshotSyncSummary {
  const item = unwrapObjectPayload(raw);
  return {
    type: optionalText(item.type) || "STOCKS_SNAPSHOT_SYNC",
    pharmacyId: optionalText(item.pharmacyId ?? item.pharmacy_id) ?? "",
    synced: finiteNumber(item.synced),
    snapshotRows: finiteNumber(item.snapshotRows ?? item.snapshot_rows),
    snapshotDrugCount: finiteNumber(
      item.snapshotDrugCount ?? item.snapshot_drug_count,
    ),
    positiveDrugCount: finiteNumber(
      item.positiveDrugCount ?? item.positive_drug_count,
    ),
    zeroDrugCount: finiteNumber(item.zeroDrugCount ?? item.zero_drug_count),
    negativeDrugCount: finiteNumber(
      item.negativeDrugCount ?? item.negative_drug_count,
    ),
  };
}

function isDeductionLikePayload(raw: unknown) {
  const item = asRecord(raw);
  return [
    "id",
    "deductionId",
    "prescriptionCode",
    "drugName",
    "deductQuantity",
    "deductedQuantity",
    "shortageQuantity",
    "shortageStatus",
  ].some((key) => item[key] !== undefined);
}

function isReturnReviewLikePayload(raw: unknown) {
  const item = asRecord(raw);
  return ["id", "reviewId", "pc", "drugName", "status", "matchType"].some(
    (key) => item[key] !== undefined,
  );
}

function mergeDeductionRecords(
  current: CmsDeductionRecord[],
  incoming: CmsDeductionRecord[],
) {
  const next = new Map(current.map((record) => [record.id, record]));
  incoming.forEach((record) => next.set(record.id, record));
  return [...next.values()].sort((a, b) =>
    `${b.createdAt}${b.id}`.localeCompare(`${a.createdAt}${a.id}`),
  );
}

function normalizeCmsReturnReview(
  raw: unknown,
  index: number,
): CmsReturnReview {
  const item = unwrapObjectPayload(raw);
  const rawStatus = String(item.status ?? "OPEN").toUpperCase();
  const status: CmsReturnReviewStatus =
    rawStatus === "RESOLVED"
      ? "RESOLVED"
      : rawStatus === "HOLD"
        ? "HOLD"
        : "OPEN";
  const rawMatchType = String(
    item.matchType ?? "NO_SELLER_CANDIDATE",
  ).toUpperCase();
  const matchType: CmsReturnReview["matchType"] = rawMatchType.includes(
    "ESTIMATED",
  )
    ? "ESTIMATED"
    : rawMatchType.includes("CONFIRMED")
      ? "CONFIRMED"
      : "NO_SELLER_CANDIDATE";

  return {
    id: String(item.id ?? item.reviewId ?? index),
    pc: optionalText(item.pc) || "",
    sn: normalizeLookupSn(item.sn, ""),
    lot: optionalText(item.lot) || "",
    exp: optionalText(item.exp) || "",
    drugName: optionalText(item.drugName ?? item.name) || "미확인 약품",
    insuranceCode: optionalText(item.insuranceCode ?? item.productCode) || "",
    matchType,
    status,
    message: optionalText(item.message) || "",
    sellerCandidateCount: finiteNumber(item.sellerCandidateCount),
    sellerCandidateSummary: optionalText(item.sellerCandidateSummary) || "",
    requestedQuantity: finiteNumber(item.requestedQuantity),
    returnQuantity: finiteNumber(item.returnQuantity),
    stockId: optionalText(item.stockId) || undefined,
    stockName: optionalText(item.stockName) || undefined,
    stockBefore:
      item.stockBeforeQuantity === undefined
        ? undefined
        : finiteNumber(item.stockBeforeQuantity),
    stockAfter:
      item.stockAfterQuantity === undefined
        ? undefined
        : finiteNumber(item.stockAfterQuantity),
    memo: optionalText(item.memo) || undefined,
    createdAt: formatTransactionAt(item.createdAt),
    resolvedAt:
      item.resolvedAt === undefined
        ? undefined
        : formatTransactionAt(item.resolvedAt, "-"),
  };
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
      item.name ??
        item.drugName ??
        item.koreanName ??
        item.koreanProductName ??
        "미확인 약품",
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
    active: normalizeBoolean(item.active ?? true),
  };
}

function normalizeCmsPurchase(raw: unknown, index: number): CmsPurchaseHistory {
  const item = raw as Record<string, unknown>;
  return {
    id: String(item.id ?? item.purchaseHistoryId ?? index),
    sellerName: String(item.sellerName ?? item.wholesalerName ?? "-"),
    transactionAt: formatTransactionAt(item.transactionAt ?? item.orderDate),
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
    message: userFacingConnectionMessage(item.message ?? status),
  };
}

function normalizeCmsImportJob(
  raw: unknown,
  index: number,
  fallback?: { dataType: "1번" | "2번"; fileName: string },
): CmsImportJob {
  const item = asRecord(raw);
  const status = String(item.status ?? "PENDING") as CmsImportJob["status"];
  const processedRows = Number(
    item.processedRows ??
      item.processedCount ??
      item.currentRows ??
      item.doneRows ??
      0,
  );
  const totalRows = Number(item.totalRows ?? item.totalCount ?? 0);
  const progress = Number(
    item.progress ??
      item.progressRate ??
      (totalRows > 0 ? Math.round((processedRows / totalRows) * 100) : 0),
  );

  return {
    id: String(item.id ?? item.jobId ?? index),
    dataType: String(
      item.dataType ?? item.masterType ?? fallback?.dataType,
    ).includes("2")
      ? "2번"
      : "1번",
    fileName: String(
      item.fileName ??
        item.originalFileName ??
        item.originalFilename ??
        fallback?.fileName ??
        "-",
    ),
    status,
    progress,
    processedRows,
    totalRows,
    newCount: Number(
      item.newCount ?? item.insertedCount ?? item.createdCount ?? 0,
    ),
    updatedCount: Number(item.updatedCount ?? item.modifiedCount ?? 0),
    inactiveCount: Number(item.inactiveCount ?? item.deactivatedCount ?? 0),
    duplicateCount: Number(
      item.duplicateCount ?? item.duplicateExcludedCount ?? 0,
    ),
    failedCount: Number(item.failedCount ?? item.errorCount ?? 0),
    message: String(
      item.message ?? item.failureReason ?? item.failedDetail ?? status,
    ),
  };
}

function normalizeCmsCookie(raw: unknown): CmsCookieState {
  const item = asRecord(raw);
  const registered = Boolean(
    item.registered ?? item.exists ?? item.hasCookie ?? item.cookieRegistered,
  );
  const status = String(
    item.status ?? (registered ? "VALID" : "UNKNOWN"),
  ).toUpperCase();

  return {
    registered,
    status:
      status === "AUTH_FAILED"
        ? "AUTH_FAILED"
        : status === "VALID"
          ? "VALID"
          : "UNKNOWN",
    maskedCookie: String(
      item.maskedCookie ??
        item.cookieMasked ??
        (registered ? "구매내역 인증 정보 보관됨" : ""),
    ),
    message: userFacingConnectionMessage(
      item.message ??
        (registered
          ? "구매내역 연결 정보 등록됨"
          : "구매내역 연결 정보 미등록"),
    ),
  };
}

function normalizeCmsDeduction(
  raw: unknown,
  index: number,
): CmsDeductionRecord {
  const item = asRecord(raw);
  const rawStatus = String(item.status ?? item.deductionStatus ?? "FAILED");
  const status: CmsDeductionStatus =
    rawStatus === "DEDUCTED" ||
    rawStatus === "PARTIAL_DEDUCTED" ||
    rawStatus === "SHORTAGE" ||
    rawStatus === "RESOLVED" ||
    rawStatus === "PENDING"
      ? rawStatus
      : "FAILED";
  const rawResolution = String(item.resolutionType ?? item.resolution ?? "");
  const resolutionType = [
    "VIRTUAL_DRUG",
    "EXISTING_STOCK",
    "UNREGISTERED_DRUG",
  ].includes(rawResolution)
    ? (rawResolution as CmsDeductionResolution)
    : undefined;
  const rawShortageStatus = String(item.shortageStatus ?? "");
  const shortageStatus = [
    "OPEN",
    "ORDERED",
    "HOLD",
    "RESOLVED",
    "IGNORED",
  ].includes(rawShortageStatus)
    ? (rawShortageStatus as CmsShortageStatus)
    : undefined;
  const totalQuantity = finiteNumber(
    item.requestedQuantity ??
      item.deductQuantity ??
      item.totalQuantity ??
      item.quantity ??
      item.pdAmount ??
      0,
  );
  const shortageQuantity = finiteNumber(item.shortageQuantity);

  return {
    id: String(item.id ?? item.deductionId ?? index),
    prescriptionCode: String(item.prescriptionCode ?? "-"),
    lineNo: finiteNumber(item.lineNo ?? item.lineNumber ?? item.pdNo),
    insuranceCode: String(
      item.insuranceCode ?? item.productCode ?? item.pdIscode ?? "-",
    ),
    drugName: String(
      item.drugName ?? item.name ?? item.drug_name ?? "미확인 약품",
    ),
    totalQuantity,
    deductedQuantity: finiteNumber(
      item.deductedQuantity ??
        (status === "DEDUCTED" || status === "RESOLVED" ? totalQuantity : 0),
    ),
    shortageQuantity,
    status,
    reason: String(
      item.failureReason ??
        item.reason ??
        item.message ??
        (shortageQuantity > 0 ? "재고 부족분이 있습니다." : "자동 차감 실패"),
    ),
    resolutionType,
    shortageStatus,
    stockId:
      item.stockId === undefined || item.stockId === null
        ? undefined
        : String(item.stockId),
    stockName: optionalText(item.stockName ?? item.matchedStockName),
    stockBefore:
      item.stockBeforeQuantity === undefined && item.stockBefore === undefined
        ? undefined
        : optionalFiniteNumber(item.stockBeforeQuantity ?? item.stockBefore),
    stockAfter:
      item.stockAfterQuantity === undefined &&
      item.stockAfter === undefined &&
      item.stockQuantityAfter === undefined
        ? undefined
        : optionalFiniteNumber(
            item.stockAfterQuantity ??
              item.stockAfter ??
              item.stockQuantityAfter,
          ),
    displayAfter:
      item.displayAfterQuantity === undefined && item.displayAfter === undefined
        ? undefined
        : optionalFiniteNumber(item.displayAfterQuantity ?? item.displayAfter),
    memo:
      item.memo === undefined || item.memo === null
        ? undefined
        : String(item.memo),
    createdAt: formatTransactionAt(
      item.createdAt ?? item.processedAt ?? item.deductedAt,
      "-",
    ),
    resolvedAt:
      item.resolvedAt === undefined && item.shortageResolvedAt === undefined
        ? undefined
        : formatTransactionAt(item.resolvedAt ?? item.shortageResolvedAt, "-"),
  };
}

function normalizeCmsPrescriptionDrugLine(
  raw: unknown,
): CmsPrescriptionDrugLine {
  const item = asRecord(raw);
  return {
    lineNo: finiteNumber(item.lineNo ?? item.lineNumber),
    insuranceCode: String(item.insuranceCode ?? item.productCode ?? "-"),
    drugName: String(item.drugName ?? item.name ?? "미확인 약품"),
    quantityPerDose: finiteNumber(item.quantityPerDose ?? item.dose),
    dailyFrequency: finiteNumber(item.dailyFrequency ?? item.dailyCount),
    medicationDays: finiteNumber(item.medicationDays ?? item.days),
    totalQuantity: finiteNumber(item.totalQuantity ?? item.quantity),
    memo: String(item.memo ?? ""),
  };
}

function normalizeCmsShortageDetail(
  raw: unknown,
  fallback: CmsDeductionRecord,
): CmsShortageDetail {
  const item = unwrapObjectPayload(raw);
  const deduction = normalizeCmsDeduction(item.deduction ?? fallback, 0);
  const drugs = firstArrayPayload(item, ["drugs", "lines", "items"]).map(
    normalizeCmsPrescriptionDrugLine,
  );

  return {
    deduction: { ...fallback, ...deduction, id: fallback.id },
    prescriptionId: String(
      item.prescriptionId ?? fallback.prescriptionCode ?? "-",
    ),
    prescriptionCode: String(
      item.prescriptionCode ?? fallback.prescriptionCode ?? "-",
    ),
    prescriptionGroupLabel: String(item.prescriptionGroupLabel ?? "-"),
    source: String(item.source ?? "-"),
    drugCount: finiteNumber(item.drugCount, drugs.length),
    capturedAt: formatApiDateTime(item.capturedAt ?? item.createdAt),
    createdAt: formatApiDateTime(item.createdAt),
    drugs:
      drugs.length > 0
        ? drugs
        : [
            {
              lineNo: fallback.lineNo,
              insuranceCode: fallback.insuranceCode,
              drugName: fallback.drugName,
              quantityPerDose: 0,
              dailyFrequency: 0,
              medicationDays: 0,
              totalQuantity: fallback.totalQuantity,
              memo: "",
            },
          ],
  };
}

function createFallbackShortageDetail(
  record: CmsDeductionRecord,
): CmsShortageDetail {
  return normalizeCmsShortageDetail(
    {
      deduction: record,
      prescriptionCode: record.prescriptionCode,
      drugCount: 1,
      createdAt: record.createdAt,
      drugs: [
        {
          lineNo: record.lineNo,
          insuranceCode: record.insuranceCode,
          drugName: record.drugName,
          totalQuantity: record.totalQuantity,
        },
      ],
    },
    record,
  );
}

function normalizeCmsDashboard(raw: unknown): CmsDashboardData {
  const item = unwrapObjectPayload(raw);
  const tasks = asRecord(item.tasks);
  const todayMovements = asRecord(item.todayMovements);
  const stockSummary = asRecord(item.stockSummary);
  const traceSummary = asRecord(item.traceSummary);
  const integrationStatus = asRecord(item.integrationStatus);
  const recentActivities = firstArrayPayload(item, ["recentActivities"]).map(
    normalizeCmsDashboardActivity,
  );

  return {
    tasks: {
      failedDeductions: Number(tasks.failedDeductions ?? 0),
      virtualStocks: Number(tasks.virtualStocks ?? 0),
      zeroStocks: Number(tasks.zeroStocks ?? 0),
      controlledCandidates: Number(tasks.controlledCandidates ?? 0),
      baropharmNeedsAction: normalizeBoolean(tasks.baropharmNeedsAction),
      agentNeedsAction: normalizeBoolean(tasks.agentNeedsAction),
    },
    todayMovements: {
      receivedQuantity: Number(todayMovements.receivedQuantity ?? 0),
      returnedQuantity: Number(todayMovements.returnedQuantity ?? 0),
      prescriptionDeductedQuantity: Number(
        todayMovements.prescriptionDeductedQuantity ?? 0,
      ),
      manualAdjustedQuantity: Number(
        todayMovements.manualAdjustedQuantity ?? 0,
      ),
    },
    stockSummary: {
      stockCount: Number(stockSummary.stockCount ?? 0),
      totalQuantity: Number(stockSummary.totalQuantity ?? 0),
      estimatedAmount: Number(stockSummary.estimatedAmount ?? 0),
      zeroStockCount: Number(stockSummary.zeroStockCount ?? 0),
      virtualStockCount: Number(stockSummary.virtualStockCount ?? 0),
      controlledStockCount: Number(stockSummary.controlledStockCount ?? 0),
    },
    traceSummary: {
      returnableItemCount: Number(traceSummary.returnableItemCount ?? 0),
      missingExpiryItemCount: Number(traceSummary.missingExpiryItemCount ?? 0),
      expiringSoonItemCount: Number(traceSummary.expiringSoonItemCount ?? 0),
    },
    integrationStatus: {
      agentLastSeenAt: formatApiDateTime(integrationStatus.agentLastSeenAt),
      agentLastPayloadType: String(
        integrationStatus.agentLastPayloadType ?? "-",
      ),
      baropharmCookieRegistered: normalizeBoolean(
        integrationStatus.baropharmCookieRegistered,
      ),
      lastPurchaseSyncStatus: String(
        integrationStatus.lastPurchaseSyncStatus ?? "-",
      ),
      lastPurchaseSyncAt: formatApiDateTime(
        integrationStatus.lastPurchaseSyncAt,
      ),
    },
    recentActivities,
  };
}

function normalizeCmsDashboardActivity(
  raw: unknown,
  index: number,
): CmsDashboardActivity {
  const item = asRecord(raw);
  const rawTone = String(item.tone ?? "blue");
  const tone: CmsDashboardActivity["tone"] =
    rawTone === "amber" || rawTone === "red" ? rawTone : "blue";

  return {
    id: String(item.referenceId ?? item.id ?? index),
    type: String(item.type ?? "ACTIVITY"),
    title: String(item.title ?? "활동"),
    description: String(item.description ?? "-"),
    tone,
    occurredAt: formatApiDateTime(item.occurredAt),
  };
}

function formatApiDateTime(value: unknown, fallback = "-") {
  if (Array.isArray(value)) {
    const [year, month, day, hour = 0, minute = 0] = value.map(Number);
    if (year && month && day) {
      return formatTransactionAt(
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(
          2,
          "0",
        )}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        fallback,
      );
    }
  }

  return formatTransactionAt(value, fallback);
}

function accountTypeLabel(account?: AuthAccount | null) {
  const role = account?.role?.toUpperCase();
  const accountType = account?.accountType?.toUpperCase();

  if (role === "ADMIN") return "관리자";
  if (accountType === "PRIMARY" || role === "PHARMACY_OWNER") return "주계정";
  if (accountType === "LIMITED" || role === "PHARMACY_LIMITED") {
    return "제한 계정";
  }
  return "계정";
}

function getCmsAccountDisplay(account?: AuthAccount | null) {
  const name =
    account?.pharmacyName ??
    account?.accountName ??
    (account?.pharmacyId ? `약국 ${account.pharmacyId}` : "로그인 계정");
  const loginLabel =
    account?.loginId ?? (account?.accountId ? `#${account.accountId}` : "");
  const detail = [accountTypeLabel(account), loginLabel]
    .filter(Boolean)
    .join(" · ");

  return {
    initial: Array.from(name.trim())[0] ?? "P",
    name,
    detail,
  };
}

function CmsSidebar({
  account,
  canAccessMasterData,
  collapsed,
  navigate,
  onToggleCollapsed,
  page,
}: {
  account?: AuthAccount | null;
  canAccessMasterData: boolean;
  collapsed: boolean;
  navigate: (path: string) => void;
  onToggleCollapsed: () => void;
  page: CmsPage;
}) {
  const items: Array<[CmsPage, string, string, string]> = [
    ["dashboard", "대시보드", "/cms", homeIcon],
    ...(canAccessMasterData
      ? ([
          ["master", "기준 데이터", "/cms/master", viewGridIcon],
          ["import", "Import", "/cms/import", viewListIcon],
          ["wholesaler", "도매처", "/cms/wholesaler", briefcaseIcon],
        ] as Array<[CmsPage, string, string, string]>)
      : []),
    ...(canAccessMasterData
      ? ([["signup", "계정 생성", "/cms/signup", fileTextIcon]] as Array<
          [CmsPage, string, string, string]
        >)
      : []),
    ["inventory", "재고", "/cms/inventory", barGraphIcon],
    ["prescriptions", "처방전", "/cms/prescriptions", fileTextIcon],
    ["purchase", "구매 내역", "/cms/purchase", pieGraphIcon],
  ];
  const accountDisplay = getCmsAccountDisplay(account);
  const isInventorySection =
    page === "inventory" ||
    page === "inventory-shortages" ||
    page === "return-reviews";
  const [inventoryExpanded, setInventoryExpanded] =
    useState(isInventorySection);
  const [inventoryFlyoutOpen, setInventoryFlyoutOpen] = useState(false);
  const inventoryFlyoutCloseTimerRef = useRef<number | null>(null);

  function clearInventoryFlyoutCloseTimer() {
    if (inventoryFlyoutCloseTimerRef.current === null) return;
    window.clearTimeout(inventoryFlyoutCloseTimerRef.current);
    inventoryFlyoutCloseTimerRef.current = null;
  }

  function openInventoryFlyout() {
    if (!collapsed) return;
    clearInventoryFlyoutCloseTimer();
    setInventoryFlyoutOpen(true);
  }

  function closeInventoryFlyoutSoon() {
    if (!collapsed) return;
    clearInventoryFlyoutCloseTimer();
    inventoryFlyoutCloseTimerRef.current = window.setTimeout(() => {
      setInventoryFlyoutOpen(false);
      inventoryFlyoutCloseTimerRef.current = null;
    }, 220);
  }

  useEffect(() => {
    if (isInventorySection) setInventoryExpanded(true);
  }, [isInventorySection]);

  useEffect(() => {
    clearInventoryFlyoutCloseTimer();
    setInventoryFlyoutOpen(false);
  }, [collapsed, page]);

  useEffect(() => () => clearInventoryFlyoutCloseTimer(), []);

  const inventorySubItems: Array<[CmsPage, string, string]> = [
    ["inventory", "재고 목록", "/cms/inventory"],
    ["inventory-shortages", "초과 처방", "/cms/inventory/shortages"],
    ["return-reviews", "반품 확인", "/cms/inventory/returns"],
  ];
  const showInventorySubnav = collapsed || inventoryExpanded;

  function handleInventoryParentClick() {
    if (collapsed) {
      clearInventoryFlyoutCloseTimer();
      setInventoryFlyoutOpen((current) => !current);
      return;
    }

    setInventoryExpanded((current) => !current);
  }

  return (
    <aside className="cms-sidebar">
      <div className="cms-brand">
        <img src={pharmfarmLogo} alt="" aria-hidden="true" />
        <div>
          <strong>팜팜</strong>
          <em>관리자 페이지</em>
        </div>
        <button
          className="cms-sidebar-toggle"
          type="button"
          aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
          title={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
          onClick={onToggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen size={18} strokeWidth={2.2} />
          ) : (
            <PanelLeftClose size={18} strokeWidth={2.2} />
          )}
        </button>
      </div>
      <nav className="cms-nav">
        {items.map(([key, label, href, icon]) =>
          key === "inventory" ? (
            <div
              className={`cms-nav-group ${
                inventoryExpanded ? "is-open" : ""
              } ${inventoryFlyoutOpen ? "is-flyout-open" : ""}`}
              key={key}
              onBlur={(event) => {
                const nextTarget = event.relatedTarget;
                if (
                  !(nextTarget instanceof Node) ||
                  !event.currentTarget.contains(nextTarget)
                ) {
                  closeInventoryFlyoutSoon();
                }
              }}
              onMouseEnter={openInventoryFlyout}
              onMouseLeave={closeInventoryFlyoutSoon}
            >
              <button
                aria-expanded={
                  collapsed ? inventoryFlyoutOpen : inventoryExpanded
                }
                aria-haspopup={collapsed ? "menu" : undefined}
                className={`cms-nav-parent ${
                  isInventorySection ? "is-section-active" : ""
                }`}
                type="button"
                title={label}
                onClick={handleInventoryParentClick}
              >
                <img className="cms-nav-icon" src={icon} alt="" aria-hidden />
                <span className="cms-nav-label">{label}</span>
                <ChevronDown
                  className="cms-nav-caret"
                  size={15}
                  strokeWidth={2.6}
                />
              </button>
              {showInventorySubnav && (
                <div
                  className="cms-subnav"
                  aria-label="재고 하위 메뉴"
                  onMouseEnter={openInventoryFlyout}
                >
                  {inventorySubItems.map(([subKey, subLabel, subHref]) => (
                    <button
                      className={page === subKey ? "is-active" : ""}
                      key={subKey}
                      type="button"
                      title={subLabel}
                      onClick={() => {
                        clearInventoryFlyoutCloseTimer();
                        setInventoryFlyoutOpen(false);
                        navigate(subHref);
                      }}
                    >
                      <span className="cms-nav-label">{subLabel}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <button
              key={key}
              className={page === key ? "is-active" : ""}
              type="button"
              title={label}
              onClick={() => navigate(href)}
            >
              <img className="cms-nav-icon" src={icon} alt="" aria-hidden />
              <span className="cms-nav-label">{label}</span>
            </button>
          ),
        )}
      </nav>
      <div className="cms-account">
        <span>{accountDisplay.initial}</span>
        <div>
          <strong>{accountDisplay.name}</strong>
          <em>{accountDisplay.detail}</em>
        </div>
      </div>
    </aside>
  );
}

function CmsHeader({
  onLogout,
  page,
  onRefresh,
}: {
  onLogout?: () => void;
  page: CmsPage;
  onRefresh: () => void;
}) {
  const titles: Record<CmsPage, string> = {
    dashboard: "대시보드",
    master: "기준 데이터",
    import: "기준 데이터 Import",
    signup: "계정 생성",
    inventory: "재고",
    "inventory-shortages": "재고 · 초과 처방",
    "return-reviews": "재고 · 반품 확인",
    wholesaler: "도매처 관리",
    prescriptions: "처방전",
    purchase: "구매 내역",
  };
  const subtitles: Record<CmsPage, string> = {
    dashboard: "오늘 필요한 업무를 한눈에 확인하세요.",
    master: "약품 기준 데이터를 확인하고 정리합니다.",
    import: "기준 데이터 파일을 등록합니다.",
    signup: "root 계정으로 신규 약국과 기본 계정을 생성합니다.",
    inventory: "보유 재고와 수량을 관리합니다.",
    "inventory-shortages": "초과 처방과 부족 수량을 확인합니다.",
    "return-reviews": "앱에서 확정되지 않은 반품을 확인하고 처리합니다.",
    wholesaler: "약국별 도매처 정보를 관리합니다.",
    prescriptions: "처방전 차감 결과와 수동 처리 항목을 확인합니다.",
    purchase: "구매 내역과 주문 기록을 확인합니다.",
  };
  return (
    <header className="cms-header">
      <div>
        <strong>{titles[page]}</strong>
        <span>{subtitles[page]}</span>
      </div>
      <div className="cms-header-actions">
        <button type="button" onClick={onRefresh}>
          새로고침
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

function CmsLoadingPage({ apiMessage }: { apiMessage: string }) {
  return (
    <section className="cms-loading">
      <div className="cms-loading-shell">
        <div className="cms-loading-brand">
          <img src={pharmfarmLogo} alt="" />
          <div>
            <strong>PharmFarm 관리자</strong>
            <span>{apiMessage || "관리자 데이터를 불러오는 중입니다."}</span>
          </div>
        </div>
        <div className="cms-loading-spinner" aria-hidden="true" />
        <div className="cms-loading-steps">
          <span>인증 확인</span>
          <span>기준 데이터 · 재고 조회</span>
          <span>처방전 차감 기록 동기화</span>
        </div>
        <div className="cms-loading-skeleton" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </div>
    </section>
  );
}

function CmsSignupPage({
  draft,
  submitting,
  onChange,
  onSubmit,
}: {
  draft: CmsSignupDraft;
  submitting: boolean;
  onChange: (patch: Partial<CmsSignupDraft>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="cms-content cms-signup-page">
      <form className="cms-signup-form" onSubmit={onSubmit}>
        <div className="cms-signup-section">
          <header>
            <strong>약국 정보</strong>
            <span>신규 약국과 기본 관리자 계정을 함께 생성합니다.</span>
          </header>
          <div className="cms-field-grid">
            <label className="cms-input">
              <span>약국명</span>
              <input
                value={draft.pharmacyName}
                onChange={(event) =>
                  onChange({ pharmacyName: event.target.value })
                }
                required
              />
            </label>
            <label className="cms-input">
              <span>대표자명</span>
              <input
                value={draft.ownerName}
                onChange={(event) =>
                  onChange({ ownerName: event.target.value })
                }
              />
            </label>
            <label className="cms-input">
              <span>연락처</span>
              <input
                value={draft.phone}
                onChange={(event) => onChange({ phone: event.target.value })}
              />
            </label>
            <label className="cms-input">
              <span>사업자등록번호</span>
              <input
                value={draft.businessRegistrationNumber}
                onChange={(event) =>
                  onChange({ businessRegistrationNumber: event.target.value })
                }
              />
            </label>
            <label className="cms-input span-2">
              <span>주소</span>
              <input
                value={draft.address}
                onChange={(event) => onChange({ address: event.target.value })}
              />
            </label>
            <label className="cms-input span-2">
              <span>상세 주소</span>
              <input
                value={draft.addressDetail}
                onChange={(event) =>
                  onChange({ addressDetail: event.target.value })
                }
              />
            </label>
          </div>
        </div>

        <div className="cms-signup-section">
          <header>
            <strong>계정 정보</strong>
            <span>
              주계정은 금액을 볼 수 있고, 제한계정은 금액이 숨겨집니다.
            </span>
          </header>
          <div className="cms-field-grid">
            <label className="cms-input">
              <span>주계정 아이디</span>
              <input
                autoComplete="off"
                value={draft.primaryLoginId}
                onChange={(event) =>
                  onChange({ primaryLoginId: event.target.value })
                }
                required
              />
            </label>
            <label className="cms-input">
              <span>주계정 비밀번호</span>
              <input
                autoComplete="new-password"
                type="password"
                value={draft.primaryPassword}
                onChange={(event) =>
                  onChange({ primaryPassword: event.target.value })
                }
                required
              />
            </label>
            <label className="cms-input">
              <span>제한계정 아이디</span>
              <input
                autoComplete="off"
                value={draft.limitedLoginId}
                onChange={(event) =>
                  onChange({ limitedLoginId: event.target.value })
                }
                required
              />
            </label>
            <label className="cms-input">
              <span>제한계정 비밀번호</span>
              <input
                autoComplete="new-password"
                type="password"
                value={draft.limitedPassword}
                onChange={(event) =>
                  onChange({ limitedPassword: event.target.value })
                }
                required
              />
            </label>
          </div>
        </div>

        <div className="cms-signup-section compact">
          <label className="cms-input">
            <span>생성 확인 비밀번호</span>
            <input
              autoComplete="off"
              type="password"
              value={draft.adminPassword}
              onChange={(event) =>
                onChange({ adminPassword: event.target.value })
              }
              required
            />
          </label>
          <button className="cms-primary" type="submit" disabled={submitting}>
            {submitting ? "생성 중" : "약국 계정 생성"}
          </button>
        </div>
      </form>
    </section>
  );
}

function CmsLoginPage({
  apiMessage,
  apiState,
  loginId,
  password,
  onLoginId,
  onPassword,
  onSubmit,
}: {
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
      <div className="cms-login-shell">
        <div className="cms-login-visual">
          <div className="cms-login-mark">
            <img src={pharmfarmLogo} alt="" />
            <span>PharmFarm 관리자</span>
          </div>
          <div className="cms-login-message">
            <strong>
              QR 입고부터 반품 추적까지,
              <br />
              약국 재고를 한 곳에서.
            </strong>
            <span>
              시리얼 기반 입고처 추적, 기준 데이터 매칭, 처방전 차감과 구매내역
              관리를 한 화면에서 진행하세요.
            </span>
            <div className="cms-login-tags">
              <em>QR 입고 추적</em>
              <em>반품 도매처 확인</em>
            </div>
          </div>
          <small>© 2026 PharmFarm. 약국 전용 재고 관리 시스템</small>
        </div>
        <form className="cms-login-card" onSubmit={onSubmit}>
          <div className="cms-login-logo">
            <img src={pharmfarmLogo} alt="" />
          </div>
          <div className="cms-login-title">
            <strong>운영자 로그인</strong>
            <span>약국 관리자 계정으로 로그인하세요</span>
            <em>
              {apiStateLabel(apiState)} · {apiMessage || "로그인이 필요합니다."}
            </em>
          </div>
          <label>
            <span>아이디</span>
            <input
              autoComplete="username"
              value={loginId}
              onChange={(event) => onLoginId(event.target.value)}
            />
          </label>
          <label>
            <span>비밀번호</span>
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => onPassword(event.target.value)}
            />
          </label>
          <button className="cms-primary" type="submit">
            로그인
          </button>
          <div className="cms-login-help">
            <span>계정이 없으신가요?</span>
            <strong>약국 등록 문의</strong>
          </div>
        </form>
      </div>
    </section>
  );
}

function CmsDashboard({
  account,
  cookieState,
  dashboard,
  deductionRecords,
  navigate,
  stocks,
  syncJobs,
}: {
  account?: AuthAccount | null;
  cookieState: CmsCookieState;
  dashboard: CmsDashboardData | null;
  deductionRecords: CmsDeductionRecord[];
  navigate: (path: string) => void;
  stocks: StockItem[];
  syncJobs: CmsSyncJob[];
}) {
  const data =
    dashboard ??
    createFallbackDashboardData({
      cookieState,
      deductionRecords,
      stocks,
      syncJobs,
    });
  const canViewAmounts = canViewAmountCms(account);
  const accountDisplay = getCmsAccountDisplay(account);
  const pharmacyGreetingName =
    account?.pharmacyName ?? account?.accountName ?? accountDisplay.name;
  const greetingRole = cmsGreetingRoleLabel(account);
  const shortageRecords = deductionRecords.filter(
    (record) => record.shortageQuantity > 0,
  );
  const activeShortageRecords = shortageRecords.filter(
    (record) => !isHoldShortageStatus(record.shortageStatus),
  );
  const failedPrescriptionRecords = deductionRecords.filter(
    (record) => record.status === "FAILED" || record.status === "PENDING",
  );
  const orderNeededShortageRecords = shortageRecords.filter((record) =>
    isOpenShortageStatus(record.shortageStatus),
  );
  const orderedShortageRecords = shortageRecords.filter(
    (record) => record.shortageStatus === "ORDERED",
  );
  const holdShortageRecords = shortageRecords.filter((record) =>
    isHoldShortageStatus(record.shortageStatus),
  );
  const prescriptionIssueCount =
    activeShortageRecords.length + failedPrescriptionRecords.length;
  const prescriptionWorkTotal =
    prescriptionIssueCount > 0
      ? prescriptionIssueCount
      : data.tasks.failedDeductions;
  const inventoryTaskTotal =
    data.tasks.virtualStocks +
    data.tasks.zeroStocks +
    data.tasks.controlledCandidates;
  const prescriptionTaskItems: Array<{
    count: number;
    description: string;
    href: string;
    title: string;
    tone: "blue" | "amber" | "red";
  }> = [
    {
      count: activeShortageRecords.length,
      description: "부족 수량과 연결된 처방을 확인하세요",
      href: "/cms/inventory/shortages",
      title: "초과 처방 확인",
      tone: "red",
    },
    {
      count: failedPrescriptionRecords.length,
      description: "재고 매칭이 필요한 처방 약품입니다",
      href: "/cms/prescriptions",
      title: "차감 실패 처리",
      tone: "red",
    },
    {
      count: orderNeededShortageRecords.length,
      description: "아직 주문 처리로 넘기지 않은 부족분입니다",
      href: "/cms/inventory/shortages",
      title: "주문 필요 부족분",
      tone: "amber",
    },
    {
      count: deductionRecords.length,
      description: "최근 차감 결과를 처방 단위로 확인합니다",
      href: "/cms/prescriptions",
      title: "처방 기록 보기",
      tone: "blue",
    },
  ];
  const visibleActivities = data.recentActivities.filter((activity) => {
    const text = `${activity.type} ${activity.title} ${activity.description}`;
    return !/(agent|sync|baropharm|integration|cookie|쿠키|동기화|에이전트)/i.test(
      text,
    );
  });
  const flowTotal =
    data.todayMovements.receivedQuantity +
    data.todayMovements.returnedQuantity +
    data.todayMovements.prescriptionDeductedQuantity +
    Math.abs(data.todayMovements.manualAdjustedQuantity);

  return (
    <section className="cms-content cms-dashboard-page">
      <div className="cms-dashboard-hero">
        <div className="cms-dashboard-greeting">
          <span>오늘의 처방 업무</span>
          <strong>
            안녕하세요, {pharmacyGreetingName} {greetingRole}.
          </strong>
          <p>오늘 해야할 일들을 확인해보세요!</p>
        </div>
        <div className="cms-dashboard-work-count">
          <span>오늘 처리할 일</span>
          <strong>{prescriptionWorkTotal}건</strong>
          <button type="button" onClick={() => navigate("/cms/prescriptions")}>
            처방전 확인
          </button>
        </div>
      </div>

      <section className="cms-prescription-work">
        <header>
          <div>
            <strong>
              {prescriptionWorkTotal > 0
                ? "지금 확인이 필요한 처방 업무가 있습니다."
                : "오늘 바로 처리할 처방 이슈가 없습니다."}
            </strong>
          </div>
          <button
            type="button"
            onClick={() => navigate("/cms/inventory/shortages")}
          >
            초과 처방 목록
          </button>
        </header>
        <div className="cms-prescription-task-grid">
          {prescriptionTaskItems.map((item) => {
            const isActive = item.count > 0;
            return (
              <button
                className={`cms-prescription-task-card ${
                  isActive ? "is-active" : ""
                }`}
                key={item.title}
                type="button"
                onClick={() => navigate(item.href)}
              >
                <span className={`cms-task-dot ${item.tone}`} />
                <strong>{item.title}</strong>
                <em>{item.description}</em>
                <b>{item.count}건</b>
              </button>
            );
          })}
        </div>
      </section>

      <div className="cms-dashboard-sections">
        <CmsDashboardSection
          title="오늘 재고 흐름"
          summary={`${currency(flowTotal)}개`}
        >
          <div className="cms-flow-grid">
            <CmsFlowStat
              label="입고"
              value={data.todayMovements.receivedQuantity}
              tone="blue"
            />
            <CmsFlowStat
              label="반품"
              value={data.todayMovements.returnedQuantity}
              tone="amber"
            />
            <CmsFlowStat
              label="처방 차감"
              value={data.todayMovements.prescriptionDeductedQuantity}
              tone="amber"
            />
            <CmsFlowStat
              label="수동 조정"
              value={data.todayMovements.manualAdjustedQuantity}
              tone="red"
            />
          </div>
        </CmsDashboardSection>
        <CmsDashboardSection
          title="재고 참고 정보"
          summary={`${data.stockSummary.stockCount}종`}
          action="재고 보기"
          onAction={() => navigate("/cms/inventory")}
        >
          <div
            className={`cms-kpis compact4 dashboard-kpis ${
              canViewAmounts ? "" : "is-amount-hidden"
            }`}
          >
            <CmsKpi
              label="보유 재고 품목"
              value={`${data.stockSummary.stockCount}`}
              unit="종"
            />
            <CmsKpi
              label="총 보유 수량"
              value={currency(data.stockSummary.totalQuantity)}
              unit="개"
            />
            <CmsKpi
              label="재고 확인 필요"
              value={`${inventoryTaskTotal}`}
              unit="건"
              tone={inventoryTaskTotal > 0 ? "red" : undefined}
            />
            {canViewAmounts && (
              <CmsKpi
                label="예상 재고 금액"
                detail={`전체 ${currency(data.stockSummary.estimatedAmount)}원`}
                value={compactKoreanCurrency(data.stockSummary.estimatedAmount)}
                unit="원"
                tone="blue"
              />
            )}
          </div>
          <CmsMiniList
            items={[
              ["90일 내 만료", `${data.traceSummary.expiringSoonItemCount}건`],
              ["관리약 재고", `${data.stockSummary.controlledStockCount}종`],
              ["임의 재고", `${data.stockSummary.virtualStockCount}종`],
              ["0개 재고", `${data.stockSummary.zeroStockCount}종`],
            ]}
          />
        </CmsDashboardSection>
        <CmsDashboardSection
          title="초과 처방 처리 상태"
          summary={`${activeShortageRecords.length}건`}
          action="상세 보기"
          onAction={() => navigate("/cms/inventory/shortages")}
        >
          <CmsMiniList
            items={[
              ["주문 필요", `${orderNeededShortageRecords.length}건`],
              ["주문 완료", `${orderedShortageRecords.length}건`],
              ["보류", `${holdShortageRecords.length}건`],
            ]}
          />
        </CmsDashboardSection>
        <CmsDashboardSection
          title="최근 활동"
          summary={`${visibleActivities.length}건`}
        >
          <div className="cms-activity-list">
            {visibleActivities.map((activity) => (
              <div
                className="cms-activity-row"
                key={`${activity.type}-${activity.id}`}
              >
                <span className={`cms-task-dot ${activity.tone}`} />
                <div>
                  <strong>{activity.title}</strong>
                  <span>{activity.description}</span>
                </div>
                <time>{activity.occurredAt}</time>
              </div>
            ))}
            {visibleActivities.length === 0 && (
              <p className="cms-empty">표시할 최근 활동이 없습니다.</p>
            )}
          </div>
        </CmsDashboardSection>
      </div>
    </section>
  );
}

function CmsDashboardSection({
  action,
  children,
  defaultOpen = false,
  onAction,
  summary,
  title,
}: {
  action?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  onAction?: () => void;
  summary?: string;
  title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`cms-dashboard-section ${open ? "is-open" : ""}`}>
      <header>
        <button
          className="cms-dashboard-section-toggle"
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown size={16} strokeWidth={2.4} />
          <span>
            <strong>{title}</strong>
            {summary && <em>{summary}</em>}
          </span>
        </button>
        {action && (
          <button
            className="cms-dashboard-section-action"
            type="button"
            onClick={onAction}
          >
            {action}
          </button>
        )}
      </header>
      {open && <div className="cms-dashboard-section-body">{children}</div>}
    </section>
  );
}

function CmsFlowStat({
  label,
  tone,
  value,
}: {
  label: string;
  tone: "blue" | "amber" | "red";
  value: number;
}) {
  return (
    <div className={`cms-flow-stat ${tone}`}>
      <span>{label}</span>
      <strong>{currency(value)}</strong>
      <em>개</em>
    </div>
  );
}

function createFallbackDashboardData({
  cookieState,
  deductionRecords,
  stocks,
  syncJobs,
}: {
  cookieState: CmsCookieState;
  deductionRecords: CmsDeductionRecord[];
  stocks: StockItem[];
  syncJobs: CmsSyncJob[];
}): CmsDashboardData {
  const failedDeductions = deductionRecords.filter(
    (record) => record.status === "FAILED" || record.shortageQuantity > 0,
  ).length;
  const controlledStockCount = stocks.filter(
    (stock) => stock.controlledDrug.controlled,
  ).length;
  const recentActivities = deductionRecords.slice(0, 6).map((record) => ({
    id: record.id,
    type: "PRESCRIPTION_DEDUCTION",
    title:
      record.status === "FAILED"
        ? "처방전 차감 실패"
        : deductionStatusText(record.status),
    description: `${record.drugName} · ${record.totalQuantity}개 · ${record.reason}`,
    tone: record.status === "FAILED" ? ("red" as const) : ("blue" as const),
    occurredAt: record.createdAt,
  }));

  return {
    tasks: {
      failedDeductions,
      virtualStocks: stocks.filter(isVirtualStock).length,
      zeroStocks: stocks.filter((stock) => stock.quantity <= 0).length,
      controlledCandidates: controlledStockCount,
      baropharmNeedsAction:
        !cookieState.registered || cookieState.status === "AUTH_FAILED",
      agentNeedsAction: false,
    },
    todayMovements: {
      receivedQuantity: 0,
      returnedQuantity: 0,
      prescriptionDeductedQuantity: 0,
      manualAdjustedQuantity: 0,
    },
    stockSummary: {
      stockCount: stocks.length,
      totalQuantity: stocks.reduce((sum, stock) => sum + stock.quantity, 0),
      estimatedAmount: stocks.reduce(
        (sum, stock) => sum + stock.quantity * stock.price,
        0,
      ),
      zeroStockCount: stocks.filter((stock) => stock.quantity <= 0).length,
      virtualStockCount: stocks.filter(isVirtualStock).length,
      controlledStockCount,
    },
    traceSummary: {
      returnableItemCount: 0,
      missingExpiryItemCount: 0,
      expiringSoonItemCount: 0,
    },
    integrationStatus: {
      agentLastSeenAt: "-",
      agentLastPayloadType: "-",
      baropharmCookieRegistered: cookieState.registered,
      lastPurchaseSyncStatus: syncJobs[0]?.status ?? "-",
      lastPurchaseSyncAt: "-",
    },
    recentActivities,
  };
}

function syncStatusText(status: string) {
  switch (status) {
    case "RUNNING":
      return "진행 중";
    case "SUCCESS":
      return "성공";
    case "AUTH_FAILED":
      return "인증 실패";
    case "PARTIAL_AUTH_FAILED":
      return "일부 성공 후 인증 실패";
    case "FAILED":
      return "실패";
    default:
      return status || "-";
  }
}

function purchaseConnectionStatusText(status: string) {
  switch (status) {
    case "VALID":
    case "OK":
      return "정상";
    case "AUTH_FAILED":
      return "확인 필요";
    case "UNKNOWN":
      return "미확인";
    default:
      return status || "-";
  }
}

function CmsMasterPage({
  includeInactive,
  masterQuery,
  masters,
  selectedMaster,
  onIncludeInactive,
  onMasterChange,
  onQuery,
  onRematch,
  onSave,
  onSelect,
  onUpload,
}: {
  includeInactive: boolean;
  masterQuery: string;
  masters: CmsMaster[];
  selectedMaster?: CmsMaster;
  onIncludeInactive: (value: boolean) => void;
  onMasterChange: (masterId: string, patch: Partial<CmsMaster>) => void;
  onQuery: (value: string) => void;
  onRematch: (master: CmsMaster) => void;
  onSave: (master: CmsMaster) => void;
  onSelect: (id: string) => void;
  onUpload: (kind: "drug" | "price", file: File | null) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const masterPagination = usePagination(
    masters,
    CMS_PAGE_SIZES.master,
    `${masterQuery}|${includeInactive}`,
  );

  useEffect(() => {
    if (!selectedMaster) setSheetOpen(false);
  }, [selectedMaster]);

  return (
    <section className="cms-content cms-list-page cms-master-page">
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
          <label className="cms-search">
            <span className="search-icon" />
            <input
              placeholder="표준코드 · 보험코드 · 약명 검색"
              value={masterQuery}
              onChange={(event) => onQuery(event.target.value)}
            />
          </label>
          <label className="cms-check">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => onIncludeInactive(event.target.checked)}
            />
            비활성 포함
          </label>
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
        <div className="cms-table-scroll">
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
            {masterPagination.items.map((master) => (
              <button
                key={master.id}
                className={`cms-tr ${selectedMaster?.id === master.id ? "is-selected" : ""}`}
                type="button"
                onClick={() => {
                  onSelect(master.id);
                  setSheetOpen(true);
                }}
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
            {masters.length === 0 && (
              <p className="cms-empty table-empty">
                기준 데이터를 불러오는 중입니다.
              </p>
            )}
          </div>
        </div>
        <CmsPagination {...masterPagination} />
      </div>
      {sheetOpen && selectedMaster && (
        <CmsSheet
          title={selectedMaster.name}
          subtitle={statusText(selectedMaster.status)}
          onClose={() => setSheetOpen(false)}
        >
          <div className="cms-sheet-body">
            <span className={`cms-badge ${statusClass(selectedMaster.status)}`}>
              {statusText(selectedMaster.status)}
            </span>
            <CmsEditableField
              label="표준코드"
              value={selectedMaster.standardCode}
              mono
              onChange={(value) =>
                onMasterChange(selectedMaster.id, { standardCode: value })
              }
            />
            <CmsEditableField
              label="보험코드"
              value={selectedMaster.insuranceCode}
              mono
              onChange={(value) =>
                onMasterChange(selectedMaster.id, { insuranceCode: value })
              }
            />
            <div className="cms-field-grid">
              <CmsEditableField
                label="약품규격"
                value={selectedMaster.spec}
                onChange={(value) =>
                  onMasterChange(selectedMaster.id, { spec: value })
                }
              />
              <CmsEditableField
                label="제품총수량"
                value={`${selectedMaster.productTotalQuantity}`}
                onChange={(value) =>
                  onMasterChange(selectedMaster.id, {
                    productTotalQuantity: Number(value) || 0,
                  })
                }
              />
            </div>
            <CmsEditableField
              label="한글상품명"
              value={selectedMaster.name}
              onChange={(value) =>
                onMasterChange(selectedMaster.id, { name: value })
              }
            />
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
          </div>
        </CmsSheet>
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
  const jobPagination = usePagination(
    jobs,
    CMS_PAGE_SIZES.importJobs,
    `${jobs.length}`,
  );

  return (
    <section className="cms-content cms-list-page">
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
      <div className="cms-grid two cms-scroll-grid">
        <CmsPanel
          title="Import 작업"
          bodyClassName="cms-panel-body cms-panel-scroll"
          footer={<CmsPagination {...jobPagination} />}
        >
          {jobPagination.items.map((job) => (
            <CmsJobRow key={job.id} job={job} />
          ))}
          {jobs.length === 0 && (
            <p className="cms-empty">표시할 import job이 없습니다.</p>
          )}
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
  mergeInsuranceCode,
  controlledFilter,
  query,
  searchStatus,
  selectedStock,
  sortDirection,
  sortKey,
  stocks,
  canSyncSnapshot,
  syncSnapshotDefaultPharmacyId,
  onAdjust,
  onAdjustDirection,
  onAdjustMemo,
  onAdjustQuantity,
  onCreateStock,
  onControlledFilter,
  onMergeInsuranceCode,
  onMergeVirtual,
  onQuery,
  onSearch,
  onSelect,
  onSort,
  onSyncSnapshot,
  onUpdatePrice,
}: {
  adjustDirection: "INCREASE" | "DECREASE";
  adjustMemo: string;
  adjustQuantity: number;
  mergeInsuranceCode: string;
  controlledFilter: CmsStockControlledFilter;
  query: string;
  searchStatus: CmsStockSearchStatus;
  selectedStock?: StockItem;
  sortDirection: CmsStockSortDirection;
  sortKey: CmsStockSortKey;
  stocks: StockItem[];
  canSyncSnapshot: boolean;
  syncSnapshotDefaultPharmacyId: string;
  onAdjust: () => void;
  onAdjustDirection: (value: "INCREASE" | "DECREASE") => void;
  onAdjustMemo: (value: string) => void;
  onAdjustQuantity: (value: number) => void;
  onCreateStock: (draft: CmsStockCreateDraft) => Promise<boolean>;
  onControlledFilter: (value: CmsStockControlledFilter) => void;
  onMergeInsuranceCode: (value: string) => void;
  onMergeVirtual: () => void;
  onQuery: (value: string) => void;
  onSearch: (
    keyword: string,
    controlledFilter: CmsStockControlledFilter,
    sortKey?: CmsStockSortKey,
    sortDirection?: CmsStockSortDirection,
  ) => void;
  onSelect: (id: string) => void;
  onSort: (sortKey: CmsStockSortKey) => void;
  onSyncSnapshot: (
    targetPharmacyId: string,
  ) => Promise<CmsStockSnapshotSyncSummary>;
  onUpdatePrice: (stock: StockItem, price: number) => Promise<boolean>;
}) {
  const [sheetMode, setSheetMode] = useState<
    "adjust" | "create" | "virtualPrice" | null
  >(null);
  const [sheetStockId, setSheetStockId] = useState<string | null>(null);
  const [createDraft, setCreateDraft] = useState<CmsStockCreateDraft>(
    emptyCmsStockCreateDraft,
  );
  const [priceDraft, setPriceDraft] = useState(0);
  const [stockSheetTab, setStockSheetTab] = useState<"quantity" | "meta">(
    "quantity",
  );
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncResult, setSyncResult] =
    useState<CmsStockSnapshotSyncSummary | null>(null);
  const [syncError, setSyncError] = useState("");
  const [syncPharmacyId, setSyncPharmacyId] = useState(
    syncSnapshotDefaultPharmacyId,
  );
  const [debugLargeAmount, setDebugLargeAmount] = useState(false);
  const normalizedQuery = normalizeSearchText(query);
  const stockPagination = usePagination(
    stocks,
    CMS_PAGE_SIZES.inventory,
    `${normalizedQuery}|${controlledFilter}|${stocks.length}`,
  );
  const stockValue = stocks.reduce(
    (sum, item) => sum + item.quantity * item.price,
    0,
  );
  const displayedStockValue = debugLargeAmount ? 987_654_321_098 : stockValue;
  const controlledCount = stocks.filter(
    (stock) => stock.controlledDrug.controlled,
  ).length;
  const nonControlledCount = stocks.length - controlledCount;
  const virtualCount = stocks.filter(isVirtualStock).length;
  const zeroVirtualPriceCount = stocks.filter(
    (stock) => isVirtualStock(stock) && stock.price <= 0,
  ).length;
  const sheetStock =
    stocks.find((stock) => stock.id === sheetStockId) ?? selectedStock;
  const signedQuantity =
    adjustDirection === "INCREASE" ? adjustQuantity : -adjustQuantity;
  const canCreateStock =
    createDraft.name.trim().length > 0 &&
    createDraft.insuranceCode.trim().length > 0 &&
    createDraft.price >= 0 &&
    createDraft.quantity >= 0 &&
    createDraft.productTotalQuantity >= 0;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onSearch(query, controlledFilter, sortKey, sortDirection);
    }, 250);

    return () => window.clearTimeout(timer);
  }, [controlledFilter, onSearch, query, sortDirection, sortKey]);

  useEffect(() => {
    setSyncPharmacyId(syncSnapshotDefaultPharmacyId);
  }, [syncSnapshotDefaultPharmacyId]);

  async function submitCreateStock(event: FormEvent) {
    event.preventDefault();
    if (!canCreateStock) return;

    const created = await onCreateStock(createDraft);
    if (created) {
      setCreateDraft(emptyCmsStockCreateDraft());
      setSheetMode(null);
    }
  }

  function openCreateSheet() {
    setCreateDraft(emptyCmsStockCreateDraft());
    setSheetStockId(null);
    setStockSheetTab("quantity");
    setSheetMode("create");
  }

  async function saveVirtualPrice() {
    if (!sheetStock) return;
    const saved = await onUpdatePrice(sheetStock, priceDraft);
    if (saved && sheetMode === "virtualPrice") setSheetMode(null);
  }

  async function confirmSnapshotSync() {
    if (!syncPharmacyId.trim()) {
      setSyncError("대상 약국 ID를 입력해 주세요.");
      return;
    }
    setSyncRunning(true);
    setSyncError("");
    try {
      const result = await onSyncSnapshot(syncPharmacyId);
      setSyncResult(result);
    } catch (error) {
      setSyncError(
        error instanceof Error
          ? userFacingConnectionMessage(error.message)
          : "재고 재동기화에 실패했습니다.",
      );
    } finally {
      setSyncRunning(false);
    }
  }

  return (
    <section className="cms-content cms-list-page cms-inventory-page">
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
            detail={`전체 ${currency(displayedStockValue)}원`}
            value={compactKoreanCurrency(displayedStockValue)}
            unit="원"
          />
          <CmsKpi label="향정 품목" value={`${controlledCount}`} unit="종" />
          <CmsKpi label="임의 재고" value={`${virtualCount}`} unit="종" />
        </div>
        <div className="cms-toolbar">
          {/* <div className="cms-pills">
            <span>
              {searchStatus === "loading"
                ? "검색 중"
                : searchStatus === "short"
                  ? "2글자 이상 입력"
                  : searchStatus === "error"
                    ? "오프라인 결과"
                    : normalizedQuery
                      ? "검색 결과"
                      : "전체 재고"}
            </span>
          </div> */}
          <div style={{ display: "flex", gap: "10px" }}>
            <label className="cms-search">
              <span className="search-icon" />
              <input
                placeholder="약품명 · 보험코드 검색"
                value={query}
                onChange={(event) => onQuery(event.target.value)}
              />
            </label>
            <div className="cms-inventory-filter" role="tablist">
              {(
                [
                  ["ALL", "전체"],
                  ["CONTROLLED", "향정"],
                  ["NON_CONTROLLED", "비향정"],
                  ["VIRTUAL", "임의"],
                ] as Array<[CmsStockControlledFilter, string]>
              ).map(([value, label]) => (
                <button
                  className={controlledFilter === value ? "is-active" : ""}
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={controlledFilter === value}
                  onClick={() => onControlledFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="cms-toolbar-actions">
            {/* {(debugToolsEnabled || canSyncSnapshot) && (
              <button
                className="cms-secondary cms-toolbar-action"
                type="button"
                onClick={() => setDebugLargeAmount((current) => !current)}
              >
                {debugLargeAmount ? "실제 금액" : "큰 금액 테스트"}
              </button>
            )} */}
            {canSyncSnapshot && (
              <button
                className="cms-secondary cms-toolbar-action cms-inventory-sync-button"
                type="button"
                onClick={() => {
                  setSyncResult(null);
                  setSyncError("");
                  setSyncPharmacyId(syncSnapshotDefaultPharmacyId);
                  setSyncModalOpen(true);
                }}
              >
                <RefreshCw size={14} strokeWidth={2.5} />
                재고 재동기화
              </button>
            )}
            <button
              className="cms-primary cms-toolbar-action cms-inventory-create-button"
              type="button"
              onClick={openCreateSheet}
            >
              약품 생성
            </button>
          </div>
        </div>
        <div className="cms-table-scroll">
          <div className="cms-table inventory">
            <div className="cms-tr cms-th">
              <button
                className={`cms-sort-header ${
                  sortKey === "name" ? "is-active" : ""
                }`}
                type="button"
                aria-label={stockSortAriaLabel(
                  "약품명",
                  "name",
                  sortKey,
                  sortDirection,
                )}
                title={stockSortAriaLabel(
                  "약품명",
                  "name",
                  sortKey,
                  sortDirection,
                )}
                onClick={() => onSort("name")}
              >
                약품명
                <StockSortIcon
                  active={sortKey === "name"}
                  direction={sortDirection}
                />
              </button>
              <span>보험코드</span>
              <span>가격</span>
              <button
                className={`cms-sort-header ${
                  sortKey === "quantity" ? "is-active" : ""
                }`}
                type="button"
                aria-label={stockSortAriaLabel(
                  "보유수량",
                  "quantity",
                  sortKey,
                  sortDirection,
                )}
                title={stockSortAriaLabel(
                  "보유수량",
                  "quantity",
                  sortKey,
                  sortDirection,
                )}
                onClick={() => onSort("quantity")}
              >
                보유수량
                <StockSortIcon
                  active={sortKey === "quantity"}
                  direction={sortDirection}
                />
              </button>
              <span>예상금액</span>
              <span>매칭</span>
            </div>
            {stockPagination.items.map((stock) => (
              <button
                key={stock.id}
                className={`cms-tr ${selectedStock?.id === stock.id ? "is-selected" : ""}`}
                type="button"
                onClick={() => {
                  onSelect(stock.id);
                  setSheetStockId(stock.id);
                  setStockSheetTab("quantity");
                  if (isVirtualStock(stock)) {
                    setPriceDraft(stock.price);
                  }
                  if (isVirtualStock(stock) && stock.price <= 0) {
                    setSheetMode("virtualPrice");
                  } else {
                    setSheetMode("adjust");
                  }
                }}
              >
                <div className="cms-stock-name-cell">
                  <strong>{stock.name}</strong>
                  {isVirtualStock(stock) && (
                    <span className="cms-badge virtual">임의</span>
                  )}
                  {stock.controlledDrug.controlled && (
                    <span
                      className="cms-badge controlled"
                      title={
                        stock.controlledDrug.remark ??
                        stock.controlledDrug.habitKind ??
                        "향정신성 의약품"
                      }
                    >
                      향정
                    </span>
                  )}
                </div>
                <span>{stock.insuranceCode}</span>
                <span>{currency(stock.price)}원</span>
                <span>{stock.quantity}</span>
                <span>{currency(stock.quantity * stock.price)}원</span>
                <span className={`cms-badge ${statusClass(stock.matchStatus)}`}>
                  {isVirtualStock(stock) && stock.price <= 0
                    ? "가격 필요"
                    : statusText(stock.matchStatus)}
                </span>
              </button>
            ))}
            {stocks.length === 0 && (
              <p className="cms-empty table-empty">
                재고 데이터를 불러오는 중입니다.
              </p>
            )}
          </div>
        </div>
        <CmsPagination {...stockPagination} />
      </div>
      {syncModalOpen && (
        <CmsModal
          title="에이전트 재고 재동기화"
          subtitle="현재 로그인한 약국의 스냅샷 전체 기준"
          variant="confirm"
          onClose={() => {
            if (!syncRunning) setSyncModalOpen(false);
          }}
        >
          <div className="cms-sync-confirm">
            <label className="cms-input">
              <span>대상 약국 ID</span>
              <input
                inputMode="numeric"
                placeholder="예: 4"
                value={syncPharmacyId}
                disabled={syncRunning || Boolean(syncResult)}
                onChange={(event) =>
                  setSyncPharmacyId(event.target.value.replace(/[^\d]/g, ""))
                }
              />
            </label>
            <div className="cms-resolution-confirm-card is-stock">
              <span>동기화 방식</span>
              <strong>같은 보험코드는 기존 재고를 업데이트합니다.</strong>
              <em>
                스냅샷을 보험코드별로 합산해 수량을 다시 맞추며, 0개와 음수
                재고도 반영됩니다.
              </em>
            </div>
            {syncResult ? (
              <div className="cms-sync-result-grid">
                <CmsReadonlyItem
                  label="대상 약국"
                  value={`${syncResult.pharmacyId || syncPharmacyId}번`}
                />
                <CmsReadonlyItem
                  label="스냅샷 row"
                  value={`${currency(syncResult.snapshotRows)}건`}
                />
                <CmsReadonlyItem
                  label="반영 약품"
                  value={`${currency(syncResult.synced)}종`}
                />
                <CmsReadonlyItem
                  label="0개 재고"
                  value={`${currency(syncResult.zeroDrugCount)}종`}
                />
                <CmsReadonlyItem
                  label="음수 재고"
                  tone="red"
                  value={`${currency(syncResult.negativeDrugCount)}종`}
                />
              </div>
            ) : (
              <p>
                이미 생성된 재고는 중복으로 만들지 않고 현재 스냅샷 수량으로
                갱신합니다. 스냅샷에 없는 기존 재고는 삭제하지 않습니다.
              </p>
            )}
            {syncError && <p className="cms-sync-error">{syncError}</p>}
            <div className="cms-confirm-actions">
              <button
                className="cms-confirm-button"
                disabled={syncRunning}
                type="button"
                onClick={() => setSyncModalOpen(false)}
              >
                {syncResult ? "닫기" : "취소"}
              </button>
              {!syncResult && (
                <button
                  className="cms-confirm-button is-primary"
                  disabled={syncRunning || !syncPharmacyId.trim()}
                  type="button"
                  onClick={confirmSnapshotSync}
                >
                  {syncRunning ? "동기화 중" : "재동기화 실행"}
                </button>
              )}
            </div>
          </div>
        </CmsModal>
      )}
      {sheetMode && (
        <div
          className="cms-sheet-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSheetMode(null);
          }}
        >
          <aside aria-modal="true" className="cms-sheet" role="dialog">
            <header className="cms-sheet-header">
              <div>
                <strong>
                  {sheetMode === "create"
                    ? "약품 생성"
                    : sheetMode === "virtualPrice"
                      ? "임의 재고 가격 입력"
                      : "수동 재고 조정"}
                </strong>
                <span>
                  {sheetMode === "create"
                    ? "직접 입력"
                    : (sheetStock?.insuranceCode ?? "-")}
                </span>
              </div>
              <button type="button" onClick={() => setSheetMode(null)}>
                닫기
              </button>
            </header>

            {sheetMode === "adjust" && sheetStock && (
              <div className="cms-sheet-body">
                <strong className="cms-selected-name">{sheetStock.name}</strong>
                {sheetStock.controlledDrug.controlled && (
                  <div className="cms-controlled-summary">
                    <span className="cms-badge controlled">향정</span>
                    <strong>
                      {sheetStock.controlledDrug.shortName ?? sheetStock.name}
                    </strong>
                    <em>
                      {[
                        sheetStock.controlledDrug.habitKind,
                        sheetStock.controlledDrug.appliedDate,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "PDF 기준 등록"}
                    </em>
                  </div>
                )}
                {isVirtualStock(sheetStock) && (
                  <div
                    className="cms-sheet-tabs"
                    role="tablist"
                    aria-label="임의 재고 수정 메뉴"
                  >
                    <button
                      className={
                        stockSheetTab === "quantity" ? "is-active" : ""
                      }
                      type="button"
                      role="tab"
                      aria-selected={stockSheetTab === "quantity"}
                      onClick={() => setStockSheetTab("quantity")}
                    >
                      재고 수정
                    </button>
                    <button
                      className={stockSheetTab === "meta" ? "is-active" : ""}
                      type="button"
                      role="tab"
                      aria-selected={stockSheetTab === "meta"}
                      onClick={() => setStockSheetTab("meta")}
                    >
                      가격 및 보험코드 수정
                    </button>
                  </div>
                )}

                {(!isVirtualStock(sheetStock) ||
                  stockSheetTab === "quantity") && (
                  <>
                    <CmsField
                      label="현재 재고"
                      value={`${sheetStock.quantity}개`}
                    />
                    <div className="cms-segment">
                      <button
                        className={
                          adjustDirection === "INCREASE" ? "is-active" : ""
                        }
                        type="button"
                        onClick={() => onAdjustDirection("INCREASE")}
                      >
                        증가
                      </button>
                      <button
                        className={
                          adjustDirection === "DECREASE" ? "is-active" : ""
                        }
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
                      <input
                        aria-label="조정 수량"
                        inputMode="numeric"
                        min={1}
                        max={999}
                        type="number"
                        value={adjustQuantity}
                        onChange={(event) =>
                          onAdjustQuantity(Number(event.target.value) || 1)
                        }
                      />
                      <button
                        type="button"
                        onClick={() => onAdjustQuantity(adjustQuantity + 1)}
                      >
                        +
                      </button>
                    </div>
                    {/* <label className="cms-input">
                      <span>조정 사유</span>
                      <input
                        value={adjustMemo}
                        onChange={(event) => onAdjustMemo(event.target.value)}
                      />
                    </label> */}
                    <div className="cms-after">
                      <span>조정 후 재고</span>
                      <strong>
                        {Math.max(0, sheetStock.quantity + signedQuantity)}개
                      </strong>
                    </div>
                    <button
                      className="cms-primary"
                      type="button"
                      onClick={onAdjust}
                    >
                      저장
                    </button>
                  </>
                )}

                {isVirtualStock(sheetStock) && stockSheetTab === "meta" && (
                  <>
                    <h2>임의 재고 가격 수정</h2>
                    <label className="cms-input">
                      <span>약품 가격</span>
                      <input
                        min="0"
                        type="number"
                        value={priceDraft}
                        onChange={(event) =>
                          setPriceDraft(
                            Math.max(0, Number(event.target.value) || 0),
                          )
                        }
                      />
                    </label>
                    <div className="cms-after">
                      <span>입력 기준 재고 금액</span>
                      <strong>
                        {currency(
                          sheetStock.quantity * Math.max(0, priceDraft),
                        )}
                        원
                      </strong>
                    </div>
                    <button
                      className="cms-primary"
                      type="button"
                      onClick={saveVirtualPrice}
                    >
                      가격 저장
                    </button>
                    <div className="cms-divider" />
                    <div className="cms-section-title-row">
                      <h2>임의 보험코드 보정</h2>
                      <button
                        className="cms-help-icon"
                        type="button"
                        aria-label="임의 보험코드 보정 설명"
                      >
                        <CircleHelp size={16} strokeWidth={2.4} />
                        <span>
                          입력한 코드와 같은 코드의 약이 있으면 이 재고 수량을
                          <br />
                          그 약에 더합니다.
                          <br />
                          없으면, 이 임의 재고의 코드만 입력한 코드로 바뀝니다.
                        </span>
                      </button>
                    </div>
                    <label className="cms-input">
                      <span>전환/병합할 보험코드</span>
                      <input
                        value={mergeInsuranceCode}
                        onChange={(event) =>
                          onMergeInsuranceCode(event.target.value)
                        }
                      />
                    </label>
                    <button
                      className="cms-primary"
                      type="button"
                      onClick={onMergeVirtual}
                    >
                      실제 코드로 전환/병합
                    </button>
                  </>
                )}
              </div>
            )}

            {sheetMode === "virtualPrice" && sheetStock && (
              <div className="cms-sheet-body">
                <div className="cms-controlled-summary">
                  <span className="cms-badge virtual">임의</span>
                  <strong>{sheetStock.name}</strong>
                  <em>
                    기준 데이터 가격과 자동 연결되지 않는 재고입니다. <br />
                    실제 관리 가격을 직접 입력해 주세요.
                  </em>
                </div>
                <CmsField label="보험코드" value={sheetStock.insuranceCode} />
                <CmsField
                  label="현재 재고"
                  value={`${currency(sheetStock.quantity)}개`}
                />
                <label className="cms-input">
                  <span>약품 가격</span>
                  <input
                    min="0"
                    type="number"
                    value={priceDraft}
                    onChange={(event) =>
                      setPriceDraft(
                        Math.max(0, Number(event.target.value) || 0),
                      )
                    }
                  />
                </label>
                <div className="cms-after">
                  <span>입력 기준 재고 금액</span>
                  <strong>
                    {currency(sheetStock.quantity * Math.max(0, priceDraft))}원
                  </strong>
                </div>
                <button
                  className="cms-primary"
                  type="button"
                  onClick={saveVirtualPrice}
                >
                  가격 저장
                </button>
              </div>
            )}

            {sheetMode === "create" && (
              <form className="cms-sheet-body" onSubmit={submitCreateStock}>
                <div className="cms-input cms-stock-tag-field">
                  <span>재고 태그</span>
                  <div className="cms-segment">
                    <button
                      className={
                        createDraft.stockTag === "EXISTING" ? "is-active" : ""
                      }
                      type="button"
                      onClick={() =>
                        setCreateDraft((current) => ({
                          ...current,
                          stockTag: "EXISTING",
                        }))
                      }
                    >
                      실제 약품
                    </button>
                    <button
                      className={
                        createDraft.stockTag === "VIRTUAL" ? "is-active" : ""
                      }
                      type="button"
                      onClick={() =>
                        setCreateDraft((current) => ({
                          ...current,
                          stockTag: "VIRTUAL",
                        }))
                      }
                    >
                      임의 재고
                    </button>
                  </div>
                </div>
                <label className="cms-input">
                  <span>약품명</span>
                  <input
                    value={createDraft.name}
                    onChange={(event) =>
                      setCreateDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="cms-input">
                  <span>보험코드</span>
                  <input
                    value={createDraft.insuranceCode}
                    onChange={(event) =>
                      setCreateDraft((current) => ({
                        ...current,
                        insuranceCode: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="cms-field-grid">
                  <label className="cms-input">
                    <span>가격</span>
                    <input
                      min="0"
                      type="number"
                      value={createDraft.price}
                      onChange={(event) =>
                        setCreateDraft((current) => ({
                          ...current,
                          price: Math.max(0, Number(event.target.value) || 0),
                        }))
                      }
                    />
                  </label>
                  <label className="cms-input">
                    <span>초기 재고</span>
                    <input
                      min="0"
                      type="number"
                      value={createDraft.quantity}
                      onChange={(event) =>
                        setCreateDraft((current) => ({
                          ...current,
                          quantity: Math.max(
                            0,
                            Number(event.target.value) || 0,
                          ),
                        }))
                      }
                    />
                  </label>
                </div>
                <label className="cms-input">
                  <span>제품총수량</span>
                  <input
                    min="0"
                    type="number"
                    value={createDraft.productTotalQuantity}
                    onChange={(event) =>
                      setCreateDraft((current) => ({
                        ...current,
                        productTotalQuantity: Math.max(
                          0,
                          Number(event.target.value) || 0,
                        ),
                      }))
                    }
                  />
                </label>
                <label className="cms-input">
                  <span>메모</span>
                  <input
                    value={createDraft.memo}
                    onChange={(event) =>
                      setCreateDraft((current) => ({
                        ...current,
                        memo: event.target.value,
                      }))
                    }
                  />
                </label>
                <button
                  className="cms-primary"
                  disabled={!canCreateStock}
                  type="submit"
                >
                  생성 저장
                </button>
              </form>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

function CmsInventoryShortagePage({
  detail,
  detailLoading,
  detailMode,
  records,
  selectedRecord,
  onBack,
  onOpenDetail,
  onSelect,
  onShortageStatus,
}: {
  detail: CmsShortageDetail | null;
  detailLoading: boolean;
  detailMode: boolean;
  records: CmsDeductionRecord[];
  selectedRecord?: CmsDeductionRecord;
  onBack: () => void;
  onOpenDetail: (record: CmsDeductionRecord) => void;
  onSelect: (record: CmsDeductionRecord) => void;
  onShortageStatus: (
    record: CmsDeductionRecord,
    shortageStatus: CmsShortageStatus,
  ) => void;
}) {
  const [listFilter, setListFilter] = useState<CmsShortageListFilter>("OPEN");
  const orderNeededRecords = records.filter((record) =>
    isOpenShortageStatus(record.shortageStatus),
  );
  const totalShortageQuantity = records.reduce(
    (sum, record) => sum + record.shortageQuantity,
    0,
  );
  const orderedRecords = records.filter(
    (record) => record.shortageStatus === "ORDERED",
  );
  const holdRecords = records.filter((record) =>
    isHoldShortageStatus(record.shortageStatus),
  );
  const visibleRecords =
    listFilter === "HOLD"
      ? holdRecords
      : listFilter === "ORDERED"
        ? orderedRecords
        : orderNeededRecords;
  const recordPagination = usePagination(
    visibleRecords,
    CMS_PAGE_SIZES.shortages,
    `${listFilter}-${visibleRecords.length}`,
  );
  const activeDetail =
    detail?.deduction.id === selectedRecord?.id ? detail : null;
  const activeRecord = activeDetail?.deduction ?? selectedRecord;
  const shortageFilterItems: Array<{
    count: number;
    label: string;
    value: CmsShortageListFilter;
  }> = [
    { count: orderNeededRecords.length, label: "주문 필요", value: "OPEN" },
    { count: orderedRecords.length, label: "주문 완료", value: "ORDERED" },
    { count: holdRecords.length, label: "보류", value: "HOLD" },
  ];
  const emptyMessage =
    listFilter === "HOLD"
      ? "보류된 초과 처방 내역이 없습니다."
      : listFilter === "ORDERED"
        ? "주문 완료된 초과 처방 내역이 없습니다."
        : "주문 필요한 초과 처방 내역이 없습니다.";

  function selectListFilter(nextFilter: CmsShortageListFilter) {
    setListFilter(nextFilter);
    onBack();
  }

  return (
    <section className="cms-content cms-list-page cms-shortage-page">
      {detailMode && (
        <button
          className="cms-detail-back-button"
          type="button"
          onClick={onBack}
        >
          목록으로 돌아가기
        </button>
      )}
      {/* <div className="cms-shortage-header">
        {detailMode && (
          <button type="button" onClick={onBack}>
            초과 처방 목록
          </button>
        )}
        <div>
          <strong>초과 처방 약품</strong>
          <span>재고를 0까지 차감한 뒤 남은 부족 수량을 관리합니다.</span>
        </div>
      </div> */}

      {!detailMode && (
        <>
          <div className="cms-kpis compact4">
            <CmsKpi
              label="주문 필요"
              value={`${orderNeededRecords.length}`}
              unit="건"
              tone="red"
            />
            <CmsKpi
              label="주문 완료"
              value={`${orderedRecords.length}`}
              unit="건"
              tone="blue"
            />
            <CmsKpi label="보류" value={`${holdRecords.length}`} unit="건" />
            <CmsKpi
              label="부족 수량"
              value={currency(totalShortageQuantity)}
              unit="개"
              tone="red"
            />
          </div>

          <div className="cms-shortage-filter" role="tablist">
            {shortageFilterItems.map((item) => (
              <button
                className={listFilter === item.value ? "is-active" : ""}
                key={item.value}
                type="button"
                onClick={() => selectListFilter(item.value)}
              >
                <span>{item.label}</span>
                <b>{item.count}건</b>
              </button>
            ))}
          </div>
        </>
      )}

      <div className={`cms-shortage-layout ${detailMode ? "is-detail" : ""}`}>
        {!detailMode && (
          <div className="cms-table-card">
            <div className="cms-table-scroll">
              <div className="cms-shortage-table">
                <div className="cms-shortage-row cms-th">
                  <span>처방일시</span>
                  <span>약품</span>
                  <span>처방전</span>
                  <span>차감</span>
                  <span>부족</span>
                  <span>상태</span>
                  <span>상세</span>
                </div>
                {recordPagination.items.map((record) => (
                  <div
                    className={`cms-shortage-row ${
                      selectedRecord?.id === record.id ? "is-selected" : ""
                    }`}
                    key={record.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(record)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(record);
                      }
                    }}
                  >
                    <span>{record.createdAt}</span>
                    <strong>
                      {record.drugName}
                      <em>{record.insuranceCode}</em>
                    </strong>
                    <span>{record.prescriptionCode}</span>
                    <b>
                      {record.deductedQuantity}/{record.totalQuantity}
                    </b>
                    <b className="is-shortage">{record.shortageQuantity}개</b>
                    <span className="cms-badge missing">
                      {shortageStatusText(record.shortageStatus)}
                    </span>
                    <button
                      className="cms-shortage-open-detail"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(record);
                        onOpenDetail(record);
                      }}
                    >
                      상세 보기
                    </button>
                  </div>
                ))}
                {visibleRecords.length === 0 && (
                  <p className="cms-empty table-empty">{emptyMessage}</p>
                )}
              </div>
            </div>
            <CmsPagination {...recordPagination} />
          </div>
        )}

        {(detailMode || activeRecord) && (
          <>
            {!detailMode && (
              <button
                aria-label="상세 닫기"
                className="cms-side-sheet-backdrop"
                type="button"
                onClick={onBack}
              />
            )}
            <aside className="cms-shortage-detail-card">
          {!activeRecord ? (
            <p className="cms-empty">선택된 초과 처방 항목이 없습니다.</p>
          ) : (
            <>
              <div className="cms-shortage-detail-head">
                {!detailMode && (
                  <button
                    className="cms-sheet-close-inline"
                    type="button"
                    onClick={onBack}
                  >
                    닫기
                  </button>
                )}
                <span className="cms-badge missing">
                  {shortageStatusText(activeRecord.shortageStatus)}
                </span>
                <strong>{activeRecord.drugName}</strong>
                <em>
                  {activeRecord.createdAt} · {activeRecord.prescriptionCode}
                </em>
              </div>
              <div className="cms-prescription-paper">
                <div className="cms-prescription-paper-head">
                  <div>
                    <span>처방전</span>
                    <strong>{activeRecord.prescriptionCode}</strong>
                  </div>
                  <b>{activeRecord.lineNo}번 항목</b>
                </div>
                <div className="cms-prescription-paper-meta">
                  <span>
                    처방일시
                    <b>{activeDetail?.capturedAt ?? activeRecord.createdAt}</b>
                  </span>
                  <span>
                    보험코드
                    <b>{activeRecord.insuranceCode}</b>
                  </span>
                </div>
                <div className="cms-prescription-quantity-strip">
                  <div>
                    <span>처방 수량</span>
                    <strong>{activeRecord.totalQuantity}개</strong>
                  </div>
                  <div>
                    <span>실제 차감</span>
                    <strong>{activeRecord.deductedQuantity}개</strong>
                  </div>
                  <div className="is-shortage">
                    <span>부족 수량</span>
                    <strong>{activeRecord.shortageQuantity}개</strong>
                  </div>
                  <div>
                    <span>화면상 재고</span>
                    <strong>
                      {activeRecord.displayAfter ??
                        -activeRecord.shortageQuantity}
                      개
                    </strong>
                  </div>
                </div>
              </div>
              <div className="cms-shortage-actions">
                <button
                  className={
                    activeRecord.shortageStatus === "OPEN" ||
                    !activeRecord.shortageStatus
                      ? "is-active"
                      : ""
                  }
                  type="button"
                  onClick={() => onShortageStatus(activeRecord, "OPEN")}
                >
                  주문 필요
                </button>
                <button
                  className={
                    activeRecord.shortageStatus === "ORDERED" ? "is-active" : ""
                  }
                  type="button"
                  onClick={() => onShortageStatus(activeRecord, "ORDERED")}
                >
                  주문 완료
                </button>
                <button
                  className={
                    isHoldShortageStatus(activeRecord.shortageStatus)
                      ? "is-active"
                      : ""
                  }
                  type="button"
                  onClick={() => onShortageStatus(activeRecord, "HOLD")}
                >
                  보류
                </button>
              </div>
              <div className="cms-divider" />
              <div className="cms-prescription-full-paper">
                <div className="cms-prescription-summary">
                  <strong>전체 처방 내용</strong>
                  <span>
                    {detailLoading
                      ? "상세 불러오는 중"
                      : `${activeDetail?.drugCount ?? activeDetail?.drugs.length ?? 1}개 약품`}
                  </span>
                </div>
                <div className="cms-prescription-line-list">
                  {(activeDetail?.drugs ?? []).map((drug, index) => {
                    const isTarget = drug.lineNo === activeRecord.lineNo;

                    return (
                      <div
                        className={isTarget ? "is-target" : ""}
                        key={`${drug.lineNo}-${drug.insuranceCode}-${drug.drugName}`}
                      >
                        <div className="cms-prescription-line-index">
                          <span>처방 품목</span>
                          <strong>{String(index + 1).padStart(2, "0")}</strong>
                        </div>
                        <div className="cms-prescription-line-main">
                          <strong>{drug.drugName}</strong>
                          <span>{drug.insuranceCode || "보험코드 없음"}</span>
                        </div>
                        <div className="cms-prescription-line-qty">
                          <span>수량</span>
                          <b>{drug.totalQuantity}개</b>
                        </div>
                        {isTarget && <em>초과 처방</em>}
                      </div>
                    );
                  })}
                  {!detailLoading &&
                    (activeDetail?.drugs.length ?? 0) === 0 && (
                      <p className="cms-empty">처방전 품목 정보가 없습니다.</p>
                    )}
                </div>
              </div>
            </>
          )}
            </aside>
          </>
        )}
      </div>
    </section>
  );
}

function CmsReturnReviewPage({
  detailMode,
  records,
  selectedRecord,
  stocks,
  onBack,
  onOpenDetail,
  onResolve,
  onSelect,
  onStatus,
}: {
  detailMode: boolean;
  records: CmsReturnReview[];
  selectedRecord?: CmsReturnReview;
  stocks: StockItem[];
  onBack: () => void;
  onOpenDetail: (record: CmsReturnReview) => void;
  onResolve: (
    record: CmsReturnReview,
    stockId: string,
    returnQuantity: number,
    memo: string,
  ) => void;
  onSelect: (record: CmsReturnReview) => void;
  onStatus: (record: CmsReturnReview, status: CmsReturnReviewStatus) => void;
}) {
  const [listFilter, setListFilter] = useState<CmsReturnReviewFilter>("OPEN");
  const [resolveStockId, setResolveStockId] = useState("");
  const [resolveQuantity, setResolveQuantity] = useState(1);
  const [resolveMemo, setResolveMemo] = useState("관리자 반품 확인 처리");
  const [stockSearchOpen, setStockSearchOpen] = useState(false);
  const [otherStockQuery, setOtherStockQuery] = useState("");
  const [confirmAction, setConfirmAction] = useState<"HOLD" | "RESOLVE" | "">(
    "",
  );
  const openRecords = records.filter((record) => record.status === "OPEN");
  const holdRecords = records.filter((record) => record.status === "HOLD");
  const resolvedRecords = records.filter(
    (record) => record.status === "RESOLVED",
  );
  const visibleRecords =
    listFilter === "HOLD"
      ? holdRecords
      : listFilter === "RESOLVED"
        ? resolvedRecords
        : openRecords;
  const recordPagination = usePagination(
    visibleRecords,
    CMS_PAGE_SIZES.shortages,
    `${listFilter}-${visibleRecords.length}`,
  );
  const activeRecord = selectedRecord;
  const expectedWholesalers = returnReviewWholesalerCandidates(
    activeRecord?.sellerCandidateSummary ?? "",
  );
  const selectedStock = stocks.find((stock) => stock.id === resolveStockId);
  const maxQuantity = Math.max(0, selectedStock?.quantity ?? 0);
  const stockAfterReturn = selectedStock
    ? Math.max(0, maxQuantity - resolveQuantity)
    : 0;
  const canResolve =
    Boolean(activeRecord) &&
    activeRecord?.status !== "RESOLVED" &&
    Boolean(selectedStock) &&
    resolveQuantity > 0 &&
    resolveQuantity <= maxQuantity;
  const canHold =
    Boolean(activeRecord) &&
    activeRecord?.status !== "RESOLVED" &&
    activeRecord?.status !== "HOLD";
  const activeDrugKeyword = normalizeSearchText(activeRecord?.drugName ?? "");
  const recommendedStocks = stocks
    .filter((stock) => stock.quantity > 0)
    .map((stock) => {
      const exactCode =
        Boolean(activeRecord?.insuranceCode) &&
        stock.insuranceCode === activeRecord?.insuranceCode;
      const nameMatched =
        activeDrugKeyword.length >= 2 &&
        normalizeSearchText(`${stock.name} ${stock.insuranceCode}`).includes(
          activeDrugKeyword,
        );
      return { exactCode, nameMatched, stock };
    })
    .filter((item) => item.exactCode || item.nameMatched)
    .sort((left, right) => Number(right.exactCode) - Number(left.exactCode))
    .map((item) => item.stock)
    .slice(0, 6);
  const recommendedStockIds = new Set(
    recommendedStocks.map((stock) => stock.id),
  );
  const otherStockKeyword = normalizeSearchText(otherStockQuery);
  const otherStockCandidates =
    stockSearchOpen && otherStockKeyword.length >= 2
      ? stocks
          .filter(
            (stock) =>
              stock.quantity > 0 &&
              !recommendedStockIds.has(stock.id) &&
              normalizeSearchText(
                `${stock.name} ${stock.insuranceCode}`,
              ).includes(otherStockKeyword),
          )
          .slice(0, 10)
      : [];
  const filterItems: Array<{
    count: number;
    label: string;
    value: CmsReturnReviewFilter;
  }> = [
    { count: openRecords.length, label: "확인 필요", value: "OPEN" },
    { count: holdRecords.length, label: "보류", value: "HOLD" },
    { count: resolvedRecords.length, label: "처리 완료", value: "RESOLVED" },
  ];
  const emptyMessage =
    listFilter === "HOLD"
      ? "보류된 반품 확인 항목이 없습니다."
      : listFilter === "RESOLVED"
        ? "처리 완료된 반품 확인 항목이 없습니다."
        : "확인 필요한 반품 항목이 없습니다.";

  useEffect(() => {
    if (!activeRecord) return;
    const normalizedDrugName = normalizeSearchText(activeRecord.drugName ?? "");
    const matchedStock =
      (activeRecord.insuranceCode
        ? stocks.find(
            (stock) =>
              stock.quantity > 0 &&
              stock.insuranceCode === activeRecord.insuranceCode,
          )
        : undefined) ??
      (normalizedDrugName.length >= 2
        ? stocks.find(
            (stock) =>
              stock.quantity > 0 &&
              normalizeSearchText(
                `${stock.name} ${stock.insuranceCode}`,
              ).includes(normalizedDrugName),
          )
        : undefined);
    setResolveStockId(matchedStock?.id ?? "");
    setResolveQuantity(Math.max(1, activeRecord.requestedQuantity || 1));
    setResolveMemo("관리자 반품 확인 처리");
    setConfirmAction("");
    setStockSearchOpen(false);
    setOtherStockQuery("");
  }, [
    activeRecord?.id,
    activeRecord?.drugName,
    activeRecord?.insuranceCode,
    activeRecord?.requestedQuantity,
    stocks,
  ]);

  function selectListFilter(nextFilter: CmsReturnReviewFilter) {
    setListFilter(nextFilter);
    onBack();
  }

  function openOtherStockSearch() {
    const defaultQuery =
      activeRecord?.drugName || activeRecord?.insuranceCode || "";
    setOtherStockQuery(defaultQuery);
    setStockSearchOpen(true);
  }

  function selectReturnStock(stock: StockItem) {
    setResolveStockId(stock.id);
    setResolveQuantity((current) =>
      Math.min(Math.max(1, current), Math.max(1, stock.quantity)),
    );
  }

  function confirmReturnAction() {
    if (!activeRecord) return;
    if (confirmAction === "HOLD") {
      onStatus(activeRecord, "HOLD");
      setConfirmAction("");
      return;
    }
    if (confirmAction === "RESOLVE" && selectedStock && canResolve) {
      onResolve(activeRecord, selectedStock.id, resolveQuantity, resolveMemo);
      setConfirmAction("");
    }
  }

  return (
    <section className="cms-content cms-list-page cms-shortage-page">
      {detailMode && (
        <button
          className="cms-detail-back-button"
          type="button"
          onClick={onBack}
        >
          목록으로 돌아가기
        </button>
      )}
      {/* <div className="cms-shortage-header">
        {detailMode && (
          <button type="button" onClick={onBack}>
            반품 확인 목록
          </button>
        )}
        <div>
          <strong>반품 확인</strong>
          <span>
            앱에서 입고 이력으로 확정되지 않은 반품을 관리자 페이지에서 재고
            선택 후 처리합니다.
          </span>
        </div>
      </div> */}

      {!detailMode && (
        <>
          <div className="cms-kpis compact3">
            <CmsKpi
              label="확인 필요"
              value={`${openRecords.length}`}
              unit="건"
              tone="red"
            />
            <CmsKpi label="보류" value={`${holdRecords.length}`} unit="건" />
            <CmsKpi
              label="처리 완료"
              value={`${resolvedRecords.length}`}
              unit="건"
              tone="blue"
            />
          </div>

          <div className="cms-shortage-filter" role="tablist">
            {filterItems.map((item) => (
              <button
                className={listFilter === item.value ? "is-active" : ""}
                key={item.value}
                type="button"
                onClick={() => selectListFilter(item.value)}
              >
                <span>{item.label}</span>
                <b>{item.count}건</b>
              </button>
            ))}
          </div>
        </>
      )}

      <div className={`cms-shortage-layout ${detailMode ? "is-detail" : ""}`}>
        {!detailMode && (
          <div className="cms-table-card">
            <div className="cms-table-scroll">
              <div className="cms-shortage-table">
                <div className="cms-shortage-row cms-return-review-row cms-th">
                  <span>스캔일시</span>
                  <span>약품</span>
                  <span>PC/SN</span>
                  <span>후보</span>
                  <span>상태</span>
                  <span>상세</span>
                </div>
                {recordPagination.items.map((record) => (
                  <div
                    className={`cms-shortage-row cms-return-review-row ${
                      selectedRecord?.id === record.id ? "is-selected" : ""
                    }`}
                    key={record.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(record)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(record);
                      }
                    }}
                  >
                    <span>{record.createdAt}</span>
                    <strong>
                      {record.drugName}
                      <em>{record.insuranceCode || "보험코드 없음"}</em>
                    </strong>
                    <span>
                      {record.pc}
                      <em>{record.sn || "SN 없음"}</em>
                    </span>
                    <b>{record.sellerCandidateCount}건</b>
                    <span className="cms-badge missing">
                      {returnReviewStatusText(record.status)}
                    </span>
                    <button
                      className="cms-shortage-open-detail"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(record);
                        onOpenDetail(record);
                      }}
                    >
                      상세 보기
                    </button>
                  </div>
                ))}
                {visibleRecords.length === 0 && (
                  <p className="cms-empty table-empty">{emptyMessage}</p>
                )}
              </div>
            </div>
            <CmsPagination {...recordPagination} />
          </div>
        )}

        {(detailMode || activeRecord) && (
          <>
            {!detailMode && (
              <button
                aria-label="상세 닫기"
                className="cms-side-sheet-backdrop"
                type="button"
                onClick={onBack}
              />
            )}
            <aside className="cms-shortage-detail-card">
          {!activeRecord ? (
            <p className="cms-empty">선택된 반품 확인 항목이 없습니다.</p>
          ) : (
            <>
              <div className="cms-shortage-detail-head">
                {!detailMode && (
                  <button
                    className="cms-sheet-close-inline"
                    type="button"
                    onClick={onBack}
                  >
                    닫기
                  </button>
                )}
                <span className="cms-badge missing">
                  {returnReviewStatusText(activeRecord.status)}
                </span>
                <strong>{activeRecord.drugName}</strong>
                <em>{activeRecord.createdAt}</em>
              </div>
              <div className="cms-prescription-paper">
                <div className="cms-prescription-paper-head">
                  <div>
                    <span>스캔 코드</span>
                    <strong>{activeRecord.pc}</strong>
                  </div>
                  <b>{activeRecord.sn || "SN 없음"}</b>
                </div>
                <div className="cms-prescription-paper-meta">
                  <span>
                    보험코드
                    <b>{activeRecord.insuranceCode || "없음"}</b>
                  </span>
                  <span>
                    LOT / EXP
                    <b>
                      {activeRecord.lot || "LOT 없음"} ·{" "}
                      {activeRecord.exp || "EXP 없음"}
                    </b>
                  </span>
                </div>
                {/* <div className="cms-prescription-quantity-strip">
                  <div>
                    <span>앱 판단</span>
                    <strong>
                      {activeRecord.matchType === "ESTIMATED"
                        ? "구매 후보"
                        : "후보 없음"}
                    </strong>
                  </div>
                  <div>
                    <span>후보 수</span>
                    <strong>{activeRecord.sellerCandidateCount}건</strong>
                  </div>
                  <div>
                    <span>요청 수량</span>
                    <strong>
                      {activeRecord.requestedQuantity > 0
                        ? `${activeRecord.requestedQuantity}개`
                        : "-"}
                    </strong>
                  </div>
                </div> */}
              </div>

              {expectedWholesalers.length > 0 && (
                <div className="cms-prescription-full-paper cms-expected-wholesalers">
                  <div className="cms-prescription-summary">
                    <strong>예상 도매처</strong>
                    <span>{expectedWholesalers.length}곳</span>
                  </div>
                  <div className="cms-wholesaler-card-strip">
                    {expectedWholesalers.map((wholesaler) => (
                      <span className="cms-wholesaler-card" key={wholesaler}>
                        {wholesaler}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {activeRecord.status === "RESOLVED" ? (
                <div className="cms-prescription-paper">
                  <div className="cms-prescription-paper-head">
                    <div>
                      <span>처리 재고</span>
                      <strong>{activeRecord.stockName ?? "-"}</strong>
                    </div>
                    <b>{activeRecord.returnQuantity}개 반품</b>
                  </div>
                  <div className="cms-prescription-paper-meta">
                    <span>
                      처리 전<b>{activeRecord.stockBefore ?? 0}개</b>
                    </span>
                    <span>
                      처리 후<b>{activeRecord.stockAfter ?? 0}개</b>
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="cms-detail-section">
                    <strong>재고 감소 처리</strong>
                    <div className="cms-stock-candidate-picker cms-return-stock-picker">
                      <div className="cms-candidate-hint">
                        <strong>추천 재고</strong>
                        <span>보험코드와 약품명 기준으로 먼저 좁혔습니다.</span>
                      </div>
                      <div className="cms-stock-candidate-list">
                        {recommendedStocks.map((stock) => {
                          const exactCode =
                            Boolean(activeRecord.insuranceCode) &&
                            stock.insuranceCode === activeRecord.insuranceCode;
                          return (
                            <button
                              className={`cms-stock-candidate ${
                                resolveStockId === stock.id ? "is-selected" : ""
                              }`}
                              key={stock.id}
                              type="button"
                              onClick={() => {
                                selectReturnStock(stock);
                              }}
                            >
                              <span>
                                {exactCode ? "보험코드 일치" : "이름 후보"}
                              </span>
                              <strong>{stock.name}</strong>
                              <em>{stock.insuranceCode}</em>
                              <b>{stock.quantity}개</b>
                            </button>
                          );
                        })}
                        {recommendedStocks.length === 0 && (
                          <p className="cms-empty">추천 재고가 없습니다.</p>
                        )}
                        <button
                          className="cms-stock-candidate is-other"
                          type="button"
                          onClick={openOtherStockSearch}
                        >
                          <span>그 외</span>
                          <strong>다른 재고에서 찾기</strong>
                          <em>약품명 또는 보험코드로 검색</em>
                          <b>검색</b>
                        </button>
                      </div>

                      {selectedStock && (
                        <div className="cms-candidate-hint">
                          <strong>선택 재고</strong>
                          <span>
                            {selectedStock.name} · {selectedStock.quantity}개
                          </span>
                        </div>
                      )}
                    </div>
                    <label className="cms-field">
                      <span>반품 수량</span>
                      <input
                        min={1}
                        max={Math.max(1, maxQuantity)}
                        type="number"
                        value={resolveQuantity}
                        onChange={(event) =>
                          setResolveQuantity(
                            Math.max(
                              1,
                              Math.min(
                                Math.max(1, maxQuantity),
                                Number(event.target.value) || 1,
                              ),
                            ),
                          )
                        }
                      />
                    </label>
                  </div>
                  <div className="cms-return-action-panel">
                    <div className="cms-return-status-note">
                      <span>현재 상태</span>
                      <strong>
                        {returnReviewStatusText(activeRecord.status)}
                      </strong>
                    </div>
                    <div className="cms-return-action-buttons">
                      <button
                        className="cms-return-action-button is-hold"
                        disabled={!canHold}
                        type="button"
                        onClick={() => setConfirmAction("HOLD")}
                      >
                        보류 처리
                      </button>
                      <button
                        className="cms-return-action-button is-primary"
                        disabled={!canResolve}
                        type="button"
                        onClick={() => setConfirmAction("RESOLVE")}
                      >
                        선택 재고 감소 처리
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
            </aside>
          </>
        )}
      </div>

      {stockSearchOpen && activeRecord && (
        <CmsModal
          title="다른 재고 찾기"
          subtitle={activeRecord.drugName}
          onClose={() => setStockSearchOpen(false)}
        >
          <div className="cms-return-stock-search-modal">
            <label className="cms-input">
              <span>약품명 또는 보험코드</span>
              <input
                autoFocus
                value={otherStockQuery}
                onChange={(event) => setOtherStockQuery(event.target.value)}
                placeholder="2글자 이상 입력"
              />
            </label>
            <div className="cms-candidate-hint">
              <strong>검색 후보</strong>
              <span>선택하면 상세 화면의 선택 재고에만 반영됩니다.</span>
            </div>
            <div className="cms-stock-candidate-list">
              {otherStockCandidates.map((stock) => (
                <button
                  className={`cms-stock-candidate ${
                    resolveStockId === stock.id ? "is-selected" : ""
                  }`}
                  key={stock.id}
                  type="button"
                  onClick={() => {
                    selectReturnStock(stock);
                    setStockSearchOpen(false);
                  }}
                >
                  <span>검색 후보</span>
                  <strong>{stock.name}</strong>
                  <em>{stock.insuranceCode || "-"}</em>
                  <b>{stock.quantity}개</b>
                </button>
              ))}
              {otherStockKeyword.length < 2 ? (
                <p className="cms-empty">검색어를 2글자 이상 입력해 주세요.</p>
              ) : otherStockCandidates.length === 0 ? (
                <p className="cms-empty">검색된 재고 후보가 없습니다.</p>
              ) : null}
            </div>
          </div>
        </CmsModal>
      )}

      {confirmAction && activeRecord && (
        <CmsModal
          title={
            confirmAction === "HOLD" ? "보류 처리 확인" : "재고 감소 처리 확인"
          }
          subtitle={activeRecord.drugName}
          variant="confirm"
          onClose={() => setConfirmAction("")}
        >
          <div className="cms-resolution-confirm">
            <div
              className={`cms-resolution-confirm-card ${
                confirmAction === "HOLD" ? "is-warning" : "is-stock"
              }`}
            >
              {confirmAction === "HOLD" ? (
                <>
                  <span>이 반품 확인 항목을 보류로 이동합니다.</span>
                  <strong>{activeRecord.drugName}</strong>
                  <em>보류 항목은 보류 탭에서 다시 확인할 수 있습니다.</em>
                </>
              ) : selectedStock ? (
                <>
                  <span>아래 재고에서 반품 수량을 감소 처리합니다.</span>
                  <strong>{selectedStock.name}</strong>
                  <em>
                    현재 {currency(maxQuantity)}개 → 처리 후{" "}
                    {currency(stockAfterReturn)}개
                  </em>
                  <em>감소 수량: {currency(resolveQuantity)}개</em>
                </>
              ) : (
                <>
                  <span>선택된 재고가 없습니다.</span>
                  <strong>재고 선택 필요</strong>
                  <em>먼저 감소 처리할 재고를 선택해 주세요.</em>
                </>
              )}
            </div>
            <p>
              {confirmAction === "HOLD"
                ? "확인 시 재고 수량은 변경되지 않고 상태만 보류로 변경됩니다."
                : "확인 시 선택한 재고 수량이 감소되고 이 항목은 처리 완료 상태가 됩니다."}
            </p>
            <div className="cms-confirm-actions">
              <button
                className="cms-confirm-button"
                type="button"
                onClick={() => setConfirmAction("")}
              >
                취소
              </button>
              <button
                className={`cms-confirm-button ${
                  confirmAction === "HOLD" ? "is-danger" : "is-primary"
                }`}
                disabled={confirmAction === "HOLD" ? !canHold : !canResolve}
                type="button"
                onClick={confirmReturnAction}
              >
                {confirmAction === "HOLD" ? "보류 처리" : "감소 처리"}
              </button>
            </div>
          </div>
        </CmsModal>
      )}
    </section>
  );
}

function CmsWholesalerPage({
  editingName,
  newName,
  query,
  searchStatus,
  selectedWholesaler,
  wholesalers,
  onCreate,
  onEditingName,
  onNewName,
  onQuery,
  onSave,
  onSearch,
  onSelect,
}: {
  editingName: string;
  newName: string;
  query: string;
  searchStatus: "idle" | "short" | "loading" | "done" | "error";
  selectedWholesaler?: Wholesaler;
  wholesalers: Wholesaler[];
  onCreate: () => void | Promise<void>;
  onEditingName: (value: string) => void;
  onNewName: (value: string) => void;
  onQuery: (value: string) => void;
  onSave: () => void | Promise<void>;
  onSearch: (keyword: string) => void;
  onSelect: (id: string) => void;
}) {
  const [sheetMode, setSheetMode] = useState<"create" | "edit" | null>(null);
  const normalizedQuery = normalizeSearchText(query);
  const canSearch = normalizedQuery.length >= 2;

  useEffect(() => {
    if (!canSearch) {
      onSearch(query);
      return;
    }

    const timer = window.setTimeout(() => {
      onSearch(query);
    }, 250);

    return () => window.clearTimeout(timer);
  }, [canSearch, onSearch, query]);

  const wholesalerPagination = usePagination(
    wholesalers,
    CMS_PAGE_SIZES.wholesaler,
    normalizedQuery,
  );

  useEffect(() => {
    if (sheetMode === "edit" && !selectedWholesaler) setSheetMode(null);
  }, [selectedWholesaler, sheetMode]);

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    await onCreate();
    setSheetMode(null);
  }

  async function submitEdit(event: FormEvent) {
    event.preventDefault();
    await onSave();
    setSheetMode(null);
  }

  return (
    <section className="cms-content cms-list-page cms-wholesaler-page">
      <div className="cms-table-card">
        <div className="cms-toolbar">
          <div className="cms-pills">
            <span>검색 결과 {wholesalers.length}</span>
            <span>{canSearch ? "keyword 적용" : "2글자 이상 필요"}</span>
          </div>
          <label className="cms-search">
            <span className="search-icon" />
            <input
              placeholder="도매처명 검색"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
            />
          </label>
          <button
            className="cms-primary cms-toolbar-action"
            type="button"
            onClick={() => {
              onNewName("");
              setSheetMode("create");
            }}
          >
            새 도매처
          </button>
        </div>
        <div className="cms-table-scroll">
          <div className="cms-table wholesaler">
            <div className="cms-tr cms-th">
              <span>도매처명</span>
              <span>구분</span>
              <span>ID</span>
            </div>
            {searchStatus === "loading" && (
              <p className="cms-empty table-empty">검색 중입니다.</p>
            )}
            {searchStatus !== "loading" &&
              wholesalerPagination.items.map((wholesaler) => (
                <button
                  key={wholesaler.id}
                  className={`cms-tr ${selectedWholesaler?.id === wholesaler.id ? "is-selected" : ""}`}
                  type="button"
                  onClick={() => {
                    onSelect(wholesaler.id);
                    setSheetMode("edit");
                  }}
                >
                  <strong>{wholesaler.name}</strong>
                  <span>{wholesaler.meta}</span>
                  <span>{wholesaler.id}</span>
                </button>
              ))}
            {!canSearch && (
              <p className="cms-empty table-empty">
                도매처명을 2글자 이상 입력하면 검색을 실행합니다.
              </p>
            )}
            {canSearch &&
              searchStatus !== "loading" &&
              wholesalers.length === 0 && (
                <p className="cms-empty table-empty">검색 결과가 없습니다.</p>
              )}
          </div>
        </div>
        <CmsPagination {...wholesalerPagination} />
      </div>
      {sheetMode === "create" && (
        <CmsSheet
          title="도매처 등록"
          subtitle="약국별 도매처"
          onClose={() => setSheetMode(null)}
        >
          <form className="cms-sheet-body" onSubmit={submitCreate}>
            <label className="cms-input">
              <span>도매처명</span>
              <input
                value={newName}
                onChange={(event) => onNewName(event.target.value)}
              />
            </label>
            <button
              className="cms-primary"
              type="submit"
              disabled={!newName.trim()}
            >
              새 도매처 등록
            </button>
          </form>
        </CmsSheet>
      )}
      {sheetMode === "edit" && selectedWholesaler && (
        <CmsSheet
          title="도매처 수정"
          subtitle={selectedWholesaler.name}
          onClose={() => setSheetMode(null)}
        >
          <form className="cms-sheet-body" onSubmit={submitEdit}>
            <CmsField label="현재 구분" value={selectedWholesaler.meta} />
            <label className="cms-input">
              <span>도매처명</span>
              <input
                value={editingName}
                onChange={(event) => onEditingName(event.target.value)}
              />
            </label>
            <button
              className="cms-primary"
              type="submit"
              disabled={!editingName.trim()}
            >
              수정 저장
            </button>
          </form>
        </CmsSheet>
      )}
    </section>
  );
}

function CmsPrescriptionPage({
  filter,
  prescriptionId,
  records,
  selectedRecord,
  selectedStockId,
  onDeduct,
  onFilter,
  onPrescriptionId,
  onResolve,
  onSelectRecord,
  onSelectStock,
  onShortageStatus,
  stocks,
}: {
  filter: CmsDeductionFilter;
  prescriptionId: string;
  records: CmsDeductionRecord[];
  selectedRecord?: CmsDeductionRecord;
  selectedStockId: string;
  onDeduct: () => void;
  onFilter: (filter: CmsDeductionFilter) => void;
  onPrescriptionId: (value: string) => void;
  stocks: StockItem[];
  onResolve: (
    record: CmsDeductionRecord,
    resolutionType: CmsDeductionResolution,
  ) => void;
  onSelectRecord: (id: string) => void;
  onSelectStock: (id: string) => void;
  onShortageStatus: (
    record: CmsDeductionRecord,
    shortageStatus: CmsShortageStatus,
  ) => void;
}) {
  const visibleRecords =
    filter === "ALL"
      ? records
      : filter === "SHORTAGE_ITEMS"
        ? records.filter((record) => record.shortageQuantity > 0)
        : records.filter((record) => record.status === filter);
  const failedCount = records.filter(
    (record) => record.status === "FAILED",
  ).length;
  const resolvedCount = records.filter(
    (record) => record.status === "RESOLVED",
  ).length;
  const deductedCount = records.filter(
    (record) => record.status === "DEDUCTED",
  ).length;
  const shortageCount = records.filter(
    (record) => record.shortageQuantity > 0,
  ).length;
  const canResolve = selectedRecord?.status === "FAILED";
  const hasShortage = (selectedRecord?.shortageQuantity ?? 0) > 0;
  const filterItems: Array<[CmsDeductionFilter, string, number]> = [
    ["ALL", "전체", records.length],
    ["SHORTAGE_ITEMS", "초과 처방", shortageCount],
    ["FAILED", "실패", failedCount],
    ["RESOLVED", "수동 처리", resolvedCount],
    ["DEDUCTED", "자동 차감", deductedCount],
  ];
  const recordPagination = usePagination(
    visibleRecords,
    CMS_PAGE_SIZES.prescriptions,
    `${filter}|${records.length}`,
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [resolutionChoice, setResolutionChoice] = useState<
    CmsDeductionResolution | ""
  >("");
  const [resolutionConfirmOpen, setResolutionConfirmOpen] = useState(false);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidateSubmittedQuery, setCandidateSubmittedQuery] = useState("");
  const [candidateSearchKey, setCandidateSearchKey] = useState(0);
  const [candidateStocks, setCandidateStocks] = useState<StockItem[]>([]);
  const [candidateStatus, setCandidateStatus] = useState<
    "idle" | "short" | "loading" | "done" | "error"
  >("idle");
  const [candidateMessage, setCandidateMessage] = useState("");
  const selectedStockIdRef = useRef(selectedStockId);

  useEffect(() => {
    selectedStockIdRef.current = selectedStockId;
  }, [selectedStockId]);

  useEffect(() => {
    if (!selectedRecord) {
      setSheetOpen(false);
      setConnectionOpen(false);
      setResolutionChoice("");
      setResolutionConfirmOpen(false);
      setCandidateSubmittedQuery("");
    }
  }, [selectedRecord]);

  useEffect(() => {
    if (!connectionOpen || !selectedRecord) return;
    const defaultQuery = prescriptionCandidateDefaultQuery(selectedRecord);
    setCandidateQuery(defaultQuery);
    setCandidateSubmittedQuery(defaultQuery.trim());
    setCandidateSearchKey((key) => key + 1);
    setCandidateStocks([]);
    setCandidateStatus(canResolve ? "loading" : "idle");
    setCandidateMessage("");
    setResolutionChoice("");
    setResolutionConfirmOpen(false);
  }, [canResolve, connectionOpen, selectedRecord?.id]);

  useEffect(() => {
    if (!connectionOpen || !selectedRecord || !canResolve) {
      setCandidateStocks([]);
      setCandidateStatus("idle");
      setCandidateMessage("");
      return;
    }

    const queries = prescriptionCandidateQueries(
      selectedRecord,
      candidateSubmittedQuery,
    );
    if (queries.length === 0) {
      setCandidateStocks([]);
      setCandidateStatus("short");
      setCandidateMessage("약품명 또는 보험코드를 2글자 이상 입력해 주세요.");
      onSelectStock("");
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setCandidateStatus("loading");
        setCandidateMessage("추천 후보를 검색 중입니다.");
        try {
          const responses = await Promise.all(
            queries.map((keyword) => {
              const params = new URLSearchParams({ keyword });
              return apiFetch<unknown>(`/stocks?${params}`);
            }),
          );
          if (cancelled) return;

          const nextCandidates = mergeStockCandidates(
            responses.flatMap((response) =>
              arrayPayload(response).map(normalizeStock),
            ),
          )
            .sort(
              (a, b) =>
                stockCandidateScore(
                  b,
                  selectedRecord,
                  candidateSubmittedQuery,
                ) -
                stockCandidateScore(a, selectedRecord, candidateSubmittedQuery),
            )
            .slice(0, 8);

          setCandidateStocks(nextCandidates);
          setCandidateStatus("done");
          setCandidateMessage(
            nextCandidates.length > 0
              ? `${nextCandidates.length}건의 추천 후보를 찾았습니다.`
              : "일치하는 기존 재고가 없습니다.",
          );

          const currentStockId = selectedStockIdRef.current;
          if (!nextCandidates.some((stock) => stock.id === currentStockId)) {
            onSelectStock(nextCandidates[0]?.id ?? "");
          }
        } catch {
          if (cancelled) return;
          const fallbackCandidates = localStockCandidates(
            stocks,
            selectedRecord,
            candidateSubmittedQuery,
          )
            .sort(
              (a, b) =>
                stockCandidateScore(
                  b,
                  selectedRecord,
                  candidateSubmittedQuery,
                ) -
                stockCandidateScore(a, selectedRecord, candidateSubmittedQuery),
            )
            .slice(0, 8);

          setCandidateStocks(fallbackCandidates);
          setCandidateStatus("error");
          setCandidateMessage(
            "검색 연결 실패로 현재 재고 목록에서만 찾았습니다.",
          );

          const currentStockId = selectedStockIdRef.current;
          if (
            !fallbackCandidates.some((stock) => stock.id === currentStockId)
          ) {
            onSelectStock(fallbackCandidates[0]?.id ?? "");
          }
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    candidateSearchKey,
    candidateSubmittedQuery,
    canResolve,
    connectionOpen,
    onSelectStock,
    selectedRecord,
    stocks,
  ]);

  const selectedStock =
    candidateStocks.find((stock) => stock.id === selectedStockId) ??
    stocks.find((stock) => stock.id === selectedStockId);
  const selectedStockQuantity = finiteNumber(selectedStock?.quantity);
  const selectedPrescriptionQuantity = finiteNumber(
    selectedRecord?.totalQuantity,
  );
  const stockAfterExisting =
    selectedRecord && selectedStock
      ? Math.max(0, selectedStockQuantity - selectedPrescriptionQuantity)
      : undefined;
  const existingShortageQuantity =
    selectedRecord && selectedStock
      ? Math.max(0, selectedPrescriptionQuantity - selectedStockQuantity)
      : 0;
  const selectedDisplayAfterQuantity = selectedRecord
    ? finiteNumber(
        selectedRecord.displayAfter ?? -selectedRecord.shortageQuantity,
      )
    : 0;
  const selectedResultText = selectedRecord
    ? selectedRecord.resolutionType
      ? resolutionText(selectedRecord.resolutionType)
      : selectedRecord.stockName
        ? selectedRecord.stockName
        : selectedRecord.status === "DEDUCTED"
          ? "자동 차감"
          : "수동 처리 대기"
    : "";
  const virtualDrugNamePreview =
    selectedRecord?.drugName?.trim() || "미확인 약품";
  const virtualDrugNameNeedsReview =
    virtualDrugNamePreview === "미확인 약품" ||
    virtualDrugNamePreview === "-" ||
    normalizeInsuranceCode(virtualDrugNamePreview) ===
      normalizeInsuranceCode(selectedRecord?.insuranceCode);
  const canConfirmResolutionChoice =
    resolutionChoice === "EXISTING_STOCK"
      ? Boolean(selectedStock)
      : Boolean(resolutionChoice);
  const candidateSearchPending =
    normalizeSearchText(candidateQuery) !==
    normalizeSearchText(candidateSubmittedQuery);
  const candidateHintTitle = candidateSearchPending
    ? "입력 중"
    : candidateStatus === "loading"
      ? "검색 중"
      : candidateStatus === "done"
        ? "추천 후보"
        : candidateStatus === "error"
          ? "현재 목록 기준"
          : "검색 대기";
  const candidateHintMessage = candidateSearchPending
    ? "Enter를 누르거나 검색 버튼을 눌러 후보를 갱신하세요."
    : candidateMessage;
  const submitCandidateSearch = (nextQuery = candidateQuery) => {
    setCandidateSubmittedQuery(nextQuery.trim());
    setCandidateSearchKey((key) => key + 1);
  };
  const resolutionChoiceText =
    resolutionChoice === "EXISTING_STOCK"
      ? "선택한 재고에서 차감"
      : resolutionChoice === "VIRTUAL_DRUG"
        ? "임의 약품으로 처리"
        : resolutionChoice === "UNREGISTERED_DRUG"
          ? "재고 반영 없이 완료"
          : "처리 방식을 선택하세요";
  const resolutionChoiceDescription =
    resolutionChoice === "EXISTING_STOCK"
      ? selectedStock
        ? `${selectedStock.name} 재고에서 처방 수량을 차감합니다.`
        : "기존 재고를 먼저 선택하세요."
      : resolutionChoice === "VIRTUAL_DRUG"
        ? `${virtualDrugNamePreview} 이름의 임의 재고를 생성합니다.`
        : resolutionChoice === "UNREGISTERED_DRUG"
          ? "재고 수량을 변경하지 않고 해당 처방만 완료 처리합니다."
          : "카드를 선택해도 바로 처리되지 않습니다.";
  const resolutionConfirmTitle =
    resolutionChoice === "EXISTING_STOCK"
      ? "선택한 재고 차감 확인"
      : resolutionChoice === "VIRTUAL_DRUG"
        ? "임의 약품 생성 확인"
        : "재고 반영 없이 완료 확인";
  const resolutionConfirmCardClass =
    resolutionChoice === "EXISTING_STOCK"
      ? existingShortageQuantity === 0
        ? "is-stock"
        : "is-warning"
      : resolutionChoice === "VIRTUAL_DRUG"
        ? virtualDrugNameNeedsReview
          ? "is-warning"
          : "is-virtual"
        : "is-warning";

  useEffect(() => {
    if (resolutionChoice === "EXISTING_STOCK" && !selectedStock) {
      setResolutionChoice("");
      setResolutionConfirmOpen(false);
    }
  }, [resolutionChoice, selectedStock]);

  return (
    <section className="cms-content cms-list-page cms-prescription-page">
      {/* <div className="cms-prescription-command">
        <div>
          <strong>처방전 분석 결과 차감</strong>
          <span>
            처방전 분석 결과의 약명과 보유 재고명을 매칭해 재고를
            차감합니다.
          </span>
        </div>
        <label className="cms-input inline">
          <span>처방전 ID</span>
          <input
            placeholder="prescriptionId"
            value={prescriptionId}
            onChange={(event) => onPrescriptionId(event.target.value)}
          />
        </label>
        <button
          className="cms-primary"
          type="button"
          disabled={!prescriptionId.trim()}
          onClick={onDeduct}
        >
          차감 실행
        </button>
      </div> */}

      <div className="cms-kpis compact4 prescription-kpis">
        <CmsKpi label="차감 기록" value={`${records.length}`} unit="건" />
        <CmsKpi
          label="자동 차감"
          value={`${deductedCount}`}
          unit="건"
          tone="blue"
        />
        <CmsKpi
          label="초과 처방"
          value={`${shortageCount}`}
          unit="건"
          tone="red"
        />
        <CmsKpi
          label="수동 필요"
          value={`${failedCount}`}
          unit="건"
          tone="red"
        />
      </div>

      <div className="cms-table-card prescription-table-card">
        <div className="cms-toolbar">
          <div className="cms-pills prescription-filters">
            {filterItems.map(([value, label, count]) => (
              <button
                className={filter === value ? "is-active" : ""}
                key={value}
                type="button"
                onClick={() => onFilter(value)}
              >
                {label}
                <b>{count}</b>
              </button>
            ))}
          </div>
        </div>
        <div className="cms-table-scroll">
          <div className="cms-deduction-table">
            <div className="cms-deduction-row cms-th">
              <span>처방전</span>
              <span>약품</span>
              <span>보험코드</span>
              <span>요청</span>
              <span>결과</span>
              <span>상태</span>
            </div>
            {recordPagination.items.map((record) => (
              <button
                className={`cms-deduction-row ${
                  selectedRecord?.id === record.id ? "is-selected" : ""
                }`}
                key={record.id}
                type="button"
                onClick={() => {
                  onSelectRecord(record.id);
                  setSheetOpen(true);
                }}
              >
                <span>
                  {record.prescriptionCode}
                  <em>line {record.lineNo}</em>
                </span>
                <strong>
                  {record.drugName}
                  <em>{record.reason}</em>
                </strong>
                <span className="mono">{record.insuranceCode}</span>
                <b>{record.totalQuantity}개</b>
                <b className={record.shortageQuantity > 0 ? "is-shortage" : ""}>
                  -{record.deductedQuantity}개
                  {record.shortageQuantity > 0 && (
                    <em>부족 {record.shortageQuantity}개</em>
                  )}
                </b>
                <span
                  className={`cms-badge ${deductionStatusClass(record.status)}`}
                >
                  {deductionStatusText(record.status)}
                </span>
              </button>
            ))}
            {visibleRecords.length === 0 && (
              <p className="cms-empty table-empty">
                표시할 처방전 차감 기록이 없습니다.
              </p>
            )}
          </div>
        </div>
        <CmsPagination {...recordPagination} />
      </div>

      {sheetOpen && selectedRecord && (
        <CmsSheet
          title={selectedRecord.drugName}
          subtitle={deductionStatusText(selectedRecord.status)}
          onClose={() => {
            setSheetOpen(false);
            setConnectionOpen(false);
            setResolutionChoice("");
            setResolutionConfirmOpen(false);
          }}
        >
          <div className="cms-sheet-body cms-deduction-detail">
            <div className="cms-detail-summary">
              <span
                className={`cms-badge ${deductionStatusClass(selectedRecord.status)}`}
              >
                {deductionStatusText(selectedRecord.status)}
              </span>
              <div>
                <strong>처방 차감 상세</strong>
                <span>
                  {selectedRecord.prescriptionCode} · line{" "}
                  {selectedRecord.lineNo}
                </span>
              </div>
            </div>

            <section className="cms-detail-section">
              <header>
                <strong>처방 차감 요약</strong>
                <span>처방 수량과 실제 재고 반영 결과입니다.</span>
              </header>
              <div className="cms-readonly-grid is-summary">
                <CmsReadonlyItem
                  label="처방 수량"
                  value={`${currency(selectedRecord.totalQuantity)}개`}
                />
                <CmsReadonlyItem
                  label="실제 차감"
                  tone="blue"
                  value={`${currency(selectedRecord.deductedQuantity)}개`}
                />
                <CmsReadonlyItem
                  label="부족 수량"
                  tone={hasShortage ? "red" : undefined}
                  value={`${currency(selectedRecord.shortageQuantity)}개`}
                />
                {hasShortage && (
                  <CmsReadonlyItem
                    label="초과 처방 상태"
                    tone="red"
                    value={`${shortageStatusText(selectedRecord.shortageStatus)} · 화면상 ${currency(selectedDisplayAfterQuantity)}개`}
                  />
                )}
              </div>
            </section>

            {hasShortage && (
              <section className="cms-detail-section is-status-action">
                <header>
                  <strong>초과 처방 상태 변경</strong>
                  <span>
                    주문 진행 상태만 바꾸며 실제 재고 수량은 변경하지 않습니다.
                  </span>
                </header>
                <div className="cms-shortage-actions">
                  <button
                    className={
                      selectedRecord.shortageStatus === "OPEN" ||
                      !selectedRecord.shortageStatus
                        ? "is-active"
                        : ""
                    }
                    type="button"
                    onClick={() => onShortageStatus(selectedRecord, "OPEN")}
                  >
                    주문 필요
                  </button>
                  <button
                    className={
                      selectedRecord.shortageStatus === "ORDERED"
                        ? "is-active"
                        : ""
                    }
                    type="button"
                    onClick={() => onShortageStatus(selectedRecord, "ORDERED")}
                  >
                    주문 완료
                  </button>
                  <button
                    className={
                      isHoldShortageStatus(selectedRecord.shortageStatus)
                        ? "is-active"
                        : ""
                    }
                    type="button"
                    onClick={() => onShortageStatus(selectedRecord, "HOLD")}
                  >
                    보류
                  </button>
                </div>
              </section>
            )}

            <section className="cms-detail-section">
              <header>
                <strong>처방 정보</strong>
                <span>처방전과 차감 처리 기준입니다.</span>
              </header>
              <div className="cms-readonly-grid">
                <CmsReadonlyItem
                  label="처방전"
                  value={selectedRecord.prescriptionCode}
                />
                <CmsReadonlyItem
                  label="라인"
                  value={`${selectedRecord.lineNo}`}
                />
                <CmsReadonlyItem
                  label="보험코드"
                  mono
                  value={selectedRecord.insuranceCode}
                />
                <CmsReadonlyItem label="처리 결과" value={selectedResultText} />
                {selectedRecord.stockBefore !== undefined && (
                  <CmsReadonlyItem
                    label="차감 전 재고"
                    value={`${currency(selectedRecord.stockBefore)}개`}
                  />
                )}
                {selectedRecord.stockAfter !== undefined && (
                  <CmsReadonlyItem
                    label="실제 차감 후 재고"
                    value={`${currency(selectedRecord.stockAfter)}개`}
                  />
                )}
                <CmsReadonlyItem
                  label="처리 사유"
                  value={selectedRecord.reason}
                  wide
                />
              </div>
            </section>

            {canResolve && (
              <section className="cms-detail-section is-action">
                <header>
                  <strong>재고 연결</strong>
                  <span>
                    기존 재고 검색과 처리 방식 선택은 별도 화면에서 진행합니다.
                  </span>
                </header>
                <div className="cms-connect-summary-card">
                  <span>검색 기준</span>
                  <strong>
                    {prescriptionCandidateDefaultQuery(selectedRecord)}
                  </strong>
                </div>
                <button
                  className="cms-connect-open"
                  type="button"
                  onClick={() => setConnectionOpen(true)}
                >
                  재고 검색하기
                </button>
              </section>
            )}
          </div>
        </CmsSheet>
      )}

      {connectionOpen && selectedRecord && canResolve && (
        <CmsModal
          title="재고 검색"
          subtitle={selectedRecord.drugName}
          onClose={() => {
            setConnectionOpen(false);
            setResolutionChoice("");
            setResolutionConfirmOpen(false);
          }}
        >
          <div className="cms-connect-modal">
            <section className="cms-connect-section">
              <header>
                <strong>기존 재고 찾기</strong>
                <span>약품명 또는 보험코드로 연결할 재고를 검색합니다.</span>
              </header>
              <div className="cms-stock-candidate-picker">
                <div className="cms-candidate-search-row">
                  <label className="cms-input">
                    <span>재고 검색</span>
                    <input
                      value={candidateQuery}
                      onChange={(event) =>
                        setCandidateQuery(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          submitCandidateSearch();
                        }
                      }}
                      placeholder="약품명 또는 보험코드 검색"
                    />
                  </label>
                  <button
                    className="cms-primary"
                    type="button"
                    onClick={() => submitCandidateSearch()}
                  >
                    검색
                  </button>
                  <button
                    className="cms-secondary"
                    type="button"
                    onClick={() => {
                      const defaultQuery =
                        prescriptionCandidateDefaultQuery(selectedRecord);
                      setCandidateQuery(defaultQuery);
                      submitCandidateSearch(defaultQuery);
                    }}
                  >
                    처방전 기준
                  </button>
                </div>
                <div className="cms-candidate-hint">
                  <strong>{candidateHintTitle}</strong>
                  <span>{candidateHintMessage}</span>
                </div>
                <div className="cms-stock-candidate-list">
                  {candidateStocks.map((stock) => (
                    <button
                      className={`cms-stock-candidate ${
                        stock.id === selectedStockId ? "is-selected" : ""
                      }`}
                      key={stock.id}
                      type="button"
                      onClick={() => onSelectStock(stock.id)}
                    >
                      <span>{stockCandidateLabel(stock, selectedRecord)}</span>
                      <strong>{stock.name}</strong>
                      <em>{stock.insuranceCode || "-"}</em>
                      <b>보유 {currency(stock.quantity)}개</b>
                    </button>
                  ))}
                  {candidateStatus !== "loading" &&
                    candidateStocks.length === 0 && (
                      <p className="cms-empty">
                        검색어와 연결할 기존 재고가 없습니다.
                      </p>
                    )}
                </div>
              </div>
            </section>

            <section className="cms-connect-section">
              <header>
                <strong>처리 방식 선택</strong>
                <span>선택한 방식으로 차감 실패 항목을 정리합니다.</span>
              </header>
              {selectedStock && (
                <div className="cms-after cms-connect-impact">
                  <span>처리 후 재고</span>
                  <strong>
                    {currency(selectedStockQuantity)} →{" "}
                    {currency(stockAfterExisting ?? 0)}개
                  </strong>
                  {existingShortageQuantity > 0 && (
                    <em>
                      초과 처방으로 {currency(existingShortageQuantity)}개
                      넘어갑니다.
                    </em>
                  )}
                </div>
              )}
              <div className="cms-connect-action-list">
                <button
                  className={`cms-connect-action ${
                    resolutionChoice === "EXISTING_STOCK" ? "is-selected" : ""
                  }`}
                  type="button"
                  disabled={!selectedStock}
                  aria-pressed={resolutionChoice === "EXISTING_STOCK"}
                  onClick={() => setResolutionChoice("EXISTING_STOCK")}
                >
                  <strong>선택한 재고에서 차감</strong>
                  <span>
                    {selectedStock
                      ? `${selectedStock.name} 재고를 사용합니다.`
                      : "먼저 기존 재고를 선택하세요."}
                  </span>
                </button>
                <button
                  className={`cms-connect-action ${
                    resolutionChoice === "VIRTUAL_DRUG" ? "is-selected" : ""
                  }`}
                  type="button"
                  aria-pressed={resolutionChoice === "VIRTUAL_DRUG"}
                  onClick={() => setResolutionChoice("VIRTUAL_DRUG")}
                >
                  <strong>임의 약품으로 처리</strong>
                  <span>생성명: {virtualDrugNamePreview}</span>
                  {virtualDrugNameNeedsReview && (
                    <em>
                      약명이 부족해 생성 후 재고 관리에서 이름 보정이
                      필요합니다.
                    </em>
                  )}
                </button>
                <button
                  className={`cms-connect-action ${
                    resolutionChoice === "UNREGISTERED_DRUG"
                      ? "is-selected"
                      : ""
                  }`}
                  type="button"
                  aria-pressed={resolutionChoice === "UNREGISTERED_DRUG"}
                  onClick={() => setResolutionChoice("UNREGISTERED_DRUG")}
                >
                  <strong>재고 반영 없이 완료</strong>
                  <span>
                    재고 감소 없이 해당 처방의 실패 상태만 완료 처리합니다.
                  </span>
                </button>
              </div>
              <div className="cms-connect-confirm-bar">
                <button
                  className="cms-primary"
                  type="button"
                  disabled={!canConfirmResolutionChoice}
                  onClick={() => setResolutionConfirmOpen(true)}
                >
                  선택 내용 확인
                </button>
              </div>
            </section>
          </div>
        </CmsModal>
      )}

      {resolutionConfirmOpen &&
        selectedRecord &&
        canResolve &&
        resolutionChoice && (
          <CmsModal
            title={resolutionConfirmTitle}
            subtitle={selectedRecord.drugName}
            variant="confirm"
            onClose={() => setResolutionConfirmOpen(false)}
          >
            <div className="cms-resolution-confirm">
              <div
                className={`cms-resolution-confirm-card ${resolutionConfirmCardClass}`}
              >
                {resolutionChoice === "EXISTING_STOCK" && selectedStock ? (
                  <>
                    <span>아래 재고에서 처방 수량을 차감합니다.</span>
                    <strong>{selectedStock.name}</strong>
                    <em>
                      현재 {currency(selectedStockQuantity)}개 → 처리 후{" "}
                      {currency(stockAfterExisting ?? 0)}개
                    </em>
                    {existingShortageQuantity > 0 && (
                      <em className="is-danger-text">
                        초과 처방으로 {currency(existingShortageQuantity)}개
                        넘어갑니다.
                      </em>
                    )}
                  </>
                ) : resolutionChoice === "VIRTUAL_DRUG" ? (
                  <>
                    <span>아래 이름으로 임의 약품이 생성됩니다.</span>
                    <strong>{virtualDrugNamePreview}</strong>
                    {virtualDrugNameNeedsReview && (
                      <em className="is-danger-text">
                        약명이 부족해 생성 후 재고 관리에서 이름 보정이
                        필요합니다.
                      </em>
                    )}
                  </>
                ) : (
                  <>
                    <span>재고 감소 없이 완료 처리합니다.</span>
                    <strong>재고 반영 없이 완료</strong>
                    <em>
                      해당 처방은 처리 완료로 변경되지만 재고 수량은 변경되지
                      않습니다.
                    </em>
                  </>
                )}
              </div>
              <p>
                {resolutionChoice === "EXISTING_STOCK"
                  ? "확인 시 선택한 재고 기준으로 차감 실패 항목이 처리됩니다."
                  : resolutionChoice === "VIRTUAL_DRUG"
                    ? "기존 재고와 연결하지 않고 새 임의 재고로 처리합니다."
                    : ""}
              </p>
              <div className="cms-confirm-actions">
                <button
                  className="cms-confirm-button"
                  type="button"
                  onClick={() => setResolutionConfirmOpen(false)}
                >
                  취소
                </button>
                <button
                  className={`cms-confirm-button ${
                    resolutionChoice === "EXISTING_STOCK"
                      ? "is-primary"
                      : "is-danger"
                  }`}
                  type="button"
                  onClick={() => {
                    const nextResolution = resolutionChoice;
                    if (!nextResolution) return;
                    if (nextResolution === "EXISTING_STOCK" && !selectedStock) {
                      return;
                    }
                    onResolve(selectedRecord, nextResolution);
                    setResolutionChoice("");
                    setResolutionConfirmOpen(false);
                    setConnectionOpen(false);
                    setSheetOpen(false);
                  }}
                >
                  {resolutionChoice === "EXISTING_STOCK"
                    ? "차감 처리"
                    : resolutionChoice === "VIRTUAL_DRUG"
                      ? "생성 처리"
                      : "완료 처리"}
                </button>
              </div>
            </div>
          </CmsModal>
        )}
    </section>
  );
}

function CmsPurchasePage({
  cookieDraft,
  cookieState,
  histories,
  syncEndDate,
  onCookieDraftChange,
  onRegisterCookie,
  onResume,
  onSync,
  onSyncEndDate,
  onSyncStartDate,
  syncJobs,
  syncStartDate,
}: {
  cookieDraft: BaropharmCookieDraft;
  cookieState: CmsCookieState;
  histories: CmsPurchaseHistory[];
  syncEndDate: string;
  syncJobs: CmsSyncJob[];
  syncStartDate: string;
  onCookieDraftChange: (value: BaropharmCookieDraft) => void;
  onRegisterCookie: () => void;
  onResume: (jobId: string) => void;
  onSync: () => void;
  onSyncEndDate: (value: string) => void;
  onSyncStartDate: (value: string) => void;
}) {
  const cookiePreview = buildBaropharmCookie(cookieDraft);
  const canRegisterCookie = Boolean(cookiePreview);
  const syncJobPagination = usePagination(
    syncJobs,
    CMS_PAGE_SIZES.syncJobs,
    `${syncJobs.length}`,
  );
  const historyPagination = usePagination(
    histories,
    CMS_PAGE_SIZES.purchaseHistories,
    `${histories.length}`,
  );

  return (
    <section className="cms-content cms-list-page cms-purchase-page">
      <div className="cms-grid two purchase-top">
        <CmsPanel title="구매내역 연결 정보">
          <div
            className={`cms-cookie-state ${
              cookieState.status === "AUTH_FAILED" ? "warning" : ""
            }`}
          >
            <strong>
              {cookieState.registered ? "등록됨" : "미등록"} ·{" "}
              {purchaseConnectionStatusText(cookieState.status)}
            </strong>
            <span>{cookieState.message}</span>
            {cookieState.maskedCookie && (
              <em>인증 정보가 저장되어 있습니다.</em>
            )}
          </div>
          <div className="cms-cookie-token-grid">
            <label className="cms-input">
              <span>sessionid</span>
              <input
                autoComplete="off"
                placeholder="sessionid 값만 입력"
                value={cookieDraft.sessionId}
                onChange={(event) =>
                  onCookieDraftChange({
                    ...cookieDraft,
                    sessionId: event.target.value,
                  })
                }
              />
            </label>
            <label className="cms-input">
              <span>csrftoken</span>
              <input
                autoComplete="off"
                placeholder="csrftoken 값만 입력"
                value={cookieDraft.csrfToken}
                onChange={(event) =>
                  onCookieDraftChange({
                    ...cookieDraft,
                    csrfToken: event.target.value,
                  })
                }
              />
            </label>
          </div>
          <button
            className="cms-primary"
            style={{ width: "100%" }}
            type="button"
            disabled={!canRegisterCookie}
            onClick={onRegisterCookie}
          >
            연결 정보 저장
          </button>
        </CmsPanel>
        <CmsPanel
          title="주문내역 불러오기"
          action="불러오기 시작"
          onAction={onSync}
        >
          <div className="cms-field-grid">
            <label className="cms-input">
              <span>시작일</span>
              <input
                type="date"
                value={syncStartDate}
                onChange={(event) => onSyncStartDate(event.target.value)}
              />
            </label>
            <label className="cms-input">
              <span>종료일</span>
              <input
                type="date"
                value={syncEndDate}
                onChange={(event) => onSyncEndDate(event.target.value)}
              />
            </label>
          </div>
          <p className="cms-empty">
            선택한 기간의 구매 내역을 한 번에 불러옵니다.
          </p>
        </CmsPanel>
      </div>
      <div className="cms-grid two cms-scroll-grid">
        <CmsPanel
          title="구매내역 불러오기 기록"
          bodyClassName="cms-panel-body cms-panel-scroll"
          footer={<CmsPagination {...syncJobPagination} />}
        >
          {syncJobPagination.items.map((job) => (
            <div className="cms-sync-card" key={job.id}>
              <div>
                <strong>{syncStatusText(job.status)}</strong>
                <span>
                  {job.startDate} ~ {job.endDate}
                </span>
              </div>
              <b>
                {job.lastSuccessPage}/{job.totalPages} 단계
              </b>
              <p>{job.message}</p>
              {(job.status === "AUTH_FAILED" ||
                job.status === "PARTIAL_AUTH_FAILED") && (
                <button type="button" onClick={() => onResume(job.id)}>
                  연결 정보 확인 후 재개
                </button>
              )}
            </div>
          ))}
          {syncJobs.length === 0 && (
            <p className="cms-empty">표시할 불러오기 기록이 없습니다.</p>
          )}
        </CmsPanel>
        <CmsPanel
          title="구매 내역"
          bodyClassName="cms-panel-body cms-panel-scroll"
          footer={<CmsPagination {...historyPagination} />}
        >
          <div className="cms-list cms-list-scroll">
            {historyPagination.items.map((history) => (
              <div className="cms-list-row" key={history.id}>
                <div>
                  <strong>{history.orderItemName}</strong>
                  <span>
                    {history.sellerName} · {history.transactionAt} ·{" "}
                    {history.source}
                  </span>
                </div>
                <b>{history.quantity}개</b>
              </div>
            ))}
            {histories.length === 0 && (
              <p className="cms-empty">표시할 구매 내역이 없습니다.</p>
            )}
          </div>
        </CmsPanel>
      </div>
    </section>
  );
}

function CmsKpi({
  detail,
  label,
  tone,
  unit,
  value,
}: {
  detail?: string;
  label: string;
  tone?: "blue" | "red";
  unit?: string;
  value: string;
}) {
  const fullValue = detail ?? `${value}${unit ?? ""}`;
  return (
    <div className={`cms-kpi ${detail ? "has-detail" : ""}`} title={fullValue}>
      <span>{label}</span>
      <strong className={tone ?? ""}>
        {value}
        {unit && <em>{unit}</em>}
      </strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function CmsPanel({
  action,
  bodyClassName,
  children,
  footer,
  onAction,
  title,
}: {
  action?: string;
  bodyClassName?: string;
  children: ReactNode;
  footer?: ReactNode;
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
      <div className={bodyClassName ?? "cms-panel-body"}>{children}</div>
      {footer}
    </section>
  );
}

const CMS_PAGE_SIZES = {
  importJobs: 6,
  inventory: 14,
  master: 14,
  prescriptions: 12,
  purchaseHistories: 8,
  shortages: 10,
  syncJobs: 6,
  wholesaler: 12,
} as const;

function usePagination<T>(items: T[], pageSize: number, resetKey: string) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const pagedItems = useMemo(
    () => items.slice(start, end),
    [end, items, start],
  );

  const handlePageChange = useCallback(
    (nextPage: number) => {
      setPage(Math.max(1, Math.min(nextPage, totalPages)));
    },
    [totalPages],
  );

  return {
    endIndex: Math.min(totalItems, end),
    items: pagedItems,
    page: currentPage,
    setPage: handlePageChange,
    startIndex: totalItems === 0 ? 0 : start + 1,
    totalItems,
    totalPages,
  };
}

function CmsSheet({
  children,
  onClose,
  subtitle,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  subtitle?: string;
  title: string;
}) {
  return (
    <div
      className="cms-sheet-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside aria-modal="true" className="cms-sheet" role="dialog">
        <header className="cms-sheet-header">
          <div>
            <strong>{title}</strong>
            {subtitle && <span>{subtitle}</span>}
          </div>
          <button
            aria-label="닫기"
            className="cms-sheet-close"
            type="button"
            onClick={onClose}
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}

function CmsModal({
  children,
  onClose,
  subtitle,
  title,
  variant = "default",
}: {
  children: ReactNode;
  onClose: () => void;
  subtitle?: string;
  title: string;
  variant?: "default" | "confirm";
}) {
  const modalClassName =
    variant === "confirm" ? "cms-modal is-confirm" : "cms-modal";
  return (
    <div
      className="cms-modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside aria-modal="true" className={modalClassName} role="dialog">
        <header className="cms-modal-header">
          <div>
            <strong>{title}</strong>
            {subtitle && <span>{subtitle}</span>}
          </div>
          <button
            aria-label="닫기"
            className="cms-sheet-close"
            type="button"
            onClick={onClose}
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </header>
        <div className="cms-modal-body">{children}</div>
      </aside>
    </div>
  );
}

function CmsPagination({
  endIndex,
  page,
  setPage,
  startIndex,
  totalItems,
  totalPages,
}: {
  endIndex: number;
  page: number;
  setPage: (page: number) => void;
  startIndex: number;
  totalItems: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="cms-pagination">
      <span className="cms-pagination-info">
        {startIndex}-{endIndex} / {totalItems}
      </span>
      <div className="cms-pagination-controls">
        <button
          className="is-ghost"
          type="button"
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          이전
        </button>
        {paginationWindow(page, totalPages).map((item, index) =>
          item === "ellipsis" ? (
            <span className="cms-pagination-ellipsis" key={`${item}-${index}`}>
              ...
            </span>
          ) : (
            <button
              className={page === item ? "is-active" : ""}
              key={item}
              type="button"
              onClick={() => setPage(item)}
            >
              {item}
            </button>
          ),
        )}
        <button
          className="is-ghost"
          type="button"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          다음
        </button>
      </div>
    </div>
  );
}

function paginationWindow(page: number, totalPages: number) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const windowStart = Math.max(2, page - 1);
  const windowEnd = Math.min(totalPages - 1, page + 1);
  const items: Array<number | "ellipsis"> = [1];

  if (windowStart > 2) {
    items.push("ellipsis");
  }

  for (let value = windowStart; value <= windowEnd; value += 1) {
    items.push(value);
  }

  if (windowEnd < totalPages - 1) {
    items.push("ellipsis");
  }

  items.push(totalPages);
  return items;
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

function CmsReadonlyItem({
  label,
  mono,
  tone,
  value,
  wide,
}: {
  label: string;
  mono?: boolean;
  tone?: "blue" | "red";
  value: string;
  wide?: boolean;
}) {
  return (
    <div
      className={`cms-readonly-item ${wide ? "is-wide" : ""} ${
        tone ? `tone-${tone}` : ""
      }`}
    >
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}

function CmsEditableField({
  label,
  mono,
  value,
  onChange,
}: {
  label: string;
  mono?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="cms-field">
      <span>{label}</span>
      <input
        className={mono ? "mono" : ""}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function shortCode(value: string) {
  if (!value) return "-";
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export default App;
