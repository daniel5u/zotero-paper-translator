/* global Subprocess, PROTOCOL_PREFIX, LOG_LINES_KEPT, Zotero, ChromeUtils */

// The bootstrap scope has no window timers
var PTTimer = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

/**
 * One long-lived Python process for parse, reader, export and edit requests.
 * It keeps BabelDOC imported and the layout model loaded, so only the first
 * request pays for loading. It starts on first use, and stops after the idle
 * time set in the preferences so the memory goes back to the system.
 */
var PaperTranslatorParserWorker = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.proc = null;
    this.mode = null;
    this.current = null;
    this.tail = Promise.resolve();
    this.nextID = 0;
    this.pending = 0;
    this.idleTimer = null;
    this.idleDeadline = null;
    this.closed = false;
    // Shown in the preferences
    this.provider = null;
    this.memory = null;
    this.lastError = null;
    // Whether the current process finished a request, so it is no longer loading
    this.warm = false;
  }

  /** What the preferences show about the parser. */
  get state() {
    return {
      loaded: !!this.proc,
      busy: this.pending > 0,
      loading: !!this.current && !this.warm,
      mode: this.mode,
      provider: this.proc ? this.provider : null,
      memory: this.proc ? this.memory : null,
      idleDeadline: this.idleDeadline,
      error: this.lastError,
    };
  }

  run(command, job = {}, { onMessage, onSpawn } = {}) {
    this.cancelIdle();
    this.pending++;
    let entry = { id: ++this.nextID, command, job, onMessage, log: [], cancelled: false,
      mode: this.plugin.parseDevice() };
    onSpawn?.({ kill: () => {
      entry.cancelled = true;
      if (this.current === entry && entry.proc) entry.proc.kill().catch(() => {});
    } });
    let request = this.tail.then(() => this.execute(entry)).finally(() => {
      if (--this.pending === 0) this.scheduleIdle();
    });
    this.tail = request.catch(() => {});
    return request;
  }

  async start(mode) {
    if (this.proc && this.mode === mode) return this.proc;
    await this.stop();
    if (this.closed) throw new Error("The parser worker is closed.");
    let proc = await Subprocess.call({
      command: this.plugin.venvPython,
      arguments: [this.plugin.runnerPath, "serve", mode],
      workdir: this.plugin.dataDir,
      stderr: "stdout",
      environment: { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1", COLUMNS: "200" },
      environmentAppend: true,
    });
    if (this.closed) { await proc.kill(); throw new Error("The parser worker is closed."); }
    this.proc = proc;
    this.mode = mode;
    this.provider = null;
    this.memory = null;
    this.lastError = null;
    this.warm = false;
    this.pump(proc).catch(error => Zotero.logError(error));
    return proc;
  }

  async execute(entry) {
    if (entry.cancelled || this.closed) throw new Error("The parser request was cancelled.");
    this.current = entry;
    try {
      entry.proc = await this.start(entry.mode);
      if (entry.cancelled || this.closed) throw new Error("The parser request was cancelled.");
      return await new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
        entry.proc.stdin.write(JSON.stringify({ id: entry.id, command: entry.command, job: entry.job }) + "\n")
          .catch(error => {
            entry.proc.kill().catch(() => {});
            reject(error);
          });
      });
    }
    finally { if (this.current === entry) this.current = null; }
  }

  async pump(proc) {
    let buffer = "";
    let failure = "The parser worker exited unexpectedly.";
    try {
      let chunk;
      while ((chunk = await proc.stdout.readString())) {
        buffer += chunk;
        let lines = buffer.split(/\r\n|\r|\n/);
        buffer = lines.pop();
        for (let line of lines) this.line(proc, line);
      }
      if (buffer) this.line(proc, buffer);
    }
    catch (error) {
      failure = String(error.message || error);
      Zotero.logError(error);
      await proc.kill().catch(() => {});
    }
    finally {
      let entry = this.current;
      if (this.proc === proc) {
        this.proc = null;
        if (!this.closed && !entry?.cancelled) this.lastError = failure;
      }
      if (entry?.proc === proc) {
        entry.resolve?.({ exitCode: 1, result: { type: "error", message: failure }, log: entry.log });
      }
      await proc.wait();
    }
  }

  line(proc, line) {
    let entry = this.current;
    if (entry?.proc !== proc) return;
    if (!line.startsWith(PROTOCOL_PREFIX)) {
      if (line.trim()) {
        entry.log.push(line);
        if (entry.log.length > LOG_LINES_KEPT) entry.log.shift();
      }
      return;
    }
    let message = JSON.parse(line.slice(PROTOCOL_PREFIX.length));
    if (message.request_id !== entry.id) return;
    if (message.type === "request_end") {
      this.warm = true;
      if (message.memory) this.memory = message.memory;
      if (message.provider) this.provider = message.provider;
      entry.resolve({ exitCode: message.exit_code, result: entry.result, log: entry.log });
      return;
    }
    if (message.type === "parser_device") {
      this.provider = message.provider;
      return;
    }
    if (message.type !== "progress") entry.result = message;
    entry.onMessage?.(message);
  }

  scheduleIdle() {
    this.cancelIdle();
    let minutes = this.plugin.parserIdleMinutes();
    if (!this.proc || !minutes || this.closed) return;
    this.idleDeadline = Date.now() + minutes * 60 * 1000;
    this.idleTimer = PTTimer.setTimeout(() => {
      this.idleTimer = null;
      this.idleDeadline = null;
      if (!this.pending) this.unload();
    }, minutes * 60 * 1000);
  }

  cancelIdle() {
    if (this.idleTimer) PTTimer.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.idleDeadline = null;
  }

  async stop() {
    let proc = this.proc;
    this.proc = null;
    this.provider = null;
    this.memory = null;
    if (proc) { await proc.kill(); await proc.wait(); }
  }

  /** Stop the process once the requests already queued have finished. */
  unload() {
    this.cancelIdle();
    let unload = this.tail.then(() => this.stop());
    this.tail = unload.catch(() => {});
    return unload;
  }

  shutdown() {
    this.closed = true;
    this.cancelIdle();
    this.proc?.kill().catch(() => {});
  }
};
