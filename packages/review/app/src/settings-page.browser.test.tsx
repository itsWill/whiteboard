import type { ReviewCanvasSettingsContent } from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";

import { SettingsPage } from "./settings-page";

let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});

async function mount() {
  const settings: ReviewCanvasSettingsContent = {
    telemetryEnabled: true,
    setTelemetryEnabled: async (value) => value,
    theme: "dark",
    setTheme: vi.fn<ReviewCanvasSettingsContent["setTheme"]>(
      async (value) => value,
    ),
    diffTheme: { id: "Review Dark", label: "Whiteboard Dark" },
    pickDiffTheme: vi.fn<ReviewCanvasSettingsContent["pickDiffTheme"]>(
      async () => ({ id: "Monokai", label: "Monokai" }),
    ),
    keymap: "none",
    setKeymap: async (value) => value,
    softwareMapEnabled: false,
    setSoftwareMapEnabled: async (value) => value,
    structuralDiffEnabled: true,
    setStructuralDiffEnabled: async (value) => value,
    scratchpadEnabled: false,
    setScratchpadEnabled: async (value) => value,
    diffrConfig: {
      read: async () => ({ values: {}, credentialSource: "missing" }),
      set: async () => ({ values: {}, credentialSource: "missing" }),
      saveSummarizer: async () => ({ values: {}, credentialSource: "missing" }),
      testSummarizer: async () => "",
    },
    reloadWindow: async () => {},
    manageExtensions: () => {},
  };

  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SettingsPage settings={settings} />));

  return settings;
}

test("choosing an installed Diff theme updates its label without changing the editor theme", async () => {
  const settings = await mount();
  await act(() =>
    page
      .getByRole("button", { name: "Diff theme: Whiteboard Dark", exact: true })
      .click(),
  );
  expect(settings.pickDiffTheme).toHaveBeenCalledOnce();
  expect(settings.setTheme).not.toHaveBeenCalled();
  await expect
    .element(
      page.getByRole("button", { name: "Diff theme: Monokai", exact: true }),
    )
    .toBeVisible();
  await expect
    .element(
      page
        .getByRole("radiogroup", { name: "Theme", exact: true })
        .getByRole("radio", { name: "Dark", exact: true }),
    )
    .toHaveAttribute("aria-checked", "true");
});

test("a failed Diff theme save keeps the selected value and reports the error", async () => {
  const settings = await mount();
  vi.mocked(settings.pickDiffTheme).mockRejectedValueOnce(
    new Error("Could not save theme"),
  );
  await act(() =>
    page
      .getByRole("button", { name: "Diff theme: Whiteboard Dark", exact: true })
      .click(),
  );
  await expect
    .element(page.getByText("Could not save theme", { exact: true }))
    .toBeVisible();
  await expect
    .element(
      page.getByRole("button", {
        name: "Diff theme: Whiteboard Dark",
        exact: true,
      }),
    )
    .toBeVisible();
});
