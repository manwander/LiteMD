// 设置持久化桥接：Tauri invoke → app_config_dir/settings.json；
// 纯浏览器调试时回退 localStorage。
import { invoke } from "@tauri-apps/api/core";

export interface SettingsBridge {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

export const settingsBridge: SettingsBridge = {
  load: () => invoke<string | null>("load_settings"),
  save: (json) => invoke<void>("save_settings", { json }),
};
