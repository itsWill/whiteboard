interface Player {
  visible: boolean;
  autoplay: boolean;
  held: boolean;
  start(): void;
  stop(): void;
}

/** One playing animation per canvas process; offscreen players retain their state. */
export class AnimationPlayback {
  private players = new Map<string, Player>();
  private active: string | undefined;

  register(id: string, actions: Pick<Player, "start" | "stop">) {
    this.players.set(id, {
      ...actions,
      visible: false,
      autoplay: false,
      held: false,
    });

    return {
      play: () => this.play(id),
      pause: () => this.pause(id, true),
      visible: (visible: boolean) => {
        const player = this.players.get(id);

        if (!player) return;
        player.visible = visible;

        if (!visible) this.pause(id, false);
        this.schedule();
      },
      autoplay: (enabled: boolean) => {
        const player = this.players.get(id);

        if (!player) return;
        player.autoplay = enabled;
        this.schedule();
      },
      dispose: () => {
        this.pause(id, true);
        this.players.delete(id);
        this.schedule();
      },
    };
  }

  private play(id: string) {
    const player = this.players.get(id);

    if (!player) return;

    if (this.active && this.active !== id) this.pause(this.active, true);
    player.held = false;

    if (this.active === id) return;
    this.active = id;
    player.start();
  }

  private pause(id: string, held: boolean) {
    const player = this.players.get(id);

    if (!player) return;
    player.held ||= held;

    if (this.active !== id) return;
    this.active = undefined;
    player.stop();
  }

  private schedule() {
    if (this.active) return;

    for (const [id, player] of this.players) {
      if (player.visible && player.autoplay && !player.held) {
        this.play(id);

        return;
      }
    }
  }
}

export const animationPlayback = new AnimationPlayback();
