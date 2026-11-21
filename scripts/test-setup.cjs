const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

for (const locale of ["en-US", "zh-CN"]) {
  test(`preferences render Redistributable link safely: ${locale}`, () => {
    const url = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
    const launched = [];
    function element() {
      return {
        children: [],
        listeners: {},
        classList: { toggle() {} },
        set textContent(text) { this.children = [text]; },
        get textContent() {
          return this.children.map((child) => typeof child === "string" ? child : child.textContent).join("");
        },
        append(...children) { this.children.push(...children); },
        addEventListener(name, handler) { this.listeners[name] = handler; },
      };
    }
    const status = element();
    const context = {
      window: { MozXULElement: { insertFTLIfNeeded() {} } },
      document: {
        addEventListener() {},
        getElementById: () => status,
        createElementNS: (namespace, tag) => {
          assert.equal(namespace, "http://www.w3.org/1999/xhtml");
          assert.equal(tag, "a");
          return element();
        },
      },
      Zotero: { launchURL: (value) => launched.push(value) },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../addon/content/preferences.js"), "utf8"), context);
    const strings = fs.readFileSync(path.join(__dirname, `../addon/locale/${locale}/paper-translator.ftl`), "utf8");
    const guidance = strings.match(/^pt-error-vcredist = (.+)$/m)[1];
    const text = strings.match(/^pt-error-setup-failed = (.+)$/m)[1]
      .replace("{ $detail }", guidance).replace("{ $log }", "C:\\setup-error.log <not markup>");
    context.PaperTranslatorPrefs.setStatus("pt-env-status", text, "error");
    assert.equal(status.textContent, text);
    const links = status.children.filter((child) => typeof child !== "string");
    assert.equal(links.length, 1);
    assert.equal(links[0].href, url);
    let prevented = false;
    links[0].listeners.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(launched, [url]);
    context.PaperTranslatorPrefs.setStatus("pt-env-status", "");
    assert.equal(status.textContent, "");
    context.PaperTranslatorPrefs.setStatus("pt-env-status", "Ready");
    assert.deepEqual(status.children, ["Ready"]);
    context.PaperTranslatorPrefs.setStatus("pt-models-status", url);
    assert.deepEqual(status.children, [url]);
  });
}

function fixture() {
  const context = {
    ChromeUtils: { importESModule: () => ({ Subprocess: {
      pathSearch: async () => { throw new Error("bad PATH"); },
    } }) },
    Zotero: { isWin: true, DataDirectory: { dir: "C:\\Zotero" } },
    PathUtils: {
      join(base, ...parts) {
        if (!/^[A-Za-z]:\\/.test(base) || parts.some((part) => /[\\/]/.test(part))) {
          throw new Error("invalid path");
        }
        return path.win32.join(base, ...parts);
      },
      parent: path.win32.dirname,
    },
    IOUtils: {
      stat: async () => ({ type: "regular" }),
      makeDirectory: async () => {},
      readUTF8: async () => "babeldoc==1\n",
    },
    Ci: {},
    Cc: {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../addon/content/paper-translator.js"), "utf8"), context);
  return { context, plugin: context.PaperTranslator };
}

for (const failure of [null, "download failed", "no binary", "logger failed"]) {
  test(`archive cleanup is best-effort: ${failure || "success"}`, async () => {
    const { context, plugin } = fixture();
    const cleanupErrors = [];
    const events = [];
    context.Services = { appinfo: { XPCOMABI: "x86_64-msvc" } };
    context.Zotero.logError = (error) => {
      cleanupErrors.push(error.message);
      if (failure === "logger failed") throw new Error(failure);
    };
    context.IOUtils.remove = async (file) => {
      if (file.endsWith(".zip")) {
        events.push("cleanup");
        throw new Error("NS_ERROR_FILE_ACCESS_DENIED");
      }
    };
    context.Zotero.HTTP = {
      request: async () => ({ responseText: "checksum" }),
      download: async () => {
        events.push("download");
        if (failure === "download failed") throw new Error(failure);
      },
    };
    plugin.sha256 = async () => "checksum";
    plugin.extractZip = async () => {};
    plugin.findFile = async () => failure === "no binary" ? null : "C:\\uv\\uv.exe";
    plugin.t = (id, args) => args?.detail || id;
    const operation = plugin.downloadUV(() => {});
    if (failure === "download failed") await assert.rejects(operation, /download failed/);
    else if (failure === "no binary") await assert.rejects(operation, /has no uv binary/);
    else assert.equal(await operation, "C:\\uv\\uv.exe");
    assert.deepEqual(events, ["cleanup", "download", "cleanup"]);
    assert.deepEqual(cleanupErrors, ["NS_ERROR_FILE_ACCESS_DENIED", "NS_ERROR_FILE_ACCESS_DENIED"]);
  });
}

test("PATH fallback skips relative and unexpanded entries", async () => {
  const { context, plugin } = fixture();
  context.Cc["@mozilla.org/process/environment;1"] = {
    getService: () => ({ get: () => ".;%USERPROFILE%\\bin;C:\\Tools" }),
  };
  assert.equal(await plugin.findExecutable("uv.exe"), "C:\\Tools\\uv.exe");
});

test("PATH lookup preserves a successful native lookup", async () => {
  const { context, plugin } = fixture();
  context.Subprocess.pathSearch = async () => "C:\\Tools\\uv.exe";
  assert.equal(await plugin.findExecutable("uv.exe"), "C:\\Tools\\uv.exe");
});

test("empty PATH and missing files return null", async () => {
  const { context, plugin } = fixture();
  let value = "";
  context.Cc["@mozilla.org/process/environment;1"] = { getService: () => ({ get: () => value }) };
  assert.equal(await plugin.findExecutable("uv.exe"), null);
  value = "C:\\Missing";
  context.IOUtils.stat = async () => { throw new Error("missing"); };
  assert.equal(await plugin.findExecutable("uv.exe"), null);
});

for (const names of [["uv/", "uv/uv.exe"], [], ["../uv.exe"]]) {
  test(`zip extraction: ${JSON.stringify(names)}`, async () => {
    const { context, plugin } = fixture();
    let closed = false;
    const extracted = [];
    let index = 0;
    context.Cc["@mozilla.org/file/local;1"] = {
      createInstance: () => ({ initWithPath(value) { this.path = value; } }),
    };
    context.Cc["@mozilla.org/libjar/zip-reader;1"] = { createInstance: () => ({
      open() {},
      close() { closed = true; },
      findEntries: () => ({ hasMore: () => index < names.length, getNext: () => names[index++] }),
      getEntry: (name) => ({ isDirectory: name.endsWith("/") }),
      extract: (name, file) => extracted.push(file.path),
    }) };
    const operation = plugin.extractZip("C:\\uv.zip", "C:\\uv");
    if (names.includes("../uv.exe")) await assert.rejects(operation, /Invalid zip entry/);
    else {
      await operation;
      assert.deepEqual(extracted, names.length ? ["C:\\uv\\uv\\uv.exe"] : []);
    }
    assert.equal(closed, true);
  });
}

test("successful setup verifies, warms up and records the lock", async () => {
  const { context, plugin } = fixture();
  const commands = [];
  let copied = false;
  plugin.installPythonFiles = async () => {};
  plugin.findUV = async () => "C:\\uv.exe";
  plugin.setPref = () => {};
  plugin.t = (id) => id;
  context.IOUtils.copy = async () => { copied = true; };
  plugin.run = async (command, args) => {
    commands.push(args);
    return { exitCode: 0, result: { type: "done" }, log: [] };
  };
  await plugin._setUpEnvironment(() => {}, true);
  assert.equal(commands.length, 4);
  assert.equal(commands[2][1], "verify");
  assert.equal(commands[3][1], "warmup");
  assert.equal(copied, true);
});

for (const [message, logs, expected] of [
  ["OSError: Microsoft Visual C++ Redistributable is not installed", [], "pt-error-vcredist"],
  ["ImportError: DLL load failed while importing onnxruntime_pybind11_state", [], "pt-error-vcredist"],
  ["specific import error", ["other log"], "specific import error"],
  [undefined, ["last useful line", "  "], "last useful line"],
  [undefined, [], "?"],
]) {
  test(`setup failure detail: ${expected}`, async () => {
    const { plugin } = fixture();
    plugin.installPythonFiles = async () => {};
    plugin.findUV = async () => "C:\\uv.exe";
    plugin.setPref = () => {};
    plugin.t = (id, args) => args ? `${id} ${JSON.stringify(args)}` : id;
    plugin.saveLog = async () => "C:\\setup-error.log";
    plugin.run = async (command, args) => args.includes("verify")
      ? { exitCode: 1, result: message ? { type: "error", message } : null, log: logs }
      : { exitCode: 0, result: null, log: [] };
    await assert.rejects(plugin._setUpEnvironment(() => {}, true), (error) => {
      assert.ok(error.message.includes(expected));
      assert.ok(error.message.includes("setup-error.log"));
      return true;
    });
  });
}
