import type {
  ReviewAnimationBridge,
  ReviewAnimationEvent,
  ReviewInlineEditorSpec,
} from "@dev.fast/review-protocol";
import { selectionKey } from "@review/lens-selection";
import { animationSchema } from "@review/review-api/blocks/animation";
import type { Snapshot } from "@review/review-api/store";
import { QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { AnimationBlock } from "./animation-block";
import { createCanvasQueryClient } from "./canvas-query";
import { ReviewDebugSettingsProvider } from "./debug-settings";
import { ReviewSessionProvider } from "./host/review-session";
import { ReviewProvider } from "./review-context";
import { ReviewPanelProvider } from "./review-panel";
import { ReviewContainerProvider } from "./review-root-context";
import {
  testReviewBridge,
  testReviewSession,
} from "./review-session-test-utils";

let cleanup = () => {};

afterEach(async () => {
  await act(cleanup);
  document.body.replaceChildren();
});

it("keeps running source and named code links until Restart, then loads the saved revision", async () => {
  const listeners = new Set<(event: ReviewAnimationEvent) => void>();
  let nextId = 0;

  const editors: {
    spec: ReviewInlineEditorSpec;
    dispose: ReturnType<typeof vi.fn>;
    setActive: ReturnType<typeof vi.fn>;
  }[] = [];

  const inlineEditors = vi.fn<ReviewAnimationBridge["inlineEditors"]>(() => ({
    async find() {
      return { matchCount: 0 };
    },
    create(spec) {
      const dispose = vi.fn<() => void>();
      const setActive = vi.fn<(active: boolean) => void>();
      editors.push({ spec, dispose, setActive });

      return {
        height: 180,
        dispose,
        setActive,
        setCollapsed() {},
        async setFindQuery() {
          return { matchCount: 0 };
        },
        revealFindMatch() {},
        clearActiveFindMatch() {},
        clearFind() {},
        onDidChangeHeight: () => ({ dispose() {} }),
        onDidError: () => ({ dispose() {} }),
      };
    },
  }));

  const request = vi.fn<ReturnType<typeof testReviewBridge>["request"]>(
    async () =>
      Response.json({
        complete: true,
        files: [],
        lenses: [],
        resolvedSelections: Object.fromEntries(
          node.bindings.flatMap((binding) =>
            binding.links.map(({ source }) => [
              selectionKey(source),
              [
                {
                  file: source.file,
                  side: source.start.side,
                  fromLine: source.start.line,
                  toLine: source.end.line,
                },
              ],
            ]),
          ),
        ),
      }),
  );

  const animations: ReviewAnimationBridge = {
    inlineEditors,
    create: vi.fn<ReviewAnimationBridge["create"]>(
      async () => `guest-${++nextId}`,
    ),
    command: vi.fn<ReviewAnimationBridge["command"]>(async () => {}),
    destroy: vi.fn<ReviewAnimationBridge["destroy"]>(async () => {}),
    openSource: vi.fn<ReviewAnimationBridge["openSource"]>(async () => {}),
    autoplay: () => false,
    onDidChangeAutoplay: () => ({ dispose() {} }),
    subscribe: (listener) => {
      listeners.add(listener);

      return { dispose: () => listeners.delete(listener) };
    },
  };

  const session = testReviewSession(
    {},
    {
      animations,
      request,
    },
  );

  const node = {
    ...animationSchema.parse({
      type: "animation",
      title: "Requests",
      description: "A moving request",
      html: "<button>old</button>",
      bindings: [
        {
          key: "request",
          links: [
            {
              label: "Sender",
              source: {
                file: "old.ts",
                start: { side: "head", line: 1 },
                end: { side: "head", line: 2 },
              },
            },
            {
              label: "Handler",
              source: {
                file: "handler.ts",
                start: { side: "head", line: 4 },
                end: { side: "head", line: 8 },
              },
            },
          ],
        },
      ],
    }),
    id: "animation-1",
  };

  node.bindings.push({
    key: "response",
    links: [
      {
        label: "Response",
        source: {
          file: "response.ts",
          start: { side: "head", line: 1 },
          end: { side: "head", line: 3 },
        },
      },
    ],
  });

  const snapshot: Snapshot = {
    reviewId: "review-1",
    version: 3,
    title: "Example",
    document: [node],
    createdAt: "2026-10-02",
  };

  const container = document.createElement("div");
  document.body.append(container);
  const mount = document.createElement("div");
  container.append(mount);
  const root = createRoot(mount);
  const queryClient = createCanvasQueryClient();
  cleanup = () => {
    root.unmount();
    queryClient.clear();
  };

  const render = async (current = node, version = 3) =>
    act(() =>
      root.render(
        <ReviewSessionProvider session={session}>
          <QueryClientProvider client={queryClient}>
            <ReviewContainerProvider container={container}>
              <ReviewDebugSettingsProvider>
                <ReviewProvider>
                  <ReviewPanelProvider>
                    <AnimationBlock
                      node={current}
                      snapshot={{ ...snapshot, version }}
                    />
                  </ReviewPanelProvider>
                </ReviewProvider>
              </ReviewDebugSettingsProvider>
            </ReviewContainerProvider>
          </QueryClientProvider>
        </ReviewSessionProvider>,
      ),
    );

  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent === label ||
        button.getAttribute("aria-label") === label,
    );

    expect(button).toBeTruthy();
    await act(async () => button!.click());
  };

  await render();
  expect(animations.create).not.toHaveBeenCalled();
  await click("Play");
  await expect.poll(() => animations.create).toHaveBeenCalledTimes(1);

  const regions = async (id: string) =>
    act(() => {
      for (const listener of listeners)
        listener({
          id,
          type: "regions",
          regions: [
            { key: "request", x: 20, y: 40, width: 200, height: 80 },
            { key: "response", x: 240, y: 40, width: 200, height: 80 },
          ],
        });
    });

  await regions("guest-1");

  const codeButton = container.querySelector('[aria-label="Explore request"]')!;

  expect(
    codeButton.closest("div")?.parentElement?.querySelector("canvas"),
  ).toBeTruthy();
  await click("Explore request");
  expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  expect(container.textContent).toContain("Handler");
  expect(inlineEditors).toHaveBeenLastCalledWith(
    expect.objectContaining({ reviewId: "review-1", version: 3 }),
  );
  expect(animations.command).toHaveBeenCalledWith("guest-1", { type: "pause" });

  await expect.poll(() => editors.length).toBeGreaterThan(0);
  const loaded = [...editors];

  const progressReads = () =>
    request.mock.calls.filter(([url]) => url.includes("/progress?")).length;

  const reads = progressReads();
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  await click("Close");
  expect(dialog.getClientRects()).toHaveLength(0);
  expect(dialog.inert).toBe(true);

  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });

  document.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(false);
  await click("Explore response");
  expect(dialog.getClientRects().length).toBeGreaterThan(0);
  await expect
    .poll(() => {
      const editor = editors.find((item) => item.spec.path === "response.ts");

      return editor?.setActive.mock.lastCall?.[0] ?? editor?.spec.active;
    })
    .toBe(true);
  await click("Close");
  await click("Explore request");
  expect(inlineEditors).toHaveBeenCalledTimes(1);
  expect(progressReads()).toBe(reads);

  for (const editor of loaded) expect(editor.dispose).not.toHaveBeenCalled();

  const updated = {
    ...node,
    html: "<button>new</button>",
    bindings: [
      {
        ...node.bindings[0]!,
        links: [{ ...node.bindings[0]!.links[0]!, label: "Updated sender" }],
      },
    ],
  };

  await render(updated, 4);
  expect(animations.create).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Handler");
  expect(container.textContent).not.toContain("Updated sender");
  await click("Close");
  await click("Restart");
  await expect.poll(() => animations.create).toHaveBeenCalledTimes(2);
  expect(animations.create).toHaveBeenLastCalledWith(
    expect.objectContaining({ html: "<button>new</button>" }),
  );
  expect(animations.destroy).toHaveBeenCalledWith("guest-1");

  for (const editor of loaded) expect(editor.dispose).toHaveBeenCalledTimes(1);
  await regions("guest-2");
  await click("Explore request");
  expect(inlineEditors).toHaveBeenLastCalledWith(
    expect.objectContaining({ version: 4 }),
  );
  expect(container.textContent).toContain("Updated sender");
  await act(() => root.unmount());
  queryClient.clear();
  cleanup = () => {};

  expect(animations.destroy).toHaveBeenCalledWith("guest-2");

  for (const editor of editors) expect(editor.dispose).toHaveBeenCalledTimes(1);
});

