import {
  ReviewApiClient,
  resolveReviewSourceView,
  reviewSourceAnchor,
} from "@dev.fast/review-protocol";
import type { AnimationBlock } from "@review/review-api/blocks/animation";
import type { Snapshot } from "@review/review-api/store";
import * as stylex from "@stylexjs/stylex";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { DiagramHeader } from "./diagram-header";
import { DiagramTourOverlay, useDiagramTourShell } from "./diagram-tour";
import { ReviewSessionProvider, useReviewSession } from "./host/review-session";
import { ReviewLensesProvider } from "./review-lenses";
import type { GuidedTour } from "./review-panel-model";
import { tokens } from "./tokens.stylex";
import { Button } from "./ui/button";

/** The existing diagram explorer, bound to the animation's running source version. */
export function AnimationExplorer({
  node,
  snapshot,
  request,
  open,
  onClose,
  stageRef,
  children,
}: {
  node: AnimationBlock;
  snapshot: Snapshot;
  request: { key: string };
  open: boolean;
  onClose(): void;
  stageRef: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const session = useReviewSession();
  const { portalTarget } = useDiagramTourShell(open, onClose);

  const client = useMemo(
    () => new ReviewApiClient(session.config, session.bridge.request),
    [session],
  );

  const frozen = useMemo<typeof session>(
    () => ({
      ...session,
      bridge: {
        ...session.bridge,
        inlineEditors: session.bridge.animations!.inlineEditors(
          resolveReviewSourceView(snapshot),
        ),
      },
      surface: {
        ...session.surface,
        revealAnchor: (file, range, side = "head", pins) =>
          session.bridge.animations!.openSource(
            {
              view: reviewSourceAnchor(resolveReviewSourceView(snapshot), pins),
              file,
              side,
            },
            { startLine: range.fromLine, endLine: range.toLine },
          ),
      },
    }),
    [session, snapshot],
  );

  const tour = useMemo<GuidedTour>(
    () => ({
      id: `animation:${node.id}:${snapshot.version}`,
      title: node.title,
      stops: node.bindings.flatMap((binding) =>
        binding.links.map((link, index) => ({
          anchor: {
            id: `${binding.key}:${index}`,
            title: binding.key,
            peek: link.source,
          },
          label: binding.key,
          detail: link.label,
          content: { kind: "source", source: link.source },
        })),
      ),
    }),
    [node, snapshot.version],
  );

  const [selection, setSelection] = useState({
    request,
    anchor: `${request.key}:0`,
    revealRequest: 1,
  });

  // Each box click selects its first link, including reopening the same box.
  // Keep the mounted editors and their diff cache until this animation restarts.
  if (selection.request !== request) {
    setSelection({
      request,
      anchor: `${request.key}:0`,
      revealRequest: selection.revealRequest + 1,
    });
  }

  const change = useCallback(
    (anchor: string, { reveal }: { reveal: boolean }) =>
      setSelection((value) => ({
        ...value,
        anchor,
        revealRequest: value.revealRequest + Number(reveal),
      })),
    [],
  );

  if (!portalTarget) return null;

  return createPortal(
    <ReviewSessionProvider session={frozen}>
      <ReviewLensesProvider
        client={client}
        snapshot={snapshot}
        structuralDiffEnabled={false}
      >
        <DiagramTourOverlay
          open={open}
          flow
          tour={tour}
          activeAnchor={selection.anchor}
          revealRequest={selection.revealRequest}
          onActiveAnchorChange={change}
          onClose={onClose}
        >
          <DiagramHeader
            kind="ANIMATION"
            title={node.title}
            action={<Button onClick={onClose}>Close</Button>}
          />
          <div ref={stageRef} {...stylex.props(styles.stage)}>
            {children}
          </div>
        </DiagramTourOverlay>
      </ReviewLensesProvider>
    </ReviewSessionProvider>,
    portalTarget,
  );
}

const styles = stylex.create({
  stage: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: tokens.diagramCanvasBg,
  },
});
