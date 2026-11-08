// tsc only compiles .ts, so the download worker (plain JS, loaded by URL at runtime) is copied
// next to the compiled code it is resolved from.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'download');

fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'download', 'download-worker.js'), path.join(out, 'download-worker.js'));
