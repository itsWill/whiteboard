/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onUnexpectedError } from '../../base/common/errors.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../platform/environment/common/environment.js';
import { IExtensionResourceLoaderService } from '../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { editorForeground, editorSelectionForeground } from '../../platform/theme/common/colorRegistry.js';
import { isDark } from '../../platform/theme/common/theme.js';
import type { TokenStyleData } from '../../platform/theme/common/tokenClassificationRegistry.js';
import { Extensions, IThemeService, type IColorTheme, type IThemingRegistry } from '../../platform/theme/common/themeService.js';
import { IExtensionService } from '../../workbench/services/extensions/common/extensions.js';
import { generateColorThemeCSS } from '../../workbench/services/themes/browser/colorThemeCss.js';
import { ColorThemeData } from '../../workbench/services/themes/common/colorThemeData.js';
import { IWorkbenchThemeService, type IWorkbenchColorTheme } from '../../workbench/services/themes/common/workbenchThemeService.js';
import { currentReviewDiffThemeChoice } from '../browser/reviewThemeChoice.js';
import { REVIEW_DIFF_THEME_SETTING } from '../common/reviewConfigurationDefaults.js';

let nextScope = 0;

/** A theme service and stylesheet owned by one diff, never the workbench. */
export class ReviewDiffTheme extends Disposable implements IThemeService {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<IColorTheme>());
	readonly onDidColorThemeChange = this.changed.event;
	private readonly style: HTMLStyleElement;
	private readonly scope = `review-diff-theme-${++nextScope}`;
	private readonly themes = new Map<string, Promise<ColorThemeData>>();
	private theme: IWorkbenchColorTheme;
	private readonly tokenRules = new Map<string, { name: string; rule: string }>();
	private readonly tokenStyle: HTMLStyleElement;
	private tokenRulesDirty = false;
	private nextToken = 0;
	private generation = 0;
	private disposed = false;

	constructor(
		containers: readonly HTMLElement[],
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkbenchThemeService private readonly host: IWorkbenchThemeService,
		@IExtensionResourceLoaderService private readonly loader: IExtensionResourceLoaderService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IEnvironmentService private readonly environment: IEnvironmentService,
	) {
		super();
		this.theme = host.getColorTheme();
		this.style = containers[0].ownerDocument.createElement('style');
		this.tokenStyle = containers[0].ownerDocument.createElement('style');
		containers[0].ownerDocument.head.append(this.style, this.tokenStyle);
		for (const container of containers) container.classList.add(this.scope);
		this._register(toDisposable(() => {
			this.style.remove();
			this.tokenStyle.remove();
			for (const container of containers) container.classList.remove(this.scope);
		}));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if ([REVIEW_DIFF_THEME_SETTING, 'workbench.colorCustomizations', 'editor.tokenColorCustomizations', 'editor.semanticTokenColorCustomizations'].some(key => event.affectsConfiguration(key))) {
				this.themes.clear();
				void this.update().catch(onUnexpectedError);
			}
		}));
		this._register(host.onDidColorThemeChange(() => { void this.update().catch(onUnexpectedError); }));
		const registry = Registry.as<IThemingRegistry>(Extensions.ThemingContribution);
		this._register(registry.onThemingParticipantAdded(() => { void this.update().catch(onUnexpectedError); }));
	}

	getColorTheme(): IWorkbenchColorTheme { return this.theme; }
	getFileIconTheme() { return this.host.getFileIconTheme(); }
	get onDidFileIconThemeChange() { return this.host.onDidFileIconThemeChange; }
	getProductIconTheme() { return this.host.getProductIconTheme(); }
	get onDidProductIconThemeChange() { return this.host.onDidProductIconThemeChange; }

	async update(): Promise<void> {
		const generation = ++this.generation;
		const choice = currentReviewDiffThemeChoice(this.configurationService, this.host);
		const theme = await this.loadTheme(choice.id);
		if (this.disposed || generation !== this.generation) return;
		this.theme = theme;
		this.tokenRules.clear();
		this.tokenStyle.textContent = '';
		const registry = Registry.as<IThemingRegistry>(Extensions.ThemingContribution);
		// @scope also contains participant rules that normally style every editor.
		const css = generateColorThemeCSS(theme, ':scope', registry.getThemingParticipants(), this.environment).code;
		// Encoded token IDs belong to the workbench theme. Syntax decorations
		// resolve original TextMate scopes and semantic token types instead.
		this.style.textContent = `@scope (.${this.scope}) {
${css.replaceAll('.monaco-workbench', ':scope')}
:scope { color-scheme: ${isDark(theme.type) ? 'dark' : 'light'}; }
.monaco-editor .view-lines [class*="mtk"] { color: ${theme.getColor(editorForeground)}; font-style: normal; font-weight: normal; text-decoration: none; }
${theme.getColor(editorSelectionForeground) ? `.monaco-editor .view-line span.inline-selected-text { color: ${theme.getColor(editorSelectionForeground)} !important; }` : ''}
.review-files-editor-tree { background: var(--vscode-sideBar-background); color: var(--vscode-foreground); }
}`;
		this.changed.fire(theme);
	}

	private loadTheme(choice: string): Promise<ColorThemeData> {
		let pending = this.themes.get(choice);
		if (!pending) {
			pending = (async () => {
				await this.extensions.whenInstalledExtensionsRegistered();
				const registered = (await this.host.getColorThemes()).find(theme => theme.settingsId === choice) ?? this.host.getColorTheme();
				if (!(registered instanceof ColorThemeData)) throw new Error(`Diff theme unavailable: ${choice}`);
				if (!registered.location) return registered;
				// Load a private copy; the workbench can customize its registered themes.
				const theme = ColorThemeData.createUnloadedTheme(registered.id);
				theme.label = registered.label;
				theme.settingsId = registered.settingsId;
				theme.location = registered.location;
				await theme.ensureLoaded(this.loader);
				theme.setCustomColors(this.configurationService.getValue('workbench.colorCustomizations') ?? {});
				theme.setCustomTokenColors(this.configurationService.getValue('editor.tokenColorCustomizations') ?? {});
				theme.setCustomSemanticTokenColors(this.configurationService.getValue('editor.semanticTokenColorCustomizations') ?? {});
				return theme;
			})();
			this.themes.set(choice, pending);
			void pending.catch(() => this.themes.delete(choice));
		}
		return pending;
	}

	/** The class is editor-local; it never changes shared text-model tokens. */
	tokenClass(style: Partial<TokenStyleData> | undefined, semantic = false): string {
		const declarations: string[] = [];
		if (style?.foreground) declarations.push(`color: ${style.foreground} !important`);
		else if (!semantic) declarations.push(`color: ${this.theme.getColor(editorForeground)} !important`);
		for (const [property, value, on, off] of [
			['font-style', style?.italic, 'italic', 'normal'],
			['font-weight', style?.bold, 'bold', 'normal'],
		] as const) {
			if (value !== undefined || !semantic) declarations.push(`${property}: ${value ? on : off} !important`);
		}
		if (!semantic || style?.underline !== undefined || style?.strikethrough !== undefined) {
			declarations.push(`text-decoration: ${[style?.underline && 'underline', style?.strikethrough && 'line-through'].filter(Boolean).join(' ') || 'none'} !important`);
		}
		const css = declarations.join(';');
		const key = `${semantic}:${css}`;
		let entry = this.tokenRules.get(key);
		if (!entry) {
			const name = `${this.scope}-token-${++this.nextToken}`;
			entry = { name, rule: `.${name}${semantic ? `.${name}` : ''} { ${css} }` };
			this.tokenRules.set(key, entry);
			this.tokenRulesDirty = true;
		}
		return entry.name;
	}

	flushTokenStyles(): void {
		if (!this.tokenRulesDirty || this.disposed) return;
		this.tokenRulesDirty = false;
		this.tokenStyle.textContent = `@scope (.${this.scope}) { ${[...this.tokenRules.values()].map(entry => entry.rule).join('\n')} }`;
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}
