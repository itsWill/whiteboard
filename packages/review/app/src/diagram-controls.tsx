import * as stylex from "@stylexjs/stylex";

import { tokens } from "./tokens.stylex";
import { Button } from "./ui/button";

/** Host-owned controls shared by freestyle animations. Authors only draw the scene. */
export function DiagramPlaybackControls({
  playing,
  loading,
  failed,
  onPlay,
  onPause,
  onRestart,
}: {
  playing: boolean;
  loading: boolean;
  failed: boolean;
  onPlay(): void;
  onPause(): void;
  onRestart(): void;
}) {
  return (
    <span {...stylex.props(styles.controls)}>
      <Button disabled={loading || failed} onClick={playing ? onPause : onPlay}>
        {loading ? "Loading…" : playing ? "Pause" : "Play"}
      </Button>
      <Button onClick={onRestart}>Restart</Button>
    </span>
  );
}

/** A code-bearing object is itself the exploration target, including for keyboard users. */
export function DiagramCodeRegion({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-label={`Explore ${label}`}
      aria-haspopup="dialog"
      aria-pressed={selected}
      onClick={onClick}
      {...stylex.props(styles.region)}
    />
  );
}

const styles = stylex.create({
  controls: { display: "flex", alignItems: "center", gap: 8 },
  region: {
    display: "block",
    width: "100%",
    height: "100%",
    padding: 0,
    borderWidth: 0,
    borderStyle: "none",
    backgroundColor: "transparent",
    cursor: "pointer",
    outline: {
      default: "none",
      ":focus-visible": `2px solid ${tokens.accent}`,
      ":hover": `1px solid ${tokens.accent}`,
    },
    outlineOffset: 2,
  },
});