it("never executes a shared animation even when a Desktop bridge is present", async () => {
  const create = vi.fn<ReviewAnimationBridge["create"]>();

  const session = testReviewSession(
    {},
    {
      animations: {
        inlineEditors: () => testReviewBridge().inlineEditors,
        create,
        command: vi.fn<ReviewAnimationBridge["command"]>(),
        destroy: vi.fn<ReviewAnimationBridge["destroy"]>(),
        openSource: vi.fn<ReviewAnimationBridge["openSource"]>(),
        autoplay: () => true,
        onDidChangeAutoplay: () => ({ dispose() {} }),
        subscribe: () => ({ dispose() {} }),
      },
    },
  );

  const node = {
    ...animationSchema.parse({
      type: "animation",
      title: "Shared",
      description: "Static explanation",
      html: "<h1>Run</h1>",
    }),
    id: "shared",
  };

  const snapshot: Snapshot = {
    reviewId: "shared",
    version: 1,
    title: "Shared",
    document: [node],
    shared: { login: "author" },
    createdAt: "2026-10-02",
  };

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => root.unmount();
  await act(() =>
    root.render(
      <ReviewSessionProvider session={session}>
        <AnimationBlock node={node} snapshot={snapshot} />
      </ReviewSessionProvider>,
    ),
  );
  expect(container.textContent).toContain("Static explanation");
  expect(container.querySelector("canvas")).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

it("ignores late command errors from renderers replaced by consecutive Restarts", async () => {
  const stale = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let nextId = 0;

  const command = vi.fn<ReviewAnimationBridge["command"]>(
    async (id, action) => {
      if (action.type === "pause" && id !== "guest-3")
        return stale[Number(id.at(-1)) - 1]!.promise;
    },
  );

  const session = testReviewSession(
    {},
    {
      animations: {
        inlineEditors: () => testReviewBridge().inlineEditors,
        create: async () => `guest-${++nextId}`,
        command,
        destroy: async () => {},
        openSource: async () => {},
        autoplay: () => false,
        onDidChangeAutoplay: () => ({ dispose() {} }),
        subscribe: () => ({ dispose() {} }),
      },
    },
  );

  const node = {
    ...animationSchema.parse({
      type: "animation",
      title: "Restart",
      description: "Restart race",
      html: "<div>Scene</div>",
    }),
    id: "race",
  };

  const snapshot: Snapshot = {
    reviewId: "review-1",
    version: 1,
    title: "Restart",
    document: [node],
    createdAt: "2026-10-02",
  };

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => root.unmount();
  await act(() =>
    root.render(
      <ReviewSessionProvider session={session}>
        <AnimationBlock node={node} snapshot={snapshot} />
      </ReviewSessionProvider>,
    ),
  );

  const click = async (label: string) =>
    act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === label,
      )!;

      button.click();
    });

  await click("Play");
  await click("Restart");
  await click("Restart");
  await act(async () => {
    stale[0]!.reject(new Error("Animation timed out."));
    stale[1]!.reject(new Error("Animation was closed."));
    await Promise.resolve();
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await click("Pause");
  await click("Play");
  expect(command).toHaveBeenLastCalledWith("guest-3", { type: "play" });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
