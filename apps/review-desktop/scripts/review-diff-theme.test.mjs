import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

test("diff theme starts from the editor, remembers explicit choices, and isolates pending loads", () => {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      String.raw`
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { resolve } from "node:path";
    import { JSDOM } from "jsdom";
    const dom = new JSDOM("<html><head></head><body><div id='diff'></div><div id='hover'></div><div id='editor'></div></body></html>");
    for (const key of ["window", "document", "navigator", "HTMLElement", "customElements"]) {
      Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    }
    const native = "./code-oss/src/vs/";
    const { Emitter, Event } = await import(native + "base/common/event.ts");
    const { URI } = await import(native + "base/common/uri.ts");
    const { ColorThemeData } = await import(native + "workbench/services/themes/common/colorThemeData.ts");
    const { ReviewDiffTheme } = await import(native + "review/services/reviewDiffTheme.ts");
    const { currentReviewDiffThemeChoice, applyReviewDiffThemeChoice, pickReviewDiffTheme } = await import(native + "review/browser/reviewThemeChoice.ts");
    const loader = { readExtensionResource: uri => readFile(uri.fsPath, "utf8") };
    async function load(choice) {
      const theme = ColorThemeData.createUnloadedTheme(choice === "light" ? "vs" : "vs-dark");
      theme.settingsId = choice === "light" ? "Review Light" : "Review Dark";
      theme.location = URI.file(resolve("code-oss/extensions/review-themes/themes/review-" + choice + ".json"));
      await theme.ensureLoaded(loader);
      return theme;
    }
    const [dark, light] = await Promise.all([load("dark"), load("light")]);
    const configurations = new Emitter();
    const hostChanges = new Emitter();
    let choice;
    const writes = [];
    const configuration = {
      getValue: key => key === "review.diff.theme" ? choice : undefined,
      onDidChangeConfiguration: configurations.event,
      async updateValue(key, value) {
        writes.push([key, value]);
        choice = value;
        configurations.fire({ affectsConfiguration: candidate => candidate === key });
      },
    };
    let hostTheme = dark;
    const host = {
      getColorTheme: () => hostTheme,
      getColorThemes: async () => [dark, light],
      onDidColorThemeChange: hostChanges.event,
      onDidFileIconThemeChange: Event.None,
      onDidProductIconThemeChange: Event.None,
    };
    const containers = [document.querySelector("#diff"), document.querySelector("#hover")];
    const themes = [];
    const create = (extensions = { whenInstalledExtensionsRegistered: async () => {} }) => {
      const theme = new ReviewDiffTheme(containers, configuration, host, loader, extensions, {});
      themes.push(theme);
      return theme;
    };
    try {
      assert.equal(currentReviewDiffThemeChoice(configuration, host).id, "Review Dark");
      hostTheme = light;
      assert.equal(currentReviewDiffThemeChoice(configuration, host).id, "Review Dark", "initial appearance is stable for this run");
      const nextHost = { ...host };
      assert.equal(currentReviewDiffThemeChoice(configuration, nextHost).id, "Review Light", "a new app starts from its editor appearance");
      hostTheme = dark;
      const theme = create();
      await theme.update();
      assert.equal(theme.getColorTheme().settingsId, "Review Dark");
      assert.ok(document.querySelector("style").textContent.length > 0);
      assert.equal(document.querySelector("#editor").className, "");

      const changed = () => new Promise(resolve => {
        const subscription = theme.onDidColorThemeChange(value => { subscription.dispose(); resolve(value); });
      });
      let pending = changed();
      await applyReviewDiffThemeChoice(configuration, { id: "Review Light", label: "Whiteboard Light" });
      assert.equal((await pending).type, light.type);
      assert.strictEqual(host.getColorTheme(), dark);
      assert.equal(theme.getColorTheme().getColor("editor.background").toString(), light.getColor("editor.background").toString());
      assert.ok(document.querySelector("style").textContent.length > 0);
      assert.deepEqual(writes, [["review.diff.theme", "Review Light"]]);
      assert.equal(currentReviewDiffThemeChoice(configuration, host).id, "Review Light");

      // A system/editor theme change must not overwrite an explicit diff theme.
      pending = changed();
      hostTheme = light;
      hostChanges.fire(light);
      await pending;
      assert.equal(theme.getColorTheme().settingsId, "Review Light");

      pending = changed();
      await applyReviewDiffThemeChoice(configuration, { id: "Review Dark", label: "Whiteboard Dark" });
      await pending;
      assert.equal(theme.getColorTheme().settingsId, "Review Dark");
      assert.ok(document.querySelector("style").textContent.length > 0);
      pending = changed();
      hostTheme = dark;
      hostChanges.fire(dark);
      await pending;
      assert.equal(theme.getColorTheme().settingsId, "Review Dark");
      theme.dispose();
      assert.equal(document.querySelectorAll("style").length, 0);
      assert.ok(containers.every(container => container.className === ""));

      // Recreated views read the saved preference even with the opposite editor theme.
      hostTheme = light;
      const reopened = create();
      await reopened.update();
      assert.equal(reopened.getColorTheme().settingsId, "Review Dark");
      reopened.dispose();
      hostTheme = dark;

      // Resolving an old async load cannot override a newer selection.
      let release;
      const ready = new Promise(resolve => { release = resolve; });
      choice = "light";
      const racing = create({ whenInstalledExtensionsRegistered: () => ready });
      const loading = racing.update();
      choice = "dark";
      const latest = racing.update();
      release();
      await Promise.all([loading, latest]);
      assert.equal(racing.getColorTheme().settingsId, "Review Dark");
      assert.ok(document.querySelector("style").textContent.length > 0);
      racing.dispose();

      // Disposing during a load must not add styles back to the document.
      choice = "light";
      const disposed = create();
      const work = disposed.update();
      disposed.dispose();
      await work;
      assert.equal(document.querySelectorAll("style").length, 0);

      // Picker includes extension themes, cancellation writes nothing, and
      // the saved identifier can differ from the display label.
      const extension = ColorThemeData.createUnloadedTheme("vs-dark extension");
      extension.settingsId = "publisher.theme-id";
      extension.label = "Custom Theme";
      host.getColorThemes = async () => [dark, light, extension];
      const beforeCancel = writes.length;
      const canceled = await pickReviewDiffTheme(configuration, host, { pick: async items => {
        assert.ok(items.some(item => item.label === "Custom Theme"));
        return undefined;
      } });
      assert.equal(canceled.id, "Review Light");
      assert.equal(writes.length, beforeCancel);
      const picked = await pickReviewDiffTheme(configuration, host, { pick: async items => items.find(item => item.label === "Custom Theme") });
      assert.deepEqual(picked, { id: "publisher.theme-id", label: "Custom Theme" });
      assert.equal(choice, "publisher.theme-id");
      assert.strictEqual(host.getColorTheme(), dark);

      // Different scopes can share a workbench color but have different colors
      // and font styles in the selected theme. Preserve those distinctions.
      extension.setCustomTokenColors({ textMateRules: [
        { scope: "keyword", settings: { foreground: "#FF0000", fontStyle: "bold" } },
        { scope: "entity.name.function", settings: { foreground: "#00FF00", fontStyle: "italic" } },
      ] });
      const syntax = create();
      await syntax.update();
      const keyword = syntax.tokenClass(extension.resolveScopes([["source.ts", "keyword"]]));
      const fn = syntax.tokenClass(extension.resolveScopes([["source.ts", "entity.name.function"]]));
      assert.notEqual(keyword, fn);
      syntax.flushTokenStyles();
      const css = [...document.querySelectorAll("style")].map(style => style.textContent).join("\n");
      assert.match(css, /color: #ff0000 !important/);
      assert.match(css, /font-weight: bold !important/);
      assert.match(css, /color: #00ff00 !important/);
      assert.match(css, /font-style: italic !important/);
      // The real editor contribution styles both halves independently and
      // never adds decorations to an ordinary editor sharing the same model.
      await import(native + "review/services/reviewDiffSyntax.ts");
      const { EditorExtensionsRegistry } = await import(native + "editor/browser/editorExtensions.ts");
      const { Range } = await import(native + "editor/common/core/range.ts");
      const contribution = EditorExtensionsRegistry.getEditorContributions().find(item => item.id === "review.diffSyntax").ctor;
      const model = { getLanguageId: () => "typescript", getLineContent: () => "const greet", getLineMaxColumn: () => 12, getLineCount: () => 1, getFullModelRange: () => new Range(1, 1, 1, 12), uri: URI.parse("test:/sample.ts") };
      extension.setCustomSemanticTokenColors({ enabled: true, rules: { "function.declaration": "#123456" } });
      let released = 0;
      const semanticProvider = {
        getLegend: () => ({ tokenTypes: ["function"], tokenModifiers: ["declaration"] }),
        provideDocumentSemanticTokens: async () => ({ resultId: "fixture", data: new Uint32Array([0, 6, 5, 0, 1]) }),
        releaseDocumentSemanticTokens: () => { released++; },
      };
      const provider = { onDidChange: Event.None, has: () => true, orderedGroups: () => [[semanticProvider]] };
      const languages = { documentSemanticTokensProvider: provider, documentRangeSemanticTokensProvider: provider };
      const grammar = { createTokenizer: async () => ({ tokenizeLine: () => ({ ruleStack: null, tokens: [
        { startIndex: 0, endIndex: 6, scopes: ["source.ts", "keyword"] },
        { startIndex: 6, endIndex: 11, scopes: ["source.ts", "entity.name.function"] },
      ] }) }) };
      function editor() {
        let values = [];
        let created = 0;
        let rendered;
        const next = () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("syntax did not render")), 2000);
          rendered = () => { clearTimeout(timer); resolve(); };
        });
        return {
          get values() { return values; }, get created() { return created; }, next,
          getModel: () => model, getVisibleRanges: () => [new Range(1, 1, 1, 12)],
          onDidChangeModel: Event.None, onDidChangeModelLanguage: Event.None, onDidChangeModelContent: Event.None,
          onDidScrollChange: Event.None, onDidLayoutChange: Event.None,
          createDecorationsCollection: () => { created++; return { clear: () => { values = []; }, set: next => { values = next; rendered?.(); } }; },
        };
      }
      const original = editor(), modified = editor(), ordinary = editor();
      const first = original.next(), second = modified.next();
      const left = new contribution(original, syntax, grammar, languages, configuration);
      const right = new contribution(modified, syntax, grammar, languages, configuration);
      const regular = new contribution(ordinary, host, grammar, languages, configuration);
      await Promise.all([first, second]);
      assert.equal(ordinary.created, 0);
      assert.equal(original.values.length, 3);
      assert.equal(released, 2);
      assert.match([...document.querySelectorAll("style")].map(style => style.textContent).join("\n"), /color: #123456 !important/);
      assert.deepEqual(original.values, modified.values);
      assert.notEqual(original.values[0].options.inlineClassName, original.values[1].options.inlineClassName);
      const oldClass = original.values[0].options.inlineClassName;
      const restyled = original.next();
      await applyReviewDiffThemeChoice(configuration, { id: "Review Light", label: "Whiteboard Light" });
      await restyled;
      assert.notEqual(original.values[0].options.inlineClassName, oldClass);
      left.dispose(); right.dispose(); regular.dispose();
      assert.deepEqual(original.values, []);
      assert.deepEqual(modified.values, []);
      syntax.dispose();

      // Removing an extension does not prevent opening diffs.
      choice = "uninstalled-theme";
      const fallback = create();
      await fallback.update();
      assert.equal(fallback.getColorTheme().settingsId, "Review Dark");
      fallback.dispose();
    } finally {
      for (const theme of themes) theme.dispose();
      configurations.dispose();
      hostChanges.dispose();
      dom.window.close();
    }
  `,
    ],
    {
      cwd: desktopRoot,
      env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.test.json" },
      stdio: "pipe",
    },
  );
});
