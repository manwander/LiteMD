import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// 测试环境：jsdom（sanitizeHtml 依赖 window/DOMPurify；编辑器命令依赖 CodeMirror DOM）
// svelte 插件：支持在测试中实例化 .svelte 组件（FileTree 冒烟测试）
export default defineConfig({
  plugins: [svelte()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
