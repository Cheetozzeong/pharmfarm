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
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>WebView</Text>
          <Text style={styles.title}>PharmFarm</Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.78}
          style={styles.retryButton}
          onPress={() => {
            setLoadError("");
            setReloadKey((value) => value + 1);
          }}
        >
          <Text style={styles.retryText}>새로고침</Text>
        </TouchableOpacity>
      </View>

      {loadError ? (
        <View style={styles.errorPanel}>
          <Text style={styles.errorTitle}>웹 앱 연결 실패</Text>
          <Text style={styles.errorText}>{loadError}</Text>
          <Text style={styles.urlText}>{webUrl}</Text>
        </View>
      ) : (
        <WebView
          key={reloadKey}
          allowsInlineMediaPlayback
          domStorageEnabled
          javaScriptEnabled
          mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
          mediaPlaybackRequiresUserAction={false}
          originWhitelist={["https://*"]}
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
    backgroundColor: "#eef1ed",
  },
  header: {
    alignItems: "center",
    backgroundColor: "#f8faf7",
    borderBottomColor: "#d7ded8",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  eyebrow: {
    color: "#65716c",
    fontSize: 11,
    fontWeight: "800",
  },
  title: {
    color: "#16211e",
    fontSize: 17,
    fontWeight: "900",
    marginTop: 2,
  },
  retryButton: {
    alignItems: "center",
    backgroundColor: "#0c7a65",
    borderRadius: 8,
    height: 36,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  retryText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900",
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
    color: "#a11c12",
    fontSize: 20,
    fontWeight: "900",
  },
  errorText: {
    color: "#34413d",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 21,
    marginTop: 10,
  },
  urlText: {
    color: "#65716c",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 18,
    marginTop: 12,
  },
});
