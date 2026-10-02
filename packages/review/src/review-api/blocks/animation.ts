import { lensSourceSchema } from "@review/lens-selection.js";
import { z } from "zod";

import { defineBlock, label } from "./definition.js";

/** Executable source stays data until a Desktop reader starts its sandbox. */
export const animationSchema = defineBlock("animation", {
  title: label.max(200),
  description: label.max(4000),
  runtimeVersion: z.literal(1).default(1),
  height: z.number().int().min(160).max(1200).default(360),
  html: z.string().max(128 * 1024),
  css: z
    .string()
    .max(64 * 1024)
    .default(""),
  js: z
    .string()
    .max(64 * 1024)
    .default(""),
  bindings: z
    .array(
      z.strictObject({
        key: label.max(100),
        links: z
          .array(
            z.strictObject({ label: label.max(200), source: lensSourceSchema }),
          )
          .min(1)
          .max(10),
      }),
    )
    .max(100)
    .default([]),
}).refine(
  (block) =>
    new Set(block.bindings.map((binding) => binding.key)).size ===
    block.bindings.length,
  "Animation binding keys must be unique.",
);

export type AnimationBlock = z.infer<typeof animationSchema>;

export const animation = {
  type: "animation",
  schema: animationSchema,
} as const;
