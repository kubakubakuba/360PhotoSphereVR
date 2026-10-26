// Minimal Chromium launcher + DevTools protocol client (no dependencies, Node >= 22).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome() {
	if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
	for (const name of CANDIDATES) {
		try {
			return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
		} catch { /* try the next one */ }
	}
	throw new Error(`Chromium not found (tried ${CANDIDATES.join(', ')}). Set CHROME_BIN.`);
}

export async function launchBrowser({ headed = false } = {}) {
	const userDataDir = mkdtempSync(join(tmpdir(), 'pano-e2e-'));
	const args = [
		headed ? null : '--headless=new',
		'--no-sandbox',
		'--remote-debugging-port=0',
		`--user-data-dir=${userDataDir}`,
		'--use-angle=swiftshader',
		'--enable-unsafe-swiftshader',
		'--window-size=1280,800',
		'--hide-scrollbars',
		'--no-first-run',
		'--no-default-browser-check',
		'about:blank',
	].filter(Boolean);
	// Own process group, so closing can also stop Chromium's helper processes.
	const proc = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

	const browserUrl = await new Promise((resolve, reject) => {
		let output = '';
		const timer = setTimeout(() => reject(new Error('Chromium did not start within 20 s')), 20000);
		proc.stderr.on('data', (chunk) => {
			output += chunk;
			const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		proc.on('exit', (code) => reject(new Error(`Chromium exited early (code ${code})`)));
	});

	const port = new URL(browserUrl).port;
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = await Page.connect(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);

	return {
		page,
		async close() {
			page.close();
			const exited = new Promise((resolve) => (proc.exitCode !== null ? resolve() : proc.once('exit', resolve)));
			try {
				process.kill(-proc.pid, 'SIGTERM');
			} catch {
				proc.kill();
			}
			await exited;
			try {
				// Chromium helper processes can still be flushing the profile for a moment.
				rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
			} catch (error) {
				console.warn(`Could not remove ${userDataDir}: ${error.message}`);
			}
		},
	};
}

export class Page {
	static async connect(url) {
		const ws = new WebSocket(url);
		await new Promise((resolve, reject) => {
			ws.addEventListener('open', resolve, { once: true });
			ws.addEventListener('error', reject, { once: true });
		});
		return new Page(ws);
	}

	constructor(ws) {
		this.ws = ws;
		this.nextId = 0;
		this.pending = new Map();
		this.listeners = new Map();
		this.console = []; // { type, text }
		this.errors = []; // uncaught exceptions and console.error output

		ws.addEventListener('message', (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined) {
				const entry = this.pending.get(message.id);
				if (!entry) return;
				this.pending.delete(message.id);
				if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
				else entry.resolve(message.result);
				return;
			}
			for (const listener of this.listeners.get(message.method) || []) listener(message.params);
		});

		this.on('Runtime.consoleAPICalled', ({ type, args }) => {
			const text = args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
			this.console.push({ type, text });
			if (type === 'error') this.errors.push(text);
		});
		this.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
			this.errors.push(exceptionDetails.exception?.description || exceptionDetails.text);
		});
	}

	send(method, params = {}) {
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			this.pending.set(id, { resolve, reject, method });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	on(method, listener) {
		if (!this.listeners.has(method)) this.listeners.set(method, []);
		this.listeners.get(method).push(listener);
	}

	once(method) {
		return new Promise((resolve) => {
			const listener = (params) => {
				this.listeners.set(method, this.listeners.get(method).filter((l) => l !== listener));
				resolve(params);
			};
			this.on(method, listener);
		});
	}

	async init({ scripts = [] } = {}) {
		await Promise.all([this.send('Runtime.enable'), this.send('Page.enable'), this.send('DOM.enable')]);
		for (const source of scripts) await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
	}

	// evaluate(fn, ...args) runs fn in the page; evaluate('expression') evaluates a string.
	async evaluate(fn, ...args) {
		const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
		const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) {
			throw new Error(`In page: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
		}
		return result.result.value;
	}

	async goto(url) {
		const loaded = this.once('Page.loadEventFired');
		await this.send('Page.navigate', { url });
		await loaded;
	}

	async reload() {
		const loaded = this.once('Page.loadEventFired');
		await this.send('Page.reload');
		await loaded;
	}

	async screenshot() {
		const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
		return Buffer.from(data, 'base64');
	}

	async click(selector) {
		const point = await this.evaluate((sel) => {
			const element = document.querySelector(sel);
			if (!element) throw new Error(`No element for ${sel}`);
			element.scrollIntoView({ block: 'center', inline: 'center' });
			const rect = element.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		}, selector);
		for (const type of ['mousePressed', 'mouseReleased']) {
			await this.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
		}
	}

	async press(key, code = key, keyCode = 0) {
		for (const type of ['keyDown', 'keyUp']) {
			await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode });
		}
	}

	async setFiles(selector, files) {
		const { root } = await this.send('DOM.getDocument');
		const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
		await this.send('DOM.setFileInputFiles', { nodeId, files });
	}

	async dragFiles(files, { x = 640, y = 400, drop = true } = {}) {
		const data = { items: [], files, dragOperationsMask: 1 };
		await this.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
		await this.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
		if (drop) await this.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
	}

	// Polls an async predicate until it returns a truthy value.
	async waitFor(predicate, { timeout = 15000, interval = 250, message = 'condition' } = {}) {
		const start = Date.now();
		let last;
		while (Date.now() - start < timeout) {
			try {
				last = await predicate();
				if (last) return last;
			} catch (error) {
				last = error;
			}
			await sleep(interval);
		}
		throw new Error(`Timed out after ${timeout} ms waiting for ${message}${last instanceof Error ? ` (${last.message})` : ''}`);
	}

	close() {
		this.ws.close();
	}
}
