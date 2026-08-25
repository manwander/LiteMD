// 日志工具模块：仅保留控制台输出，不再写入本地日志文件。
// 操作/异常信息通过浏览器 DevTools 控制台查看，零文件开销。

/** 快捷方法：记录用户操作 */
export function logOp(message: string): void {
  console.log("[operation]", message);
}

/** 快捷方法：记录软件运行状态 */
export function logInfo(message: string): void {
  console.log("[software]", message);
}

/** 快捷方法：记录警告 */
export function logWarn(message: string): void {
  console.warn("[software]", message);
}

/** 快捷方法：记录错误/异常 */
export function logError(message: string): void {
  console.error("[problem]", message);
}
