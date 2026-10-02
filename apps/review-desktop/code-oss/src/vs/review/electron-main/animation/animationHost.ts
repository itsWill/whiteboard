import { randomUUID, randomBytes } from 'node:crypto';
import { BrowserWindow, session, webContents } from 'electron';
import { Sequencer } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import type { ReviewAnimationCommand, ReviewAnimationCreate, ReviewAnimationEvent } from '../../common/reviewProtocol.js';
import { animationDocument } from './animationDocument.js';

interface RunningAnimation {
	id: string;
	owner: BrowserWindow;
	window: BrowserWindow;
	keys: Set<string>;
	playing: boolean;
	failed: boolean;
	pending: Set<(reason: Error) => void>;
	timer?: ReturnType<typeof setInterval>;
	ownerClosed: () => void;
	cleanup: () => void;
}

/** Each guest owns a memory-only session and renderer; no preload or IPC is exposed. */
export class AnimationHost extends Disposable {
	private readonly commands = new Sequencer();
	private readonly creations = new Sequencer();
	private readonly animations = new Map<string, RunningAnimation>();
	private readonly events = this._register(new Emitter<ReviewAnimationEvent>());
	readonly onEvent = this.events.event;

	create(owner: BrowserWindow, source: ReviewAnimationCreate): Promise<string> {
		return this.creations.queue(() => this.createGuest(owner, source));
	}

