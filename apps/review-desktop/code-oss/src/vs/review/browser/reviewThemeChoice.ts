/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConfigurationTarget, IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { REVIEW_DIFF_THEME_SETTING } from '../common/reviewConfigurationDefaults.js';
import type { ReviewDiffThemeChoice } from '../common/reviewProtocol.js';
import { ColorScheme } from '../../platform/theme/common/theme.js';
import { IWorkbenchThemeService, type IWorkbenchColorTheme } from '../../workbench/services/themes/common/workbenchThemeService.js';
import { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../platform/theme/common/themeService.js';

/**
 * The theme choice, shared by the `review.selectTheme` quick pick and the
 * Settings canvas tab. This module registers nothing, so the canvas part can
 * import it without pulling in a contribution.
 */

const REVIEW_DARK_THEME = 'Review Dark';
const REVIEW_LIGHT_THEME = 'Review Light';

export type ReviewThemeChoice = 'dark' | 'light' | 'system';

export function currentReviewThemeChoice(configurationService: IConfigurationService, themeService: IThemeService): ReviewThemeChoice {
	if (configurationService.getValue<boolean>('window.autoDetectColorScheme')) {
		return 'system';
	}

	// The theme service applies a theme change asynchronously, so a read taken
	// right after applyReviewThemeChoice still reports the previous theme. The
	// configured name is authoritative whenever it names a Review theme.
	const configured = configurationService.getValue<string>('workbench.colorTheme');
	if (configured === REVIEW_LIGHT_THEME) {
		return 'light';
	}
	if (configured === REVIEW_DARK_THEME) {
		return 'dark';
	}

	const type = themeService.getColorTheme().type;
	return type === ColorScheme.LIGHT || type === ColorScheme.HIGH_CONTRAST_LIGHT ? 'light' : 'dark';
}

export async function applyReviewThemeChoice(configurationService: IConfigurationService, choice: ReviewThemeChoice): Promise<void> {
	switch (choice) {
		case 'dark':
			await configurationService.updateValue('window.autoDetectColorScheme', false, ConfigurationTarget.USER);
			await configurationService.updateValue('workbench.colorTheme', REVIEW_DARK_THEME, ConfigurationTarget.USER);
			break;
		case 'light':
			await configurationService.updateValue('window.autoDetectColorScheme', false, ConfigurationTarget.USER);
			await configurationService.updateValue('workbench.colorTheme', REVIEW_LIGHT_THEME, ConfigurationTarget.USER);
			break;
		case 'system':
			await configurationService.updateValue('window.autoDetectColorScheme', true, ConfigurationTarget.USER);
			await configurationService.updateValue('workbench.preferredDarkColorTheme', REVIEW_DARK_THEME, ConfigurationTarget.USER);
			await configurationService.updateValue('workbench.preferredLightColorTheme', REVIEW_LIGHT_THEME, ConfigurationTarget.USER);
			break;
	}
}

// Capture the initial theme once per workbench. An unset preference must not
// keep following later editor theme changes within this application run.
const initialDiffThemes = new WeakMap<IWorkbenchThemeService, string>();

export function currentReviewDiffThemeChoice(configurationService: IConfigurationService, themeService: IWorkbenchThemeService, installed: readonly IWorkbenchColorTheme[] = []): ReviewDiffThemeChoice {
	let initial = initialDiffThemes.get(themeService);
	if (!initial) {
		initial = themeService.getColorTheme().settingsId;
		initialDiffThemes.set(themeService, initial);
	}
	const configured = configurationService.getValue<string | null>(REVIEW_DIFF_THEME_SETTING);
	// Preserve preferences saved by the original Light/Dark selector.
	const id = configured === 'light' ? REVIEW_LIGHT_THEME : configured === 'dark' ? REVIEW_DARK_THEME : configured || initial;
	return { id, label: installed.find(theme => theme.settingsId === id)?.label ?? (themeService.getColorTheme().settingsId === id ? themeService.getColorTheme().label : id) };
}

export async function applyReviewDiffThemeChoice(configurationService: IConfigurationService, choice: ReviewDiffThemeChoice): Promise<ReviewDiffThemeChoice> {
	await configurationService.updateValue(REVIEW_DIFF_THEME_SETTING, choice.id, ConfigurationTarget.USER);
	return choice;
}

export async function pickReviewDiffTheme(configurationService: IConfigurationService, themeService: IWorkbenchThemeService, quickInputService: IQuickInputService): Promise<ReviewDiffThemeChoice> {
	const themes = await themeService.getColorThemes();
	const current = currentReviewDiffThemeChoice(configurationService, themeService, themes);
	const items = themes.map(theme => ({
		id: theme.settingsId,
		label: theme.label,
		description: theme.settingsId === current.id ? 'Current' : undefined,
	})).sort((a, b) => a.label.localeCompare(b.label));
	const selected = await quickInputService.pick(items, {
		title: 'Diff theme',
		placeHolder: 'Search installed themes for all diffs',
		activeItem: items.find(item => item.id === current.id),
	});
	return selected ? applyReviewDiffThemeChoice(configurationService, { id: selected.id, label: selected.label }) : current;
}
