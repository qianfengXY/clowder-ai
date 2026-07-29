import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'src'), { recursive: true });

await Promise.all([
  cp(join(root, 'index.html'), join(output, 'index.html')),
  cp(join(root, 'styles.css'), join(output, 'styles.css')),
  cp(join(root, 'src', 'app.js'), join(output, 'src', 'app.js')),
  cp(join(root, 'src', 'analyze.js'), join(output, 'src', 'analyze.js')),
]);

process.stdout.write(`Built Literature Reader to ${output}\n`);
