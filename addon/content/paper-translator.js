/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils, Localization */

var { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const PREF_BRANCH = "extensions.paper-translator.";
// Must match PROTOCOL_PREFIX in python/runner.py
const PROTOCOL_PREFIX = "@@PT ";
const PYTHON_VERSION = "3.12";
const LOG_LINES_KEPT = 300;
const OUTPUT_LANGS = ["zh", "zh-TW", "ja", "ko", "en"];
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
  },

  shutdown() {
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
      }],
    });
    this.menuIDs = [menuID].filter(Boolean);
  },

  // Preferences

  getPref(name) {
    return Zotero.Prefs.get(PREF_BRANCH + name, true);
  },

  getSettings() {
    return {
      baseURL: (this.getPref("baseURL") || "").trim(),
      apiKey: (this.getPref("apiKey") || "").trim(),
      model: (this.getPref("model") || "").trim(),
      langOut: this.getPref("langOut") || "zh",
      reasoning: this.getPref("reasoning") || "",
      qps: parseInt(this.getPref("qps")) || 4,
      customPrompt: (this.getPref("customPrompt") || "").trim(),
      openWhenDone: !!this.getPref("openWhenDone"),
      maxTokens: parseInt(this.getPref("maxTokens")) || 8192,
      thinking: this.getPref("thinking") || "",
    };
  },

  apiJob(settings) {
    return {
      base_url: settings.baseURL,
      api_key: settings.apiKey,
      model: settings.model,
      reasoning: settings.reasoning,
      max_tokens: settings.maxTokens,
      thinking: settings.thinking,
    };
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
   */
  ensureEnvironment(onStatus = () => {}) {
    if (!this.setupPromise) {
      this.setupPromise = this._setUpEnvironment(onStatus).finally(() => {
        this.setupPromise = null;
      });
    }
    return this.setupPromise;
  },

  async _setUpEnvironment(onStatus) {
    await this.installPythonFiles();
    if (await this.isEnvironmentReady()) {
      return;
    }
    let uv = await this.findUV();
    if (!uv) {
      throw new UserError(this.t("pt-error-uv-not-found"));
    }
    let steps = [
      ["pt-setup-venv", uv, ["venv", "--python", PYTHON_VERSION, "--allow-existing", this.venvDir]],
      ["pt-setup-install", uv, ["pip", "sync", "--python", this.venvPython, this.lockPath]],
      ["pt-setup-warmup", this.venvPython, [this.runnerPath, "warmup"]],
    ];
    for (let [l10nID, command, args] of steps) {
      onStatus(this.t(l10nID));
      let { exitCode, result, log } = await this.run(command, args);
      if (exitCode !== 0 || result?.type === "error") {
        let logPath = await this.saveLog("setup", log);
        throw new UserError(this.t("pt-error-setup-failed", { log: logPath }));
      }
    }
    await IOUtils.copy(this.lockPath, this.installedLockPath);
  },

  async checkEnvironment() {
    if (!(await this.isEnvironmentReady())) {
      return null;
    }
    await this.installPythonFiles();
    let { result } = await this.run(this.venvPython, [this.runnerPath, "check"]);
    return result?.type === "check" ? result : null;
  },

  async testConnection(settings) {
    await this.ensureEnvironment();
    let { result, log } = await this.run(this.venvPython, [this.runnerPath, "ping"], {
      input: JSON.stringify(this.apiJob(settings)),
    });
    if (result?.type !== "done") {
      throw new UserError(await this.describeRunnerError(result, log));
    }
  },

  // Subprocesses

  /**
   * Run a command, collecting runner protocol messages and log lines.
   * @param {Object} [options]
   * @param {string} [options.input] - Written to stdin
   * @param {Function} [options.onMessage] - Called with each protocol message
   * @param {Function} [options.onSpawn] - Called with the process handle
   */
  async run(command, args, { input, onMessage, onSpawn } = {}) {
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
        if (message.type !== "progress") {
          result = message;
        }
        onMessage?.(message);
      }
      else if (line.trim()) {
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

  async openTextTranslation(attachment, options = {}) {
    if (!attachment?.isPDFAttachment?.()) return;
    let readerItem = attachment;
    let link = this.readerRegistry[`${attachment.libraryID}/${attachment.key}`];
    attachment = this.sourceFor(attachment);
    let lang = link?.lang || this.getSettings().langOut;
    let key = `${attachment.libraryID}-${attachment.key}-${lang}`;
    let translation = this.textTranslations.get(key);
    if (!translation || translation.closed) {
      translation = new PaperTranslatorTextTranslation(this, attachment, () => this.textTranslations.delete(key), lang);
      this.textTranslations.set(key, translation);
    }
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
