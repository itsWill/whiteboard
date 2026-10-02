import {
  type ReviewAnimationCommand,
  type ReviewAnimationRegion,
  type ReviewAnimationTheme,
} from "@dev.fast/review-protocol";
import type { AnimationBlock as AnimationSource } from "@review/review-api/blocks/animation";
import type { Snapshot } from "@review/review-api/store";
import * as stylex from "@stylexjs/stylex";
import { useCallback, useEffect, useRef, useState } from "react";

import { AnimationExplorer } from "./animation-explorer";
import { animationPlayback } from "./animation-playback";
import { DiagramCodeRegion, DiagramPlaybackControls } from "./diagram-controls";
import { DiagramHeader } from "./diagram-header";
import { useReviewSession } from "./host/review-session";
import { fontSize, radius } from "./scale.stylex";
import { tokens } from "./tokens.stylex";

export function AnimationBlock({
  node,
  snapshot,
}: {
  node: AnimationSource & { id: string };
  snapshot: Snapshot;
}) {
  const { bridge: host } = useReviewSession();
  // Shared/imported source does not gain automatic execution just by being opened.
  const bridge = snapshot.shared ? undefined : host.animations;
  const latest = useRef({ node, snapshot });
  latest.current = { node, snapshot };
  const surface = useRef<HTMLCanvasElement>(null);

  const controls = useRef<{
    play(): void;
    pause(): void;
    restart(): void;
    input(
      event: Extract<ReviewAnimationCommand, { type: "input" }>["event"],
    ): void;
  } | null>(null);

  const [running, setRunning] = useState<{
    node: AnimationSource;
    snapshot: Snapshot;
  } | null>(null);

  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [regions, setRegions] = useState<ReviewAnimationRegion[]>([]);

  const [explorer, setExplorer] = useState<{
    request: { key: string; image: string };
    open: boolean;
  }>();

  const closeExplorer = useCallback(
    () => setExplorer((value) => value && { ...value, open: false }),
    [],
  );

  useEffect(() => {
    const canvas = surface.current;

    if (!bridge || !canvas) return;
    let id: string | undefined;
    let pending: Promise<void> | undefined;
    let disposed = false;
    let generation = 0;
    let wantsPlay = false;

    let size = {
      width: Math.min(2048, Math.max(1, Math.round(canvas.clientWidth))),
      height: latest.current.node.height,
    };

    const report = (cause: unknown) => {
      if (disposed) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      player.pause();
    };

    const command = (value: ReviewAnimationCommand) => {
      const target = id;
      const revision = generation;

      if (target)
        void bridge.command(target, value).catch((cause) => {
          if (revision === generation && target === id) report(cause);
        });
    };

    const theme = (): ReviewAnimationTheme => {
      const style = getComputedStyle(canvas);

      const color = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;

      return {
        background: color("--diagram-canvas-bg", "#ffffff"),
        foreground: color("--ink", "#222222"),
        muted: color("--ink-muted", "#666666"),
        accent: color("--accent", "#6254cc"),
        border: color("--rule-soft", "#cccccc"),
        font: style.fontFamily,
        dark: host.currentTheme() === "dark",
      };
    };

    const start = async () => {
      wantsPlay = true;
      setSelected(undefined);

      if (!id && !pending) {
        const revision = latest.current;
        const current = ++generation;
        setRunning(revision);
        setError(undefined);
        setLoading(true);
        pending = (async () => {
          const created = await bridge.create({
            html: revision.node.html,
            css: revision.node.css,
            js: revision.node.js,
            keys: revision.node.bindings.map((binding) => binding.key),
            ...size,
            pixelRatio: Math.min(3, Math.max(1, window.devicePixelRatio)),
            theme: theme(),
          });

          if (disposed || current !== generation) {
            await bridge.destroy(created);

            return;
          }

          id = created;
        })().finally(() => {
          if (current === generation) {
            pending = undefined;

            if (!disposed) setLoading(false);
          }
        });
      }

      const startedGeneration = generation;

      try {
        await pending;

        if (startedGeneration !== generation) return;

        if (!disposed && id && wantsPlay) {
          await bridge.command(id, { type: "play" });

          if (!disposed && startedGeneration === generation && wantsPlay)
            setPlaying(true);
        }
      } catch (cause) {
        if (startedGeneration === generation) report(cause);
      }
    };

    const player = animationPlayback.register(crypto.randomUUID(), {
      start: () => {
        void start();
      },
      stop: () => {
        wantsPlay = false;
        setPlaying(false);
        command({ type: "pause" });
      },
    });

    controls.current = {
      play: player.play,
      pause: player.pause,
      restart: () => {
        player.pause();
        generation++;

        if (id) void bridge.destroy(id).catch(() => {});
        id = undefined;
        pending = undefined;
        setError(undefined);
        setRegions([]);
        setExplorer(undefined);
        player.play();
      },
      input: (event) => command({ type: "input", event }),
    };
    let drawing = false;
    let nextImage: string | undefined;

    const draw = () => {
      if (drawing || !nextImage || disposed) return;
      drawing = true;
      const image = new Image();
      image.onload = () => {
        if (!disposed) {
          if (canvas.width !== image.width || canvas.height !== image.height) {
            canvas.width = image.width;
            canvas.height = image.height;
          }

          canvas.getContext("2d")?.drawImage(image, 0, 0);
        }

        drawing = false;
        draw();
      };

      image.onerror = () => {
        drawing = false;
      };

      image.src = nextImage;
      nextImage = undefined;
    };

    const subscription = bridge.subscribe((event) => {
      if (disposed || event.id !== id) return;

      if (event.type === "frame") {
        nextImage = event.image;
        draw();
      } else if (event.type === "regions") {
        setRegions(event.regions);
      } else if (event.type === "selected") {
        player.pause();
        setSelected(event.key);
        setExplorer({
          request: { key: event.key, image: canvas.toDataURL() },
          open: true,
        });
      } else if (event.type === "paused") player.pause();
      else if (event.type === "error") report(event.message);
    });

    const motion = matchMedia("(prefers-reduced-motion: reduce)");

    const updateAutoplay = () =>
      player.autoplay(bridge.autoplay() && !motion.matches);

    const autoplay = bridge.onDidChangeAutoplay(updateAutoplay);
    motion.addEventListener("change", updateAutoplay);
    updateAutoplay();
    let intersecting = false;

    const visibility = () =>
      player.visible(
        intersecting && !document.hidden && canvas.getClientRects().length > 0,
      );

    const observer = new IntersectionObserver(
      (entries) => {
        intersecting = entries[0]?.isIntersecting ?? false;
        visibility();
      },
      { threshold: 0.1 },
    );

    observer.observe(canvas);
    document.addEventListener("visibilitychange", visibility);

    const resize = new ResizeObserver(() => {
      const next = {
        width: Math.min(2048, Math.max(1, Math.round(canvas.clientWidth))),
        height: Math.max(1, Math.round(canvas.clientHeight)),
      };

      if (next.width !== size.width || next.height !== size.height) {
        size = next;
        command({ type: "resize", ...size });
      }

      visibility();
    });

    resize.observe(canvas);

    const themeSubscription = host.onDidChangeTheme(() =>
      requestAnimationFrame(() => {
        if (!disposed) command({ type: "theme", theme: theme() });
      }),
    );

    return () => {
      disposed = true;
      generation++;
      controls.current = null;
      player.dispose();
      subscription.dispose();
      autoplay.dispose();
      themeSubscription.dispose();
      observer.disconnect();
      resize.disconnect();
      motion.removeEventListener("change", updateAutoplay);
      document.removeEventListener("visibilitychange", visibility);

      if (id) void bridge.destroy(id);
    };
  }, [bridge, host, node.id]);

  const current = running?.node ?? node;

  return (
    <figure {...stylex.props(styles.figure)} aria-label={current.title}>
      <DiagramHeader
        kind="ANIMATION"
        title={current.title}
        action={
          bridge && (
            <DiagramPlaybackControls
              playing={playing}
              loading={loading}
              failed={Boolean(error)}
              onPlay={() => controls.current?.play()}
              onPause={() => controls.current?.pause()}
              onRestart={() => controls.current?.restart()}
            />
          )
        }
      />
      {bridge && (
        <div {...stylex.props(styles.stage)}>
          <canvas
            ref={surface}
            {...stylex.props(styles.surface(current.height))}
            tabIndex={0}
            aria-label={`${current.title}. ${current.description}`}
            onPointerDown={(event) => {
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              const rect = event.currentTarget.getBoundingClientRect();
              controls.current?.input({
                type: "mouseDown",
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
                button: "left",
              });
            }}
            onPointerUp={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              controls.current?.input({
                type: "mouseUp",
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
                button: "left",
              });
            }}
            onPointerMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              controls.current?.input({
                type: "mouseMove",
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Tab") return;
              event.preventDefault();
              controls.current?.input({
                type: "keyDown",
                keyCode: event.key,
                modifiers: [
                  event.shiftKey && "shift",
                  event.ctrlKey && "control",
                  event.altKey && "alt",
                  event.metaKey && "meta",
                ].filter((value): value is string => Boolean(value)),
              });

              if (event.key.length === 1 && !event.ctrlKey && !event.metaKey)
                controls.current?.input({ type: "char", keyCode: event.key });
            }}
            onKeyUp={(event) => {
              if (event.key !== "Tab")
                controls.current?.input({ type: "keyUp", keyCode: event.key });
            }}
          />
          {regions.map((region) => {
            const binding = current.bindings.find(
              (item) => item.key === region.key,
            );

            const canvas = surface.current;

            if (
              !binding ||
              !canvas ||
              region.x + region.width < 0 ||
              region.y + region.height < 0 ||
              region.x > canvas.clientWidth ||
              region.y > canvas.clientHeight
            )
              return null;

            return (
              <div
                key={region.key}
                {...stylex.props(
                  styles.codeAnchor(
                    region.x,
                    region.y,
                    region.width,
                    region.height,
                  ),
                )}
              >
                <DiagramCodeRegion
                  label={region.key}
                  selected={selected === region.key}
                  onClick={() => {
                    controls.current?.pause();
                    setSelected(region.key);
                    setExplorer({
                      request: { key: region.key, image: canvas.toDataURL() },
                      open: true,
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
      <p {...stylex.props(styles.description)}>{current.description}</p>
      {error && (
        <p role="alert" {...stylex.props(styles.description)}>
          {error}
        </p>
      )}
      {explorer && running && (
        <AnimationExplorer
          node={running.node}
          snapshot={running.snapshot}
          request={explorer.request}
          open={explorer.open}
          onClose={closeExplorer}
        />
      )}
    </figure>
  );
}

const styles = stylex.create({
  figure: {
    margin: "24px auto",
    width: "100%",
    maxWidth: tokens.reviewBlockMaxWidth,
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.ruleSoft,
    borderRadius: radius.control,
    backgroundColor: tokens.diagramSurface,
    color: tokens.ink,
  },
  stage: { position: "relative", overflow: "hidden" },
  codeAnchor: (left: number, top: number, width: number, height: number) => ({
    position: "absolute",
    left,
    top,
    width,
    height,
    zIndex: 1,
  }),
  surface: (height: number) => ({
    display: "block",
    width: "100%",
    height,
    backgroundColor: tokens.diagramCanvasBg,
    fontFamily: tokens.fontMono,
    touchAction: "pan-y",
  }),
  description: {
    margin: 0,
    padding: "8px 16px",
    color: tokens.inkMuted,
    fontSize: fontSize.small,
  },
  links: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
  },
});
