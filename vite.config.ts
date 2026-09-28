import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const agentScript = readFileSync(
  new URL("./windows-agent-production/PharmFarm-Agent.ps1", import.meta.url),
  "utf8",
);
const agentVersion = agentScript.match(/\$AgentVersion\s*=\s*["']([^"']+)["']/)?.[1];
if (!agentVersion) throw new Error("Unable to determine agent release version");
const agentPackage = readFileSync(
  new URL("./public/pharmfarm-agent-production.zip", import.meta.url),
);
const agentReleaseSha256 = createHash("sha256").update(agentPackage).digest("hex");

export default defineConfig({
  plugins: [react()],
  define: {
    __AGENT_RELEASE_VERSION__: JSON.stringify(agentVersion),
    __AGENT_RELEASE_SHA256__: JSON.stringify(agentReleaseSha256),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_COMMIT_SHA__: JSON.stringify(
      process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.GITHUB_SHA ||
        process.env.COMMIT_SHA ||
        "",
    ),
  },
});
