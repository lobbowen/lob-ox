// 确认队列的行为测试。弹窗组件没有 DOM 测试设施（vitest 跑 node 环境），但真正会出错的地方恰恰在
// 组件之外：两条危险动作同时发起时谁先出现、上一条的关闭事件晚到会不会把下一条误判成「用户取消」。
// 形态门禁只能证明源码里用了统一组件，证不了这两条，故这里按行为钉纯逻辑。
import { describe, expect, it, vi } from "vitest";
import { createConfirmQueue } from "./confirm-queue";

const askA = () => ({ title: "删除供应商 A？" });
const askB = () => ({ title: "删除供应商 B？" });

describe("同屏一个确认框，按发起顺序排队", () => {
  it("连续两次 ask 只让第一条上屏，第二条排队", () => {
    const q = createConfirmQueue();
    void q.open(askA());
    void q.open(askB());
    expect(q.pending()).toBe(2);
    expect(q.peek()?.request.title).toBe(askA().title);
  });

  it("决议队首后下一条成为队首（不是最后一条插队）", () => {
    const q = createConfirmQueue();
    void q.open(askA());
    void q.open(askB());
    const a = q.peek()!.id;
    q.settle(a, true);
    expect(q.pending()).toBe(1);
    expect(q.peek()?.request.title).toBe(askB().title);
  });

  it("ask 的 Promise 取到用户给出的布尔（true/false 各自透传）", async () => {
    const q = createConfirmQueue();
    const yes = q.open(askA());
    q.settle(q.peek()!.id, true);
    const no = q.open(askB());
    q.settle(q.peek()!.id, false);
    await expect(yes).resolves.toBe(true);
    await expect(no).resolves.toBe(false);
  });
});

describe("关闭事件晚到不得误决议下一条", () => {
  it("上一条的 settle(false) 在其已被弹出队列消费后是空操作", async () => {
    const q = createConfirmQueue();
    const first = q.open(askA());
    const aId = q.peek()!.id;
    q.settle(aId, true);
    const second = q.open(askB());
    const bId = q.peek()!.id;
    // Radix 的 onOpenChange(false) 会在 Action 关闭动画后到达，携带的是上一条的 id。
    q.settle(aId, false);
    expect(q.peek()?.id).toBe(bId);
    expect(q.pending()).toBe(1);
    await expect(first).resolves.toBe(true);
    q.settle(bId, true);
    await expect(second).resolves.toBe(true);
  });

  it("同一 id 被决议两次只生效一次（按钮与 Esc 竞态）", async () => {
    const q = createConfirmQueue();
    const p = q.open(askA());
    const id = q.peek()!.id;
    q.settle(id, true);
    q.settle(id, false);
    await expect(p).resolves.toBe(true);
    expect(q.pending()).toBe(0);
    expect(q.peek()).toBeNull();
  });

  it("队列空时 settle/peek 不抛（关闭事件在异步间隙到达）", () => {
    const q = createConfirmQueue();
    expect(q.peek()).toBeNull();
    expect(() => q.settle(999, true)).not.toThrow();
    expect(q.pending()).toBe(0);
  });
});

describe("队首变化要通知宿主重绘", () => {
  it("open 与 settle 各通知一次，空操作不通知", () => {
    const notify = vi.fn();
    const q = createConfirmQueue(notify);
    q.open(askA());
    expect(notify).toHaveBeenCalledTimes(1);
    const id = q.peek()!.id;
    q.settle(id, false);
    expect(notify).toHaveBeenCalledTimes(2);
    q.settle(id, false);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
