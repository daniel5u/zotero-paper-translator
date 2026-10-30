/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils, Localization, PaperTranslatorQueue, PaperTranslatorTextTranslation, PaperTranslatorNativeReader */

var { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const PREF_BRANCH = "extensions.paper-translator.";
// Must match PROTOCOL_PREFIX in python/runner.py
const PROTOCOL_PREFIX = "@@PT ";
const PYTHON_VERSION = "3.12";
// uv release downloaded when none is installed; its .sha256 files are checked
const UV_VERSION = "0.13.6";
const LOG_LINES_KEPT = 300;
const OUTPUT_LANGS = ["zh", "zh-TW", "ja", "ko", "en"];
// A paper's parse cache is deleted after this long unused; translations stay
const SESSION_CACHE_DAYS = 7;
// Cleanup is not urgent, so it waits until Zotero has settled after startup
const SESSION_CLEANUP_DELAY_MS = 60 * 1000;
// Everything in a session folder except the translations and small records
const SESSION_CACHE_FILES = ["structure", "structure.json", "source.pdf", "original.pdf", "mediabox.json", "output", "working"];
// Ask about an unfinished batch once the main window has settled
const QUEUE_RESUME_DELAY_MS = 5 * 1000;
// Recognizes our own output files so they are never offered for translation
const OUTPUT_FILE_RE = new RegExp(`\\.(${OUTPUT_LANGS.join("|")})(\\.dual)?\\.pdf$`, "i");

const RUNNER_ERROR_L10N = {
  auth: "pt-error-auth",
  not_found: "pt-error-not-found",
  connection: "pt-error-connection",
  api: "pt-error-api",
};

/** An error whose message is already localized for the user. */
class UserError extends Error {}

PaperTranslator = {
  id: null,
  version: null,
  rootURI: null,
  l10n: null,
  menuIDs: [],
  prefPaneID: null,
  setupPromise: null,
  // False once shut down, so a pending session cleanup does nothing
  active: false,
  queue: null,
  queueWindow: null,
  columnKey: null,
  // "<libraryID>/<attachment key>" -> summary.json of its newest session
  statusCache: new Map(),
  columnRefreshPending: false,
  textTranslations: new Map(),
  readerHandler: null,
  readerContextHandler: null,
  readerBindings: new Set(),
  readerRegistry: {},
  registryWrite: Promise.resolve(),

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
  },

  async startup() {
    this.l10n = new Localization(["paper-translator.ftl"], true);
    // The preferences pane runs in its own scope and reaches the plugin here
    Zotero.PaperTranslator = this;
    this.migratePrefs();
    this.nativeCSS = await Zotero.File.getResourceAsync(this.rootURI + "content/native-reader.css");
    try { this.readerRegistry = JSON.parse(await IOUtils.readUTF8(PathUtils.join(this.dataDir, "native-readers.json"))); }
    catch { this.readerRegistry = {}; }
    this.registerMenus();
    this.readerHandler = (event) => {
      if (event.reader.type !== "pdf") return;
      for (let binding of this.readerBindings) {
        if (binding.reader === event.reader && binding.doc === event.doc) binding.dispose();
      }
      let binding = new PaperTranslatorNativeReader(this, event.reader, event.doc, event.append);
      this.readerBindings.add(binding);
      let translation = [...this.textTranslations.values()].find(w => w.readerItem?.id === event.reader.itemID);
      if (translation) binding.bind(translation);
      else if (binding.isTextTranslation) {
        this.openTextTranslation(Zotero.Items.get(event.reader.itemID), { reader: event.reader, activate: false })
          .catch(error => binding.error(String(error.message || error)));
      }
    };
    this.readerContextHandler = (event) => {
      if (event.reader.type !== "pdf" || !event.params.position?.rects?.length) return;
      let translation = [...this.textTranslations.values()].find(w => w.readerItem?.id === event.reader.itemID);
      if (translation?.session?.parse_status !== "ready") return;
      let item = Zotero.Items.get(event.reader.itemID);
      let paragraph = translation?.paragraphAt(event.params.position, event.reader);
      if (!paragraph) return;
      event.append({
        label: paragraph?.translation ? this.t("pt-reader-retranslate-paragraph") : this.t("pt-reader-translate-paragraph"),
        onCommand: () => {
          this.translateAt(item, event.params.position, event.reader).catch(error => {
            Zotero.logError(error);
            let binding = [...this.readerBindings].find(b => b.reader.itemID === item.id);
            if (binding) binding.error(String(error.message || error));
            else Zotero.alert(null, this.t("pt-text-translation-open"), String(error.message || error));
          });
        },
      });
    };
    Zotero.Reader.registerEventListener("renderToolbar", this.readerHandler, this.id);
    Zotero.Reader.registerEventListener("createViewContextMenu", this.readerContextHandler, this.id);
    this.prefPaneID = await Zotero.PreferencePanes.register({
      pluginID: this.id,
      src: this.rootURI + "content/preferences.xhtml",
      scripts: [this.rootURI + "content/preferences.js"],
    });
    for (let win of Zotero.getMainWindows()) {
      this.addToWindow(win);
    }
    this.active = true;
    await this.loadStatusCache();
    this.columnKey = await Zotero.ItemTreeManager.registerColumn({
      dataKey: "translation",
      label: this.t("pt-column-label"),
      pluginID: this.id,
      dataProvider: (item) => this.statusText(item),
      zoteroPersist: ["width", "hidden", "sortDirection"],
    });
    this.queue = new PaperTranslatorQueue(this);
    await this.queue.load();
    Zotero.Promise.delay(QUEUE_RESUME_DELAY_MS)
      .then(() => this.active && this.queue.offerResume())
      .catch((e) => Zotero.logError(e));
    Zotero.Promise.delay(SESSION_CLEANUP_DELAY_MS)
      .then(() => this.active && this.cleanSessions())
      .catch((e) => Zotero.logError(e));
  },

  shutdown() {
    this.active = false;
    this.queue?.shutdown();
    if (this.queueWindow && !this.queueWindow.closed) {
      this.queueWindow.close();
    }
    if (this.columnKey) {
      Zotero.ItemTreeManager.unregisterColumn(this.columnKey);
    }
    for (let translation of this.textTranslations.values()) translation.close();
    this.textTranslations.clear();
    if (this.readerHandler) Zotero.Reader.unregisterEventListener("renderToolbar", this.readerHandler);
    if (this.readerContextHandler) Zotero.Reader.unregisterEventListener("createViewContextMenu", this.readerContextHandler);
    for (let binding of this.readerBindings) binding.dispose();
    this.readerBindings.clear();
    for (let menuID of this.menuIDs) {
      Zotero.MenuManager.unregisterMenu(menuID);
    }
    this.menuIDs = [];
    if (this.prefPaneID) {
      Zotero.PreferencePanes.unregister(this.prefPaneID);
    }
    for (let win of Zotero.getMainWindows()) {
      this.removeFromWindow(win);
    }
    delete Zotero.PaperTranslator;
  },

  addToWindow(win) {
    win.MozXULElement.insertFTLIfNeeded("paper-translator.ftl");
  },

  removeFromWindow(win) {
    win.document.querySelector('[href="paper-translator.ftl"]')?.remove();
  },

  registerMenus() {
    let menuID = Zotero.MenuManager.registerMenu({
      menuID: "paper-translator-item",
      pluginID: this.id,
      target: "main/library/item",
      menus: [{
        menuType: "menuitem",
        l10nID: "paper-translator-menu-text-translation",
        icon: this.rootURI + "content/icon.svg",
        onShowing: (event, context) => {
          context.setVisible(this.getPDFAttachments(context.items).length > 0);
        },
        onCommand: (event, context) => {
          for (let attachment of this.getPDFAttachments(context.items)) {
            this.openTextTranslation(attachment).catch(error => {
              Zotero.logError(error);
              Zotero.alert(null, this.t("pt-text-translation-open"), String(error.message || error));
            });
          }
        },
      }, {
        menuType: "menuitem",
        l10nID: "paper-translator-menu-queue-add",
        onShowing: (event, context) => {
          context.setVisible(this.getPDFAttachments(context.items).length > 0);
        },
        onCommand: (event, context) => {
          this.queue.add(this.getPDFAttachments(context.items), "main");
          this.openQueueWindow();
          this.queue.start();
        },
      }],
    });
    let toolsMenuID = Zotero.MenuManager.registerMenu({
      menuID: "paper-translator-tools",
      pluginID: this.id,
      target: "main/menubar/tools",
      menus: [{
        menuType: "menuitem",
        l10nID: "paper-translator-menu-queue",
        icon: this.rootURI + "content/icon.svg",
        onCommand: () => this.openQueueWindow(),
      }],
    });
    this.menuIDs = [menuID, toolsMenuID].filter(Boolean);
  },

  openQueueWindow() {
    if (this.queueWindow && !this.queueWindow.closed) {
      this.queueWindow.focus();
      return;
    }
    this.queueWindow = Zotero.getMainWindow().openDialog(
      "chrome://paper-translator/content/queue.xhtml", "paper-translator-queue",
      "chrome,resizable,centerscreen,dialog=no,width=820,height=620"
    );
  },

  // Library status column

  /** Read each session's summary.json; only the newest per paper and language counts. */
  async loadStatusCache() {
    this.statusCache.clear();
    let root = PathUtils.join(this.dataDir, "sessions");
    if (!(await IOUtils.exists(root))) {
      return;
    }
    for (let folder of await IOUtils.getChildren(root)) {
      let [libraryID, key] = PathUtils.filename(folder).split("-");
      try {
        let summary = JSON.parse(await IOUtils.readUTF8(PathUtils.join(folder, "summary.json")));
        this.rememberStatus(`${libraryID}/${key}`, summary);
      }
      catch {
        // Sessions from before summary.json get one when next saved
      }
    }
  },

  rememberStatus(key, summary) {
    let lang = this.getSettings().langOut;
    let known = this.statusCache.get(key);
    if (summary.lang === lang && (!known || known.updated_at <= summary.updated_at)) {
      this.statusCache.set(key, summary);
    }
  },

  /** Called by a translation whenever its session changes. */
  noteSession(translation) {
    let paragraphs = translation.session?.paragraphs || [];
    let suggested = paragraphs.filter((p) => p.suggested);
    this.rememberStatus(`${translation.attachment.libraryID}/${translation.attachment.key}`, {
      lang: translation.lang,
      updated_at: Date.now() / 1000,
      translated: paragraphs.filter((p) => p.translation).length,
      suggested: suggested.length,
      suggested_translated: suggested.filter((p) => p.translation).length,
    });
    this.refreshStatusColumn();
  },

  refreshStatusColumn() {
    if (this.columnRefreshPending || !this.columnKey) {
      return;
    }
    this.columnRefreshPending = true;
    Zotero.Promise.delay(1000).then(() => {
      this.columnRefreshPending = false;
      if (this.active) {
        Zotero.ItemTreeManager.refreshColumns();
      }
    });
  },

  /** Short status for a paper or its PDF: queue state first, then saved progress. */
  statusText(item) {
    let attachment = item.isRegularItem() ? this.getPDFAttachments([item])[0]
      : item.isPDFAttachment?.() && !this.isTranslationOutput(item) ? item : null;
    if (!attachment) {
      return "";
    }
    let entry = this.queue?.entryFor(attachment);
    if (entry && ["queued", "parsing", "translating", "failed"].includes(entry.state)) {
      return this.t(`pt-column-${entry.state}`, {
        percent: entry.total ? Math.round(100 * entry.done / entry.total) : entry.percent || 0,
      });
    }
    let summary = this.statusCache.get(PaperTranslatorQueue.keyOf(attachment));
    if (!summary?.translated) {
      return "";
    }
    let lang = this.t(`pt-lang-${summary.lang}`);
    if (!summary.suggested || summary.suggested_translated >= summary.suggested) {
      return this.t("pt-column-translated", { lang });
    }
    return this.t("pt-column-partial", {
      lang, percent: Math.round(100 * summary.suggested_translated / summary.suggested),
    });
  },

  // Preferences

  getPref(name) {
    return Zotero.Prefs.get(PREF_BRANCH + name, true);
  },

  setPref(name, value) {
    Zotero.Prefs.set(PREF_BRANCH + name, value, true);
  },

  getSettings() {
    let baseURL = (this.getPref("baseURL") || "").trim();
    let model = (this.getPref("model") || "").trim();
    return {
      baseURL,
      apiKey: (this.getPref("apiKey") || "").trim(),
      model,
      langOut: this.getPref("langOut") || "zh",
      qps: parseInt(this.getPref("qps")) || 4,
      customPrompt: (this.getPref("customPrompt") || "").trim(),
      openWhenDone: !!this.getPref("openWhenDone"),
      // "auto", or a field the user chose; see THINKING_OFF in translation.py
      thinkingMethod: this.getPref("thinkingMethod") || "auto",
      tokenField: this.getPref("tokenField") || "auto",
      // 0 means automatic: start at 8192 and double when an answer is cut off
      maxTokens: parseInt(this.getPref("maxTokens")) || 0,
      detected: this.detectedOptions(baseURL, model),
    };
  },

  /** What detection found for this API and model, or null if it has not run for them. */
  detectedOptions(baseURL, model) {
    try {
      let detected = JSON.parse(this.getPref("detectedOptions") || "{}");
      return detected.api === `${baseURL} ${model}` ? detected : null;
    }
    catch {
      return null;
    }
  },

  rememberDetected({ thinking_method, token_field }, settings = this.getSettings()) {
    this.setPref("detectedOptions", JSON.stringify({
      api: `${settings.baseURL} ${settings.model}`, thinking_method, token_field,
    }));
  },

  apiJob(settings) {
    let isAuto = (value) => value === "auto";
    let detected = settings.detected || {};
    return {
      base_url: settings.baseURL,
      api_key: settings.apiKey,
      model: settings.model,
      thinking_method: isAuto(settings.thinkingMethod) ? detected.thinking_method || "auto" : settings.thinkingMethod,
      token_field: isAuto(settings.tokenField) ? detected.token_field || "auto" : settings.tokenField,
      // Only these may be changed when the API rejects them
      auto_fields: [isAuto(settings.thinkingMethod) && "thinking", isAuto(settings.tokenField) && "token_field"]
        .filter(Boolean),
      max_tokens: settings.maxTokens,
    };
  },

  /**
   * 0.3.0 had reasoning-effort and thinking-mode settings; keep what a user
   * chose there as the matching request option.
   */
  migratePrefs() {
    let chosen = (name) => (Zotero.Prefs.prefHasUserValue(PREF_BRANCH + name, true) ? this.getPref(name) : null);
    let thinking = chosen("thinking");
    let reasoning = chosen("reasoning");
    if (thinking === null && reasoning === null) {
      return;
    }
    if (thinking === "disabled") {
      this.setPref("thinkingMethod", "thinking");
    }
    else if (reasoning === "minimal") {
      this.setPref("thinkingMethod", "reasoning");
    }
    else if (thinking === "enabled" || reasoning !== null) {
      this.setPref("thinkingMethod", "none");
    }
    Zotero.Prefs.clear(PREF_BRANCH + "thinking", true);
    Zotero.Prefs.clear(PREF_BRANCH + "reasoning", true);
  },

  /** Model IDs an OpenAI-compatible API offers (GET /models). */
  async fetchModels(baseURL, apiKey) {
    let xhr = await Zotero.HTTP.request("GET", baseURL.replace(/\/+$/, "") + "/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      responseType: "json",
      timeout: 20000,
    });
    let ids = (xhr.response?.data || []).map((model) => model.id).filter(Boolean);
    return [...new Set(ids)].sort();
  },

  t(id, args) {
    return this.l10n.formatValueSync(id, args) || id;
  },

  // Environment

  get dataDir() {
    return PathUtils.join(Zotero.DataDirectory.dir, "paper-translator");
  },

  get venvDir() {
    return PathUtils.join(this.dataDir, "venv");
  },

  get venvPython() {
    return Zotero.isWin
      ? PathUtils.join(this.venvDir, "Scripts", "python.exe")
      : PathUtils.join(this.venvDir, "bin", "python");
  },

  get runnerPath() {
    return PathUtils.join(this.dataDir, "runner.py");
  },

  get lockPath() {
    return PathUtils.join(this.dataDir, "requirements.lock");
  },

  // Copy of the lock file the venv was built from; a mismatch means the plugin
  // was updated with new dependencies and the venv must be synced again
  get installedLockPath() {
    return PathUtils.join(this.venvDir, "paper-translator.lock");
  },

  /**
   * Read a file shipped in the plugin's python/ folder.
   * Installed from an .xpi, rootURI is a jar: URL whose path contains the
   * plugin ID's '@', which getContentsFromURLAsync() misreads as a username.
   */
  readBundledPythonFile(name) {
    return Zotero.File.getResourceAsync(this.rootURI + "python/" + name);
  },

  async installPythonFiles() {
    await IOUtils.makeDirectory(this.dataDir, { ignoreExisting: true });
    for (let name of ["runner.py", "text_translation.py", "translation.py", "requirements.lock"]) {
      let text = await this.readBundledPythonFile(name);
      await IOUtils.writeUTF8(PathUtils.join(this.dataDir, name), text);
    }
    await IOUtils.remove(PathUtils.join(this.dataDir, "workspace.py"), { ignoreAbsent: true });
  },

  async isEnvironmentReady() {
    if (!(await IOUtils.exists(this.venvPython)) || !(await IOUtils.exists(this.installedLockPath))) {
      return false;
    }
    let installed = await IOUtils.readUTF8(this.installedLockPath);
    let wanted = await this.readBundledPythonFile("requirements.lock");
    return installed === wanted;
  },

  async findUV() {
    let custom = (this.getPref("uvPath") || "").trim();
    if (custom) {
      return (await IOUtils.exists(custom)) ? custom : null;
    }
    // GUI apps on macOS don't inherit the shell's PATH, so check the usual
    // install locations before searching PATH
    let home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    let candidates = Zotero.isWin
      ? [PathUtils.join(home, ".local", "bin", "uv.exe"), PathUtils.join(home, ".cargo", "bin", "uv.exe")]
      : [
          "/opt/homebrew/bin/uv",
          "/usr/local/bin/uv",
          PathUtils.join(home, ".local", "bin", "uv"),
          PathUtils.join(home, ".cargo", "bin", "uv"),
        ];
    for (let path of candidates) {
      if (await IOUtils.exists(path)) {
        return path;
      }
    }
    try {
      return await Subprocess.pathSearch(Zotero.isWin ? "uv.exe" : "uv");
    }
    catch (e) {
      return null;
    }
  },

  /**
   * Make sure the venv exists and matches the bundled lock file.
   * Concurrent callers share one setup run.
   * @param {Function} [onStatus] - Called with a status line and, for the
   *   settings page, { step, state, detail, fraction }
   * @param {Object} [options]
   * @param {boolean} [options.repair] - Reinstall even if the venv looks fine
   */
  ensureEnvironment(onStatus = () => {}, { repair = false } = {}) {
    if (!this.setupPromise) {
      this.setupPromise = this._setUpEnvironment(onStatus, repair).finally(() => {
        this.setupPromise = null;
      });
    }
    return this.setupPromise;
  },

  async _setUpEnvironment(onStatus, repair) {
    await this.installPythonFiles();
    if (!repair && (await this.isEnvironmentReady())) {
      return;
    }
    let report = (step, state, detail = "", fraction = null) => {
      onStatus(this.t(`pt-setup-step-${step}`), { step, state, detail, fraction });
    };
    report("find-uv", "running");
    let uv = await this.findUV();
    report("find-uv", "done", uv || this.t("pt-setup-uv-missing"));
    if (uv) {
      report("download-uv", "skipped");
    }
    else {
      report("download-uv", "running");
      uv = await this.downloadUV((fraction, detail) => report("download-uv", "running", detail, fraction));
      report("download-uv", "done", uv);
    }
    // The settings page shows the uv that was actually used
    this.setPref("uvPath", uv);

    let packageCount = ((await IOUtils.readUTF8(this.lockPath)).match(/^[A-Za-z0-9_.-]+==/gm) || []).length;
    let steps = [
      ["venv", uv, ["venv", "--python", PYTHON_VERSION, "--allow-existing", this.venvDir]],
      ["packages", uv, ["pip", "sync", "--python", this.venvPython, this.lockPath, ...(repair ? ["--reinstall"] : [])]],
      ["warmup", this.venvPython, [this.runnerPath, "warmup"]],
    ];
    for (let [step, command, args] of steps) {
      report(step, "running");
      let downloaded = 0;
      let { exitCode, result, log } = await this.run(command, args, {
        onLine: (line) => {
          // uv logs "Downloading <package> (<size>)" and "Downloaded <package>"
          let match = line.match(/^\s*Download(ing|ed)\s+(\S+)/);
          if (step === "packages" && match) {
            downloaded += match[1] === "ed" ? 1 : 0;
            report(step, "running", match[2], packageCount ? Math.min(1, downloaded / packageCount) : null);
          }
          else if (step !== "packages") {
            report(step, "running", line.trim().slice(0, 100));
          }
        },
      });
      if (exitCode !== 0 || result?.type === "error") {
        report(step, "failed");
        let logPath = await this.saveLog("setup", log);
        throw new UserError(this.t("pt-error-setup-failed", { log: logPath }));
      }
      report(step, "done");
    }
    await IOUtils.copy(this.lockPath, this.installedLockPath);
  },

  /**
   * Fetch uv's official build for this system into the plugin's folder,
   * verified against the SHA-256 published with the release.
   */
  async downloadUV(onProgress) {
    let arch = Services.appinfo.XPCOMABI.split("-")[0];
    if (!["x86_64", "aarch64"].includes(arch)) {
      throw new UserError(this.t("pt-error-uv-not-found"));
    }
    let target = Zotero.isWin ? `${arch}-pc-windows-msvc`
      : Zotero.isMac ? `${arch}-apple-darwin` : `${arch}-unknown-linux-gnu`;
    let name = `uv-${target}.${Zotero.isWin ? "zip" : "tar.gz"}`;
    let url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}`;
    let dir = PathUtils.join(this.dataDir, "uv");
    let archive = PathUtils.join(this.dataDir, name);
    try {
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
      await IOUtils.makeDirectory(dir, { createAncestors: true });
      let checksum = await Zotero.HTTP.request("GET", url + ".sha256", { timeout: 30000 });
      let expected = checksum.responseText.trim().split(/\s+/)[0].toLowerCase();
      await Zotero.HTTP.download(url, archive, {
        onProgress: (bytes, total) => onProgress(total ? bytes / total : null, `${(bytes / 1048576).toFixed(1)} MB`),
      });
      if ((await this.sha256(archive)) !== expected) {
        throw new Error(this.t("pt-error-uv-checksum"));
      }
      // tar ships with macOS, Linux and Windows 10+, and reads zip files too
      let tar = await Subprocess.pathSearch(Zotero.isWin ? "tar.exe" : "tar");
      let { exitCode, log } = await this.run(tar, ["-xf", archive, "-C", dir]);
      if (exitCode !== 0) {
        throw new Error(log.join("\n"));
      }
      let binary = await this.findFile(dir, Zotero.isWin ? "uv.exe" : "uv");
      if (!binary) {
        throw new Error(`${name} has no uv binary`);
      }
      return binary;
    }
    catch (e) {
      throw new UserError(this.t("pt-error-uv-download", { detail: String(e.message || e) }));
    }
    finally {
      await IOUtils.remove(archive, { ignoreAbsent: true });
    }
  },

  async sha256(path) {
    let hasher = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hasher.init(Ci.nsICryptoHash.SHA256);
    let bytes = await IOUtils.read(path);
    hasher.update(bytes, bytes.length);
    return Array.from(hasher.finish(false), (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  },

  async findFile(dir, name) {
    for (let path of await IOUtils.getChildren(dir)) {
      let info = await IOUtils.stat(path);
      if (info.type === "directory") {
        let found = await this.findFile(path, name);
        if (found) {
          return found;
        }
      }
      else if (PathUtils.filename(path) === name) {
        return path;
      }
    }
    return null;
  },

  async checkEnvironment() {
    if (!(await this.isEnvironmentReady())) {
      return null;
    }
    await this.installPythonFiles();
    let { result } = await this.run(this.venvPython, [this.runnerPath, "check"]);
    return result?.type === "check" ? result : null;
  },

  /** Send a short request; returns the request options detected for this API. */
  async testConnection(settings) {
    await this.ensureEnvironment();
    let { result, log } = await this.run(this.venvPython, [this.runnerPath, "ping"], {
      input: JSON.stringify(this.apiJob(settings)),
    });
    if (result?.type !== "done") {
      throw new UserError(await this.describeRunnerError(result, log));
    }
    if (result.detected) {
      this.rememberDetected(result.detected, settings);
    }
    return result.detected;
  },

  // Subprocesses

  /**
   * Run a command, collecting runner protocol messages and log lines.
   * @param {Object} [options]
   * @param {string} [options.input] - Written to stdin
   * @param {Function} [options.onMessage] - Called with each protocol message
   * @param {Function} [options.onSpawn] - Called with the process handle
   * @param {Function} [options.onLine] - Called with each log line
   */
  async run(command, args, { input, onMessage, onSpawn, onLine } = {}) {
    let proc = await Subprocess.call({
      command,
      arguments: args,
      workdir: this.dataDir,
      stderr: "stdout",
      environment: { PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1", COLUMNS: "200" },
      environmentAppend: true,
    });
    onSpawn?.(proc);
    if (input !== undefined) {
      await proc.stdin.write(input);
    }
    await proc.stdin.close();

    let log = [];
    let result = null;
    let handleLine = (line) => {
      if (line.startsWith(PROTOCOL_PREFIX)) {
        let message = JSON.parse(line.slice(PROTOCOL_PREFIX.length));
        if (message.type === "request_options") {
          // An automatic request field was rejected mid-translation and replaced
          this.rememberDetected(message);
          return;
        }
        if (message.type !== "progress") {
          result = message;
        }
        onMessage?.(message);
      }
      else if (line.trim()) {
        onLine?.(line);
        log.push(line);
        if (log.length > LOG_LINES_KEPT) {
          log.shift();
        }
      }
    };
    let buffer = "";
    let chunk;
    while ((chunk = await proc.stdout.readString())) {
      buffer += chunk;
      // Progress bars redraw with bare \r
      let lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop();
      lines.forEach(handleLine);
    }
    if (buffer) {
      handleLine(buffer);
    }
    let { exitCode } = await proc.wait();
    return { exitCode, result, log };
  },

  async saveLog(name, lines) {
    let path = PathUtils.join(this.dataDir, `${name}-error.log`);
    await IOUtils.writeUTF8(path, lines.join("\n"));
    return path;
  },

  async describeRunnerError(result, log) {
    let l10nID = RUNNER_ERROR_L10N[result?.code];
    if (l10nID) {
      return this.t(l10nID, { detail: result.message });
    }
    let logPath = await this.saveLog("translate", log);
    return this.t("pt-error-unknown", { detail: result?.message || "?", log: logPath });
  },

  // Text translation

  isTextTranslationReader(reader) {
    let item = Zotero.Items.get(reader.itemID);
    return !!(item && this.readerRegistry[`${item.libraryID}/${item.key}`])
      || [...this.textTranslations.values()].some(translation => translation.readerItem?.id === reader.itemID);
  },

  sourceFor(attachment) {
    let link = this.readerRegistry[`${attachment.libraryID}/${attachment.key}`];
    if (!link) return attachment;
    let source = Zotero.Items.getByLibraryAndKey(link.libraryID, link.sourceKey);
    if (!source || source.deleted) throw new Error(this.t("pt-error-source-deleted"));
    return source;
  },

  async rememberReader(translation) {
    this.readerRegistry[`${translation.readerItem.libraryID}/${translation.readerItem.key}`] = {
      libraryID: translation.attachment.libraryID, sourceKey: translation.attachment.key,
      lang: translation.lang,
    };
    let text = JSON.stringify(this.readerRegistry);
    this.registryWrite = this.registryWrite.catch(() => {}).then(async () => {
      let path = PathUtils.join(this.dataDir, "native-readers.json");
      await IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp" });
    });
    await this.registryWrite;
  },

  /**
   * Keep each paper's translations (session.json) for good, but drop the
   * parse cache of papers unused for a while; it is rebuilt on demand. A
   * session whose source attachment no longer exists is removed entirely.
   */
  async cleanSessions() {
    let root = PathUtils.join(this.dataDir, "sessions");
    if (!(await IOUtils.exists(root))) {
      return;
    }
    let open = new Set([...this.textTranslations.values()].map((translation) => translation.folder));
    for (let folder of await IOUtils.getChildren(root)) {
      // Folder names start with "<libraryID>-<attachment key>-"
      let [libraryID, key] = PathUtils.filename(folder).split("-");
      if (!this.active || open.has(folder) || !/^\d+$/.test(libraryID) || !key) {
        continue;
      }
      try {
        // An item in the trash may still be restored, so only a purged one counts
        if (!(await Zotero.Items.getByLibraryAndKeyAsync(Number(libraryID), key))) {
          await IOUtils.remove(folder, { recursive: true, ignoreAbsent: true });
          continue;
        }
        let lastUsed = 0;
        for (let name of ["session.json", "view.json"]) {
          let info = await IOUtils.stat(PathUtils.join(folder, name)).catch(() => null);
          lastUsed = Math.max(lastUsed, info?.lastModified || 0);
        }
        if (Date.now() - lastUsed < SESSION_CACHE_DAYS * 24 * 60 * 60 * 1000) {
          continue;
        }
        let names = SESSION_CACHE_FILES.concat(
          (await IOUtils.getChildren(folder)).map((path) => PathUtils.filename(path))
            .filter((name) => /^(reader|translation)-.*\.pdf$/.test(name))
        );
        for (let name of names) {
          await IOUtils.remove(PathUtils.join(folder, name), { recursive: true, ignoreAbsent: true });
        }
      }
      catch (e) {
        Zotero.logError(e);
      }
    }
  },

  /** The one translation object per source PDF and language, shared by tabs and the queue. */
  textTranslationFor(attachment, lang) {
    lang ||= this.getSettings().langOut;
    let key = `${attachment.libraryID}-${attachment.key}-${lang}`;
    let translation = this.textTranslations.get(key);
    if (!translation || translation.closed) {
      translation = new PaperTranslatorTextTranslation(this, attachment, () => this.textTranslations.delete(key), lang);
      this.textTranslations.set(key, translation);
    }
    return translation;
  },

  async openTextTranslation(attachment, options = {}) {
    if (!attachment?.isPDFAttachment?.()) return;
    let readerItem = attachment;
    let link = this.readerRegistry[`${attachment.libraryID}/${attachment.key}`];
    attachment = this.sourceFor(attachment);
    let translation = this.textTranslationFor(attachment, link?.lang);
    translation.openMenuRequested ||= !!options.showMenu;
    if (options.reader && link) {
      translation.readerItem = readerItem;
      translation.reader = options.reader;
      translation.readers.add(options.reader);
      for (let binding of this.readerBindings) if (binding.reader === options.reader) binding.bind(translation);
    }
    if (translation.readerItem && options.activate !== false) {
      await translation.showNativeTab();
      if (options.showMenu) {
        for (let binding of this.readerBindings) if (binding.reader.itemID === translation.readerItem.id) binding.show();
      }
    }
    await translation.init({ showReader: options.activate !== false });
    return translation;
  },

  async translateAt(attachment, position, reader) {
    let translation = [...this.textTranslations.values()].find(w => w.readerItem?.id === reader.itemID);
    if (!translation || translation.session?.parse_status !== "ready" || attachment.id !== reader.itemID) return;
    let paragraph = translation.paragraphAt(position, reader);
    if (!paragraph) throw new Error(this.t("pt-error-no-paragraph"));
    await translation.translate([paragraph.id]);
    return translation;
  },

  isTranslationOutput(attachment) {
    return OUTPUT_FILE_RE.test(attachment.attachmentFilename || "");
  },

  /** The PDF attachments to translate for the selected items: the first PDF of each regular item. */
  getPDFAttachments(items) {
    let attachments = [];
    let seen = new Set();
    for (let item of items || []) {
      let candidates = item.isRegularItem() ? Zotero.Items.get(item.getAttachments()) : [item];
      for (let attachment of candidates) {
        if (
          !attachment.isPDFAttachment?.()
          || attachment.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL
          || this.isTranslationOutput(attachment)
          || seen.has(attachment.id)
        ) {
          continue;
        }
        seen.add(attachment.id);
        attachments.push(attachment);
        break;
      }
    }
    return attachments;
  },

  /** Import a translated PDF next to the original attachment. */
  async attachOutput(original, path, lang, dual) {
    let parentItemID = original.parentItemID || undefined;
    let langName = this.t(`pt-lang-${lang}`);
    // Firefox trims file names to keep the whole path under ~255 bytes, which
    // would cut off the suffix OUTPUT_FILE_RE looks for, so shorten the base first
    let baseName = Zotero.File.truncateFileName(original.attachmentFilename.replace(/\.pdf$/i, ""), 80);
    return Zotero.Attachments.importFromFile({
      file: path,
      libraryID: original.libraryID,
      parentItemID,
      collections: parentItemID ? undefined : original.getCollections(),
      fileBaseName: `${baseName}.${lang}${dual ? ".dual" : ""}`,
      title: this.t(dual ? "pt-attachment-dual" : "pt-attachment-mono", { lang: langName }),
    });
  },
};
