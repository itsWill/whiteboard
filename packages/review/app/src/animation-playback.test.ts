import { describe, expect, it, vi } from "vitest";

import { AnimationPlayback } from "./animation-playback";

describe("animation playback", () => {
  it("resumes offscreen playback, but respects explicit pauses and single playback", () => {
    const manager = new AnimationPlayback();

    const a = { start: vi.fn<() => void>(), stop: vi.fn<() => void>() },
      b = { start: vi.fn<() => void>(), stop: vi.fn<() => void>() };

    const first = manager.register("a", a),
      second = manager.register("b", b);

    first.autoplay(true);
    first.visible(true);
    second.autoplay(true);
    second.visible(true);
    expect(a.start).toHaveBeenCalledTimes(1);
    expect(b.start).not.toHaveBeenCalled();
    first.visible(false);
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.start).toHaveBeenCalledTimes(1);
    second.visible(false);
    first.visible(true);
    expect(a.start).toHaveBeenCalledTimes(2);
    first.pause();
    first.visible(false);
    first.visible(true);
    expect(a.start).toHaveBeenCalledTimes(2);
    second.play();
    first.play();
    expect(b.stop).toHaveBeenCalledTimes(2);
    first.dispose();
    second.dispose();
  });

  it("does not autoplay when disabled and does not resume a player displaced by Play", () => {
    const manager = new AnimationPlayback();

    const a = { start: vi.fn<() => void>(), stop: vi.fn<() => void>() },
      b = { start: vi.fn<() => void>(), stop: vi.fn<() => void>() };

    const first = manager.register("a", a),
      second = manager.register("b", b);

    first.visible(true);
    expect(a.start).not.toHaveBeenCalled();
    first.play();
    second.play();
    second.visible(false);
    first.autoplay(true);
    first.visible(true);
    expect(a.start).toHaveBeenCalledTimes(1);
    first.play();
    expect(a.start).toHaveBeenCalledTimes(2);
  });
});
