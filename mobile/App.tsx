import { useCallback, useEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from "expo-camera";
import {
  StatusBar,
  setStatusBarHidden,
  setStatusBarTranslucent,
} from "expo-status-bar";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

const webUrl =
  process.env.EXPO_PUBLIC_PHARMFARM_WEB_URL ?? "https://pharmfarm.vercel.app/";
const nativeScannerFrameSize = 248;
const nativeScannerFrameTopRatio = 0.45;
const nativeScannerFrameTolerance = 12;

type NativeScannerLayout = {
  height: number;
  width: number;
};

function normalizeScannerPoint(
  point: { x: number; y: number },
  layout: NativeScannerLayout,
) {
  return {
    x: point.x > 0 && point.x <= 1 ? point.x * layout.width : point.x,
    y: point.y > 0 && point.y <= 1 ? point.y * layout.height : point.y,
  };
}

function getNativeScannerFrame(layout: NativeScannerLayout) {
  const size = Math.min(nativeScannerFrameSize, layout.width * 0.72);
  const left = (layout.width - size) / 2;
  const top = layout.height * nativeScannerFrameTopRatio - size / 2;

  return {
    bottom: top + size,
    left,
    right: left + size,
    top,
  };
}

function isPointInsideFrame(
  point: { x: number; y: number },
  frame: ReturnType<typeof getNativeScannerFrame>,
) {
  return (
    point.x >= frame.left - nativeScannerFrameTolerance &&
    point.x <= frame.right + nativeScannerFrameTolerance &&
    point.y >= frame.top - nativeScannerFrameTolerance &&
    point.y <= frame.bottom + nativeScannerFrameTolerance
  );
}

function isNativeScanInsideFrame(
  result: BarcodeScanningResult,
  layout: NativeScannerLayout,
) {
  if (!layout.width || !layout.height) return true;

  const frame = getNativeScannerFrame(layout);
  const cornerPoints = result.cornerPoints
    ?.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => normalizeScannerPoint(point, layout));

  if (cornerPoints?.length) {
    return cornerPoints.every((point) => isPointInsideFrame(point, frame));
  }

  const bounds = result.bounds;
  if (
    bounds?.origin &&
    bounds.size &&
    bounds.size.width > 0 &&
    bounds.size.height > 0
  ) {
    const origin = normalizeScannerPoint(bounds.origin, layout);
    const size = {
      height:
        bounds.size.height > 0 && bounds.size.height <= 1
          ? bounds.size.height * layout.height
          : bounds.size.height,
      width:
        bounds.size.width > 0 && bounds.size.width <= 1
          ? bounds.size.width * layout.width
          : bounds.size.width,
    };
    const center = {
      x: origin.x + size.width / 2,
      y: origin.y + size.height / 2,
    };

    return isPointInsideFrame(center, frame);
  }

  return true;
}

