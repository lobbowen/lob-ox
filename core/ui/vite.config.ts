import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  // 单一产品入口：supervisor.html（dsh-supervisor 控制面板，构建后由内核 API 进程同源托管）；
  // 下方端口仅为 dev server。
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    rollupOptions: {
      input: { supervisor: "supervisor.html" },
    },
    chunkSizeWarningLimit: 1100,
  },
}));
