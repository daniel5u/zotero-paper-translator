/* global Zotero, Components, PaperTranslatorNativeReader */

// Everything here is an extension of the existing Zotero PDF reader. There is
// no custom tab, PDF canvas, sidebar, annotation layer or independent window.
var PaperTranslatorNativeReader = class {
  constructor(plugin, reader, doc, append) {
    this.plugin = plugin;
    this.reader = reader;
    this.doc = doc;
    this.translation = null;
    this.unsubscribe = null;
    this.disposed = false;
    this.isTextTranslation = plugin.isTextTranslationReader(reader);
    this.menuVersion = 0;
    this.progressWasActive = false;
    this.progressNotice = null;
    this.progressNoticeTimer = null;
    this.progressError = null;
    this.hoverViews = new Map();
    this.pendingHoverViews = new Set();
    this.root = this.node("span", "pt-native-toolbar");
    this.button = this.node("button", "paper-translator-text-translation-button",
      plugin.t(this.isTextTranslation ? "pt-text-translation-open" : "pt-text-translation-launch")
      + (this.isTextTranslation ? " ▾" : ""));
    this.button.addEventListener("click", () => {
      if (this.isTextTranslation && this.translation) this.toggle();
      else this.action(() => plugin.openTextTranslation(Zotero.Items.get(reader.itemID), { showMenu: true }));
    });
    this.root.append(this.button);
    append(this.root);
    if (!doc.getElementById("pt-native-style")) {
      let style = this.node("style"); style.id = "pt-native-style";
      style.textContent = plugin.nativeCSS; doc.head.append(style);
    }
    this.unload = () => this.dispose();
    doc.defaultView.addEventListener("unload", this.unload, { once: true });
    // Ordinary PDF readers receive only a launcher. They do not initialize a
    // translation, watch PDF views, or install any paragraph interactions.
    if (!this.isTextTranslation) return;
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.setAttribute("aria-expanded", "false");
    this.progressGroup = this.node("span", "pt-native-progress-group");
    this.progressGroup.hidden = true;
    this.progress = this.node("progress", "pt-native-progress");
    this.progress.max = 100;
    this.progress.setAttribute("aria-label", plugin.t("pt-text-translation-progress"));
    this.status = this.node("span", "pt-native-status");
    this.status.setAttribute("aria-live", "polite");
    this.progressGroup.append(this.progress, this.status);
    this.root.prepend(this.progressGroup);
    this.panel = this.node("div", "pt-native-menu");
    this.panel.hidden = true;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", plugin.t("pt-text-translation-open"));
    this.panel.addEventListener("contextmenu", (event) => event.stopPropagation());
    this.range = this.node("input");
    this.range.placeholder = plugin.t("pt-reader-pages-placeholder");
    this.range.setAttribute("aria-label", plugin.t("pt-reader-pages-label"));
    this.rangeEdited = false;
    this.range.addEventListener("input", () => { this.rangeEdited = true; });
    this.range.addEventListener("change", () => this.action(() => this.chooseRange()));
    this.range.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); this.action(() => this.chooseRange()); }
    });
    let rangeRow = this.row(this.node("span", "", plugin.t("pt-reader-pages")), this.range);
    let choices = this.row();
    choices.append(this.control(plugin.t("pt-reader-select-main"), () => this.choose("main")),
      this.control(plugin.t("pt-reader-select-all"), () => this.choose("all")),
      this.control(plugin.t("pt-reader-select-none"), () => this.choose("none")));
    this.chapter = this.node("select");
    this.chapter.setAttribute("aria-label", plugin.t("pt-reader-chapter"));
    this.chapter.addEventListener("change", () => {
      if (!this.chapter.value) return;
      this.rangeEdited = false;
      this.translation.setSelection(this.translation.session.paragraphs.filter(p => p.translatable && p.section === this.chapter.value).map(p => p.id));
      this.range.value = this.translation.selectionPages();
    });
    this.translate = this.control(plugin.t("pt-reader-translate"), () => {
      if (this.rangeEdited) this.chooseRange(false);
      return this.translation.translateSelected();
    }, "pt-native-primary");
    this.retry = this.control(plugin.t("pt-reader-retry-failed"), () => this.translation.retryFailed());
    this.stop = this.control(plugin.t("pt-reader-stop"), () => this.translation.cancel());
    this.output = this.node("select");
    this.output.setAttribute("aria-label", plugin.t("pt-reader-output-label"));
    for (let [value, label] of [["dual", "pt-reader-output-dual"], ["mono", "pt-reader-output-mono"], ["both", "pt-reader-output-both"]]) {
      let option = this.node("option", "", plugin.t(label)); option.value = value; this.output.append(option);
    }
    this.export = this.control(plugin.t("pt-reader-export"), () => this.translation.export({ output: this.output.value, untranslated: "source" }));
    for (let control of [this.translate, this.retry, this.stop, this.export, this.chapter]) control.disabled = true;
    this.panel.append(rangeRow, choices, this.chapter,
      this.row(this.translate, this.retry, this.stop), this.row(this.output, this.export));
    doc.body.append(this.panel);
    this.outside = (event) => {
      if (!this.panel.contains(event.target) && !this.root.contains(event.target)) this.hide();
    };
    this.escape = (event) => { if (event.key === "Escape" && !this.panel.hidden) this.hide(); };
    doc.addEventListener("pointerdown", this.outside, true);
    doc.addEventListener("keydown", this.escape, true);
    this.blur = () => {
      let version = this.menuVersion;
      doc.defaultView.setTimeout(() => {
        if (version === this.menuVersion && doc.activeElement?.localName === "iframe") this.hide();
      }, 0);
    };
    doc.defaultView.addEventListener("blur", this.blur);
    this.hoverObserver = new doc.defaultView.MutationObserver(() => this.attachHover());
    for (let id of ["primary-view", "secondary-view"]) {
      let container = doc.getElementById(id);
      if (container) this.hoverObserver.observe(container,
        Components.utils.cloneInto({ childList: true }, doc.defaultView));
    }
    Promise.resolve(reader._initPromise).then(() => this.attachHover()).catch(error => {
      if (!this.disposed) Zotero.logError(error);
    });
  }

  node(tag, className = "", text) {
    let element = this.doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  row(...items) { let row = this.node("div", "pt-native-row"); row.append(...items); return row; }
  control(label, call, className = "") {
    let button = this.node("button", className, label);
    button.addEventListener("click", () => this.action(call)); return button;
  }
  async action(call) {
    try { await call(); }
    catch (error) { this.error(String(error.message || error)); }
  }

  bind(translation) {
    if (!this.isTextTranslation || this.reader.itemID !== translation.readerItem?.id) return;
    if (this.translation === translation) return;
    this.clearProgressNotice();
    this.progressWasActive = false;
    this.progressError = null;
    this.unsubscribe?.(); this.translation = translation;
    translation.readers.add(this.reader);
    translation.setReaderTitle(this.reader);
    this.unsubscribe = translation.subscribe((message) => {
      if (message.type === "error" || message.type === "preview_error") this.error(message.message);
      else this.refresh();
    });
    this.refresh();
    if (translation.openMenuRequested) {
      translation.openMenuRequested = false;
      this.doc.defaultView.requestAnimationFrame(() => this.show());
    }
  }

  refresh() {
    if (!this.isTextTranslation) return;
    this.updateProgress();
    this.attachHover();
    let translation = this.translation;
    if (!translation) return;
    let ready = translation.session?.parse_status === "ready";
    let paragraphs = translation.session?.paragraphs || [];
    let failed = paragraphs.filter(p => p.status === "failed").length;
    let chosen = paragraphs.filter(p => translation.selected.has(p.id));
    let done = paragraphs.filter(p => p.translation).length;
    if (this.progressGroup.hidden) this.button.title = ready
      ? this.plugin.t("pt-reader-selection-summary", { selected: chosen.length, translated: done })
      : this.plugin.t("pt-text-translation-parsing");
    let locked = translation.busy || translation.refreshing || translation.initializing || translation.exporting;
    this.translate.disabled = locked || !ready || !chosen.length;
    this.retry.disabled = locked || (!failed && !translation.renderErrors.size);
    this.stop.disabled = !translation.busy || translation.command !== "session-translate";
    this.export.disabled = locked || !done;
    this.chapter.disabled = !ready;
    if (this.doc.activeElement !== this.range && !this.rangeEdited) this.range.value = translation.selectionPages();
    let previous = this.chapter.value;
    this.chapter.replaceChildren();
    let placeholder = this.node("option", "", this.plugin.t("pt-reader-chapter-placeholder")); placeholder.value = ""; this.chapter.append(placeholder);
    for (let section of new Set(paragraphs.filter(p => p.translatable).map(p => p.section).filter(Boolean))) {
      let option = this.node("option", "", section); option.value = section; this.chapter.append(option);
    }
    this.chapter.value = previous;
  }

  updateProgress() {
    if (!this.isTextTranslation || this.disposed) return;
    let translation = this.translation;
    let active = !!(translation?.busy || translation?.refreshing || translation?.initializing || translation?.exporting);
    if (active && !this.progressWasActive) {
      this.clearProgressNotice();
      this.progressError = null;
    }
    else if (!active && this.progressWasActive) {
      this.setProgressNotice(this.completionNotice());
    }
    this.progressWasActive = active;
    this.progressGroup.hidden = !active && !this.progressNotice;
    let percent = translation?.progress.percent;
    if (Number.isFinite(percent)) this.progress.value = Math.min(100, Math.max(0, percent));
    else this.progress.removeAttribute("value");
    let error = this.progressError || (!active && this.progressNotice?.error);
    let text = this.progressNotice?.message || "";
    let title = text;
    if (active) {
      let stage = translation.refreshing ? this.plugin.t("pt-text-translation-refreshing")
        : translation.status || this.plugin.t(translation.initializing ? "pt-text-translation-preparing" : "pt-text-translation-running");
      let details = [stage];
      if (translation.command === "session-parse" && !translation.refreshing) stage = this.plugin.t("pt-text-translation-parsing");
      else if (translation.command === "session-translate"
          && ["pt-status-translating-page", "pt-status-queued-paragraphs"].includes(translation.statusKey)) {
        stage = this.plugin.t("pt-text-translation-running");
      }
      let parts = [stage];
      if (translation.progress.total) {
        parts.push(`${translation.progress.completed}/${translation.progress.total}`);
        details.push(this.plugin.t("pt-text-translation-count", translation.progress));
      }
      if (Number.isFinite(percent)) details.push(`${Math.round(percent)}%`);
      text = this.progressError || parts.join(" · ");
      title = this.progressError || details.join(" · ");
    }
    this.status.textContent = text;
    this.status.title = this.progress.title = title;
    this.status.classList.toggle("pt-native-error", !!error);
    if (title) this.button.title = title;
  }

  completionNotice() {
    let translation = this.translation;
    let error = this.progressError || translation?.operationError || translation?.renderErrors.values().next().value;
    if (error) return { message: String(error), error: true, delay: 0 };
    if (translation?.cancelRequested) return { message: this.plugin.t("pt-text-translation-stopped") };
    let command = translation?.command;
    let failed = command === "session-translate" ? translation.session.paragraphs
      .filter(paragraph => translation.progressIDs.has(paragraph.id) && paragraph.status === "failed").length : 0;
    if (failed) return { message: this.plugin.t("pt-text-translation-partial", { failed }), error: true };
    let label = command === "session-translate" ? "pt-text-translation-completed"
      : command === "session-export" ? "pt-text-translation-exported"
      : command === "session-parse" ? "pt-text-translation-parsed" : "pt-text-translation-ready";
    return { message: this.plugin.t(label) };
  }

  clearProgressNotice() {
    if (this.progressNoticeTimer !== null) this.doc.defaultView.clearTimeout(this.progressNoticeTimer);
    this.progressNoticeTimer = null;
    this.progressNotice = null;
  }

  setProgressNotice(notice) {
    this.clearProgressNotice();
    this.progressNotice = notice;
    if (notice.delay !== 0) {
      this.progressNoticeTimer = this.doc.defaultView.setTimeout(() => {
        this.progressNoticeTimer = null;
        this.progressNotice = null;
        this.updateProgress();
      }, notice.delay ?? 4000);
    }
  }

  attachHover() {
    if (this.disposed || !this.isTextTranslation) return;
    let internal = this.reader._internalReader;
    let views = [internal?._primaryView, internal?._secondaryView].filter(Boolean);
    for (let [view, hook] of this.hoverViews) {
      if (!views.includes(view)) { hook.dispose(); this.hoverViews.delete(view); }
    }
    for (let view of views) {
      if (this.hoverViews.has(view) || this.pendingHoverViews.has(view)) continue;
      this.pendingHoverViews.add(view);
      Promise.resolve(view.initializedPromise).then(() => {
        this.pendingHoverViews.delete(view);
        if (this.disposed || ![internal._primaryView, internal._secondaryView].includes(view)) return;
        let win = view._iframeWindow;
        if (!win?.document || typeof view.pointerEventToPosition !== "function") return;
        let doc = win.document;
        if (!doc.getElementById("pt-hover-style")) {
          let style = doc.createElement("style"); style.id = "pt-hover-style";
          style.textContent = this.plugin.nativeCSS; doc.head.append(style);
        }
        let layer = doc.createElement("div");
        layer.className = "pt-paragraph-hover"; layer.hidden = true;
        layer.setAttribute("aria-hidden", "true");
        let frame = null, latestEvent;
        let hide = () => { layer.hidden = true; };
        let move = event => {
          latestEvent = event;
          if (frame !== null) return;
          frame = win.requestAnimationFrame(() => {
            frame = null;
            if (latestEvent.buttons) { hide(); return; }
            let translation = this.translation;
            if (translation?.session?.parse_status !== "ready") { hide(); return; }
            let position = view.pointerEventToPosition(latestEvent);
            let hit = PaperTranslatorNativeReader.paragraphHit(position, translation.session, translation.geometry,
              this.reader.itemID === translation.readerItem?.id);
            if (!hit || (hit.side === "target" && !hit.paragraph.translation)) { hide(); return; }
            let page = win.PDFViewerApplication.pdfViewer.getPageView(position.pageIndex);
            if (!page) { hide(); return; }
            let rect = page.viewport.convertToViewportRectangle(Components.utils.cloneInto(hit.box, win));
            if (layer.parentNode !== page.div) page.div.append(layer);
            layer.style.left = `${Math.min(rect[0], rect[2])}px`;
            layer.style.top = `${Math.min(rect[1], rect[3])}px`;
            layer.style.width = `${Math.abs(rect[2] - rect[0])}px`;
            layer.style.height = `${Math.abs(rect[3] - rect[1])}px`;
            layer.dataset.paragraphId = hit.paragraph.id;
            layer.hidden = false;
          });
        };
        win.addEventListener("pointermove", move, { passive: true });
        win.addEventListener("pointerdown", hide, { passive: true });
        win.addEventListener("pointerleave", hide);
        win.addEventListener("blur", hide);
        win.addEventListener("scroll", hide, true);
        this.hoverViews.set(view, { dispose: () => {
          if (frame !== null) win.cancelAnimationFrame(frame);
          win.removeEventListener("pointermove", move);
          win.removeEventListener("pointerdown", hide);
          win.removeEventListener("pointerleave", hide);
          win.removeEventListener("blur", hide);
          win.removeEventListener("scroll", hide, true);
          layer.remove();
        } });
      }).catch(error => {
        this.pendingHoverViews.delete(view);
        if (!this.disposed) Zotero.logError(error);
      });
    }
  }

  choose(mode) {
    if (!this.translation?.session) return;
    this.rangeEdited = false;
    this.chapter.value = "";
    this.translation.setSelection(this.translation.session.paragraphs
      .filter(p => p.translatable && mode !== "none" && (mode !== "main" || p.suggested)).map(p => p.id));
  }

  chooseRange(report = true) {
    if (!this.translation?.session || this.translation.session.parse_status !== "ready") return;
    let input = this.range.value.trim().replace(/，/g, ",");
    let numbers = new Set();
    if (!input) { this.rangeEdited = false; this.translation.setSelection([]); return; }
    for (let part of input.split(",")) {
      let match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      let start = Number(match?.[1]), end = Number(match?.[2] || match?.[1]);
      if (!match || start < 1 || end < start || end > this.translation.session.pages.length) {
        let message = this.plugin.t("pt-error-invalid-pages");
        if (report) this.error(message);
        throw new Error(message);
      }
      for (let n = start; n <= end; n++) numbers.add(n);
    }
    this.translation.setSelection(this.translation.session.paragraphs.filter(p => p.translatable && numbers.has(p.page)).map(p => p.id));
    this.rangeEdited = false;
    this.chapter.value = "";
  }

  error(message) {
    this.button.title = message;
    if (!this.isTextTranslation) {
      Zotero.alert(null, this.plugin.t("pt-text-translation-launch"), message);
      return;
    }
    this.progressError = message;
    this.setProgressNotice({ message, error: true, delay: 0 });
    this.updateProgress();
  }
  toggle() { if (this.panel.hidden) this.show(); else this.hide(); }
  show() {
    if (this.disposed) return;
    this.menuVersion++;
    this.panel.hidden = false; this.button.setAttribute("aria-expanded", "true");
    let rect = this.button.getBoundingClientRect();
    this.panel.style.left = `${Math.max(8, Math.min(rect.left, this.doc.defaultView.innerWidth - 286))}px`;
    this.panel.style.top = `${rect.bottom + 5}px`;
  }
  hide() { this.panel.hidden = true; this.button.setAttribute("aria-expanded", "false"); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe?.();
    this.clearProgressNotice();
    this.hoverObserver?.disconnect();
    for (let hook of this.hoverViews.values()) hook.dispose();
    this.hoverViews.clear();
    this.translation?.readers.delete(this.reader);
    if (this.isTextTranslation) {
      this.doc.removeEventListener("pointerdown", this.outside, true);
      this.doc.removeEventListener("keydown", this.escape, true);
      this.doc.defaultView.removeEventListener("blur", this.blur);
    }
    this.root.remove(); this.panel?.remove(); this.plugin.readerBindings.delete(this);
  }

  static paragraphAt(position, session, geometry, dual) {
    return this.paragraphHit(position, session, geometry, dual)?.paragraph || null;
  }

  static paragraphHit(position, session, geometry, dual) {
    if (!position?.rects?.length || !session) return null;
    let rect = position.rects[0];
    let x = (rect[0] + rect[2]) / 2, y = (rect[1] + rect[3]) / 2;
    let candidates = [];
    if (dual) {
      let page = geometry?.find(p => p.page === position.pageIndex + 1);
      for (let item of page?.paragraphs || []) {
        for (let [side, box] of [["source", item.source], ["target", item.target]]) {
          if (x >= box[0] - 2 && x <= box[2] + 2 && y >= box[1] - 2 && y <= box[3] + 2) {
            candidates.push({ id: item.id, box, side, area: (box[2] - box[0]) * (box[3] - box[1]) });
          }
        }
      }
    }
    else {
      let page = session.pages[position.pageIndex];
      if (!page) return null;
      for (let item of session.paragraphs.filter(p => p.page === position.pageIndex + 1 && p.translatable)) {
        let box = [item.box[0] * page.width, (1 - item.box[3]) * page.height,
          item.box[2] * page.width, (1 - item.box[1]) * page.height];
        if (x >= box[0] - 2 && x <= box[2] + 2 && y >= box[1] - 2 && y <= box[3] + 2) {
          candidates.push({ id: item.id, box, side: "source", area: (box[2] - box[0]) * (box[3] - box[1]) });
        }
      }
    }
    candidates.sort((a, b) => a.area - b.area);
    let hit = candidates[0];
    let paragraph = session.paragraphs.find(p => p.id === hit?.id);
    return paragraph ? { paragraph, box: hit.box, side: hit.side } : null;
  }
};
