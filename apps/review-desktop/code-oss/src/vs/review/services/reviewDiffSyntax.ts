/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IGrammar, IToken, StateStack } from 'vscode-textmate';
import { RunOnceScheduler, timeout } from '../../base/common/async.js';
import { CancellationTokenSource } from '../../base/common/cancellation.js';
import { Color } from '../../base/common/color.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { Disposable, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../editor/browser/editorExtensions.js';
import type { IEditorContribution } from '../../editor/common/editorCommon.js';
import { Range } from '../../editor/common/core/range.js';
import type { IModelDeltaDecoration } from '../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../editor/common/services/languageFeatures.js';
import { getDocumentSemanticTokens, getDocumentRangeSemanticTokens, isSemanticTokens } from '../../editor/contrib/semanticTokens/common/getSemanticTokens.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';
import { ITextMateTokenizationService } from '../../workbench/services/textMate/browser/textMateTokenizationFeature.js';
import { ColorThemeData } from '../../workbench/services/themes/common/colorThemeData.js';
import { ReviewDiffTheme } from './reviewDiffTheme.js';

/**
 * Text models and encoded token IDs are shared with ordinary editors. Keep
 * their tokens intact and apply the chosen diff theme through editor-owned
 * decorations, using the original grammar scopes and semantic token types.
 */
class ReviewDiffSyntax extends Disposable implements IEditorContribution {
	static readonly ID = 'review.diffSyntax';

	constructor(
		editor: ICodeEditor,
		@IThemeService theme: IThemeService,
		@ITextMateTokenizationService grammars: ITextMateTokenizationService,
		@ILanguageFeaturesService languages: ILanguageFeaturesService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		if (theme instanceof ReviewDiffTheme) {
			this._register(new DiffSyntaxDecorations(editor, theme, grammars, languages, configuration));
		}
	}
}

