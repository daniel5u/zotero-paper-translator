// One dependency-free CommonJS bundle, evaluated by OpenCode in main and windows.
const { Plugin, Ipc } = require("@opencode/plugin/gui");
const { Schema } = require("effect");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const Bridge = Ipc.define({
  id: "zotero-paper-translator-bridge.queue",
  methods: {
    next: { output: Schema.Unknown },
    finish: { input: Schema.Unknown },
  },
});

module.exports.default = Plugin.define({
  main(ctx) {
    const directory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
      "opencode", "zotero-paper-translator-bridge");
    const requests = path.join(directory, "requests");
    const responses = path.join(directory, "responses");
    const held = new Map();
    const validId = id => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id);
    ctx.provide(Bridge, {
      next(_input, caller) {
        const windows = ctx.windows.list().filter(win => !win.isDestroyed());
        const chosen = ctx.windows.focused() || windows[0];
        if (!chosen || chosen.id !== caller.window || !fs.existsSync(requests)) return null;
        for (const name of fs.readdirSync(requests).sort()) {
          if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
          const file = path.join(requests, name);
          let request;
          try { request = JSON.parse(fs.readFileSync(file, "utf8")); }
          catch { continue; }
          if (!validId(request.id) || name !== `${request.id}.json`
            || !/^ses_[A-Za-z0-9_-]{1,160}$/.test(request.sessionId)
            || !Number.isFinite(request.expires)) continue;
          if (request.expires <= Date.now()) { fs.unlinkSync(file); held.delete(request.id); continue; }
          const owner = held.get(request.id);
          if (owner && ctx.windows.get(owner)) continue;
          held.set(request.id, caller.window);
          return request;
        }
        return null;
      },
      finish(value, caller) {
        if (!validId(value?.id) || held.get(value.id) !== caller.window) return;
        const request = path.join(requests, `${value.id}.json`);
        if (!fs.existsSync(request)) { held.delete(value.id); return; }
        const payload = JSON.parse(fs.readFileSync(request, "utf8"));
        if (payload.expires > Date.now()) {
          const response = path.join(responses, `${value.id}.json`);
          const temporary = response + ".tmp";
          fs.writeFileSync(temporary, JSON.stringify({ id: value.id, opened: value.opened === true,
            error: value.error }), { mode: 0o600 });
          fs.renameSync(temporary, response);
        }
        fs.unlinkSync(request);
        held.delete(value.id);
        if (value.opened) {
          const win = ctx.windows.get(caller.window);
          if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
        }
      },
    });
  },
  setup(ctx) {
    const bridge = ctx.main(Bridge);
    let running = false;
    let stopped = false;
    const pause = () => new Promise(resolve => setTimeout(resolve, 100));
    const tick = async () => {
      if (running || stopped) return;
      running = true;
      try {
        const request = await bridge.next({ signal: ctx.signal });
        if (!request || stopped) return;
        let opened = false;
        let error;
        try {
          let server;
          // The CLI and Desktop share this local service. Never forward files to a remote server.
          while (!stopped && Date.now() < request.expires - 500) {
            server = ctx.servers.list().map(id => ctx.servers.get(id))
              .find(item => item?.builtin && item.local && item.connected);
            if (server && !ctx.router.routing()) break;
            await pause();
          }
          if (!server) throw new Error("The local OpenCode service is unavailable.");
          await server.client.session.get({ sessionID: request.sessionId });
          ctx.tabs.open({ server: server.id, id: request.sessionId }, { focus: true });
          while (!stopped && Date.now() < request.expires - 300) {
            opened = !ctx.router.routing() && ctx.sessions.current()?.id === request.sessionId;
            if (opened) break;
            await pause();
          }
          if (!opened) throw new Error("OpenCode did not select the requested session.");
        } catch (failure) { error = String(failure.message || failure); }
        if (!stopped) await bridge.finish({ id: request.id, opened, error }, { signal: ctx.signal });
      } catch (error) {
        if (!stopped && !ctx.signal.aborted) console.warn("Zotero bridge:", error);
      } finally { running = false; }
    };
    const timer = setInterval(tick, 300);
    void tick();
    return () => { stopped = true; clearInterval(timer); };
  },
});
