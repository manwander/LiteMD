/**
 * D-7 关闭标签逐个确认队列 —— 纯状态机单测。
 * 固化修复语义：多脏标签批量关闭时每一个都依次弹窗（不再只弹最后一个）、
 * 处理完推进下一个、取消中止整批、去重。
 */
import { describe, it, expect } from "vitest";
import {
  emptyCloseQueue,
  requestClose,
  resolveCurrent,
  abortAll,
  enqueue,
  advance,
} from "../tab-close-queue";

describe("tab-close-queue（D-7）", () => {
  it("首个脏标签：入队即成为 current（弹窗）", () => {
    const q = requestClose(emptyCloseQueue, "a.md");
    expect(q.current).toBe("a.md");
    expect(q.pending).toEqual([]);
  });

  it("批量三个脏标签：只弹第一个，其余排队（不再互相覆盖丢提示）", () => {
    let q = requestClose(emptyCloseQueue, "a.md");
    q = requestClose(q, "b.md");
    q = requestClose(q, "c.md");
    expect(q.current).toBe("a.md"); // 首个仍在弹
    expect(q.pending).toEqual(["b.md", "c.md"]); // 其余排队、未丢
  });

  it("逐个 resolve：a→b→c 依次弹出，全部处理完 current 归 null", () => {
    let q = requestClose(requestClose(requestClose(emptyCloseQueue, "a.md"), "b.md"), "c.md");
    expect(q.current).toBe("a.md");
    q = resolveCurrent(q);
    expect(q.current).toBe("b.md");
    q = resolveCurrent(q);
    expect(q.current).toBe("c.md");
    q = resolveCurrent(q);
    expect(q.current).toBe(null);
    expect(q.pending).toEqual([]);
  });

  it("取消 → abortAll 清空整批，不再追问其余", () => {
    let q = requestClose(requestClose(emptyCloseQueue, "a.md"), "b.md");
    q = abortAll();
    expect(q.current).toBe(null);
    expect(q.pending).toEqual([]);
  });

  it("去重：同一路径重复请求只保留一次", () => {
    let q = requestClose(emptyCloseQueue, "a.md");
    q = requestClose(q, "a.md");
    q = enqueue(q, "a.md");
    expect(q.current).toBe("a.md");
    expect(q.pending).toEqual([]);
  });

  it("advance 幂等：已有 current 时不抢占队列", () => {
    const q = advance(requestClose(emptyCloseQueue, "a.md"));
    expect(q.current).toBe("a.md");
    expect(q.pending).toEqual([]);
  });
});
