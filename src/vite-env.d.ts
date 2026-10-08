/// <reference types="svelte" />
/// <reference types="vite/client" />

// turndown-plugin-gfm 无官方/社区类型声明，这里提供最小模块声明（插件仅向 TurndownService 实例挂 use 方法）
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: (service: TurndownService) => void;
  export const tables: (service: TurndownService) => void;
  export const strikethrough: (service: TurndownService) => void;
  export const taskListItems: (service: TurndownService) => void;
}
