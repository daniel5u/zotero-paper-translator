/* global Zotero, IOUtils, PathUtils, Services, PaperTranslatorQueue */

// Entry states. "parsing" and "translating" only exist while a paper is being
// worked on; a saved queue turns them back into "queued".
const ACTIVE_STATES = ["parsing", "translating"];
const FINISHED_STATES = ["done", "skipped", "failed"];
// Queue window and status column redraws are coalesced to this interval
const QUEUE_NOTIFY_MS = 250;
// Assumed parse time for an unparsed paper until one has been measured
const DEFAULT_PARSE_SECONDS = 70;

/**
 * Translates papers one after another, in the background, without opening
 * reader tabs. Each paper goes through the same steps as an opened one, so a
 * tab opened mid-batch joins the running job. Finished paragraphs are never
 * translated twice, so retrying or resuming only costs what is missing.
 */
var PaperTranslatorQueue = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.entries = [];
    this.paused = true;
    this.running = false;
    this.stopped = false;
    // Why the whole queue stopped, e.g. a rejected API key
    this.error = "";
    this.current = null;
    this.listeners = new Set();
    this.writes = Promise.resolve();
    this.notifyPending = false;
    // Measured during this run, for the time-left estimate
    this.stats = { paragraphs: 0, paragraphSeconds: 0, parses: 0, parseSeconds: 0 };
  }

  get path() {
    return PathUtils.join(this.plugin.dataDir, "queue.json");
  }

  static keyOf(item) {
    return `${item.libraryID}/${item.key}`;
  }

  async load() {
    try {
      this.entries = JSON.parse(await IOUtils.readUTF8(this.path)).entries || [];
    }
    catch {
      this.entries = [];
    }
    for (let entry of this.entries) {
      if (ACTIVE_STATES.includes(entry.state)) {
        entry.state = "queued";
      }
    }
  }

  get unfinished() {
    return this.entries.filter((entry) => !FINISHED_STATES.includes(entry.state));
  }

  save() {
    let text = JSON.stringify({ entries: this.entries });
    this.writes = this.writes.catch(() => {}).then(
      () => IOUtils.writeUTF8(this.path, text, { tmpPath: this.path + ".tmp" })
    );
    this.writes.catch((e) => Zotero.logError(e));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tell the queue window and the status column, at most every QUEUE_NOTIFY_MS. */
  notify() {
    if (this.notifyPending) {
      return;
    }
    this.notifyPending = true;
    Zotero.Promise.delay(QUEUE_NOTIFY_MS).then(() => {
      this.notifyPending = false;
      for (let listener of this.listeners) {
        try {
          listener();
        }
        catch (e) {
          Zotero.logError(e);
        }
      }
      this.plugin.refreshStatusColumn();
    });
  }

  changed() {
    this.save();
    this.notify();
  }

  entryFor(item) {
    let key = PaperTranslatorQueue.keyOf(item);
    return this.entries.find((entry) => `${entry.libraryID}/${entry.key}` === key);
  }

  /**
   * @param {Zotero.Item[]} attachments - Source PDF attachments
   * @param {"main"|"all"} scope - Translate the main text or every paragraph
   */
  add(attachments, scope) {
    for (let attachment of attachments) {
      let parent = attachment.parentItem;
      let title = parent?.getField("title") || attachment.getField("title") || attachment.attachmentFilename;
      let entry = this.entryFor(attachment);
      if (!entry) {
        entry = { libraryID: attachment.libraryID, key: attachment.key };
        this.entries.push(entry);
      }
      else if (ACTIVE_STATES.includes(entry.state)) {
        // Already being translated; a new scope applies on its next run
        entry.scope = scope;
        continue;
      }
      Object.assign(entry, {
        title, scope, state: "queued", error: "", done: 0, total: 0, failed: 0, tokens: 0, percent: 0,
      });
    }
    this.changed();
  }

  start() {
    this.paused = false;
    this.error = "";
    this.changed();
    this.run();
  }

  /** Finish the paragraphs already sent, then wait. Nothing is lost. */
  pause() {
    this.paused = true;
    if (this.current?.entry.state === "translating") {
      this.current.translation.cancel().catch((e) => Zotero.logError(e));
    }
    this.changed();
  }

  remove(entry) {
    if (this.current?.entry === entry) {
      this.skip(entry);
      return;
    }
    this.entries = this.entries.filter((other) => other !== entry);
    this.changed();
  }

  skip(entry) {
    if (this.current?.entry === entry) {
      this.current.skip = true;
      if (entry.state === "translating") {
        this.current.translation.cancel().catch((e) => Zotero.logError(e));
      }
    }
    else {
      entry.state = "skipped";
    }
    this.changed();
  }

  retry(entry) {
    Object.assign(entry, { state: "queued", error: "" });
    this.changed();
    if (!this.paused) {
      this.run();
    }
  }

  clearFinished() {
    this.entries = this.entries.filter((entry) => !["done", "skipped"].includes(entry.state));
    this.changed();
  }

  /** Called when the plugin shuts down; the saved queue can be resumed later. */
  shutdown() {
    this.stopped = true;
    this.paused = true;
    if (this.current) {
      this.current.entry.state = "queued";
    }
    this.save();
    this.listeners.clear();
  }

  async run() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      // A wrong key or model would fail every paper in turn; check it once
      let settings = this.plugin.getSettings();
      if (!settings.baseURL || !settings.apiKey || !settings.model) {
        throw new Error(this.plugin.t("pt-error-missing-settings"));
      }
      await this.plugin.testConnection(settings);
      let entry;
      while (!this.paused && !this.stopped && (entry = this.entries.find((e) => e.state === "queued"))) {
        await this.process(entry);
      }
    }
    catch (e) {
      if (!this.stopped) {
        this.paused = true;
        this.error = String(e.message || e);
      }
    }
    finally {
      this.running = false;
      if (!this.stopped) {
        this.changed();
      }
    }
  }

  /** The paragraphs this entry asks for, translated or not. */
  targets(entry, session) {
    return (session?.paragraphs || []).filter(
      (p) => p.translatable && (entry.scope === "all" || p.suggested)
    );
  }

  count(entry, translation) {
    let targets = this.targets(entry, translation.session);
    entry.total = targets.length;
    entry.done = targets.filter((p) => p.translation).length;
    entry.failed = targets.filter((p) => p.status === "failed").length;
  }

  async process(entry) {
    let attachment = await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID, entry.key);
    if (!attachment || attachment.deleted || !attachment.isPDFAttachment()) {
      Object.assign(entry, { state: "failed", error: this.plugin.t("pt-queue-error-missing") });
      this.changed();
      return;
    }
    let translation = this.plugin.textTranslationFor(attachment);
    let current = this.current = { entry, translation, skip: false };
    Object.assign(entry, { state: "parsing", error: "", percent: 0 });
    this.changed();
    let parseStarted = Date.now();
    let parsed = translation.session?.parse_status === "ready";
    let unsubscribe = translation.subscribe((message) => this.onMessage(entry, translation, message));
    try {
      await translation.init({ showReader: false });
      if (!parsed) {
        this.stats.parses++;
        this.stats.parseSeconds += (Date.now() - parseStarted) / 1000;
      }
      // Someone may be translating this paper in its tab; let that finish
      while (translation.busy && !this.stopped) {
        await Zotero.Promise.delay(500);
      }
      this.count(entry, translation);
      let ids = this.targets(entry, translation.session).filter((p) => !p.translation).map((p) => p.id);
      if (ids.length && !current.skip && !this.paused && !this.stopped) {
        entry.state = "translating";
        this.changed();
        let started = Date.now();
        let before = entry.done;
        await translation.translate(ids);
        this.count(entry, translation);
        this.stats.paragraphs += entry.done - before;
        this.stats.paragraphSeconds += (Date.now() - started) / 1000;
      }
      if (this.stopped) {
        return;
      }
      if (current.skip) {
        entry.state = "skipped";
      }
      else if (entry.done < entry.total && this.paused) {
        entry.state = "queued";
      }
      else if (entry.total && !entry.done && entry.failed) {
        // Nothing got through: most likely the API, which would fail the
        // next paper as well
        let reason = translation.session.paragraphs.find((p) => p.status === "failed")?.error || "";
        Object.assign(entry, { state: "failed", error: reason });
        this.paused = true;
        this.error = this.plugin.t("pt-queue-error-all-failed", { detail: reason });
      }
      else {
        entry.state = "done";
      }
    }
    catch (e) {
      if (!this.stopped) {
        Zotero.logError(e);
        Object.assign(entry, { state: "failed", error: String(e.message || e) });
      }
    }
    finally {
      unsubscribe();
      this.current = null;
      // Keep the object only while a tab shows this paper
      if (!this.stopped && !translation.readers.size) {
        translation.close();
      }
      if (!this.stopped) {
        this.changed();
      }
    }
  }

  onMessage(entry, translation, message) {
    if (message.type === "paragraph") {
      let usage = message.paragraph.usage;
      if (message.paragraph.status === "done" && usage?.total_tokens && message.paragraph.translated_at) {
        entry.tokens = (entry.tokens || 0) + usage.total_tokens;
      }
      this.count(entry, translation);
    }
    else if (message.type === "progress" && entry.state === "parsing") {
      entry.percent = Math.round(translation.progress.percent || 0);
    }
    else if (message.type !== "status" && message.type !== "busy") {
      return;
    }
    this.notify();
  }

  /** Totals for the queue window header. */
  summary() {
    let entries = this.entries;
    let parsed = entries.filter((entry) => entry.total);
    let remaining = entries.filter((entry) => ["queued", ...ACTIVE_STATES].includes(entry.state));
    let unparsed = remaining.filter((entry) => !entry.total).length;
    let averageTotal = parsed.length ? parsed.reduce((sum, e) => sum + e.total, 0) / parsed.length : 0;
    let paragraphsLeft = remaining.reduce((sum, e) => sum + Math.max(0, e.total - e.done), 0)
      + unparsed * averageTotal;
    let secondsLeft = null;
    if (this.stats.paragraphs >= 10 && remaining.length) {
      let perParagraph = this.stats.paragraphSeconds / this.stats.paragraphs;
      let perParse = this.stats.parses ? this.stats.parseSeconds / this.stats.parses : DEFAULT_PARSE_SECONDS;
      secondsLeft = paragraphsLeft * perParagraph + unparsed * perParse;
    }
    return {
      papers: entries.length,
      papersDone: entries.filter((entry) => entry.state === "done").length,
      paragraphs: entries.reduce((sum, e) => sum + (e.total || 0), 0),
      paragraphsDone: entries.reduce((sum, e) => sum + (e.done || 0), 0),
      tokens: entries.reduce((sum, e) => sum + (e.tokens || 0), 0),
      secondsLeft,
    };
  }

  /** Ask once per startup whether to continue an unfinished queue. */
  async offerResume() {
    let count = this.unfinished.length;
    let win = Zotero.getMainWindow();
    if (!count || !win || this.stopped) {
      return;
    }
    let resume = Services.prompt.confirm(win, this.plugin.t("pt-queue-title"),
      this.plugin.t("pt-queue-resume-prompt", { count }));
    if (resume) {
      this.plugin.openQueueWindow();
      this.start();
    }
  }
};
