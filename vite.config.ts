import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_COMMIT_SHA__: JSON.stringify(
      process.env.VERCEL_GIT_COMMIT_SHA ||
        process.env.GITHUB_SHA ||
        process.env.COMMIT_SHA ||
        "",
    ),
  },
});
