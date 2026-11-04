/* global Zotero */

// The picker draws at most this many rows; searching narrows the rest
const PICKER_ROWS_SHOWN = 300;
const XHTML = "http://www.w3.org/1999/xhtml";

var plugin;
var queue;
var unsubscribe;
// Picker candidates: one per paper with a PDF, across all libraries
var papers = null;
// Attachment IDs ticked in the picker
var chosen = new Set();
// Item IDs of the chosen collection, or null when not filtering by collection
var collectionItems = null;

function $(id) {
  return document.getElementById(id);
}

function el(tag, className, text) {
  let element = document.createElementNS(XHTML, tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function t(id, args) {
  return plugin.t(id, args);
}

function option(select, value, label) {
  let item = el("option", "", label);
  item.value = value;
  select.append(item);
}

window.addEventListener("load", () => {
  plugin = Zotero.PaperTranslator;
  if (!plugin?.queue) {
    window.close();
    return;
  }
  queue = plugin.queue;
  document.title = t("pt-queue-title");
  $("heading").textContent = t("pt-queue-title");
  $("add").textContent = t("pt-queue-add");
  $("clear").textContent = t("pt-queue-clear");
  $("empty").textContent = t("pt-queue-empty");
  $("search").placeholder = t("pt-picker-search");
  $("scope-label").textContent = t("pt-picker-scope");
  option($("scope"), "main", t("pt-reader-select-main"));
  option($("scope"), "all", t("pt-reader-select-all"));
  for (let sort of ["added", "modified", "title", "creator", "year"]) {
    option($("sort"), sort, t(`pt-picker-sort-${sort}`));
  }
  $("back").textContent = t("pt-picker-back");

  $("toggle").addEventListener("click", () => (queue.paused ? queue.start() : queue.pause()));
  $("add").addEventListener("click", () => showPicker(true));
  $("clear").addEventListener("click", () => queue.clearFinished());
  $("back").addEventListener("click", () => showPicker(false));
  $("confirm").addEventListener("click", addChosen);
  $("search").addEventListener("input", renderPicker);
  $("sort").addEventListener("change", renderPicker);
  $("collection").addEventListener("change", chooseCollection);
  $("select-all").addEventListener("change", selectAllShown);

  unsubscribe = queue.subscribe(renderQueue);
  renderQueue();
  if (!queue.entries.length) {
    showPicker(true);
  }
});

window.addEventListener("unload", () => unsubscribe?.());

// Queue view

function renderQueue() {
  let picking = !$("picker-view").hidden;
  $("toggle").textContent = t(queue.paused ? "pt-queue-start" : "pt-queue-pause");
  $("toggle").hidden = picking || (queue.paused && !queue.unfinished.length);
  $("notice").hidden = !queue.error;
  $("notice").textContent = queue.error;
  $("empty").hidden = queue.entries.length > 0;

  let summary = queue.summary();
  let minutes = summary.secondsLeft === null ? null : Math.max(1, Math.round(summary.secondsLeft / 60));
  let stats = [
    ["pt-queue-stat-papers", t("pt-queue-stat-papers-value", { done: summary.papersDone, total: summary.papers })],
    ["pt-queue-stat-paragraphs", `${summary.paragraphsDone.toLocaleString()} / ${summary.paragraphs.toLocaleString()}`],
    ["pt-queue-stat-tokens", formatTokens(summary.tokens)],
    ["pt-queue-stat-time", minutes === null ? "—" : t("pt-queue-stat-minutes", { minutes })],
  ];
  $("stats").replaceChildren(...stats.map(([label, value]) => {
    let stat = el("div", "stat");
    stat.append(el("div", "stat-label", t(label)), el("div", "stat-value", value));
    return stat;
  }));
  $("entries").replaceChildren(...queue.entries.map(entryRow));
}

function formatTokens(tokens) {
  return tokens >= 1000 ? `${Math.round(tokens / 1000).toLocaleString()}k` : String(tokens);
}

function entryRow(entry) {
  let current = queue.current?.entry === entry;
  let row = el("div", current ? "row current" : "row");
  row.append(el("span", `dot ${entry.state}`), el("span", "title", entry.title));
  row.lastChild.title = entry.title;
  row.append(el("span", "stage", stageText(entry)));

  let action = actionFor(entry, current);
  if (action) {
    let button = el("button", "", t(action.label));
    button.addEventListener("click", action.run);
    row.append(button);
  }
  else {
    row.append(el("span"));
  }
  if (current) {
    let bar = el("progress");
    bar.max = 100;
    bar.value = entry.state === "translating" && entry.total
      ? 100 * entry.done / entry.total : entry.percent || 0;
    row.append(bar);
    let translation = queue.current.translation;
    if (translation.status) {
      row.append(el("span", "detail", translation.status));
    }
  }
  if (entry.error && ["failed", "done"].includes(entry.state)) {
    row.append(el("span", "detail", entry.error));
  }
  return row;
}

function stageText(entry) {
  let scope = t(entry.scope === "all" ? "pt-reader-select-all" : "pt-reader-select-main");
  switch (entry.state) {
    case "queued":
      return t("pt-queue-state-queued", { scope });
    case "parsing":
      return t("pt-queue-state-parsing", { percent: entry.percent || 0 });
    case "translating":
      return t("pt-queue-state-translating", { done: entry.done, total: entry.total });
    case "done":
      return entry.failed
        ? t("pt-queue-state-done-failed", { total: entry.total, failed: entry.failed })
        : t("pt-queue-state-done", { total: entry.total });
    default:
      return t(`pt-queue-state-${entry.state}`);
  }
}

function actionFor(entry, current) {
  if (current) {
    return { label: "pt-queue-skip", run: () => queue.skip(entry) };
  }
  switch (entry.state) {
    case "done":
      return { label: "pt-queue-open", run: () => openEntry(entry) };
    case "failed":
    case "skipped":
      return { label: "pt-queue-retry", run: () => queue.retry(entry) };
    case "queued":
      return { label: "pt-queue-remove", run: () => queue.remove(entry) };
    default:
      return null;
  }
}

async function openEntry(entry) {
  let attachment = await Zotero.Items.getByLibraryAndKeyAsync(entry.libraryID, entry.key);
  if (attachment) {
    plugin.openTextTranslation(attachment).catch((e) => Zotero.logError(e));
  }
}

// Paper picker

async function showPicker(show) {
  $("picker-view").hidden = !show;
  $("queue-view").hidden = show;
  for (let id of ["toggle", "add", "clear"]) {
    $(id).hidden = show || (id === "toggle" && queue.paused && !queue.unfinished.length);
  }
  if (!show) {
    renderQueue();
    return;
  }
  if (!papers) {
    $("items-note").textContent = t("pt-picker-loading");
    await loadPapers();
  }
  renderPicker();
  $("search").focus();
}

async function loadPapers() {
  papers = [];
  let collection = $("collection");
  option(collection, "all", t("pt-picker-all-libraries"));
  for (let library of Zotero.Libraries.getAll()) {
    if (!["user", "group"].includes(library.libraryType)) {
      continue;
    }
    await library.waitForDataLoad?.("item");
    option(collection, `library:${library.libraryID}`, library.name);
    let collections = Zotero.Collections.getByLibrary(library.libraryID, true);
    let depth = new Map();
    for (let item of collections) {
      let level = item.parentID ? (depth.get(item.parentID) ?? 0) + 1 : 1;
      depth.set(item.id, level);
      option(collection, `collection:${item.id}`, `${" ".repeat(level)}${item.name}`);
    }
    for (let item of await Zotero.Items.getAll(library.libraryID, true)) {
      let attachment = item.isRegularItem() ? plugin.getPDFAttachments([item])[0]
        : item.isPDFAttachment?.() && !plugin.isTranslationOutput(item) ? item : null;
      if (!attachment) {
        continue;
      }
      let title = item.getField("title") || attachment.attachmentFilename;
      let creator = item.isRegularItem() ? item.getField("firstCreator") : "";
      let year = item.isRegularItem() ? String(Zotero.Date.strToDate(item.getField("date")).year || "") : "";
      let tags = item.getTags().map((tag) => tag.tag).join(" ");
      papers.push({
        item, attachment, title, creator, year,
        libraryID: library.libraryID,
        added: item.dateAdded, modified: item.dateModified,
        haystack: `${title} ${creator} ${year} ${tags}`.toLowerCase(),
      });
    }
  }
}

function chooseCollection() {
  let [kind, id] = $("collection").value.split(":");
  collectionItems = kind === "collection"
    ? new Set(Zotero.Collections.get(Number(id)).getChildItems(true)) : null;
  renderPicker();
}

function filteredPapers() {
  let [kind, id] = $("collection").value.split(":");
  let words = $("search").value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = papers.filter((paper) =>
    (kind !== "library" || paper.libraryID === Number(id))
    && (!collectionItems || collectionItems.has(paper.item.id))
    && words.every((word) => paper.haystack.includes(word))
  );
  let sort = $("sort").value;
  let byText = (key) => (a, b) => a[key].localeCompare(b[key]);
  let newestFirst = (key) => (a, b) => (b[key] || "").localeCompare(a[key] || "");
  return shown.sort({
    added: newestFirst("added"),
    modified: newestFirst("modified"),
    title: byText("title"),
    creator: byText("creator"),
    year: newestFirst("year"),
  }[sort]);
}

function renderPicker() {
  let shown = filteredPapers();
  let rows = shown.slice(0, PICKER_ROWS_SHOWN).map((paper) => {
    let row = el("label", "row pick");
    let box = el("input");
    box.type = "checkbox";
    box.checked = chosen.has(paper.attachment.id);
    box.addEventListener("change", () => {
      if (box.checked) {
        chosen.add(paper.attachment.id);
      }
      else {
        chosen.delete(paper.attachment.id);
      }
      updatePickerFooter(shown);
    });
    let text = el("span");
    text.append(el("div", "title", paper.title),
      el("div", "meta", [paper.creator, paper.year].filter(Boolean).join(" · ")));
    text.title = paper.title;
    row.append(box, text, el("span", "meta", plugin.statusText(paper.item) || t("pt-picker-not-translated")));
    return row;
  });
  $("items").replaceChildren(...rows);
  $("items-note").textContent = shown.length > PICKER_ROWS_SHOWN
    ? t("pt-picker-more", { shown: PICKER_ROWS_SHOWN, total: shown.length })
    : shown.length ? "" : t("pt-picker-none");
  updatePickerFooter(shown);
}

function updatePickerFooter(shown) {
  $("select-all").checked = shown.length > 0 && shown.every((paper) => chosen.has(paper.attachment.id));
  $("select-all-label").textContent = t("pt-picker-select-all", { count: shown.length });
  $("confirm").textContent = t("pt-picker-add", { count: chosen.size });
  $("confirm").disabled = !chosen.size;
}

function selectAllShown() {
  let shown = filteredPapers();
  for (let paper of shown) {
    if ($("select-all").checked) {
      chosen.add(paper.attachment.id);
    }
    else {
      chosen.delete(paper.attachment.id);
    }
  }
  renderPicker();
}

function addChosen() {
  let attachments = papers.filter((paper) => chosen.has(paper.attachment.id)).map((paper) => paper.attachment);
  queue.add(attachments, $("scope").value);
  chosen.clear();
  showPicker(false);
  queue.start();
}
