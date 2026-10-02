/** Host-owned bootstrap. Source is delivered only after process isolation is checked. */
export function animationDocument(nonce: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--background);color:var(--foreground);font-family:var(--font)}
*{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button{background:var(--background);border:1px solid var(--border);border-radius:6px;padding:8px;cursor:pointer}
[data-animation-key]{cursor:pointer}[data-animation-selected]{outline:2px solid var(--accent);outline-offset:3px}
</style></head><body><main id="stage"></main><script nonce="${nonce}">${runtime}</script></body></html>`;
}

const runtime = String.raw`
(() => {
  const nonce = document.currentScript.nonce;
  const log = console.info.bind(console);
  const send = (type, data = {}) => log('whiteboard-animation:' + JSON.stringify({type, ...data}));
  const raf = requestAnimationFrame.bind(window);
  const cancel = cancelAnimationFrame.bind(window);
  const frames = new Set();
  const explicitRegions = new Map();
  const pausedAnimations = new Set();
  let playing = false, elapsedMs = 0, previous = 0, frame = 0, keys = new Set();
  let lastRegions = '', lastRegionTime = 0;
  const publishRegions = () => {
    const regions = [...explicitRegions.values()], seen = new Set(explicitRegions.keys());
    for (const element of document.querySelectorAll('[data-animation-key]')) {
      const key = element.getAttribute('data-animation-key');
      if (!keys.has(key) || seen.has(key)) continue;
      seen.add(key);
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) regions.push({key, x:rect.x, y:rect.y, width:rect.width, height:rect.height});
    }
    const encoded = JSON.stringify(regions);
    if (encoded !== lastRegions) { lastRegions = encoded; send('regions', {regions}); }
  };
  window.addEventListener('resize', () => { lastRegions = ''; publishRegions(); });
  // No networking escape through WebRTC (which does not use fetch/CSP connect-src).
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false });
  }
  const report = (error) => { setPlaying(false); send('error', {message: String(error && error.message || error).slice(0, 1000)}); };
  const tick = (now) => {
    if (!playing) return;
    const deltaMs = previous ? Math.min(now - previous, 100) : 0;
    previous = now;
    elapsedMs += deltaMs;
    try { for (const callback of frames) callback({elapsedMs, deltaMs}); }
    catch (error) { report(error); return; }
    if (now - lastRegionTime > 100) { lastRegionTime = now; publishRegions(); }
    frame = raf(tick);
  };
  function setPlaying(next) {
    if (playing === next) return;
    playing = next;
    previous = 0;
    if (next) {
      lastRegions = '';
      for (const animation of pausedAnimations) animation.play();
      pausedAnimations.clear();
      frame = raf(tick);
    } else {
      cancel(frame);
      for (const animation of document.getAnimations()) {
        if (animation.playState === 'running' || animation.pending) { pausedAnimations.add(animation); animation.pause(); }
      }
    }
  }
  const theme = (value) => {
    for (const name of ['background','foreground','muted','accent','border','font']) document.documentElement.style.setProperty('--' + name, value[name]);
    document.documentElement.style.colorScheme = value.dark ? 'dark' : 'light';
    window.dispatchEvent(new Event('animationthemechange'));
  };
  const select = (key) => {
    if (!keys.has(key)) return;
    setPlaying(false);
    publishRegions();
    for (const element of document.querySelectorAll('[data-animation-selected]')) element.removeAttribute('data-animation-selected');
    for (const element of document.querySelectorAll('[data-animation-key]')) if (element.dataset.animationKey === key) element.setAttribute('data-animation-selected', '');
    send('selected', {key});
  };
  document.addEventListener('click', event => {
    const element = event.target instanceof Element && event.target.closest('[data-animation-key]');
    if (element) select(element.getAttribute('data-animation-key'));
  });
  window.addEventListener('error', event => report(event.message));
  window.addEventListener('unhandledrejection', event => report(event.reason));
  Object.defineProperty(window, 'animation', {value: Object.freeze({
    onFrame(callback) { frames.add(callback); return () => frames.delete(callback); },
    region(key, bounds) {
      if (!keys.has(key)) return;
      if (bounds === null) { explicitRegions.delete(key); return; }
      if (bounds && ['x','y','width','height'].every(name => Number.isFinite(bounds[name]))) explicitRegions.set(key, {key, x:bounds.x, y:bounds.y, width:bounds.width, height:bounds.height});
    },
    select,
    get elapsedMs() { return elapsedMs; },
  })});
  let initialized = false;
  Object.defineProperty(window, '__whiteboardAnimation', {value: Object.freeze({
    init(source, colors) {
      if (initialized) return;
      initialized = true;
      keys = new Set(source.keys);
      theme(colors);
      document.getElementById('stage').innerHTML = source.html;
      const style = document.createElement('style'); style.textContent = source.css; document.head.append(style);
      const script = document.createElement('script'); script.nonce = nonce; script.textContent = source.js; document.body.append(script);
      // Initial authored CSS/WAAPI animations must obey the host's first Play.
      for (const animation of document.getAnimations()) { pausedAnimations.add(animation); animation.pause(); }
      for (const callback of frames) callback({elapsedMs: 0, deltaMs: 0});
    },
    play() { setPlaying(true); },
    pause() { setPlaying(false); },
    theme,
  })});
})();`;
