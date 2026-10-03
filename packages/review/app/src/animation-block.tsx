import {
  type ReviewAnimationCommand,
  type ReviewAnimationMount,
  type ReviewAnimationRegion,
  type ReviewAnimationTheme,
} from "@dev.fast/review-protocol";
import type { AnimationBlock as AnimationSource } from "@review/review-api/blocks/animation";
import type { Snapshot } from "@review/review-api/store";
import * as stylex from "@stylexjs/stylex";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

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
  const surface = useRef<HTMLDivElement>(null);

  const [explorerStage, setExplorerStage] = useState<HTMLDivElement | null>(
    null,
  );

  const controls = useRef<{
    play(): void;
    pause(): void;
    restart(): void;
    explore(key: string): void;
    move(container: HTMLElement): void;
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
    request: { key: string };
    open: boolean;
  }>();

  const closeExplorer = useCallback(() => {
    setExplorer((value) => value && { ...value, open: false });
  }, []);

  useEffect(() => {
    const stage = surface.current;

    if (!bridge || !stage) return;

    type Guest = { id: string; mounted: ReviewAnimationMount };

    let guest: Guest | undefined;
    let retained: Guest | undefined;
    let target: HTMLElement = stage;
    let pending: Promise<void> | undefined;
    let disposed = false;
    let generation = 0;
    let wantsPlay = false;
    let failed = false;

    const destroy = (value: Guest | undefined) => {
      if (!value) return;
      void bridge.destroy(value.id).catch(() => {});
      value.mounted.dispose();
    };

    const report = (cause: unknown) => {
      if (disposed || failed) return;
      failed = true;
      setRegions([]);
      setError(cause instanceof Error ? cause.message : String(cause));
      player.pause();
    };

    const command = (value: ReviewAnimationCommand) => {
      const current = guest;
      const revision = generation;

      if (current)
        void bridge.command(current.id, value).catch((cause) => {
          if (revision === generation && current === guest) report(cause);
        });
    };

    const theme = (): ReviewAnimationTheme => {
      const style = getComputedStyle(stage);

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

    const start = () => {
      wantsPlay = true;
      setSelected(undefined);

      if (pending) return;
      const revision = generation;
      setLoading(true);
      pending = (async () => {
        try {
          if (!guest) {
            const source = latest.current;
            setRunning(source);

            const created = await bridge.create({
              html: source.node.html,
              css: source.node.css,
              js: source.node.js,
              keys: source.node.bindings.map((binding) => binding.key),
              theme: theme(),
            });

            if (disposed) {
              await bridge.destroy(created.id);

              return;
            }

            try {
              guest = {
                id: created.id,
                mounted: bridge.mount(
                  created,
                  target,
                  `${source.node.title}. ${source.node.description}`,
                ),
              };
            } catch (cause) {
              void bridge.destroy(created.id).catch(() => {});
              throw cause;
            }
          }

          await bridge.command(guest.id, {
            type: wantsPlay ? "play" : "pause",
          });

          if (disposed) return;
          setPlaying(wantsPlay);
          // The replacement is ready. Until now the old, paused webview stayed visible.
          destroy(retained);
          retained = undefined;
        } catch (cause) {
          if (revision === generation) report(cause);
        } finally {
          pending = undefined;

          if (!disposed) setLoading(false);
        }
      })();
    };

    const player = animationPlayback.register(crypto.randomUUID(), {
      start,
      stop: () => {
        wantsPlay = false;
        setPlaying(false);
        command({ type: "pause" });
      },
    });

    const explore = (key: string) => {
      if (!guest || failed || pending) return;
      player.pause();
      setSelected(key);
      setExplorer({ request: { key }, open: true });
    };

    controls.current = {
      play: player.play,
      pause: player.pause,
      restart: () => {
        if (pending) return;
        player.pause();
        generation++;

        if (failed) {
          destroy(guest);
        } else {
          destroy(retained);
          retained = guest;
        }

        guest = undefined;
        failed = false;
        setRegions([]);
        setExplorer(undefined);
        setError(undefined);
        player.play();
      },
      explore,
      move: (container) => {
        target = container;
        retained?.mounted.move(container);
        guest?.mounted.move(container);
      },
    };

    const subscription = bridge.subscribe((event) => {
      if (disposed || event.id !== guest?.id) return;

      if (event.type === "regions") setRegions(event.regions);
      else if (event.type === "selected") explore(event.key);
      else if (event.type === "paused") player.pause();
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
        intersecting && !document.hidden && stage.getClientRects().length > 0,
      );

    const observer = new IntersectionObserver(
      (entries) => {
        intersecting = entries[0]?.isIntersecting ?? false;
        visibility();
      },
      { threshold: 0.1 },
    );

    observer.observe(stage);
    document.addEventListener("visibilitychange", visibility);
    const resize = new ResizeObserver(visibility);
    resize.observe(stage);

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
      destroy(guest);
      destroy(retained);
    };
  }, [bridge, host, node.id]);

  useLayoutEffect(() => {
    const target = explorer?.open ? explorerStage : surface.current;

    if (target) controls.current?.move(target);
  }, [explorer?.open, explorerStage]);

  const current = running?.node ?? node;

  const codeRegions = regions.map((region) => (
    <div
      key={region.key}
      {...stylex.props(
        styles.codeAnchor(region.x, region.y, region.width, region.height),
      )}
    >
      <DiagramCodeRegion
        label={region.key}
        selected={selected === region.key}
        onClick={() => controls.current?.explore(region.key)}
      />
    </div>
  ));

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
          <div
            ref={surface}
            {...stylex.props(styles.surface(current.height))}
          />
          {!explorer?.open && codeRegions}
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
          stageRef={setExplorerStage}
        >
          {codeRegions}
        </AnimationExplorer>
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
    position: "relative",
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
});
