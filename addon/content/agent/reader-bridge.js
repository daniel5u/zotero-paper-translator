/* global Zotero, Services, IOUtils, PathUtils, Subprocess, Cc, Ci */

var PaperTranslatorReaderBridge = class {
  constructor(plugin) {
    this.plugin = plugin;
    this.windows = new Map();
    this.environmentPromise = null;
    this.historyPromise = null;
  }

  show(attachment) {
    attachment = this.plugin.sourceFor(attachment);
    let existing = this.windows.get(attachment.id);
    if (existing && !existing.closed) { existing.focus(); return; }
    let win = Zotero.getMainWindow().openDialog(
      "chrome://paper-translator/content/agent/reader-bridge.xhtml", "",
      "chrome,resizable,centerscreen,dialog=no,width=540,height=300", { attachment }
    );
    this.windows.set(attachment.id, win);
  }

  shutdown() {
    for (let win of this.windows.values()) if (!win.closed) win.close();
    this.windows.clear();
  }

  paperKey(attachment) {
    attachment = this.plugin.sourceFor(attachment);
    let paper = attachment.parentItemID ? Zotero.Items.get(attachment.parentItemID) : attachment;
    return `${paper.libraryID}/${paper.key}`;
  }

  async history() {
    if (!this.historyPromise) {
      this.historyPromise = (async () => {
        let history = new Map();
        let root = PathUtils.join(this.plugin.dataDir, "reading");
        if (!await IOUtils.exists(root)) return history;
        let records = await Promise.allSettled((await IOUtils.getChildren(root)).map(async folder => {
          let path = PathUtils.join(folder, "conversation.json");
          if (!await IOUtils.exists(path)) return null;
          let result = JSON.parse(await IOUtils.readUTF8(path));
          if (!result.client || !result.conversation?.conversation_id || !result.workspace) return null;
          // Older releases kept the item identity only in context.json.
          let paper = result.paper || JSON.parse(await IOUtils.readUTF8(PathUtils.join(folder, "context.json"))).metadata;
          if (!paper?.library_id || !paper.item_key) return null;
          return { key: `${paper.library_id}/${paper.item_key}/${result.client}`,
            result, modified: (await IOUtils.stat(path)).lastModified };
        }));
        for (let record of records) {
          if (record.status === "rejected") { Zotero.logError(record.reason); continue; }
          let saved = record.value;
          if (saved && (!history.has(saved.key) || history.get(saved.key).modified < saved.modified)) {
            history.set(saved.key, saved);
          }
        }
        return history;
      })().catch(error => { this.historyPromise = null; throw error; });
    }
    return this.historyPromise;
  }

  async savedFor(attachment, client = null) {
    let history = await this.history();
    let key = this.paperKey(attachment);
    if (client) return history.get(`${key}/${client}`)?.result || null;
    return [...history.values()].filter(saved => saved.key.startsWith(`${key}/`))
      .sort((a, b) => b.modified - a.modified)[0]?.result || null;
  }

  async findCodex() {
    let custom = (this.plugin.getPref("codexPath") || "").trim();
    if (custom) {
      if (await IOUtils.exists(custom)) return custom;
      throw new Error(this.plugin.t("pt-bridge-codex-missing"));
    }
    try { return await Subprocess.pathSearch(Zotero.isWin ? "codex.exe" : "codex"); }
    catch { /* GUI applications may not inherit the shell PATH. */ }
    let home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    let paths = Zotero.isWin
      ? [PathUtils.join(home, "AppData", "Roaming", "npm", "codex.cmd"), PathUtils.join(home, ".local", "bin", "codex.exe")]
      : ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex",
          PathUtils.join(home, ".local", "bin", "codex"),
          "/Applications/Codex.app/Contents/Resources/codex",
          PathUtils.join(home, "Applications", "Codex.app", "Contents", "Resources", "codex")];
    for (let path of paths) if (await IOUtils.exists(path)) return path;
    throw new Error(this.plugin.t("pt-bridge-codex-missing"));
  }

  async findOpenCode() {
    let custom = (this.plugin.getPref("opencodePath") || "").trim();
    if (custom) {
      if (await IOUtils.exists(custom)) return custom;
      throw new Error(this.plugin.t("pt-bridge-opencode-missing"));
    }
    try { return await Subprocess.pathSearch(Zotero.isWin ? "opencode.exe" : "opencode"); }
    catch { /* GUI applications may not inherit the shell PATH. */ }
    let home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    let paths = Zotero.isWin
      ? [PathUtils.join(home, "AppData", "Roaming", "npm", "opencode.cmd"),
          PathUtils.join(home, ".opencode", "bin", "opencode.exe")]
      : ["/opt/homebrew/bin/opencode", "/usr/local/bin/opencode", "/usr/bin/opencode",
          PathUtils.join(home, ".opencode", "bin", "opencode"), PathUtils.join(home, ".local", "bin", "opencode")];
    for (let path of paths) if (await IOUtils.exists(path)) return path;
    throw new Error(this.plugin.t("pt-bridge-opencode-missing"));
  }

  async setupOpenCode(onStatus = () => {}) {
    if (!Zotero.isWin) Zotero.Utilities.Internal.Environment.clearMozillaVariables();
    let opencode = await this.findOpenCode();
    let python = await this.runtime(onStatus);
    onStatus("pt-bridge-setup-running");
    let outcome = await this.plugin.run(python, [this.plugin.runnerPath, "bridge-setup-opencode"], {
      input: JSON.stringify({ opencode_path: opencode, plugin_dir: PathUtils.join(this.plugin.dataDir, "opencode-bridge") }),
    });
    if (outcome.exitCode !== 0 || !outcome.result?.installed) {
      throw new Error(outcome.result?.message || outcome.log.slice(-5).join("\n"));
    }
  }

  dshHome() {
    return (this.plugin.getPref("dshHome") || "").trim()
      || PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".dsh");
  }

  async findDshDesktop() {
    let custom = (this.plugin.getPref("dshDesktopPath") || "").trim();
    if (custom && await IOUtils.exists(custom)) return custom;
    if (!custom) {
      try { return await Subprocess.pathSearch(Zotero.isWin ? "deepseek-harness.exe" : "deepseek-harness"); }
      catch { /* Desktop applications may be outside the GUI PATH. */ }
      for (let path of ["/usr/bin/deepseek-harness", "/opt/dsh-desktop-linux-bin/deepseek-harness",
        "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"]) {
        if (await IOUtils.exists(path)) return path;
      }
    }
    throw new Error(this.plugin.t("pt-bridge-dsh-missing"));
  }

  async setupDsh(onStatus = () => {}) {
    if (!Zotero.isWin) Zotero.Utilities.Internal.Environment.clearMozillaVariables();
    let desktop = await this.findDshDesktop();
    let python = await this.runtime(onStatus);
    onStatus("pt-bridge-setup-running");
    let outcome = await this.plugin.run(python, [this.plugin.runnerPath, "bridge-setup-dsh"], {
      input: JSON.stringify({ desktop_path: desktop, dsh_home: this.dshHome(),
        plugin_dir: PathUtils.join(this.plugin.dataDir, "dsh-bridge") }),
    });
    if (outcome.exitCode !== 0 || !outcome.result?.installed) {
      throw new Error(outcome.result?.message || outcome.log.slice(-5).join("\n"));
    }
  }

  async runtime(onStatus) {
    await this.plugin.installPythonFiles();
    if (await IOUtils.exists(this.plugin.venvPython)) return this.plugin.venvPython;
    if (!this.environmentPromise) {
      this.environmentPromise = (async () => {
        onStatus("pt-bridge-preparing-env");
        let folder = PathUtils.join(this.plugin.dataDir, "bridge-venv");
        let python = Zotero.isWin ? PathUtils.join(folder, "Scripts", "python.exe") : PathUtils.join(folder, "bin", "python");
        if (await IOUtils.exists(python)) return python;
        let uv = await this.plugin.findUV() || await this.plugin.downloadUV(() => {});
        this.plugin.setPref("uvPath", uv);
        let outcome = await this.plugin.run(uv, ["venv", "--python", "3.12", "--allow-existing", folder]);
        if (outcome.exitCode !== 0) throw new Error(outcome.log.join("\n"));
        return python;
      })().finally(() => { this.environmentPromise = null; });
    }
    return this.environmentPromise;
  }

  async sources(attachment, options) {
    let parent = attachment.parentItemID ? Zotero.Items.get(attachment.parentItemID) : null;
    let paper = parent || attachment;
    let title = paper.getField("title") || attachment.attachmentFilename;
    let webSnapshot = null;
    let webURL = paper.getField("url") || "";
    if (parent) {
      for (let id of parent.getAttachments()) {
        let item = Zotero.Items.get(id);
        if (item?.attachmentContentType !== "text/html") continue;
        let path = await item.getFilePathAsync();
        if (path && await IOUtils.exists(path)) {
          webSnapshot = path;
          webURL = item.getField("url") || webURL;
          break;
        }
      }
    }
    let input = await attachment.getFilePathAsync();
    if (!input || !await IOUtils.exists(input)) throw new Error(this.plugin.t("pt-error-no-file"));
    let folder = PathUtils.join(this.plugin.dataDir, "reading", Zotero.Utilities.randomString(20));
    await IOUtils.makeDirectory(folder, { createAncestors: true });
    return { input, workspace: folder, title, conversation_title: this.plugin.t("pt-bridge-conversation-title", { title }),
      client: options.client,
      web_snapshot: webSnapshot, web_url: /^https?:\/\//i.test(webURL) ? webURL : "",
      pdf_origin: Zotero.URI.getItemURI(attachment),
      metadata: { title, authors: paper.getCreators?.() || [], date: parent ? paper.getField("date") : "",
        doi: parent ? parent.getField("DOI") : "", url: webURL,
        library_id: attachment.libraryID, item_key: paper.key, attachment_key: attachment.key } };
  }

  async create(attachment, options, { onStatus = () => {}, onSpawn, cancelled = () => false } = {}) {
    if (!options.client.startsWith("codex-") && !Zotero.isWin) Zotero.Utilities.Internal.Environment.clearMozillaVariables();
    let codex = options.client.startsWith("codex-") ? await this.findCodex() : null;
    let opencode = options.client.startsWith("opencode-") ? await this.findOpenCode() : null;
    let python = await this.runtime(onStatus);
    if (cancelled()) throw new Error("Cancelled");
    onStatus("pt-bridge-preparing-files");
    let job = await this.sources(attachment, options);
    if (cancelled()) throw new Error("Cancelled");
    if (codex) job.codex_path = codex;
    if (opencode) job.opencode_path = opencode;
    if (options.client === "dsh-desktop") job.dsh_home = this.dshHome();
    let outcome = await this.plugin.run(python, [this.plugin.runnerPath, "bridge-create"], {
      input: JSON.stringify(job), onSpawn: (proc) => { onSpawn?.(proc); if (cancelled()) proc.kill(); },
      onMessage: (message) => { if (message.stage_id) onStatus(message.stage_id); },
    });
    if (outcome.exitCode !== 0 || outcome.result?.type !== "done") {
      let detail = outcome.result?.message || outcome.log.slice(-5).join("\n");
      throw new Error(this.plugin.t("pt-bridge-failed", { detail }));
    }
    let result = outcome.result;
    try {
      let key = `${this.paperKey(attachment)}/${result.client}`;
      (await this.history()).set(key, { key, result, modified: Date.now() });
    }
    catch (error) { Zotero.logError(error); }
    return result;
  }

  async open(result, parent = Zotero.getMainWindow()) {
    if (result.client === "codex-desktop") {
      let id = result.conversation.conversation_id;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error(this.plugin.t("pt-bridge-invalid-conversation"));
      }
      let service = Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService);
      let found = {};
      let handler = service.getProtocolHandlerInfoFromOS("codex", found);
      if (!found.value) throw new Error(this.plugin.t("pt-bridge-handler-missing"));
      let prompt = Services.prompt;
      let choice = prompt.confirmEx(parent, this.plugin.t("pt-bridge-confirm-title"),
        this.plugin.t("pt-bridge-confirm-message", { app: handler.defaultDescription || "Codex Desktop" }),
        prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING
          + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1_DEFAULT,
        this.plugin.t("pt-bridge-confirm-open"), this.plugin.t("pt-bridge-confirm-cancel"), null, null, {});
      if (choice !== 0) return false;
      if (!Zotero.isWin) Zotero.Utilities.Internal.Environment.clearMozillaVariables();
      // This plugin-local confirmation replaces the toolkit's untranslated one.
      // Launch only the validated Codex thread with the OS handler; don't change
      // Zotero's protocol preferences or permissions.
      handler.preferredAction = Ci.nsIHandlerInfo.useSystemDefault;
      handler.launchWithURI(Services.io.newURI(`codex://threads/${id}`), null);
      return true;
    }
    let python = await this.runtime(() => {});
    if (!Zotero.isWin) Zotero.Utilities.Internal.Environment.clearMozillaVariables();
    let job = { workspace: result.workspace, terminal_path: this.plugin.getPref("bridgeTerminal") || "" };
    if (result.client === "codex-cli") job.codex_path = await this.findCodex();
    if (result.client.startsWith("opencode-")) {
      job.opencode_path = await this.findOpenCode();
      job.opencode_desktop_path = (this.plugin.getPref("opencodeDesktopPath") || "").trim();
    }
    if (result.client === "dsh-desktop") job.dsh_home = this.dshHome();
    let outcome = await this.plugin.run(python, [this.plugin.runnerPath, "bridge-open"], {
      input: JSON.stringify(job),
    });
    if (outcome.exitCode !== 0 || !outcome.result?.opened) {
      throw new Error(this.plugin.t("pt-bridge-failed", { detail: outcome.result?.message || outcome.log.join("\n") }));
    }
    return true;
  }
};