export default function App() {
  const webViewRef = useRef<WebView>(null);
  const lastNativeScanRef = useRef({ value: "", at: 0 });
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [nativeScannerActive, setNativeScannerActive] = useState(false);
  const [nativeScannerPermissionBlocked, setNativeScannerPermissionBlocked] =
    useState(false);
  const [nativeScannerMessage, setNativeScannerMessage] =
    useState("QR을 사각형 안에 맞춰주세요.");
  const [nativeTorchOn, setNativeTorchOn] = useState(false);
  const [nativeScannerLayout, setNativeScannerLayout] =
    useState<NativeScannerLayout>({
      height: 0,
      width: 0,
    });

  useEffect(() => {
    setStatusBarHidden(true, "none");
    if (Platform.OS === "android") {
      setStatusBarTranslucent(true);
    }
  }, []);

  const sendMessageToWeb = useCallback((payload: unknown) => {
    const message = JSON.stringify(payload);
    const script = `
      window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} }));
      true;
    `;
    webViewRef.current?.injectJavaScript(script);
  }, []);

  const stopNativeScanner = useCallback(() => {
    setNativeScannerActive(false);
    setNativeScannerPermissionBlocked(false);
    setNativeTorchOn(false);
  }, []);

  const closeNativeScanner = useCallback(() => {
    stopNativeScanner();
    sendMessageToWeb({ type: "pharmfarm-native-scanner-closed" });
  }, [sendMessageToWeb, stopNativeScanner]);

  const startNativeScanner = useCallback(async () => {
    setNativeScannerActive(true);
    setNativeScannerMessage("QR을 사각형 안에 맞춰주세요.");

    if (cameraPermission?.granted) {
      setNativeScannerPermissionBlocked(false);
      return;
    }

    const nextPermission = await requestCameraPermission();
    setNativeScannerPermissionBlocked(!nextPermission.granted);
    if (!nextPermission.granted) {
      setNativeScannerMessage(
        "네이티브 리더를 사용하려면 카메라 권한이 필요합니다.",
      );
    }
  }, [cameraPermission?.granted, requestCameraPermission]);

  const sendNativeScanToWeb = useCallback(
    (value: string, barcodeType: string) => {
      sendMessageToWeb({
        barcodeType,
        type: "pharmfarm-native-scan-result",
        value,
      });
    },
    [sendMessageToWeb],
  );

  const handleNativeBarcodeScanned = useCallback(
    (result: BarcodeScanningResult) => {
      const value = result.data || result.raw || "";
      if (!value) return;

      if (!isNativeScanInsideFrame(result, nativeScannerLayout)) {
        setNativeScannerMessage("QR을 가이드 안쪽에 맞춰주세요.");
        return;
      }

      const now = Date.now();
      const lastScan = lastNativeScanRef.current;
      if (value === lastScan.value && now - lastScan.at < 1200) return;

      lastNativeScanRef.current = { value, at: now };
      setNativeScannerMessage("인식 완료 · 다음 QR을 스캔할 수 있습니다.");
      sendNativeScanToWeb(value, result.type);
    },
    [nativeScannerLayout, sendNativeScanToWeb],
  );

  const handleWebMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: unknown;

      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      if (!message || typeof message !== "object") return;
      const item = message as { action?: string; type?: string };
      if (item.type !== "pharmfarm-native-scanner") return;

      if (item.action === "start") {
        void startNativeScanner();
      } else if (item.action === "stop") {
        stopNativeScanner();
      }
    },
    [startNativeScanner, stopNativeScanner],
  );

  return (
    <View style={styles.appShell}>
      <StatusBar
        animated={false}
        backgroundColor="transparent"
        hidden
        hideTransitionAnimation="none"
        translucent
      />
      {loadError ? (
        <View style={styles.errorPanel}>
          <Text style={styles.errorTitle}>웹 앱 연결 실패</Text>
          <Text style={styles.errorText}>{loadError}</Text>
          <Text style={styles.urlText}>{webUrl}</Text>
          <TouchableOpacity
            activeOpacity={0.78}
            style={styles.retryButton}
            onPress={() => {
              setLoadError("");
              setReloadKey((value) => value + 1);
            }}
          >
            <Text style={styles.retryText}>다시 연결</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <WebView
          ref={webViewRef}
          key={reloadKey}
          allowsInlineMediaPlayback
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          domStorageEnabled
          javaScriptEnabled
          mediaCapturePermissionGrantType="grant"
          mediaPlaybackRequiresUserAction={false}
          originWhitelist={["http://*", "https://*"]}
          source={{ uri: webUrl }}
          style={styles.webview}
          onError={(event) => setLoadError(event.nativeEvent.description)}
          onHttpError={(event) =>
            setLoadError(`HTTP ${event.nativeEvent.statusCode}`)
          }
          onMessage={handleWebMessage}
        />
      )}
      {nativeScannerActive && (
        <View
          style={styles.nativeScannerLayer}
          onLayout={(event) => setNativeScannerLayout(event.nativeEvent.layout)}
        >
          {nativeScannerPermissionBlocked ? (
            <View style={styles.nativePermissionPanel}>
              <Text style={styles.nativePermissionTitle}>카메라 권한 필요</Text>
              <Text style={styles.nativePermissionText}>
                네이티브 QR 리더를 사용하려면 카메라 접근을 허용해야 합니다.
              </Text>
              <TouchableOpacity
                activeOpacity={0.78}
                style={styles.nativePrimaryButton}
                onPress={() => {
                  void startNativeScanner();
                }}
              >
                <Text style={styles.nativePrimaryText}>권한 다시 요청</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.78}
                style={styles.nativeSecondaryButton}
                onPress={closeNativeScanner}
              >
                <Text style={styles.nativeSecondaryText}>
                  웹 리더로 돌아가기
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <CameraView
                active={nativeScannerActive}
                animateShutter={false}
                autofocus="off"
                barcodeScannerSettings={{ barcodeTypes: ["datamatrix"] }}
                enableTorch={nativeTorchOn}
                facing="back"
                style={styles.nativeCamera}
                onBarcodeScanned={handleNativeBarcodeScanned}
                onMountError={(event) =>
                  setNativeScannerMessage(event.message || "카메라 실행 실패")
                }
              />
              <View style={styles.nativeScannerShade} pointerEvents="none" />
              <View style={styles.nativeScannerFrame} pointerEvents="none">
                <View
                  style={[styles.nativeCorner, styles.nativeCornerTopLeft]}
                />
                <View
                  style={[styles.nativeCorner, styles.nativeCornerTopRight]}
                />
                <View
                  style={[styles.nativeCorner, styles.nativeCornerBottomLeft]}
                />
                <View
                  style={[styles.nativeCorner, styles.nativeCornerBottomRight]}
                />
              </View>
              <View style={styles.nativeScannerTop}>
                <Pressable
                  style={styles.nativePillButton}
                  onPress={() => setNativeTorchOn((value) => !value)}
                >
                  <Text style={styles.nativePillText}>
                    {nativeTorchOn ? "플래시 끄기" : "플래시"}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.nativePillButton}
                  onPress={closeNativeScanner}
                >
                  <Text style={styles.nativePillText}>닫기</Text>
                </Pressable>
              </View>
              <View style={styles.nativeScannerBottom}>
                <Text style={styles.nativeScannerTitle}>네이티브 리더</Text>
                <Text style={styles.nativeScannerText}>
                  {nativeScannerMessage}
                </Text>
              </View>
              <View style={styles.nativeAndroidIcon} pointerEvents="none">
                <View style={styles.androidAntennaLeft} />
                <View style={styles.androidAntennaRight} />
                <View style={styles.androidHead}>
                  <View style={styles.androidEyeLeft} />
                  <View style={styles.androidEyeRight} />
                </View>
                <View style={styles.androidBody} />
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  appShell: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  webview: {
    flex: 1,
  },
  nativeCamera: {
    ...StyleSheet.absoluteFillObject,
  },
  nativeCorner: {
    borderColor: "#4D9AFF",
    height: 42,
    position: "absolute",
    width: 42,
  },
  nativeCornerBottomLeft: {
    borderBottomLeftRadius: 16,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    bottom: 0,
    left: 0,
  },
  nativeCornerBottomRight: {
    borderBottomRightRadius: 16,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    bottom: 0,
    right: 0,
  },
  nativeCornerTopLeft: {
    borderLeftWidth: 4,
    borderTopLeftRadius: 16,
    borderTopWidth: 4,
    left: 0,
    top: 0,
  },
  nativeCornerTopRight: {
    borderRightWidth: 4,
    borderTopRightRadius: 16,
    borderTopWidth: 4,
    right: 0,
    top: 0,
  },
  nativePermissionPanel: {
    backgroundColor: "#ffffff",
    borderRadius: 18,
    margin: 24,
    padding: 22,
  },
  nativePermissionText: {
    color: "#5A646D",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 21,
    marginTop: 10,
  },
  nativePermissionTitle: {
    color: "#14181B",
    fontSize: 20,
    fontWeight: "900",
  },
  nativePillButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderColor: "rgba(255,255,255,0.22)",
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 40,
    paddingHorizontal: 14,
    justifyContent: "center",
  },
  nativePillText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "900",
  },
  nativeAndroidIcon: {
    alignItems: "center",
    bottom: 18,
    height: 36,
    justifyContent: "flex-end",
    opacity: 0.92,
    position: "absolute",
    right: 18,
    width: 36,
    zIndex: 4,
  },
  androidAntennaLeft: {
    backgroundColor: "#7EDB75",
    borderRadius: 2,
    height: 9,
    left: 10,
    position: "absolute",
    top: 1,
    transform: [{ rotate: "-32deg" }],
    width: 2,
  },
  androidAntennaRight: {
    backgroundColor: "#7EDB75",
    borderRadius: 2,
    height: 9,
    position: "absolute",
    right: 10,
    top: 1,
    transform: [{ rotate: "32deg" }],
    width: 2,
  },
  androidBody: {
    backgroundColor: "#7EDB75",
    borderBottomLeftRadius: 5,
    borderBottomRightRadius: 5,
    height: 15,
    width: 24,
  },
  androidEyeLeft: {
    backgroundColor: "#0C0E0F",
    borderRadius: 2,
    height: 3,
    left: 7,
    position: "absolute",
    top: 8,
    width: 3,
  },
  androidEyeRight: {
    backgroundColor: "#0C0E0F",
    borderRadius: 2,
    height: 3,
    position: "absolute",
    right: 7,
    top: 8,
    width: 3,
  },
  androidHead: {
    backgroundColor: "#7EDB75",
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    height: 15,
    position: "relative",
    width: 24,
  },
  nativePrimaryButton: {
    alignItems: "center",
    backgroundColor: "#0064FF",
    borderRadius: 14,
    height: 50,
    justifyContent: "center",
    marginTop: 20,
  },
  nativePrimaryText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "900",
  },
  nativeScannerBottom: {
    alignItems: "center",
    bottom: 58,
    left: 24,
    position: "absolute",
    right: 24,
  },
  nativeScannerFrame: {
    height: nativeScannerFrameSize,
    left: "50%",
    marginLeft: -(nativeScannerFrameSize / 2),
    marginTop: -(nativeScannerFrameSize / 2),
    position: "absolute",
    top: `${nativeScannerFrameTopRatio * 100}%`,
    width: nativeScannerFrameSize,
  },
  nativeScannerLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    backgroundColor: "#0C0E0F",
    justifyContent: "center",
    zIndex: 20,
  },
  nativeScannerShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  nativeScannerText: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 19,
    marginTop: 6,
    textAlign: "center",
  },
  nativeScannerTitle: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "900",
  },
  nativeScannerTop: {
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    left: 18,
    position: "absolute",
    right: 18,
    top: 18,
  },
  nativeSecondaryButton: {
    alignItems: "center",
    backgroundColor: "#EEF1F2",
    borderRadius: 14,
    height: 48,
    justifyContent: "center",
    marginTop: 10,
  },
  nativeSecondaryText: {
    color: "#48515A",
    fontSize: 14,
    fontWeight: "900",
  },
  errorPanel: {
    flex: 1,
    justifyContent: "center",
    padding: 22,
  },
  errorTitle: {
    color: "#C13B2C",
    fontSize: 20,
    fontWeight: "900",
  },
  errorText: {
    color: "#48515A",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 21,
    marginTop: 10,
  },
  urlText: {
    color: "#8E98A1",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 18,
    marginTop: 12,
  },
  retryButton: {
    alignItems: "center",
    backgroundColor: "#0064FF",
    borderRadius: 14,
    height: 50,
    justifyContent: "center",
    marginTop: 22,
  },
  retryText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "900",
  },
});
