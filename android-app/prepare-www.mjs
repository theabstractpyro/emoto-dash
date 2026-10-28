// Copies the web dash (the repository root) into www/, which Capacitor packages into the APK.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const www = join(here, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const entry of ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons']) {
  cpSync(join(root, entry), join(www, entry), { recursive: true });
}
console.log(`Copied web app into ${www}`);
