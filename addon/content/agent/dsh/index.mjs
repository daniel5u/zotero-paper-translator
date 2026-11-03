/** Local file-queue handoff; uses the running Desktop's Session services. */
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, unlink, lstat, chmod } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';

export const name = 'zotero-paper-translator-bridge';
export const inject = ['sessionController', 'workspaceController', 'connection'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROUTE = '/api/zotero-bridge';

async function json(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

/** Owns queue files, the Desktop navigation channel and their disposal. */
export async function apply(ctx, config) {
  if (!isAbsolute(config?.directory || '')) throw new Error('Zotero bridge requires an absolute queue directory');
  const directory = config.directory;
  const inbox = join(directory, 'requests'), outbox = join(directory, 'responses');
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await mkdir(outbox, { recursive: true, mode: 0o700 });
  for (const folder of [directory, inbox, outbox]) await chmod(folder, 0o700);
  const instance = randomUUID();
  const statusPath = join(directory, 'status.json');
  const registryPath = join(directory, 'conversations.json');
  let registry;
  try { registry = JSON.parse(await readFile(registryPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; registry = {}; }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Invalid Zotero conversation registry');
  let disposed = false, sequence = Promise.resolve();
  const openings = new Map(), listeners = new Set();
  let revision = 0;
  const firstOpening = after => [...openings.values()].find(item => item.revision > after);
  const wake = () => { for (const notify of [...listeners]) notify(); };

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE + '/next', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const data = await request.json();
      const after = data.instance === instance && Number.isSafeInteger(data.after) ? data.after : 0;
      const item = firstOpening(after);
      if (item) return Response.json({ id: item.id, sessionId: item.sessionId, revision: item.revision, instance });
      return new Promise(resolveReply => {
        let timer;
        const done = value => {
          clearTimeout(timer); listeners.delete(notify);
          request.signal.removeEventListener('abort', abort);
          resolveReply(Response.json({ ...value, instance }));
        };
        const notify = () => {
          const current = firstOpening(after);
          if (current) done({ id: current.id, sessionId: current.sessionId, revision: current.revision });
          else if (disposed) done({});
        };
        const abort = () => done({});
        listeners.add(notify);
        request.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => done({}), 20000);
        if (request.signal.aborted) abort();
      });
    },
  }), 'zotero bridge: navigation feed');
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE + '/ack', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const data = await request.json(), item = openings.get(data.id);
      if (item) { openings.delete(data.id); item.finish(data.error ? new Error(String(data.error)) : null); }
      return Response.json({ ok: true });
    },
  }), 'zotero bridge: navigation receipt');

  async function execute(request) {
    if (request.action === 'create') {
      if (!isAbsolute(request.workspace || '') || !UUID.test(request.sessionId || '')) throw new Error('Invalid conversation placement');
      if (typeof request.title !== 'string' || !request.title.trim()) throw new Error('A conversation title is required');
      const workspace = resolve(request.workspace);
      const manifest = JSON.parse(await readFile(join(workspace, 'context.json'), 'utf8'));
      if (manifest.schema_version !== 2 || !Array.isArray(manifest.sources)) throw new Error('Unsupported Zotero file manifest');
      if (!manifest.sources.some(source => source.kind === 'pdf') || !manifest.sources.some(source => source.kind === 'metadata')) throw new Error('PDF and metadata files are required');
      for (const source of manifest.sources) {
        if (!isAbsolute(source.path) || resolve(source.path).startsWith(workspace + '/') === false
            || !(await lstat(source.path)).isFile()) throw new Error('Source files must belong to the Zotero workspace');
      }
      const existing = registry[request.sessionId];
      if (existing && existing.workspace !== workspace) throw new Error('Conversation belongs to another workspace');
      if (!existing) {
        const placement = await ctx.workspaceController.create({ path: workspace });
        const workspaceId = placement.workspace.workspaceId;
        if (placement.created) await ctx.workspaceController.rename({ workspaceId,
          title: `${request.title.slice(0, 90)} · ${request.sessionId.slice(0, 6)}` });
        const created = await ctx.sessionController.create({ workspaceId, sessionId: request.sessionId });
        await ctx.sessionController.rename({ sessionId: created.sessionId, title: String(request.title).slice(0, 300) });
        registry[created.sessionId] = { workspace, workspaceId };
        await json(registryPath, registry);
        return { sessionId: created.sessionId };
      }
      return { sessionId: request.sessionId };
    }
    if (request.action === 'open') {
      if (!UUID.test(request.sessionId || '') || !registry[request.sessionId]) throw new Error('Unknown Zotero conversation');
      await new Promise((resolveOpen, rejectOpen) => {
        const timer = setTimeout(() => { openings.delete(request.id); rejectOpen(new Error('Desktop did not acknowledge the conversation; reopen its main window')); }, Math.max(1, Math.min(15000, request.expires - Date.now())));
        openings.set(request.id, { id: request.id, sessionId: request.sessionId, revision: ++revision,
          finish(error) { clearTimeout(timer); error ? rejectOpen(error) : resolveOpen(); } });
        wake();
      });
      return { opened: true };
    }
    throw new Error('Unsupported Zotero bridge action');
  }

  async function drain() {
    if (disposed) return;
    for (const filename of await readdir(inbox)) {
      if (!filename.endsWith('.json') || !UUID.test(filename.slice(0, -5))) continue;
      const file = join(inbox, filename);
      let request;
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > 65536) throw new Error('Invalid Zotero request file');
        request = JSON.parse(await readFile(file, 'utf8'));
        if (request.id !== filename.slice(0, -5) || request.instance !== instance
            || !Number.isSafeInteger(request.expires) || request.expires < Date.now() || request.expires > Date.now() + 60000) {
          await unlink(file); continue;
        }
        const value = await execute(request);
        await json(join(outbox, filename), { ok: true, value });
      } catch (error) {
        await json(join(outbox, filename), { ok: false, error: error.message || String(error) });
      }
      await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  const schedule = () => { sequence = sequence.then(drain).catch(error => { console.error('Zotero bridge queue:', error.message); }); };
  const watcher = watch(inbox, schedule);
  const heartbeat = setInterval(() => { json(statusPath, { version: 1, instance, updated: Date.now() }).catch(error => console.error('Zotero bridge status:', error.message)); }, 2000);
  ctx.effect(() => async () => {
    disposed = true; watcher.close(); clearInterval(heartbeat);
    for (const opening of openings.values()) opening.finish(new Error('Desktop bridge stopped'));
    openings.clear(); wake();
    await sequence;
    try { if (JSON.parse(await readFile(statusPath, 'utf8')).instance === instance) await unlink(statusPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, 'zotero bridge: file queue');
  await json(statusPath, { version: 1, instance, updated: Date.now() });
  schedule();
}
