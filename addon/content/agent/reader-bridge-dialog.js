/* global Zotero, window, document */

var plugin;
var bridge;
var attachment;
var result;
var process;
var busy = false;

function $(id) { return document.getElementById(id); }
function t(id, args) { return plugin.t(id, args); }
function status(key, args, error = false) {
  $("status").textContent = key ? t(key, args) : "";
  $("status").classList.toggle("error", error);
}

function controls() {
  $("client").disabled = $("create").disabled = busy;
  $("setup").hidden = !["dsh-desktop", "opencode-desktop"].includes($("client").value);
  $("setup").disabled = busy;
  $("open").hidden = !result;
  $("open").disabled = busy || !result;
  $("open").title = result?.conversation.conversation_id || "";
  $("create").textContent = t(result ? "pt-bridge-new" : "pt-bridge-create");
  $("create").classList.toggle("primary", !result);
  $("open").classList.toggle("primary", !!result);
}

window.addEventListener("load", () => {
  plugin = Zotero.PaperTranslator;
  bridge = plugin.readerBridge;
  attachment = window.arguments[0].attachment;
  document.title = t("pt-bridge-title");
  $("title").textContent = attachment.parentItemID
    ? Zotero.Items.get(attachment.parentItemID).getField("title") : attachment.getField("title");
  for (let id of ["client-label", "note", "close", "create", "open", "setup"]) {
    $(id).textContent = t(`pt-bridge-${id}`);
  }
  $("client").value = plugin.getPref("bridgeClient") || "codex-desktop";
  $("client").addEventListener("change", () => loadSaved($("client").value));
  $("close").addEventListener("click", () => window.close());
  $("create").addEventListener("click", create);
  $("open").addEventListener("click", () => discuss(false));
  $("setup").addEventListener("click", setupDesktop);
  window.addEventListener("unload", () => process?.kill());
  loadSaved();
});

async function loadSaved(client = null) {
  if (busy) return;
  busy = true;
  controls();
  try {
    result = await bridge.savedFor(attachment, client);
    if (window.closed) return;
    if (result) $("client").value = result.client;
    status(result ? "pt-bridge-saved" : null);
  }
  catch (error) {
    result = null;
    if (!window.closed) status("pt-bridge-failed", { detail: String(error.message || error) }, true);
  }
  finally {
    busy = false;
    if (!window.closed) controls();
  }
}

function create() { return discuss(true); }

async function setupDesktop() {
  if (busy) return;
  busy = true; controls(); $("progress").hidden = false;
  try {
    let client = $("client").value;
    await (client === "opencode-desktop" ? bridge.setupOpenCode.bind(bridge) : bridge.setupDsh.bind(bridge))(
      key => { if (!window.closed) status(key); });
    if (!window.closed) status(client === "opencode-desktop" ? "pt-bridge-opencode-setup-ready" : "pt-bridge-setup-ready");
  }
  catch (error) {
    if (!window.closed) status("pt-bridge-failed", { detail: String(error.message || error) }, true);
  }
  finally {
    busy = false;
    if (!window.closed) { $("progress").hidden = true; controls(); }
  }
}

async function discuss(makeNew) {
  if (busy || (!makeNew && !result)) return;
  busy = true;
  controls();
  $("progress").hidden = false;
  try {
    let client = $("client").value;
    plugin.setPref("bridgeClient", client);
    status(makeNew ? "pt-bridge-preparing" : "pt-bridge-opening");
    if (makeNew) {
      result = await bridge.create(attachment, { client }, {
        onStatus: (key) => { if (!window.closed) status(key); },
        onSpawn: (proc) => { process = proc; },
        cancelled: () => window.closed,
      });
      process = null;
    }
    if (window.closed) return;
    if (await bridge.open(result, window) === false) {
      status("pt-bridge-saved");
      return;
    }
    status(makeNew ? (result.warnings?.length ? "pt-bridge-ready-warning" : "pt-bridge-ready") : "pt-bridge-opened");
  }
  catch (error) {
    if (!window.closed) status("pt-bridge-failed", { detail: String(error.message || error) }, true);
  }
  finally {
    process = null;
    busy = false;
    if (!window.closed) {
      $("progress").hidden = true;
      controls();
    }
  }
}
