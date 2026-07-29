import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number.parseInt(process.env.PORT ?? '4178', 10);
const host = '127.0.0.1';

const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/src/app.js', ['src/app.js', 'text/javascript; charset=utf-8']],
  ['/src/analyze.js', ['src/analyze.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', `http://${host}`).pathname;
  const route = routes.get(pathname);

  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');

  if (!route) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const [file, contentType] = route;
  response.writeHead(200, { 'Content-Type': contentType });
  createReadStream(join(root, file)).pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(`Literature Reader running at http://${host}:${port}\n`);
});
