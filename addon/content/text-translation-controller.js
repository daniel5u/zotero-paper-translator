/* global Zotero, IOUtils, PathUtils, Components, PaperTranslatorTextTranslation, PaperTranslatorNativeReader */

var PaperTranslatorTextTranslation = class {
  constructor(plugin, attachment, onClose, lang) {
    this.plugin = plugin;
    this.attachment = attachment;
    this.onClose = onClose;
    this.lang = lang || plugin.getSettings().langOut;
    this.listeners = new Set();
    this.readers = new Set();
    this.readerTitleHandlers = new Map();
    this.session = null;
    this.geometry = [];
    this.view = {};
    this.selected = new Set();
    this.pending = new Set();
    this.renderErrors = new Map();
    this.busy = false;
    this.initializing = false;
    this.exporting = false;
    this.operationError = null;
    this.cancelRequested = false;
    this.proc = null;
    this.closed = false;
    this.status = "";
    this.statusKey = null;
    this.progress = { percent: null, completed: 0, total: 0 };
    this.progressIDs = new Set();
    this.completedIDs = new Set();
    this.viewWrite = Promise.resolve();
    this.readerUpdates = Promise.resolve();
    this.initialized = null;
    this.readerItem = null;
    this.currentGeneration = null;
    this.openMenuRequested = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setStatus(key, args) {
    this.statusKey = key;
    this.status = key ? this.plugin.t(key, args) : "";
  }

  send(type, fields = {}) {
    for (let listener of this.listeners) {
      try { listener({ type, ...fields }); }
      catch (error) { Zotero.logError(error); }
    }
  }

  init(options = {}) {
    if (!this.initialized) {
      this.initializing = true;
      this.send("status");
      this.initialized = this.initialize(options).catch(error => {
        this.initialized = null;
        this.operationError = String(error.message || error);
        this.send("error", { message: String(error.message || error) });
        throw error;
      }).finally(() => {
        this.initializing = false;
        this.send("status");
      });
    }
    return this.initialized;
  }

  async initialize({ showReader = true } = {}) {
    await this.plugin.ensureEnvironment((text) => {
      this.statusKey = null; this.status = text; this.send("status");
    });
    if (this.closed) return;
    let input = await this.attachment.getFilePathAsync();
    if (!input) throw new Error(this.plugin.t("pt-error-no-file"));
    let stat = await IOUtils.stat(input);
    this.folder = PathUtils.join(this.plugin.dataDir, "sessions",
      `${this.attachment.libraryID}-${this.attachment.key}-${this.lang}-${stat.size}-${Math.trunc(stat.lastModified)}`);
    await IOUtils.makeDirectory(this.folder, { createAncestors: true });
    try { this.view = JSON.parse(await IOUtils.readUTF8(PathUtils.join(this.folder, "view.json"))); }
    catch { this.view = {}; }
    this.selected = new Set(this.view.selected || []);
    await this.operation("session-open", { input });
    await this.readerUpdates;
    let reader = showReader ? await this.showNativeTab() : this.reader;
    // Let Zotero finish opening the native PDF before the separate parser
    // starts. The document remains usable throughout the background parse.
    await reader?._initPromise;
    await reader?._internalReader?._primaryView?.initializedPromise;
    if (this.session?.parse_status !== "ready") await this.operation("session-parse");
    if (this.session?.paragraphs.some(p => p.translation)) {
      await this.operation("session-reader");
    }
    await this.readerUpdates;
    this.setStatus(null);
    this.send("ready");
  }

  accept(message) {
    if (message.type === "session") {
      this.session = message.session;
      this.geometry = message.session.reader_document?.geometry || this.geometry;
      if (!Array.isArray(this.view.selected) && this.session.parse_status === "ready") {
        this.setSelection(this.session.paragraphs.filter(p => p.suggested).map(p => p.id));
      }
    }
    else if (message.type === "paragraph" && this.session) {
      let index = this.session.paragraphs.findIndex(p => p.id === message.paragraph.id);
      if (index >= 0) this.session.paragraphs[index] = message.paragraph;
      this.setStatus(message.paragraph.status === "running" ? "pt-status-translating-page" : null,
        { page: message.paragraph.page });
      if (this.progressIDs.has(message.paragraph.id) && !["running", "queued"].includes(message.paragraph.status)) {
        this.completedIDs.add(message.paragraph.id);
        this.progress.completed = this.completedIDs.size;
        this.progress.percent = 90 * this.progress.completed / this.progress.total;
      }
    }
    else if (message.type === "preview_error") this.renderErrors.set(message.page, message.message);
    else if (message.type === "reader_document") {
      // A new file means every out-of-date page was drawn successfully.
      if (message.path) this.renderErrors.clear();
      this.progress.percent = 98;
      this.geometry = message.geometry;
      this.nextDocument = message;
      if (!this.refreshing) {
        this.refreshing = true;
        this.readerUpdates = this.readerUpdates.catch(() => {}).then(async () => {
          try {
            while (this.nextDocument && !this.closed) {
              let next = this.nextDocument; this.nextDocument = null;
              await this.presentDocument(next);
            }
          }
          finally {
            this.refreshing = false;
            if (!this.busy) this.progress.percent = 100;
            this.send("progress");
          }
        });
        this.readerUpdates.catch(error => {
          this.operationError = String(error.message || error);
          this.send("error", { message: this.operationError });
        });
      }
    }
    else if (message.type === "progress") {
      this.statusKey = message.stage_id || null;
      this.status = message.stage_id ? this.plugin.t(message.stage_id, message.stage_args) : message.stage;
      if (Number.isFinite(message.overall)) this.progress.percent = Math.max(this.progress.percent || 0, message.overall);
    }
    else if (message.type === "retry") this.setStatus("pt-status-retrying", { attempt: message.attempt, maximum: 2 });
    this.send(message.type, message);
  }

  async operation(command, fields = {}) {
    // An export keeps its files in the session folder until they are
    // imported, and the next Python run clears that folder.
    if (this.busy || (this.exporting && command !== "session-export")) throw new Error(this.plugin.t("pt-error-task-busy"));
    if (this.closed) return;
    this.busy = true;
    this.command = command;
    this.operationError = null;
    this.cancelRequested = false;
    this.progressIDs = new Set(command === "session-translate" ? fields.ids : []);
    this.completedIDs.clear();
    this.progress = { percent: this.progressIDs.size ? 0 : null, completed: 0, total: this.progressIDs.size };
    this.setStatus(command === "session-translate" ? "pt-text-translation-running"
      : command === "session-export" ? "pt-text-translation-exporting" : "pt-text-translation-parsing");
    let cancelFile = command === "session-translate" ? `cancel-${Zotero.Utilities.randomString(16)}` : null;
    this.cancelPath = cancelFile ? PathUtils.join(this.folder, cancelFile) : null;
    this.send("busy");
    try {
      let settings = this.plugin.getSettings();
      let job = { ...this.plugin.apiJob(settings), lang_out: this.lang,
        qps: settings.qps, custom_prompt: settings.customPrompt,
        session_dir: this.folder, ...(cancelFile ? { cancel_file: cancelFile } : {}),
        ...await this.readerBase(), ...fields };
      let { exitCode, result, log } = await this.plugin.run(
        this.plugin.venvPython, [this.plugin.runnerPath, command], {
          input: JSON.stringify(job),
          onSpawn: proc => { this.proc = proc; },
          onMessage: message => this.accept(message),
        }
      );
      if (exitCode !== 0 || result?.type === "error") {
        let path = await this.plugin.saveLog("reader", log);
        let detail = result?.message || this.plugin.t("pt-error-process-exit", { code: exitCode });
        throw new Error(this.plugin.t("pt-error-with-log", { detail, log: path }));
      }
    }
    catch (error) {
      this.operationError = String(error.message || error);
      throw error;
    }
    finally {
      this.proc = null;
      this.busy = false;
      this.progress.percent = this.refreshing ? 98 : 100;
      this.cancelPath = null;
      this.setStatus(null);
      this.send("busy");
    }
  }

  async presentDocument(message) {
    if (this.closed) return;
    let saved = await this.readReaderRecord();
    if (!this.readerItem) {
      this.readerItem = await this.recordedReaderItem(saved);
      if (!this.readerItem) {
        if (!message.path) throw new Error(this.plugin.t("pt-error-preview-update"));
        let base = Zotero.File.truncateFileName(this.attachment.attachmentFilename.replace(/\.pdf$/i, ""), 80);
        this.readerItem = await Zotero.Attachments.importFromFile({
          file: message.path, libraryID: this.attachment.libraryID,
          parentItemID: this.attachment.parentItemID || undefined,
          collections: this.attachment.parentItemID ? undefined : this.attachment.getCollections(),
          fileBaseName: `${base}.${this.lang}.dual`,
          title: this.plugin.t("pt-attachment-text-translation"),
        });
        await this.writeReaderRecord(message.generation);
        saved = await this.readReaderRecord();
      }
      await this.plugin.rememberReader(this);
    }
    let title = this.plugin.t("pt-attachment-text-translation");
    if (this.readerItem.getField("title") !== title) {
      this.readerItem.setField("title", title);
      await this.readerItem.saveTx();
    }
    let target = await this.readerItem.getFilePathAsync();
    if (!target || target === await this.attachment.getFilePathAsync()) throw new Error(this.plugin.t("pt-error-preview-update"));
    // A message without a path means the attachment already holds this
    // generation. Rewriting identical bytes would only trigger a sync upload.
    let copied = false;
    if (saved.key !== this.readerItem.key || saved.generation !== message.generation) {
      if (!message.path) throw new Error(this.plugin.t("pt-error-preview-update"));
      await IOUtils.copy(message.path, target + ".pt-tmp");
      await IOUtils.move(target + ".pt-tmp", target, { noOverwrite: false });
      await this.writeReaderRecord(message.generation);
      copied = true;
    }
    // The attachment is now the only copy the plugin keeps.
    if (message.path) await IOUtils.remove(message.path, { ignoreAbsent: true });
    if (copied && this.currentGeneration !== null) {
      let bytes = await IOUtils.read(target);
      for (let reader of this.readers) {
        if (!reader || reader._isUninitialized || reader._isTabClosed || !reader._internalReader) continue;
        let internal = reader._internalReader;
        // Keep the native toolbar, annotation manager, zoom and view state.
        // Only the PDF views reload, with bytes to bypass the attachment URL's
        // cache. Older Zotero readers need explicit disposal of the old views.
        for (let view of [internal._primaryView, internal._secondaryView]) {
          if (!view) continue;
          view._onChangeViewState?.flush?.();
          // Zotero's PDF view leaves delayed accessibility callbacks pending
          // when it is removed. They must not touch its detached iframe.
          for (let value of Object.values(view)) {
            if (typeof value === "function" && typeof value.cancel === "function") value.cancel();
          }
          view.destroy?.();
        }
        internal.reload(Components.utils.cloneInto({ buf: bytes }, reader._iframeWindow));
        await internal._primaryView?.initializedPromise;
      }
    }
    this.currentGeneration = message.generation;
    this.send("document_updated");
  }

  async readReaderRecord() {
    try { return JSON.parse(await IOUtils.readUTF8(PathUtils.join(this.folder, "reader-item.json"))); }
    catch { return {}; } // A new session has no working attachment yet.
  }

  async recordedReaderItem(saved) {
    let item = saved.key && Zotero.Items.getByLibraryAndKey(saved.libraryID, saved.key);
    return item?.isPDFAttachment() && !item.deleted && await item.getFilePathAsync() ? item : null;
  }

  /** Lets Python redraw only changed pages into the dual PDF Zotero already has. */
  async readerBase() {
    let saved = await this.readReaderRecord();
    let item = this.readerItem?.key === saved.key ? this.readerItem : await this.recordedReaderItem(saved);
    let path = item && !item.deleted && await item.getFilePathAsync();
    // Generations are strings: as JavaScript numbers they would be rounded.
    return path && typeof saved.generation === "string"
      ? { reader_base: path, reader_generation: saved.generation } : {};
  }

  async writeReaderRecord(generation) {
    await IOUtils.writeUTF8(PathUtils.join(this.folder, "reader-item.json"), JSON.stringify({
      libraryID: this.readerItem.libraryID, key: this.readerItem.key, generation,
    }));
  }

  setReaderTitle(reader) {
    if (this.readerTitleHandlers.has(reader)) return;
    this.readerTitleHandlers.set(reader, reader.updateTitle);
    // Native reader titles follow the user's author/year preference by default.
    // Override only this translation reader so later item updates keep its title.
    reader.updateTitle = async () => {
      let parent = this.attachment.parentItemID ? Zotero.Items.get(this.attachment.parentItemID) : null;
      let title = parent?.getField("title") || this.attachment.getField("title")
        || this.attachment.attachmentFilename;
      reader._title = this.plugin.t("pt-text-translation-tab-title", { title });
      if (reader._isTabClosed) return;
      reader._setTitleValue(reader._title);
      reader._internalReader?.setTitle(reader._title);
    };
    reader.updateTitle().catch(error => Zotero.logError(error));
  }

  async showNativeTab() {
    if (this.closed || !this.readerItem) return;
    let reader = await Zotero.Reader.open(this.readerItem.id);
    // Selecting a restored, unloaded tab starts loading it and returns no
    // ReaderInstance. Wait for the normal reader created by Zotero in that tab.
    for (let i = 0; !reader && i < 200 && !this.closed; i++) {
      let tabID = Zotero.getMainWindow()?.Zotero_Tabs.getTabIDByItemID(this.readerItem.id);
      reader = tabID && Zotero.Reader.getByTabID(tabID);
      if (!reader) await Zotero.Promise.delay(50);
    }
    if (!reader) throw new Error(this.plugin.t("pt-error-reader-open"));
    this.readers.add(reader);
    this.setReaderTitle(reader);
    this.reader = reader;
    for (let binding of this.plugin.readerBindings) {
      if (binding.reader.itemID === this.readerItem.id) binding.bind(this);
    }
    return reader;
  }

  setSelection(ids) {
    this.selected = new Set(ids);
    this.setStatus(null);
    this.view.selected = [...this.selected];
    this.saveView(this.view);
    this.send("selection");
  }

  selectionPages() {
    let pages = [...new Set((this.session?.paragraphs || []).filter(p => this.selected.has(p.id)).map(p => p.page))].sort((a, b) => a - b);
    let ranges = [];
    for (let i = 0; i < pages.length; i++) {
      let start = pages[i], end = start;
      while (pages[i + 1] === end + 1) end = pages[++i];
      ranges.push(start === end ? String(start) : `${start}-${end}`);
    }
    return ranges.join(",");
  }

  async translateSelected() {
    let ids = this.session.paragraphs.filter(p => this.selected.has(p.id) && p.translatable && !p.translation).map(p => p.id);
    if (!ids.length) throw new Error(this.plugin.t("pt-error-selection-translated"));
    return this.translate(ids);
  }

  async retryFailed() {
    let ids = this.session.paragraphs.filter(p => p.status === "failed").map(p => p.id);
    if (ids.length) await this.translate(ids);
    if (this.renderErrors.size) {
      await this.operation("session-reader", { force_reader: true });
      await this.readerUpdates;
    }
  }

  async translate(ids, instruction = "") {
    let settings = this.plugin.getSettings();
    if (!settings.apiKey || !settings.model || !settings.baseURL) throw new Error(this.plugin.t("pt-error-missing-settings"));
    if (this.busy) {
      if (this.command !== "session-translate") throw new Error(this.plugin.t("pt-error-parse-pending"));
      for (let id of ids) this.pending.add(id);
      this.setStatus("pt-status-queued-paragraphs", { count: this.pending.size });
      this.send("queued");
      return;
    }
    try {
      await this.operation("session-translate", { ids, instruction });
      await this.readerUpdates;
    }
    finally {
      if (this.pending.size && !this.closed) {
        let next = [...this.pending]; this.pending.clear();
        await this.translate(next);
      }
    }
  }

  paragraphAt(position, reader) {
    return PaperTranslatorNativeReader.paragraphAt(position, this.session, this.geometry,
      reader.itemID === this.readerItem?.id);
  }

  async export(options) {
    let exported;
    this.exporting = true;
    let unsubscribe = this.subscribe(message => { if (message.type === "export") exported = message; });
    try {
      await this.operation("session-export", options);
      if (!exported) throw new Error(this.plugin.t("pt-error-export-missing"));
      let added = [];
      for (let [path, dual] of [[exported.mono, false], [exported.dual, true]]) {
        if (path) added.push(await this.plugin.attachOutput(this.attachment, path, this.lang, dual));
      }
      this.setStatus("pt-text-translation-exported"); this.send("status");
      if (this.plugin.getSettings().openWhenDone && added.length) await Zotero.Reader.open(added[0].id);
    }
    catch (error) {
      this.operationError = String(error.message || error);
      throw error;
    }
    finally {
      // Zotero imported its own copies; the typesetting output is disposable.
      await IOUtils.remove(PathUtils.join(this.folder, "output"), { recursive: true, ignoreAbsent: true })
        .catch(error => Zotero.logError(error));
      this.exporting = false;
      unsubscribe();
      this.send("status");
    }
  }

  async cancel() {
    this.pending.clear();
    if (!this.busy || !this.cancelPath) return;
    this.cancelRequested = true;
    await IOUtils.writeUTF8(this.cancelPath, "cancel");
    this.setStatus("pt-status-stopping"); this.send("status");
  }

  saveView(view) {
    this.view = view;
    let text = JSON.stringify(view);
    this.viewWrite = this.viewWrite.catch(() => {}).then(async () => {
      if (!this.folder) return;
      let path = PathUtils.join(this.folder, "view.json");
      await IOUtils.writeUTF8(path, text, { tmpPath: path + ".tmp" });
    });
    this.viewWrite.catch(error => this.send("error", {
      message: this.plugin.t("pt-error-selection-save", { detail: String(error.message || error) }),
    }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    this.proc?.kill();
    for (let [reader, updateTitle] of this.readerTitleHandlers) {
      reader.updateTitle = updateTitle;
      if (!reader._isTabClosed && !reader._isUninitialized) {
        Promise.resolve(reader.updateTitle()).catch(error => Zotero.logError(error));
      }
    }
    this.readerTitleHandlers.clear();
    this.listeners.clear();
    this.onClose();
  }
};
