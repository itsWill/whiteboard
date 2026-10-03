import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, webContents, type WebFrameMain } from 'electron';
import { Sequencer } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { ReviewAnimationCommand, ReviewAnimationCreate, ReviewAnimationEvent, ReviewAnimationHandle } from '../../common/reviewProtocol.js';
import { animationRuntime, animationWebviewDocument } from './animationDocument.js';

interface RunningAnimation {
	id: string;
	owner: BrowserWindow;
	frame?: WebFrameMain;
	process?: { pid: number; creationTime: number; frameId: number };
	keys: Set<string>;
	playing: boolean;
	failed: boolean;
	pending: Set<(reason: Error) => void>;
	commands: Sequencer;
	ready: Promise<void>;
	resolve(): void;
	reject(reason: Error): void;
	timer?: ReturnType<typeof setTimeout>;
	cleanup(): void;
}

/** Code OSS webview container with an opaque animation iframe and a supervised guest process. */
export class AnimationHost extends Disposable {
	private readonly playback = new Sequencer();
	private readonly animations = new Map<string, RunningAnimation>();
	private readonly events = this._register(new Emitter<ReviewAnimationEvent>());
	readonly onEvent = this.events.event;

	eventsFor(owner: BrowserWindow): Event<ReviewAnimationEvent> {
		return Event.filter(this.onEvent, event => this.animations.get(event.id)?.owner === owner);
	}

