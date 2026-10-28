// Static file server for the app plus mounted fixture directories.
// Served on 127.0.0.1, which browsers treat as a secure context, so WebXR works over plain HTTP.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.svg': 'image/svg+xml',
};

/**
 * @param {string} root         directory served at /
 * @param {Object<string,string>} mounts  URL prefix (ending in /) -> directory, or exact URL path -> file
 */
export async function startServer({ root, mounts = {} }) {
	const delays = new Map(); // URL prefix -> ms, see setDelay()
	const server = createServer(async (req, res) => {
		let pathname;
		try {
			pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
		} catch {
			res.writeHead(400).end();
			return;
		}
		for (const [prefix, ms] of delays) {
			if (pathname.startsWith(prefix)) await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
		}

		let base = resolve(root);
		let file = join(base, pathname === '/' ? 'index.html' : pathname);
		for (const [prefix, target] of Object.entries(mounts)) {
			if (prefix.endsWith('/') && pathname.startsWith(prefix)) {
				base = resolve(target);
				file = join(base, pathname.slice(prefix.length));
				break;
			}
			if (pathname === prefix) {
				base = resolve(target, '..');
				file = resolve(target);
				break;
			}
		}

		if (file !== base && !file.startsWith(base + sep)) {
			res.writeHead(403).end();
			return;
		}
		try {
			const data = await readFile(file);
			res.writeHead(200, {
				'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
				'content-length': data.length,
				'cache-control': 'no-store',
			});
			res.end(data);
		} catch {
			res.writeHead(404).end();
		}
	});

	await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}/`,
		// Slows down responses under a URL prefix (0 removes the delay), e.g. to watch a preview stage.
		setDelay(prefix, ms) {
			if (ms > 0) delays.set(prefix, ms);
			else delays.delete(prefix);
		},
		close: () => new Promise((resolveClose) => {
			server.closeAllConnections();
			server.close(resolveClose);
		}),
	};
}
