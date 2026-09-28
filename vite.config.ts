import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const entry = (name: string) => fileURLToPath(new URL(name, import.meta.url));

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
    rollupOptions: {
      // 两个窗口各是一个入口：主界面 + 悬浮球
      input: {
        main: entry("index.html"),
        ball: entry("ball.html"),
      },
    },
  },
});
