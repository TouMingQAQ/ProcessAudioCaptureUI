import { defineConfig } from "vite";

// Tauri 期望一个固定端口的开发服务器
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 不要监听 Rust 侧，避免热重载风暴
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
});
