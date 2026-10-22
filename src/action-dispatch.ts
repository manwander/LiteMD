// 动作分发器（菜单栏 / 工具栏 / 命令面板统一出口）。
// map 本体在 App.svelte 组装——handler 均为 App 局部函数（editor view、settings、
// 模态状态都在 App 作用域），这是唯一务实形态；本模块只负责「查表 + 兜错」。
// 纯模块：无 DOM / 无 Tauri 依赖，可在 Node 下安全 import。

/** action id -> 无参执行体 */
export type ActionHandlerMap = Record<string, () => void>;

/**
 * 执行注册动作。
 * 未注册 → console.warn 并返回 false（集成阶段据此发现漏接线，不静默吞掉）。
 * 已注册 → 调用并返回 true；handler 同步异常向上抛（由调用方 cmd() 兜底转状态栏提示）。
 */
export function runAction(id: string, map: ActionHandlerMap): boolean {
  const fn = map[id];
  if (typeof fn !== "function") {
    console.warn(`[action-dispatch] 未注册的 action: ${id}`);
    return false;
  }
  fn();
  return true;
}
