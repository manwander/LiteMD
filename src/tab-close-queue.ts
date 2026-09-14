/**
 * 关闭标签「逐个确认」队列的纯状态机（D-7）。
 *
 * 旧实现把 closeTabDialog 作单槽，批量「关闭其他/全部」循环里逐个脏标签互相覆盖，
 * 只弹最后一个、其余既不关也不再问。此模块把语义收敛为可单测的 FIFO 队列：
 * 每个脏标签依次成为 current 弹出，处理完推进下一个，取消则清空整批。
 * App.svelte 只负责副作用（doCloseTab/save/activateTab），队列流转逻辑在此、与 DOM 解耦。
 */
export interface CloseQueueState {
  /** 待确认的脏标签路径队列（FIFO、去重） */
  pending: string[];
  /** 当前正在弹窗确认的路径；null 表示无 */
  current: string | null;
}

export const emptyCloseQueue: CloseQueueState = { pending: [], current: null };

/** 入队一个脏标签路径（与队中/当前重复则忽略）。 */
export function enqueue(q: CloseQueueState, path: string): CloseQueueState {
  if (q.current === path || q.pending.includes(path)) return q;
  return { pending: [...q.pending, path], current: q.current };
}

/** 若当前无弹窗，则从队首取下一个作为 current。 */
export function advance(q: CloseQueueState): CloseQueueState {
  if (q.current !== null || q.pending.length === 0) return q;
  const [head, ...rest] = q.pending;
  return { pending: rest, current: head };
}

/** 入队 + 推进的常用组合：请求关闭某脏标签。 */
export function requestClose(q: CloseQueueState, path: string): CloseQueueState {
  return advance(enqueue(q, path));
}

/** 处理完当前项（已保存或已不保存关闭）→ 清除当前并推进到下一个。 */
export function resolveCurrent(q: CloseQueueState): CloseQueueState {
  return advance({ pending: q.pending, current: null });
}

/** 取消：中止整批关闭，不再追问其余。 */
export function abortAll(): CloseQueueState {
  return emptyCloseQueue;
}
