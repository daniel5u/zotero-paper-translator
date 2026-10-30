/* global Zotero, IOUtils, window, document */

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
    this.initRequestOptions();
    this.refreshEnvironmentStatus();
  },

  setStatus(id, text, kind = "") {
    let elem = this.$(id);
    elem.textContent = text;
    elem.classList.toggle("error", kind === "error");
    elem.classList.toggle("ok", kind === "ok");
  },

  // Environment

  async refreshEnvironmentStatus() {
    this.setStatus("pt-env-status", this.plugin.t("pt-status-checking"));
    try {
      let info = await this.plugin.checkEnvironment();
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
    try {
      await this.plugin.ensureEnvironment((text, progress) => {
        if (progress) {
          steps[progress.step] = progress;
          this.renderSteps(steps);
        }
      }, { repair: this.environmentReady });
      this.$("pt-uv-path").value = this.plugin.getPref("uvPath") || "";
      await this.refreshEnvironmentStatus();
    }
    catch (e) {
      this.setStatus("pt-env-status", String(e.message || e), "error");
    }
    finally {
      button.disabled = false;
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