	private async createGuest(owner: BrowserWindow, source: ReviewAnimationCreate): Promise<string> {
		if (owner.isDestroyed()) throw new Error('The Whiteboard window is closed.');
		if (!source || typeof source.html !== 'string' || typeof source.css !== 'string' || typeof source.js !== 'string' ||
			!Array.isArray(source.keys) || source.keys.length > 100 || source.keys.some(key => typeof key !== 'string' || key.length > 100) ||
			Buffer.byteLength(JSON.stringify(source)) > 1024 * 1024) throw new Error('Invalid animation source.');
		if ([...this.animations.values()].filter(entry => entry.owner === owner).length >= 8) throw new Error('Eight animations are already open. Close a board before starting another.');
		this.size(source.width, source.height);
		if (!Number.isFinite(source.pixelRatio) || source.pixelRatio < 1 || source.pixelRatio > 3) throw new Error('Invalid animation pixel ratio.');
		this.theme(source.theme);
		const id = randomUUID();
		const guestSession = session.fromPartition(`whiteboard-animation-${id}`, { cache: false });
		// Deny all traffic, including implicit proxy bypasses for loopback.
		await guestSession.setProxy({ mode: 'fixed_servers', proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9', proxyBypassRules: '<-loopback>' });
		if (owner.isDestroyed()) throw new Error('The Whiteboard window is closed.');
		guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		guestSession.setPermissionCheckHandler(() => false);
		guestSession.setDevicePermissionHandler(() => false);
		guestSession.on('will-download', event => event.preventDefault());
		const url = `https://${id}.whiteboard.invalid/`;
		const nonce = randomBytes(24).toString('base64');
		const html = animationDocument(nonce);
		let served = false;
		guestSession.protocol.handle('https', request => {
			if (request.url !== url || served) return new Response(null, { status: 403 });
			served = true;
			return new Response(html, { headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`,
				'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), bluetooth=(), payment=()',
				'X-DNS-Prefetch-Control': 'off',
			} });
		});
		guestSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== url || details.resourceType !== 'mainFrame' }));
		const window = new BrowserWindow({
			show: false, width: source.width, height: source.height, frame: false, focusable: false, skipTaskbar: true,
			webPreferences: { session: guestSession, offscreen: { deviceScaleFactor: source.pixelRatio }, sandbox: true, contextIsolation: true,
				nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
				webSecurity: true, webviewTag: false, devTools: false, backgroundThrottling: false, spellcheck: false, disableDialogs: true },
		});
		const guest = window.webContents;
		guest.setFrameRate(30);
		guest.setAudioMuted(true);
		guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
		guest.setWindowOpenHandler(() => ({ action: 'deny' }));
		guest.on('will-navigate', event => event.preventDefault());
		guest.on('will-frame-navigate', event => event.preventDefault());
		guest.on('will-redirect', event => event.preventDefault());
		guest.on('will-attach-webview', event => event.preventDefault());
		const entry: RunningAnimation = { id, owner, window, keys: new Set(source.keys), playing: false, failed: false, pending: new Set(),
			ownerClosed: () => this.destroy(owner, id), cleanup: () => { guestSession.webRequest.onBeforeRequest(null); guestSession.protocol.unhandle('https'); } };
		this.animations.set(id, entry);
		owner.once('closed', entry.ownerClosed);
		owner.webContents.once('did-start-loading', entry.ownerClosed);
		guest.on('render-process-gone', () => this.fail(entry, 'Animation stopped. Press Restart to try again.'));
		guest.on('paint', (_event, _rect, image) => {
			if (!entry.failed) this.events.fire({ id, type: 'frame', image: image.toDataURL({ scaleFactor: source.pixelRatio }) });
		});
		let lastSelection = 0;
		let lastRegions = 0;
		guest.on('console-message', details => {
			if (entry.failed || details.message.length > 32768 || !details.message.startsWith('whiteboard-animation:')) return;
			const now = Date.now();
			try {
				const message = JSON.parse(details.message.slice('whiteboard-animation:'.length));
				if (message.type === 'selected' && typeof message.key === 'string' && entry.keys.has(message.key)) {
					if (now - lastSelection < 50) return;
					lastSelection = now;
					void this.pause(entry).catch(() => {});
					this.events.fire({ id, type: 'selected', key: message.key });
				} else if (message.type === 'regions' && Array.isArray(message.regions) && message.regions.length <= 100) {
					if (now - lastRegions < 50) return;
					lastRegions = now;
					const regions = message.regions.filter((region: Record<string, unknown>) => region && entry.keys.has(region.key as string) && ['x', 'y', 'width', 'height'].every(key => typeof region[key] === 'number' && Number.isFinite(region[key]) && Math.abs(region[key] as number) <= 10000) && (region.width as number) > 0 && (region.height as number) > 0);
					this.events.fire({ id, type: 'regions', regions });
				} else if (message.type === 'error' && typeof message.message === 'string') this.fail(entry, message.message.slice(0, 1000));
			} catch { /* Guest output is untrusted. */ }
		});
		try {
			await this.bounded(entry, window.loadURL(url));
			const pid = guest.getOSProcessId();
			if (!pid || webContents.getAllWebContents().some(other => other !== guest && other.getOSProcessId() === pid)) throw new Error('Animation renderer could not be isolated.');
			await this.bounded(entry, guest.executeJavaScript(`window.__whiteboardAnimation.init(${JSON.stringify({ html: source.html, css: source.css, js: source.js, keys: source.keys })},${JSON.stringify(source.theme)}); void 0`));
			if (entry.failed || !this.animations.has(id)) throw new Error('Animation failed to initialize.');
			entry.timer = setInterval(() => {
				if (!entry.failed) void this.bounded(entry, guest.executeJavaScript('void 0')).catch(() => {});
			}, 1000);
			return id;
		} catch (error) {
			this.destroy(owner, id);
			throw error;
		}
	}

	command(owner: BrowserWindow, id: string, command: ReviewAnimationCommand): Promise<void> {
		return this.commands.queue(() => this.applyCommand(owner, id, command));
	}

	private async applyCommand(owner: BrowserWindow, id: string, command: ReviewAnimationCommand): Promise<void> {
		const entry = this.animations.get(id);
		if (!entry || entry.owner !== owner || entry.failed) return;
		const guest = entry.window.webContents;
		switch (command.type) {
			case 'play':
				for (const other of this.animations.values()) if (other !== entry && other.playing) { await this.pause(other); this.events.fire({ id: other.id, type: 'paused' }); }
				entry.playing = true;
				await this.bounded(entry, guest.executeJavaScript('window.__whiteboardAnimation.play(); void 0'));
				guest.invalidate();
				break;
			case 'pause': await this.pause(entry); break;
			case 'resize': this.size(command.width, command.height); entry.window.setContentSize(command.width, command.height); break;
			case 'theme': this.theme(command.theme); await this.bounded(entry, guest.executeJavaScript(`window.__whiteboardAnimation.theme(${JSON.stringify(command.theme)}); void 0`)); break;
			case 'input': {
				const event = command.event;
				if (['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel'].includes(event.type)) {
					if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
					guest.sendInputEvent({ type: event.type as 'mouseMove' | 'mouseDown' | 'mouseUp', x: Math.round(event.x!), y: Math.round(event.y!), button: event.button ?? 'left', clickCount: 1, ...(event.type === 'mouseWheel' ? { deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 } : {}) });
				} else if (['keyDown', 'keyUp', 'char'].includes(event.type) && typeof event.keyCode === 'string' && event.keyCode.length < 40) {
					guest.sendInputEvent({ type: event.type as 'keyDown' | 'keyUp' | 'char', keyCode: ({ ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space' } as Record<string, string>)[event.keyCode] ?? event.keyCode, modifiers: event.modifiers?.filter((value): value is 'shift' | 'control' | 'alt' | 'meta' => ['shift', 'control', 'alt', 'meta'].includes(value)) });
				}
				break;
			}
		}
	}

	destroy(owner: BrowserWindow, id: string): void {
		const entry = this.animations.get(id);
		if (!entry || entry.owner !== owner) return;
		this.animations.delete(id);
		for (const cancel of entry.pending) cancel(new Error('Animation was closed.'));
		entry.pending.clear();
		clearInterval(entry.timer);
		owner.removeListener('closed', entry.ownerClosed);
		if (!owner.webContents.isDestroyed()) owner.webContents.removeListener('did-start-loading', entry.ownerClosed);
		if (!entry.window.isDestroyed()) {
			entry.window.webContents.once('destroyed', entry.cleanup);
			entry.window.destroy();
		} else entry.cleanup();
	}

	private async pause(entry: RunningAnimation): Promise<void> {
		entry.playing = false;
		if (!entry.failed) await this.bounded(entry, entry.window.webContents.executeJavaScript('window.__whiteboardAnimation.pause(); void 0'));
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
		clearInterval(entry.timer);
		const guest = entry.window.webContents;
		if (!guest.isDestroyed() && !guest.isCrashed()) {
			const pid = guest.getOSProcessId();
			// Never terminate a process used by any other webContents.
			if (pid && !webContents.getAllWebContents().some(other => other !== guest && other.getOSProcessId() === pid)) guest.forcefullyCrashRenderer();
		}
		this.events.fire({ id: entry.id, type: 'error', message });
	}

	private size(width: number, height: number): void {
		if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 2048 || height < 1 || height > 1200) throw new Error('Invalid animation dimensions.');
	}

	private theme(value: ReviewAnimationCreate['theme']): void {
		if (!value || typeof value.dark !== 'boolean' || ['background', 'foreground', 'muted', 'accent', 'border', 'font'].some(key => typeof value[key as keyof typeof value] !== 'string' || String(value[key as keyof typeof value]).length > 500)) throw new Error('Invalid animation theme.');
	}

	override dispose(): void {
		for (const entry of this.animations.values()) this.destroy(entry.owner, entry.id);
		super.dispose();
	}
}
