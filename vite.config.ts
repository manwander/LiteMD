import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  build: {
    // 体积控制策略：
    // 1. 代码级裁剪——代码块语言、预览高亮全部动态 import + 白名单；
    // 2. 手动分包会破坏 CM 语言包的异步拆分，因此不设 manualChunks，
    //    让 Vite 按动态 import 边界自动分包。
    chunkSizeWarningLimit: 1200,
    // 每次构建先清空 dist：避免历史 chunk 残留累积（曾积累 30MB/320 个旧文件），
    // 也防止发布时打进无用文件。Vite 用 fs.rm 直接删除，不走回收站。
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
