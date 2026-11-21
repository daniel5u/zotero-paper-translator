/* global Zotero, IOUtils, Services, window, document */

// Runs before the pane's markup is inserted
window.MozXULElement.insertFTLIfNeeded("paper-translator.ftl");

// Request fields as sent, so users can match them to their provider's docs.
// Keys match THINKING_OFF in python/translation.py
var PT_THINKING_FIELDS = {
  thinking: ['thinking {"type": "disabled"}', "DeepSeek, GLM"],
  reasoning_effort: ['reasoning_effort "minimal"', "OpenAI"],
  reasoning: ['reasoning {"effort": "minimal"}', "OpenRouter"],
  enable_thinking: ["enable_thinking false", "Qwen"],
};
var PT_TOKEN_FIELDS = {
  max_tokens: "",
  max_completion_tokens: "OpenAI reasoning models",
};
// Order and names match the steps reported by PaperTranslator._setUpEnvironment()
var PT_SETUP_STEPS = ["find-uv", "download-uv", "venv", "packages", "verify", "warmup"];
var PT_STEP_MARKS = { pending: "○", running: "…", done: "✓", skipped: "–", failed: "✕" };

var PaperTranslatorPrefs = {
  environmentReady: false,

  get plugin() {
    return Zotero.PaperTranslator;
  },

  $(id) {
    return document.getElementById(id);
  },

  init() {
    this.$("pt-env-setup").addEventListener("click", () => this.setUpEnvironment());
    this.$("pt-env-open").addEventListener("click", () => this.openEnvironmentFolder());
    this.$("pt-detect-models").addEventListener("click", () => this.detectModels());
    this.$("pt-models").addEventListener("change", () => this.chooseModel());
    this.$("pt-test").addEventListener("click", () => this.testConnection());
    this.$("pt-request-reset").addEventListener("click", () => this.resetRequestOptions());
    // Detection belongs to one API and model; show what applies to the current ones
    for (let id of ["pt-base-url", "pt-model"]) {
      this.$(id).addEventListener("change", () => this.renderRequestOptions());
    }
    this.initAcceleration();
    this.initRequestOptions();
    this.refreshEnvironmentStatus();
  },

  setStatus(id, text, kind = "") {
    let elem = this.$(id);
    elem.textContent = text;
    elem.classList.toggle("error", kind === "error");
    elem.classList.toggle("ok", kind === "ok");
  },

  html(tag, className = "", text = "") {
    let elem = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (className) elem.className = className;
    if (text) elem.textContent = text;
    return elem;
  },

  // Parsing acceleration

  initAcceleration() {
    this.$("pt-parse-device").addEventListener("change", () => {
      this.plugin.setParseDevice(this.$("pt-parse-device").value);
      this.renderDevice();
    });
    let idle = this.$("pt-parser-idle");
    idle.value = String(this.plugin.parserIdleMinutes());
    idle.addEventListener("change", () => {
      this.plugin.setPref("parserIdleMinutes", idle.value);
      // Restart the countdown with the new time
      if (!this.plugin.parserWorker.pending) this.plugin.parserWorker.scheduleIdle();
      this.renderParser();
    });
    this.$("pt-parser-unload").addEventListener("click", () => this.plugin.parserWorker.unload());
    this.$("pt-gpu-download").addEventListener("click", () => this.downloadGPURuntime());
    this.$("pt-gpu-cancel").addEventListener("click", () => this.plugin.cancelGPUInstall());
    this.$("pt-gpu-recheck").addEventListener("click", () => {
      // A failed download stays on screen until the user moves on from it
      if (this.plugin.gpuInstall?.state !== "running") this.plugin.gpuInstall = null;
      this.checkGPU();
    });
    this.$("pt-gpu-remove").addEventListener("click", () => this.removeGPURuntime());
    this.acceleratorTimer = window.setInterval(() => {
      this.renderParser();
      if (this.plugin.gpuInstall?.state === "running") this.renderGPUInstall();
    }, 1000);
    window.addEventListener("unload", () => window.clearInterval(this.acceleratorTimer), { once: true });
    this.renderParser();
    this.loadHardware();
  },

  async loadHardware() {
    let box = this.$("pt-hardware");
    let select = this.$("pt-parse-device");
    let line = (dot, text) => {
      let row = this.html("span");
      row.append(this.html("span", `pt-dot ${dot}`), text);
      return row;
    };
    box.replaceChildren(line("", this.plugin.t("pt-hw-detecting")));
    select.disabled = true;
    let hardware;
    try {
      hardware = await this.plugin.detectHardware();
    }
    catch (e) {
      box.replaceChildren(line("error", this.plugin.t("pt-hw-failed", { detail: String(e.message || e) })));
      return;
    }
    this.hardware = hardware;
    if (!hardware) {
      box.replaceChildren(line("", this.plugin.t("pt-hw-needs-env")));
      select.replaceChildren(this.html("option", "", this.plugin.t("pt-device-cpu")));
      this.renderDevice();
      return;
    }
    let accel = hardware.accelerator;
    let lines = [line("", this.plugin.t("pt-hw-cpu", { name: hardware.cpu }))];
    let options = [];
    if (accel?.kind === "coreml") {
      lines.push(line("ok", this.plugin.t("pt-hw-coreml")));
      options.push(["coreml", "pt-device-coreml-recommended"], ["cpu", "pt-device-cpu-only"]);
    }
    else if (accel?.kind === "cuda") {
      let memory = accel.memory_mb ? ` · ${Math.round(accel.memory_mb / 1024)} GB` : "";
      lines.push(accel.supported
        ? line("ok", this.plugin.t("pt-hw-nvidia", { name: accel.name + memory, driver: accel.driver }))
        : line("warn", this.plugin.t("pt-hw-nvidia-old", { name: accel.name + memory, driver: accel.driver, min: hardware.min_driver })));
      options.push(["cuda", accel.supported ? "pt-device-cuda" : "pt-device-cuda-old", !accel.supported],
        ["cpu", accel.supported ? "pt-device-cpu" : "pt-device-cpu-recommended"]);
    }
    else {
      lines.push(line("warn", this.plugin.t(hardware.os === "darwin" ? "pt-hw-none-mac" : "pt-hw-none")));
      options.push(["cpu", "pt-device-cpu-recommended"]);
    }
    box.replaceChildren(...lines);
    select.replaceChildren(...options.map(([value, label, disabled]) => {
      let option = this.html("option", "", this.plugin.t(label));
      option.value = value;
      option.disabled = !!disabled;
      return option;
    }));
    let device = await this.plugin.resolvedParseDevice(hardware);
    select.value = options.some(([value, , disabled]) => value === device && !disabled) ? device : "cpu";
    select.disabled = options.length < 2;
    this.renderDevice();
  },

  renderDevice() {
    let device = this.$("pt-parse-device").value;
    let accel = this.hardware?.accelerator;
    let hint = "";
    if (device === "coreml") hint = "pt-device-hint-coreml";
    else if (device === "cpu") {
      hint = accel?.kind === "coreml" ? "pt-device-hint-cpu-mac"
        : accel?.kind === "cuda" && !accel.supported ? "pt-device-hint-driver"
        : accel?.kind === "cuda" ? "pt-device-hint-try-gpu"
        : this.hardware ? "pt-device-hint-cpu" : "";
    }
    this.setStatus("pt-device-hint", hint ? this.plugin.t(hint, { min: this.hardware?.min_driver }) : "");
    if (device === "cuda") this.checkGPU();
    else if (this.plugin.gpuInstall?.state !== "running") this.$("pt-gpu-card").hidden = true;
  },

  /** Fill the GPU runtime card. buttons: the ids of the actions to offer. */
  renderCard({ dot, title, body = "", details = [], progress = false, buttons = [] }) {
    let titleElem = this.$("pt-gpu-title");
    titleElem.replaceChildren(this.html("span", `pt-dot ${dot}`), title);
    this.$("pt-gpu-body").textContent = body;
    this.$("pt-gpu-details").replaceChildren(...details.flatMap(([key, value]) => [
      this.html("span", "", this.plugin.t(key)), this.html("span", "", value),
    ]));
    let bar = this.$("pt-gpu-progress");
    bar.hidden = !progress;
    if (progress) bar.removeAttribute("value");
    for (let id of ["download", "cancel", "recheck", "remove"]) {
      this.$(`pt-gpu-${id}`).hidden = !buttons.includes(id);
    }
    this.$("pt-gpu-actions").hidden = !buttons.length;
    this.$("pt-gpu-card").hidden = false;
  },

  formatSize(bytes) {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  },

  /** Check whether the GPU runtime is installed and runs, and show the result. */
  async checkGPU() {
    let install = this.plugin.gpuInstall;
    if (install?.state === "running" || install?.state === "failed") {
      this.renderGPUInstall();
      return;
    }
    let token = this.gpuCheck = {};
    this.renderCard({ dot: "", title: this.plugin.t("pt-gpu-checking"), body: this.plugin.t("pt-gpu-checking-detail") });
    let status;
    try {
      status = await this.plugin.gpuRuntimeStatus();
    }
    catch (e) {
      if (token !== this.gpuCheck) return;
      this.renderCard({ dot: "error", title: this.plugin.t("pt-gpu-check-failed"), body: String(e.message || e),
        buttons: ["recheck"] });
      return;
    }
    if (token !== this.gpuCheck || this.$("pt-parse-device").value !== "cuda") return;
    let accel = this.hardware?.accelerator || {};
    let cancelled = install?.state === "cancelled";
    if (cancelled) this.plugin.gpuInstall = null;
    if (!status.installed) {
      this.renderCard({
        dot: "warn", title: this.plugin.t("pt-gpu-missing"),
        body: (cancelled ? this.plugin.t("pt-gpu-cancelled") + " " : "") + this.plugin.t("pt-gpu-missing-detail"),
        details: [["pt-gpu-driver", this.plugin.t("pt-gpu-driver-ok", { driver: accel.driver, min: this.hardware?.min_driver })],
          ["pt-gpu-download-size", this.plugin.t("pt-gpu-download-size-value")]],
        buttons: ["download"],
      });
      return;
    }
    let details = [["pt-gpu-device", accel.name || ""],
      ["pt-gpu-runtime", `onnxruntime-gpu ${status.onnxruntime}` + (status.bundled_cuda ? ` · CUDA ${status.cuda} · cuDNN ${status.cudnn}` : "")],
      ["pt-gpu-location", status.size ? `${status.path} · ${this.formatSize(status.size)}` : status.path]];
    if (status.working) {
      this.renderCard({ dot: "ok", title: this.plugin.t("pt-gpu-ready"),
        body: this.plugin.t(status.bundled_cuda ? "pt-gpu-ready-detail" : "pt-gpu-ready-system-cuda"),
        details, buttons: ["recheck", "remove"] });
    }
    else {
      this.renderCard({ dot: "error", title: this.plugin.t("pt-gpu-broken"),
        body: this.plugin.t("pt-gpu-broken-detail", { detail: status.error || "" }),
        details, buttons: ["recheck", "remove"] });
    }
  },

  renderGPUInstall() {
    let install = this.plugin.gpuInstall;
    if (!install) return;
    if (install.state === "running") {
      let body = install.detail ? this.plugin.t("pt-gpu-downloading-file", { file: install.detail }) : "";
      if (install.downloaded) body += (body ? " · " : "") + this.plugin.t("pt-gpu-downloaded-count", { count: install.downloaded });
      this.renderCard({ dot: "", title: this.plugin.t(`pt-gpu-stage-${install.stage}`),
        body: [body, this.plugin.t("pt-gpu-running-note")].filter(Boolean).join("\n"),
        progress: true, buttons: ["cancel"] });
    }
    else if (install.state === "failed") {
      this.renderCard({ dot: "error", title: this.plugin.t("pt-gpu-install-failed"),
        body: install.error + (install.logPath ? "\n" + this.plugin.t("pt-gpu-log", { path: install.logPath }) : ""),
        buttons: ["download", "recheck"] });
    }
  },

  async downloadGPURuntime() {
    let prompt = Services.prompt;
    let choice = prompt.confirmEx(window, this.plugin.t("pt-gpu-confirm-title"),
      this.plugin.t("pt-gpu-confirm-text"),
      prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_CANCEL
        + prompt.BUTTON_POS_1_DEFAULT,
      this.plugin.t("pt-gpu-confirm-button"), null, null, null, {});
    if (choice !== 0) return;
    let promise = this.plugin.installGPURuntime();
    this.renderGPUInstall();
    try {
      await promise;
    }
    catch (e) {
      // Shown from this.plugin.gpuInstall
    }
    if (window.closed) return;
    if (this.plugin.gpuInstall?.state === "failed") this.renderGPUInstall();
    else this.checkGPU();
  },

  async removeGPURuntime() {
    if (!Services.prompt.confirm(window, this.plugin.t("pt-gpu-remove-title"), this.plugin.t("pt-gpu-remove-text"))) return;
    this.$("pt-gpu-remove").disabled = true;
    try {
      await this.plugin.removeGPURuntime();
    }
    catch (e) {
      Services.prompt.alert(window, this.plugin.t("pt-gpu-remove-title"), String(e.message || e));
    }
    finally {
      this.$("pt-gpu-remove").disabled = false;
    }
    this.checkGPU();
  },

  renderParser() {
    let state = this.plugin.parserWorker.state;
    let minutes = this.plugin.parserIdleMinutes();
    this.setStatus("pt-idle-hint", this.plugin.t(minutes ? "pt-pref-parser-idle-hint" : "pt-pref-parser-idle-never-hint"));
    // Before the layout model is loaded, name the device it will use
    let device = { CUDAExecutionProvider: "cuda", CoreMLExecutionProvider: "coreml", CPUExecutionProvider: "cpu" }[state.provider]
      || this.$("pt-parse-device").value || "cpu";
    device = `pt-device-name-${device}`;
    let args = { device: this.plugin.t(device), memory: state.memory ? this.formatSize(state.memory) : "" };
    let key;
    if (state.busy) key = state.loading ? "pt-parser-loading" : "pt-parser-busy";
    else if (state.loaded && state.idleDeadline) {
      let seconds = Math.max(0, Math.round((state.idleDeadline - Date.now()) / 1000));
      args.time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
      key = "pt-parser-loaded-until";
    }
    else if (state.loaded) key = "pt-parser-loaded";
    else key = state.error ? "pt-parser-stopped-error" : "pt-parser-unloaded";
    if (state.error) args.detail = state.error;
    if ((key === "pt-parser-loaded" || key === "pt-parser-loaded-until" || key === "pt-parser-busy") && !args.memory) {
      key += "-nomem";
    }
    this.setStatus("pt-parser-status", this.plugin.t(key, args), key === "pt-parser-stopped-error" ? "error" : "");
    this.$("pt-parser-unload").hidden = !state.loaded || state.busy;
  },

  // Environment

  async refreshEnvironmentStatus() {
    let request = this.environmentStatusRequest = (this.environmentStatusRequest || 0) + 1;
    this.setStatus("pt-env-status", this.plugin.t("pt-status-checking"));
    try {
      let info = await this.plugin.checkEnvironment();
      if (request !== this.environmentStatusRequest) return;
      this.environmentReady = !!info;
      this.setStatus("pt-env-status",
        info ? this.plugin.t("pt-status-ready", info) : this.plugin.t("pt-status-not-ready"),
        info ? "ok" : "");
      if (info && !this.plugin.getPref("uvPath")) {
        // Set up before uv paths were recorded; show the uv that would be used
        let uv = await this.plugin.findUV();
        if (uv) {
          this.plugin.setPref("uvPath", uv);
          this.$("pt-uv-path").value = uv;
        }
      }
    }
    catch (e) {
      if (request !== this.environmentStatusRequest) return;
      this.environmentReady = false;
      this.setStatus("pt-env-status", String(e.message || e), "error");
    }
    this.$("pt-env-setup").textContent = this.plugin.t(
      this.environmentReady ? "pt-pref-env-repair" : "pt-pref-env-setup"
    );
  },

  async setUpEnvironment() {
    let button = this.$("pt-env-setup");
    button.disabled = true;
    let steps = Object.fromEntries(PT_SETUP_STEPS.map((step) => [step, { state: "pending" }]));
    this.renderSteps(steps);
    this.$("pt-env-steps").hidden = false;
    this.setStatus("pt-env-status", "");
    let error;
    try {
      await this.plugin.ensureEnvironment((text, progress) => {
        if (progress) {
          steps[progress.step] = progress;
          this.renderSteps(steps);
        }
      }, { repair: this.environmentReady });
    }
    catch (e) {
      error = e;
    }
    finally {
      try {
        this.$("pt-uv-path").value = this.plugin.getPref("uvPath") || "";
        await Promise.all([this.refreshEnvironmentStatus(), this.loadHardware()]);
        if (error) this.setStatus("pt-env-status", String(error.message || error), "error");
      }
      finally {
        button.disabled = false;
      }
    }
  },

  renderSteps(steps) {
    let items = PT_SETUP_STEPS.map((step) => {
      let { state, detail, fraction } = steps[step];
      let item = document.createElementNS("http://www.w3.org/1999/xhtml", "li");
      item.className = state;
      for (let [className, text] of [["", PT_STEP_MARKS[state]], ["", this.plugin.t(`pt-setup-step-${step}`)], ["pt-detail", detail || ""]]) {
        let span = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
        span.className = className;
        span.textContent = text;
        item.append(span);
      }
      if (state === "running" && fraction !== null && fraction !== undefined) {
        let bar = document.createElementNS("http://www.w3.org/1999/xhtml", "progress");
        bar.max = 1;
        bar.value = fraction;
        item.append(bar);
      }
      return item;
    });
    this.$("pt-env-steps").replaceChildren(...items);
  },

  async openEnvironmentFolder() {
    await IOUtils.makeDirectory(this.plugin.dataDir, { ignoreExisting: true });
    Zotero.File.reveal(this.plugin.dataDir);
  },

  // API

  async detectModels() {
    let settings = this.plugin.getSettings();
    let list = this.$("pt-models");
    if (!settings.baseURL || !settings.apiKey) {
      this.setStatus("pt-models-status", this.plugin.t("pt-error-missing-settings"), "error");
      return;
    }
    this.$("pt-detect-models").disabled = true;
    this.setStatus("pt-models-status", this.plugin.t("pt-models-loading"));
    try {
      let models = await this.plugin.fetchModels(settings.baseURL, settings.apiKey);
      list.replaceChildren(...models.map((id) => {
        let option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
        option.value = id;
        option.textContent = id;
        option.selected = id === settings.model;
        return option;
      }));
      list.hidden = !models.length;
      this.setStatus("pt-models-status", models.length ? "" : this.plugin.t("pt-models-none"));
    }
    catch (e) {
      list.hidden = true;
      this.setStatus("pt-models-status",
        this.plugin.t("pt-models-failed", { detail: String(e.status || e.message || e) }), "error");
    }
    finally {
      this.$("pt-detect-models").disabled = false;
    }
  },

  chooseModel() {
    let id = this.$("pt-models").value;
    this.$("pt-model").value = id;
    this.plugin.setPref("model", id);
    this.renderRequestOptions();
  },

  async testConnection() {
    let button = this.$("pt-test");
    button.disabled = true;
    this.setStatus("pt-test-status", this.plugin.t("pt-test-running"));
    try {
      let settings = this.plugin.getSettings();
      if (!settings.baseURL || !settings.apiKey || !settings.model) {
        throw new Error(this.plugin.t("pt-error-missing-settings"));
      }
      let detected = await this.plugin.testConnection(settings);
      this.setStatus("pt-test-status", this.plugin.t(
        detected?.thinking_method === "none" ? "pt-test-ok-thinking-on" : "pt-test-ok-thinking-off"
      ), "ok");
    }
    catch (e) {
      this.setStatus("pt-test-status", String(e.message || e), "error");
    }
    finally {
      button.disabled = false;
      this.renderRequestOptions();
    }
  },

  // Request options: each starts on "Automatic" and shows what was detected

  initRequestOptions() {
    let option = (select, value, label) => {
      let item = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      item.value = value;
      item.textContent = label;
      select.append(item);
    };
    let thinking = this.$("pt-thinking-method");
    option(thinking, "auto", "");
    for (let [value, [field, providers]] of Object.entries(PT_THINKING_FIELDS)) {
      option(thinking, value, `${field} — ${providers}`);
    }
    option(thinking, "none", this.plugin.t("pt-pref-thinking-none"));
    let tokens = this.$("pt-token-field");
    option(tokens, "auto", "");
    for (let [value, note] of Object.entries(PT_TOKEN_FIELDS)) {
      option(tokens, value, note ? `${value} — ${note}` : value);
    }
    thinking.addEventListener("change", () => this.plugin.setPref("thinkingMethod", thinking.value));
    tokens.addEventListener("change", () => this.plugin.setPref("tokenField", tokens.value));
    this.$("pt-max-tokens-mode").addEventListener("change", () => this.saveMaxTokens());
    this.$("pt-max-tokens").addEventListener("change", () => this.saveMaxTokens());
    this.renderRequestOptions();
  },

  renderRequestOptions() {
    let settings = this.plugin.getSettings();
    let detected = settings.detected;
    let automatic = (value) => (detected
      ? this.plugin.t("pt-pref-automatic-detected", { value })
      : this.plugin.t("pt-pref-automatic-pending"));
    let thinking = this.$("pt-thinking-method");
    thinking.options[0].textContent = automatic(
      detected?.thinking_method === "none" ? this.plugin.t("pt-pref-thinking-none")
        : PT_THINKING_FIELDS[detected?.thinking_method]?.[0]
    );
    thinking.value = settings.thinkingMethod;
    let tokens = this.$("pt-token-field");
    tokens.options[0].textContent = automatic(detected?.token_field);
    tokens.value = settings.tokenField;
    this.$("pt-max-tokens-mode").value = settings.maxTokens ? "fixed" : "auto";
    this.$("pt-max-tokens").value = settings.maxTokens || 8192;
    this.$("pt-max-tokens").disabled = !settings.maxTokens;
  },

  saveMaxTokens() {
    let fixed = this.$("pt-max-tokens-mode").value === "fixed";
    let value = Math.max(256, parseInt(this.$("pt-max-tokens").value) || 8192);
    this.plugin.setPref("maxTokens", fixed ? String(value) : "0");
    this.renderRequestOptions();
  },

  async resetRequestOptions() {
    for (let [name, value] of [["thinkingMethod", "auto"], ["tokenField", "auto"], ["maxTokens", "0"], ["detectedOptions", ""]]) {
      this.plugin.setPref(name, value);
    }
    this.renderRequestOptions();
    let settings = this.plugin.getSettings();
    if (settings.baseURL && settings.apiKey && settings.model) {
      await this.testConnection();
    }
  },
};

// The pane dispatches a non-bubbling 'load' event at its top-level element.
// Inline onload handlers would run in the window scope, not this sandbox, and
// load events never reach the window, so capture it on the document.
document.addEventListener(
  "load",
  function onPaneLoad(event) {
    if (event.target.id === "paper-translator-pane") {
      document.removeEventListener("load", onPaneLoad, true);
      PaperTranslatorPrefs.init();
    }
  },
  true
);
