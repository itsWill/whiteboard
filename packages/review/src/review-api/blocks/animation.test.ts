import {
  documentSchema,
  selectionReferences,
} from "@review/review-api/document.js";
import { describe, expect, it } from "vitest";

import { animationSchema } from "./animation.js";

const source = {
  file: "src/api.ts",
  start: { side: "head", line: 4 },
  end: { side: "head", line: 8 },
};

const block = {
  type: "animation",
  id: "demo",
  title: "Request",
  description: "A request moves to its handler.",
  html: "<div>request</div>",
  js: "throw new Error('must not execute while saving');",
  bindings: [
    {
      key: "request",
      links: [
        { label: "Send", source },
        { label: "Handle", source },
      ],
    },
  ],
};

describe("animation authoring", () => {
  it("stores executable source as data and retains every named source reference", () => {
    const document = documentSchema.parse([block]);
    expect(document[0]).toMatchObject({
      js: block.js,
      runtimeVersion: 1,
      height: 360,
    });
    expect(
      selectionReferences(document).map((reference) => reference.source),
    ).toEqual([source, source]);
  });
  it("rejects duplicate binding identities, unsupported runtimes and oversized source", () => {
    expect(
      animationSchema.safeParse({
        ...block,
        bindings: [block.bindings[0], block.bindings[0]],
      }).success,
    ).toBe(false);
    expect(
      animationSchema.safeParse({ ...block, runtimeVersion: 2 }).success,
    ).toBe(false);
    expect(
      animationSchema.safeParse({ ...block, js: " ".repeat(65537) }).success,
    ).toBe(false);
  });
});