	async create(owner: BrowserWindow, source: ReviewAnimationCreate): Promise<ReviewAnimationHandle> {
		if (owner.isDestroyed()) throw new Error('The Whiteboard window is closed.');
		if (!source || typeof source.html !== 'string' || typeof source.css !== 'string' || typeof source.js !== 'string' ||
			!Array.isArray(source.keys) || source.keys.length > 100 || source.keys.some(key => typeof key !== 'string' || key.length > 100) ||
			Buffer.byteLength(JSON.stringify(source)) > 1024 * 1024) throw new Error('Invalid animation source.');
		this.theme(source.theme);
		const id = randomUUID();
		const html = animationWebviewDocument(id);
		const ready = Promise.withResolvers<void>();
		// A frame can fail/close before the client's first Play arrives.
		void ready.promise.catch(() => {});
		const contents = owner.webContents;
		const closed = () => this.destroy(owner, id);
		const navigating = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
			if (event.isMainFrame && !event.isSameDocument) closed();
			else if (!event.isSameDocument && entry.process && event.frame && !event.frame.isDestroyed() && event.frame === entry.frame) {
				// about:blank can skip the cancellable navigation event.
				this.fail(entry, 'Animation tried to navigate away. Press Restart.');
			}
		};
		const blockNavigation = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
			if (entry.frame && event.frame === entry.frame) event.preventDefault();
		};
		const loaded = () => {
			if (entry.frame || entry.failed) return;
			const frame = contents.mainFrame.framesInSubtree.find(frame => !frame.isDestroyed() && frame.name === `whiteboard-animation-${id}` && frame.url === 'about:srcdoc');
			if (frame) void this.initialize(entry, frame, source);
		};
		const entry: RunningAnimation = {
			id, owner, keys: new Set(source.keys), playing: false, failed: false, pending: new Set(), commands: new Sequencer(),
			ready: ready.promise, resolve: ready.resolve, reject: ready.reject,
			cleanup: () => {
				owner.removeListener('closed', closed);
				if (!contents.isDestroyed()) {
					contents.removeListener('did-start-navigation', navigating);
					contents.removeListener('will-frame-navigate', blockNavigation);
					contents.removeListener('did-frame-finish-load', loaded);
				}
			},
		};
		this.animations.set(id, entry);
		owner.once('closed', closed);
		contents.on('did-start-navigation', navigating);
		contents.on('will-frame-navigate', blockNavigation);
		contents.on('did-frame-finish-load', loaded);
		entry.timer = setTimeout(() => this.fail(entry, 'Animation could not start. Press Restart.'), 10000);
		return { id, html };
	}

	private async initialize(entry: RunningAnimation, frame: WebFrameMain, source: ReviewAnimationCreate): Promise<void> {
		entry.frame = frame;
		clearTimeout(entry.timer);
		try {
			// Check actual Chromium placement before any authored JavaScript runs.
			const pid = frame.osProcessId;
			const metric = app.getAppMetrics().find(metric => metric.pid === pid && metric.type === 'Tab');
			let root = frame;
			while (root.parent && root.parent !== entry.owner.webContents.mainFrame) root = root.parent;
			if (root === frame || !root.url.startsWith('vscode-webview://')) throw new Error('Animation is not inside a webview.');
			const belongsToWebview = (other: WebFrameMain) => {
				for (let current: WebFrameMain | null = other; current; current = current.parent) if (current === root) return true;
				return false;
			};
			if (!metric || pid === process.pid || this.frames().some(other => other.osProcessId === pid && !belongsToWebview(other))) throw new Error('Animation renderer could not be isolated.');
			entry.process = { pid, creationTime: metric.creationTime, frameId: root.frameTreeNodeId };
			await this.bounded(entry, frame.executeJavaScript(`${animationRuntime}
window.__whiteboardAnimation.init(${JSON.stringify({ html: source.html, css: source.css, keys: source.keys })},${JSON.stringify(source.theme)}); void 0`));
			// Execute authored JS through the supervised native bridge. The document
			// itself permits no script loads, so it exposes no reusable CSP nonce.
			await this.bounded(entry, frame.executeJavaScript(`(() => {\n${source.js}\n})(); void 0`));
			await this.bounded(entry, frame.executeJavaScript(`window.__whiteboardAnimation.initialized();
new Promise(resolve => {
  let first = 0, second = 0;
  const finish = () => { clearTimeout(timer); cancelAnimationFrame(first); cancelAnimationFrame(second); resolve(); };
  // Hidden/occluded windows can suspend animation frames; readiness must still settle.
  const timer = setTimeout(finish, 100);
  first = requestAnimationFrame(() => { second = requestAnimationFrame(finish); });
})`));
			if (!this.animations.has(entry.id) || entry.failed) return;
			entry.resolve();
			void this.poll(entry);
		} catch (error) {
			this.fail(entry, error instanceof Error ? error.message : 'Animation failed to initialize.');
		}
	}

	/** Pull bounded helper events. Guest code cannot flood a custom IPC/console channel. */
	private async poll(entry: RunningAnimation): Promise<void> {
		if (entry.failed || !this.animations.has(entry.id)) return;
		try {
			// Validate in the renderer before Electron serializes a result across IPC.
			// The page can tamper with its globals, so even read() is untrusted.
			const encoded: unknown = await this.bounded(entry, entry.frame!.executeJavaScript(`(() => {
				const value = window.__whiteboardAnimation.read();
				return typeof value === 'string' && value.length <= 32768 ? value : null;
			})()`));
			if (typeof encoded !== 'string' || encoded.length > 32768) throw new Error('Invalid animation event payload.');
			const messages: unknown = JSON.parse(encoded);
			if (!entry.failed && this.animations.has(entry.id) && Array.isArray(messages) && messages.length <= 3) {
				for (const message of messages) {
					if (!message || typeof message !== 'object') continue;
					if (message.type === 'selected' && typeof message.key === 'string' && entry.keys.has(message.key)) {
						this.events.fire({ id: entry.id, type: 'selected', key: message.key });
					} else if (message.type === 'regions' && Array.isArray(message.regions) && message.regions.length <= 100) {
						const regions = message.regions.filter((region: Record<string, unknown>) => region && entry.keys.has(region.key as string) && ['x', 'y', 'width', 'height'].every(key => typeof region[key] === 'number' && Number.isFinite(region[key]) && Math.abs(region[key] as number) <= 10000) && (region.width as number) > 0 && (region.height as number) > 0);
						this.events.fire({ id: entry.id, type: 'regions', regions });
					} else if (message.type === 'error' && typeof message.message === 'string') this.fail(entry, message.message.slice(0, 1000));
				}
			}
		} catch { this.fail(entry, 'Animation stopped responding. Press Restart.'); }
		if (!entry.failed && this.animations.has(entry.id)) entry.timer = setTimeout(() => { void this.poll(entry); }, 100);
	}

	command(owner: BrowserWindow, id: string, command: ReviewAnimationCommand): Promise<void> {
		const entry = this.animations.get(id);
		if (!entry || entry.owner !== owner) return Promise.reject(new Error('Animation is no longer available.'));
		return entry.commands.queue(async () => {
			// The bootstrap has its own deadline; a slow guest must not hold the
			// command queues of other animations or windows.
			await entry.ready;
			this.assertRunning(entry);
			switch (command.type) {
				case 'play':
					await this.playback.queue(async () => {
						this.assertRunning(entry);
						for (const other of this.animations.values()) {
							if (other === entry || !other.playing) continue;
							try { await this.pause(other); }
							catch { this.fail(other, 'Animation stopped responding. Press Restart.'); }
							this.events.fire({ id: other.id, type: 'paused' });
						}
						this.assertRunning(entry);
						entry.playing = true;
						await this.bounded(entry, entry.frame!.executeJavaScript('window.__whiteboardAnimation.play(); void 0'));
					});
					break;
				case 'pause': await this.pause(entry); break;
				case 'theme': this.theme(command.theme); await this.bounded(entry, entry.frame!.executeJavaScript(`window.__whiteboardAnimation.theme(${JSON.stringify(command.theme)}); void 0`)); break;
			}
		});
	}

	private assertRunning(entry: RunningAnimation): void {
		if (entry.failed || !this.animations.has(entry.id) || !entry.frame || entry.frame.isDestroyed()) throw new Error('Animation is no longer available. Press Restart.');
	}

	destroy(owner: BrowserWindow, id: string): void {
		const entry = this.animations.get(id);
		if (!entry || entry.owner !== owner) return;
		this.animations.delete(id);
		entry.failed = true;
		const reason = new Error('Animation was closed.');
		entry.reject(reason);
		for (const cancel of entry.pending) cancel(reason);
		entry.pending.clear();
		clearTimeout(entry.timer);
		try { this.terminate(entry); } finally { entry.cleanup(); }
	}

	private async pause(entry: RunningAnimation): Promise<void> {
		entry.playing = false;
		if (!entry.failed) await this.bounded(entry, entry.frame!.executeJavaScript('window.__whiteboardAnimation.pause(); void 0'));
	}

	private async bounded<T>(entry: RunningAnimation, operation: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancel: ((reason: Error) => void) | undefined;
		try {
			return await Promise.race([operation, new Promise<never>((_, reject) => {
				cancel = reject;
				entry.pending.add(cancel);
				timer = setTimeout(() => { this.fail(entry, 'Animation stopped responding. Press Restart.'); reject(new Error('Animation timed out.')); }, 3000);
			})]);
		} finally { clearTimeout(timer); if (cancel) entry.pending.delete(cancel); }
	}

	private fail(entry: RunningAnimation, message: string): void {
		if (entry.failed || !this.animations.has(entry.id)) return;
		entry.failed = true;
		entry.playing = false;
		clearTimeout(entry.timer);
		const reason = new Error(message);
		entry.reject(reason);
		for (const cancel of entry.pending) cancel(reason);
		this.terminate(entry);
		this.events.fire({ id: entry.id, type: 'error', message });
	}

	private frames(): WebFrameMain[] {
		return webContents.getAllWebContents().filter(contents => !contents.isDestroyed()).flatMap(contents => contents.mainFrame.framesInSubtree).filter(frame => !frame.isDestroyed());
	}

	private terminate(entry: RunningAnimation): void {
		const identity = entry.process;
		if (!identity) return;
		// Removing an iframe alone does not stop an infinite loop. Check the process
		// birth time as well as PID, even if React already detached the frame.
		const metric = app.getAppMetrics().find(metric => metric.pid === identity.pid && metric.creationTime === identity.creationTime && metric.type === 'Tab');
		if (!metric || identity.pid === process.pid) return;
		let shared = true;
		try { shared = this.frames().some(frame => {
			if (frame.osProcessId !== identity.pid) return false;
			for (let current: WebFrameMain | null = frame; current; current = current.parent) if (current.frameTreeNodeId === identity.frameId) return false;
			return true;
		}); } catch { return; /* An incomplete frame inventory cannot authorize a kill. */ }
		if (!shared) {
			try { process.kill(identity.pid, 'SIGKILL'); } catch { /* The guest may already have exited. */ }
		}
	}

	private theme(value: ReviewAnimationCreate['theme']): void {
		if (!value || typeof value.dark !== 'boolean' || ['background', 'foreground', 'muted', 'accent', 'border', 'font'].some(key => typeof value[key as keyof typeof value] !== 'string' || String(value[key as keyof typeof value]).length > 500)) throw new Error('Invalid animation theme.');
	}

	override dispose(): void {
		for (const entry of this.animations.values()) this.destroy(entry.owner, entry.id);
		super.dispose();
	}
}
