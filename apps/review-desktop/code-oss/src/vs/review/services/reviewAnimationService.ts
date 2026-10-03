import { getWindow } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { IMainProcessService } from '../../platform/ipc/common/mainProcessService.js';
import { IWebviewService } from '../../workbench/contrib/webview/browser/webview.js';
import { REVIEW_DESKTOP_CHANNEL } from '../common/reviewDesktopBootstrap.js';
import type { ReviewAnimationCommand, ReviewAnimationCreate, ReviewAnimationEvent, ReviewAnimationHandle, ReviewAnimationMount } from '../common/reviewProtocol.js';

/** Uses the existing Whiteboard channel and Code OSS webview service. */
export class ReviewAnimationService extends Disposable {
	private readonly surfaces = new Map<string, HTMLElement>();
	constructor(
		@IMainProcessService private readonly mainProcess: IMainProcessService,
		@IWebviewService private readonly webviews: IWebviewService,
	) { super(); }

	private get channel() { return this.mainProcess.getChannel(REVIEW_DESKTOP_CHANNEL); }

	create(source: ReviewAnimationCreate): Promise<ReviewAnimationHandle> {
		return this.channel.call('animationCreate', source);
	}

	mount(handle: ReviewAnimationHandle, container: HTMLElement, title: string): ReviewAnimationMount {
		const view = this.webviews.createWebviewElement({
			origin: handle.id,
			providedViewType: 'whiteboard.animation',
			title,
			options: { disableServiceWorker: true, enableFindWidget: false, tryRestoreScrollPosition: false },
			contentOptions: { allowScripts: true, allowForms: false, enableCommandUris: false, localResourceRoots: [], portMapping: [] },
			extension: undefined,
		});
		// Keep the themed board visible while the webview's blank documents load.
		// Opacity preserves layout and animation frames during initialization.
		const surface = container.ownerDocument.createElement('div');
		surface.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0';
		container.appendChild(surface);
		this.surfaces.set(handle.id, surface);
		try {
			view.setHtml(handle.html);
			view.mountTo(surface, getWindow(container));
		} catch (error) {
			view.dispose();
			surface.remove();
			this.surfaces.delete(handle.id);
			throw error;
		}
		return {
			// State-preserving moves keep the iframe and its paused runtime alive.
			move: target => target.moveBefore(surface, null),
			dispose: () => {
				this.surfaces.delete(handle.id);
				view.dispose();
				surface.remove();
			},
		};
	}

	async command(id: string, command: ReviewAnimationCommand): Promise<void> {
		await this.channel.call('animationCommand', { id, command });
		// Native readiness includes theme application and an opportunity to paint.
		const surface = this.surfaces.get(id);
		if (surface) surface.style.opacity = '1';
	}

	destroy(id: string): Promise<void> {
		return this.channel.call('animationDestroy', { id });
	}

	subscribe(listener: (event: ReviewAnimationEvent) => void) {
		return this.channel.listen<ReviewAnimationEvent>('animationEvent')(listener);
	}
}
