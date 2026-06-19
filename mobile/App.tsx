import { useState } from "react";
import {
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { WebView } from "react-native-webview";

const webUrl =
  process.env.EXPO_PUBLIC_PHARMFARM_WEB_URL ?? "https://pharmfarm.vercel.app/";

export default function App() {
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
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
          key={reloadKey}
          allowsInlineMediaPlayback
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
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  webview: {
    flex: 1,
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
