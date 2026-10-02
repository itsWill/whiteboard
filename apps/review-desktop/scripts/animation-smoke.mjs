import { createRequire } from 'node:module';

const { build } = createRequire(new URL('../../../packages/review-protocol/package.json', import.meta.url))('esbuild');

import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Run with an Electron executable. All test state stays under the temporary root.
const executable = process.argv[2];

if (!executable) throw new Error('Usage: node animation-smoke.mjs /path/to/Electron');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const temporary = await mkdtemp(path.join(os.tmpdir(), 'whiteboard-animation-'));

await build({ entryPoints: [path.join(root, 'apps/review-desktop/code-oss/src/vs/review/electron-main/animation/animationHost.ts')], outfile: path.join(temporary, 'host.cjs'), platform: 'node', format: 'cjs', bundle: true, external: ['electron'] });

await writeFile(path.join(temporary, 'main.cjs'), String.raw`
const { app, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AnimationHost } = require('./host.cjs');
app.setPath('userData', __dirname + '/profile');
app.commandLine.appendSwitch('disable-gpu');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (test, label) => { const deadline = Date.now()+12000; while (Date.now()<deadline) { if (await test()) return; await delay(50); } throw new Error('Timed out: '+label); };
app.whenReady().then(async () => {
 const owner = new BrowserWindow({show:false, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await owner.loadURL('data:text/html,host');
 const host = new AnimationHost(); const events = []; host.onEvent(event => events.push(event));
 const theme = {background:'#fff',foreground:'#222',muted:'#666',accent:'#55f',border:'#ccc',font:'sans-serif',dark:false};
 const source = {html:'<button data-animation-key="packet" id="packet">Packet</button><input id="value" value="a">',css:'button{margin:20px}',js:'animation.onFrame(({elapsedMs}) => document.querySelector("#packet").textContent = String(Math.floor(elapsedMs)));',keys:['packet'],width:500,height:300,pixelRatio:2,theme};
 let requests = 0; const server = http.createServer((_req,res) => { requests++; res.end('secret'); }); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const id = await host.create(owner, source);
 const guest = webContents.getAllWebContents().find(w=>w.getURL().includes(id));
 assert(guest); assert.notEqual(guest.getOSProcessId(),owner.webContents.getOSProcessId());
 assert.equal(await guest.executeJavaScript('typeof process'), 'undefined');
 assert.equal(await guest.executeJavaScript('typeof require'), 'undefined');
 assert.equal(await guest.executeJavaScript('typeof RTCPeerConnection'), 'undefined');
 assert.equal(await guest.executeJavaScript('try { localStorage.getItem("secret"); "allowed" } catch { "blocked" }'), 'blocked');
 await host.command(owner,id,{type:'play'});
 await until(()=>events.some(e=>e.id===id&&e.type==='frame'),'paint frame');
 const png = Buffer.from(events.find(e=>e.id===id&&e.type==='frame').image.split(',')[1], 'base64');
 assert.equal(png.readUInt32BE(16),1000); assert.equal(png.readUInt32BE(20),600);
 await until(()=>events.some(e=>e.id===id&&e.type==='regions'&&e.regions.some(r=>r.key==='packet')), 'code link regions');
 await delay(200);
 await host.command(owner,id,{type:'pause'});
 const elapsed = await guest.executeJavaScript('animation.elapsedMs');
 await delay(200); assert.equal(await guest.executeJavaScript('animation.elapsedMs'), elapsed);
 await host.command(owner,id,{type:'play'}); await delay(100); assert(await guest.executeJavaScript('animation.elapsedMs') > elapsed);
 await host.command(owner,id,{type:'input',event:{type:'mouseDown',x:45,y:35,button:'left'}});
 await host.command(owner,id,{type:'input',event:{type:'mouseUp',x:45,y:35,button:'left'}});
 await until(()=>events.some(e=>e.id===id&&e.type==='selected'&&e.key==='packet'),'mouse selection');
 await guest.executeJavaScript('fetch("http://127.0.0.1:'+server.address().port+'/").catch(()=>{}); new Image().src="http://127.0.0.1:'+server.address().port+'/image"; void 0');
 await delay(200); assert.equal(requests,0);
 await guest.executeJavaScript('location.href="http://127.0.0.1:'+server.address().port+'/navigate"; void 0');
 await delay(200); assert.equal(requests,0); assert(guest.getURL().includes(id));
 const id2 = await host.create(owner, source);
 const guest2 = webContents.getAllWebContents().find(w=>w.getURL().includes(id2));
 assert.notEqual(guest.getOSProcessId(),guest2.getOSProcessId());
 await host.command(owner,id,{type:'play'}); await host.command(owner,id2,{type:'play'});
 const stopped = await guest.executeJavaScript('animation.elapsedMs'); await delay(150); assert.equal(await guest.executeJavaScript('animation.elapsedMs'),stopped);
 console.log('Paused renderer memory (KiB):', JSON.stringify(app.getAppMetrics().filter(m=>[guest.getOSProcessId(),guest2.getOSProcessId()].includes(m.pid)).map(m=>({pid:m.pid,memory:m.memory}))));
 void guest.executeJavaScript('while(true) {}').catch(()=>{});
 await until(()=>events.some(e=>e.id===id&&e.type==='error'),'hung renderer stopped');
 assert(guest.isCrashed()); assert.equal(await owner.webContents.executeJavaScript('1+1'),2); assert.equal(await guest2.executeJavaScript('1+1'),2);
 void guest2.executeJavaScript('while(true) {}').catch(()=>{});
 const pendingPause = host.command(owner,id2,{type:'pause'}).catch(error=>error);
 await delay(50); const closedAt=Date.now(); host.destroy(owner,id2);
 assert.match((await pendingPause).message,/closed/); assert(Date.now()-closedAt<1000);
 host.destroy(owner,id); await until(()=>guest.isDestroyed() && guest2.isDestroyed(), 'renderer cleanup');
 host.dispose(); owner.destroy(); server.close();
 console.log('PASS: independent renderers, paint/input, selection, pause/resume, offline boundary, watchdog and cleanup');
 app.exit(0);
}).catch(error=>{console.error(error); app.exit(1);});
setTimeout(()=>{console.error('Smoke test timed out');app.exit(1)},45000).unref();
`);

const child = spawn(executable, [path.join(temporary, 'main.cjs')], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });

child.on('exit', code => { process.exitCode = code ?? 1; });

console.log('Animation smoke artifacts:', temporary);