class DiffSyntaxDecorations extends Disposable {
	private readonly decorations;
	private readonly scheduler;
	private readonly semanticRequest = this._register(new MutableDisposable<CancellationTokenSource>());
	private readonly semanticChange = this._register(new MutableDisposable());
	private grammar: Promise<IGrammar | null> | undefined;
	private readonly lines: IToken[][] = [];
	private state: StateStack | null = null;
	private readonly scopeClasses = new Map<string, string>();
	private semantic: { range: Range; type: string; modifiers: string[] }[] = [];
	private generation = 0;
	private renderGeneration = 0;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly theme: ReviewDiffTheme,
		private readonly grammars: ITextMateTokenizationService,
		private readonly languages: ILanguageFeaturesService,
		private readonly configuration: IConfigurationService,
	) {
		super();
		this.decorations = editor.createDecorationsCollection();
		this._register(toDisposable(() => this.decorations.clear()));
		this.scheduler = this._register(new RunOnceScheduler(() => { void this.render().catch(onUnexpectedError); }, 20));
		this._register(editor.onDidChangeModel(() => this.reset()));
		this._register(editor.onDidChangeModelLanguage(() => this.reset()));
		this._register(editor.onDidChangeModelContent(() => this.reset()));
		this._register(editor.onDidScrollChange(() => this.scheduler.schedule()));
		this._register(editor.onDidLayoutChange(() => this.scheduler.schedule()));
		this._register(languages.documentSemanticTokensProvider.onDidChange(() => this.reset()));
		this._register(languages.documentRangeSemanticTokensProvider.onDidChange(() => this.reset()));
		this._register(theme.onDidColorThemeChange(() => {
			this.scopeClasses.clear();
			this.scheduler.schedule();
			void this.loadSemanticTokens().catch(onUnexpectedError);
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('editor.semanticHighlighting')) this.reset();
		}));
		this.reset();
	}

	private reset(): void {
		this.generation++;
		this.renderGeneration++;
		this.lines.length = 0;
		this.state = null;
		this.grammar = undefined;
		this.semantic = [];
		this.scopeClasses.clear();
		this.decorations.clear();
		this.semanticRequest.value?.cancel();
		this.semanticRequest.clear();
		this.semanticChange.clear();
		this.scheduler.schedule();
		void this.loadSemanticTokens().catch(onUnexpectedError);
	}

	private async render(): Promise<void> {
		const model = this.editor.getModel();
		const visible = this.editor.getVisibleRanges();
		if (!model || !visible.length) return;
		const generation = ++this.renderGeneration;
		this.grammar ??= this.grammars.createTokenizer(model.getLanguageId());
		const grammar = await this.grammar;
		if (generation !== this.renderGeneration) return;
		const lastLine = visible[visible.length - 1].endLineNumber;
		const maxLength = this.configuration.getValue<number>('editor.maxTokenizationLineLength', { resource: model.uri, overrideIdentifier: model.getLanguageId() }) ?? 20000;
		// Keep grammar state across lines (including folded lines). Yield during
		// large files so scrolling and switching themes remain responsive.
		let started = Date.now();
		while (grammar && this.lines.length < lastLine) {
			const text = model.getLineContent(this.lines.length + 1);
			const result = text.length <= maxLength ? grammar.tokenizeLine(text, this.state, 10) : undefined;
			this.lines.push(result?.tokens ?? []);
			this.state = result?.ruleStack ?? this.state;
			if (Date.now() - started >= 8) {
				await timeout(0);
				if (generation !== this.renderGeneration) return;
				started = Date.now();
			}
		}
		const theme = this.theme.getColorTheme();
		const decorations: IModelDeltaDecoration[] = [];
		for (const range of visible) {
			for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
				for (const token of this.lines[line - 1] ?? []) {
					const key = token.scopes.join('\n');
					let className = this.scopeClasses.get(key);
					if (!className) {
						className = this.theme.tokenClass(theme instanceof ColorThemeData ? theme.resolveScopes([token.scopes]) : undefined);
						this.scopeClasses.set(key, className);
					}
					decorations.push({
						range: new Range(line, token.startIndex + 1, line, Math.min(token.endIndex + 1, model.getLineMaxColumn(line))),
						options: { description: 'review-diff-syntax', inlineClassName: className, inlineClassNameAffectsLetterSpacing: true },
					});
				}
			}
		}
		for (const token of this.semantic) {
			if (!visible.some(range => Range.areIntersecting(range, token.range))) continue;
			const style = theme.getTokenStyleMetadata(token.type, token.modifiers, model.getLanguageId());
			if (!style) continue;
			const color = style.foreground ? theme.tokenColorMap[style.foreground] : undefined;
			decorations.push({ range: token.range, options: {
				description: 'review-diff-semantic-syntax',
				inlineClassName: this.theme.tokenClass({ ...style, foreground: color ? Color.fromHex(color) : undefined }, true),
				inlineClassNameAffectsLetterSpacing: true,
			} });
		}
		this.theme.flushTokenStyles();
		this.decorations.set(decorations);
	}

	private async loadSemanticTokens(): Promise<void> {
		this.semanticRequest.value?.cancel();
		const request = new CancellationTokenSource();
		this.semanticRequest.value = request;
		this.semantic = [];
		this.semanticChange.clear();
		const model = this.editor.getModel();
		if (!model) return;
		const enabled = this.configuration.getValue<{ enabled?: boolean | string }>('editor.semanticHighlighting', { resource: model.uri, overrideIdentifier: model.getLanguageId() })?.enabled;
		if (!(typeof enabled === 'boolean' ? enabled : this.theme.getColorTheme().semanticHighlighting)) return;
		const generation = this.generation;
		const result = this.languages.documentSemanticTokensProvider.has(model)
			? await getDocumentSemanticTokens(this.languages.documentSemanticTokensProvider, model, null, null, request.token)
			: await getDocumentRangeSemanticTokens(this.languages.documentRangeSemanticTokensProvider, model, model.getFullModelRange(), request.token);
		try {
			if (request.token.isCancellationRequested || generation !== this.generation || !result?.tokens || !isSemanticTokens(result.tokens)) return;
			const legend = result.provider.getLegend();
			const data = result.tokens.data;
			let line = 1, column = 1;
			for (let i = 0; i + 4 < data.length; i += 5) {
				column = data[i] === 0 ? column + data[i + 1] : data[i + 1] + 1;
				line += data[i];
				const type = legend.tokenTypes[data[i + 3]];
				if (!type || line > model.getLineCount()) continue;
				this.semantic.push({ range: new Range(line, column, line, column + data[i + 2]), type,
					modifiers: legend.tokenModifiers.filter((_, bit) => (data[i + 4] & (1 << bit)) !== 0) });
			}
			if ('onDidChange' in result.provider && result.provider.onDidChange) {
				this.semanticChange.value = result.provider.onDidChange(() => { void this.loadSemanticTokens().catch(onUnexpectedError); });
			}
			this.scheduler.schedule();
		} finally {
			if (result?.tokens && 'releaseDocumentSemanticTokens' in result.provider) result.provider.releaseDocumentSemanticTokens(result.tokens.resultId);
		}
	}

	override dispose(): void {
		this.generation++;
		this.renderGeneration++;
		this.semanticRequest.value?.cancel();
		super.dispose();
	}
}

registerEditorContribution(ReviewDiffSyntax.ID, ReviewDiffSyntax, EditorContributionInstantiation.Eager);
