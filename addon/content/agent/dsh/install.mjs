/** Install this local bridge through the Desktop profile, preserving existing entries. */
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, rename, lstat, symlink, readlink, copyFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [home, runtime] = process.argv.slice(2);
if (!home || !runtime) throw new Error('Expected Harness home and Desktop runtime directory');
const require = createRequire(join(runtime, 'package.json'));
const YAML = require('yaml');
const plugin = dirname(fileURLToPath(import.meta.url));
const name = '@zotero-paper-translator/dsh-bridge';
const profile = join(resolve(home), 'profiles', 'desktop');
const packagePath = join(profile, 'package.json'), patchPath = join(profile, 'cordis.patch.yml');
const originalPackage = await readFile(packagePath, 'utf8');
const originalPatch = await readFile(patchPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const packageData = JSON.parse(originalPackage);
if (packageData.name !== 'dsh-profile-desktop') throw new Error('The target is not an initialized Desktop profile; open Desktop once first');
const patch = YAML.parse(originalPatch) || [];
if (!Array.isArray(patch)) throw new Error('Desktop patch must contain a YAML sequence');
const existing = patch.flatMap(item => item?.insert || []).find(item => item.id === 'zotero-paper-translator-bridge');
const entry = { id: 'zotero-paper-translator-bridge', name, config: { directory: join(resolve(home), 'storages', 'zotero-paper-translator-bridge') } };
if (existing && existing.name !== name) throw new Error('Desktop already has an unrelated entry with the bridge id');
if (existing) Object.assign(existing, entry); else patch.push({ insert: [entry] });
packageData.dependencies ||= {};
packageData.dependencies[name] = 'file:' + plugin;
const link = join(profile, 'node_modules', '@zotero-paper-translator', 'dsh-bridge');
await mkdir(dirname(link), { recursive: true });
const info = await lstat(link).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
if (info && (!info.isSymbolicLink() || resolve(dirname(link), await readlink(link)) !== plugin)) {
  throw new Error('The Desktop bridge package path already exists; remove the old bridge installation before moving it');
}
const backup = join(profile, 'zotero-bridge-backups', new Date().toISOString().replaceAll(':', '-'));
await mkdir(backup, { recursive: true, mode: 0o700 });
await copyFile(packagePath, join(backup, 'package.json'));
await writeFile(join(backup, 'cordis.patch.yml'), originalPatch, { mode: 0o600 });
async function atomic(path, text) { await writeFile(path + '.zotero.tmp', text, { mode: 0o600 }); await rename(path + '.zotero.tmp', path); }
if (await readFile(packagePath, 'utf8') !== originalPackage
    || await readFile(patchPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) !== originalPatch) {
  throw new Error('Desktop profile changed during installation; retry after its current operation finishes');
}
try {
  if (!info) await symlink(plugin, link, process.platform === 'win32' ? 'junction' : 'dir');
  await atomic(packagePath, JSON.stringify(packageData, null, 2) + '\n');
  await atomic(patchPath, YAML.stringify(patch));
} catch (error) {
  await atomic(packagePath, originalPackage);
  await atomic(patchPath, originalPatch);
  if (!info) await unlink(link).catch(() => {});
  throw error;
}
console.log(JSON.stringify({ installed: true, backup }));
