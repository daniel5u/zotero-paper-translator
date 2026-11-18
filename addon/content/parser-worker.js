/* global Subprocess, PROTOCOL_PREFIX, LOG_LINES_KEPT, Zotero */

var PaperTranslatorParserWorker = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.proc = null;
    this.mode = null;
    this.current = null;
    this.tail = Promise.resolve();
    this.nextID = 0;
    this.gpuSetup = null;
    this.setupProc = null;
    this.closed = false;
  }

  status(state, fields = {}) {
    this.plugin.parserStatus = { ...this.plugin.parserStatus, ...fields, state };
  }

  run(command, job = {}, { onMessage, onSpawn } = {}) {
    let entry = { id: ++this.nextID, command, job, onMessage, log: [], cancelled: false,
      mode: this.plugin.getPref("parseDevice") || "auto" };
    onSpawn?.({ kill: () => {
      entry.cancelled = true;
      if (this.current === entry && entry.proc) entry.proc.kill().catch(() => {});
    } });
    let request = this.tail.then(() => this.execute(entry));
    this.tail = request.catch(() => {});
    return request;
  }

  async start(mode) {
    if (this.proc && this.mode === mode) return this.proc;
    await this.stop();
    this.status("preparing", { device: null, provider: null, warning: null, stage: null });
    let gpu = { available: false };
    if (mode !== "cpu" && !Zotero.isMac) {
      if (!this.gpuSetup) {
        this.gpuSetup = (async () => {
          let uv = await this.plugin.findUV();
          if (this.closed) throw new Error("The parser worker is closed.");
          let outcome = await this.plugin.run(this.plugin.venvPython, [this.plugin.runnerPath, "gpu-setup"], {
            input: JSON.stringify({ uv: uv || "uv" }),
            onSpawn: proc => {
              this.setupProc = proc;
              if (this.closed) proc.kill().catch(() => {});
            },
            onMessage: message => {
              if (message.stage_id) this.status("preparing", { stage: message.stage_id });
            },
          });
          if (outcome.exitCode !== 0 || outcome.result?.type === "error") {
            return { available: false, warning: outcome.result?.message || outcome.log.slice(-3).join("\n") };
          }
          return outcome.result;
        })().catch(error => ({ available: false, warning: String(error.message || error) }))
          .finally(() => { this.setupProc = null; });
      }
      gpu = await this.gpuSetup;
    }
    if (this.closed) throw new Error("The parser worker is closed.");
    let proc = await Subprocess.call({
      command: this.plugin.venvPython,
      arguments: [this.plugin.runnerPath, "serve", mode],
      workdir: this.plugin.dataDir,
      stderr: "stdout",
      environment: { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1", COLUMNS: "200",
        PAPER_TRANSLATOR_GPU_RUNTIME: gpu.available ? "1" : "0" },
      environmentAppend: true,
    });
    if (this.closed) { await proc.kill(); throw new Error("The parser worker is closed."); }
    this.proc = proc;
    this.mode = mode;
    this.status("preparing", { warning: gpu.warning || null, stage: null });
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
        this.status(this.closed || entry?.cancelled ? "idle" : "error", { message: failure });
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
      entry.resolve({ exitCode: message.exit_code, result: entry.result, log: entry.log });
      return;
    }
    if (message.type === "parser_device") this.status("ready", message);
    if (message.type !== "progress") entry.result = message;
    entry.onMessage?.(message);
  }

  async stop() {
    let proc = this.proc;
    this.proc = null;
    if (proc) { await proc.kill(); await proc.wait(); }
  }

  reset() {
    let reset = this.tail.then(async () => { await this.stop(); this.gpuSetup = null; });
    this.tail = reset.catch(() => {});
    return reset;
  }

  shutdown() {
    this.closed = true;
    this.setupProc?.kill().catch(() => {});
    this.proc?.kill().catch(() => {});
  }
};
