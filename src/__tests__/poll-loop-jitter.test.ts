import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PollLoop } from "../poll-loop.js";

vi.mock("../ui.js", () => ({
  warn: vi.fn(),
  debug: vi.fn(),
}));

describe("PollLoop jitter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("without jitter, onTick fires immediately on start", async () => {
    const onTick = vi.fn().mockResolvedValue(undefined);
    const loop = new PollLoop({ name: "test", intervalMs: 1000, onTick });

    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTick).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("with jitter, onTick is delayed up to jitterMs", async () => {
    const onTick = vi.fn().mockResolvedValue(undefined);
    const loop = new PollLoop({ name: "test", intervalMs: 10_000, onTick, jitterMs: 5_000 });

    loop.start();
    // At t=0, should not have fired yet (jitter delays it)
    await vi.advanceTimersByTimeAsync(0);
    // May or may not have fired depending on random jitter
    // But by t=5000 it must have fired
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onTick).toHaveBeenCalled();
    loop.stop();
  });

  it("jitter does not fire if stopped before delay expires", async () => {
    const onTick = vi.fn().mockResolvedValue(undefined);
    const loop = new PollLoop({ name: "test", intervalMs: 10_000, onTick, jitterMs: 5_000 });

    loop.start();
    loop.stop();
    await vi.advanceTimersByTimeAsync(6_000);
    // The interval tick may still fire since setInterval was set before stop cleared it
    // But the jitter callback checks this.timer, which is null after stop
    // onTick should only be called from interval ticks, not jitter
    expect(onTick).toHaveBeenCalledTimes(0);
  });
});
