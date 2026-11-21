const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function pane(plugin) {
  let elements = new Map();
  let element = () => ({
    value: "", textContent: "", disabled: false, hidden: true,
    classList: { toggle() {} },
    append() {},
    replaceChildren(...children) { this.children = children; },
  });
  let context = vm.createContext({
    Zotero: { PaperTranslator: {
      t: key => key,
      getPref: () => "/uv",
      resolvedParseDevice: async () => "cpu",
      ...plugin,
    } },
    window: { MozXULElement: { insertFTLIfNeeded() {} } },
    document: {
      addEventListener() {},
      createElementNS: element,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../addon/content/preferences.js"), "utf8"), context);
  let prefs = context.PaperTranslatorPrefs;
  prefs.renderSteps = () => {};
  return prefs;
}

test("setup refreshes environment and hardware without reopening", async () => {
  let ready = false;
  let prefs = pane({
    checkEnvironment: async () => ready ? { python: "3.12", babeldoc: "1" } : null,
    detectHardware: async () => ready ? { cpu: "CPU", os: "linux" } : null,
    ensureEnvironment: async () => { ready = true; },
  });
  await prefs.refreshEnvironmentStatus();
  await prefs.loadHardware();
  assert.equal(prefs.$("pt-env-status").textContent, "pt-status-not-ready");
  assert.equal(prefs.hardware, null);
  await prefs.setUpEnvironment();
  assert.equal(prefs.$("pt-env-status").textContent, "pt-status-ready");
  assert.equal(prefs.$("pt-env-setup").textContent, "pt-pref-env-repair");
  assert.equal(prefs.hardware.cpu, "CPU");
  assert.equal(prefs.$("pt-device-hint").textContent, "pt-device-hint-cpu");
  assert.equal(prefs.$("pt-env-setup").disabled, false);
});

test("failed setup refreshes missing environment and clears stale acceleration UI", async () => {
  let prefs = pane({
    ensureEnvironment: async () => { throw new Error("setup failed"); },
    checkEnvironment: async () => null,
    detectHardware: async () => null,
  });
  prefs.environmentReady = true;
  prefs.hardware = { cpu: "old CPU" };
  prefs.$("pt-device-hint").textContent = "old hint";
  prefs.$("pt-gpu-card").hidden = false;
  await prefs.setUpEnvironment();
  assert.equal(prefs.environmentReady, false);
  assert.equal(prefs.$("pt-env-status").textContent, "setup failed");
  assert.equal(prefs.$("pt-env-setup").textContent, "pt-pref-env-setup");
  assert.equal(prefs.hardware, null);
  assert.equal(prefs.$("pt-device-hint").textContent, "");
  assert.equal(prefs.$("pt-gpu-card").hidden, true);
  assert.equal(prefs.$("pt-env-setup").disabled, false);
});

test("a failed environment check resets readiness and still refreshes hardware", async () => {
  let prefs = pane({
    ensureEnvironment: async () => {},
    checkEnvironment: async () => { throw new Error("check failed"); },
    detectHardware: async () => null,
  });
  prefs.environmentReady = true;
  await prefs.setUpEnvironment();
  assert.equal(prefs.environmentReady, false);
  assert.equal(prefs.hardware, null);
  assert.equal(prefs.$("pt-env-status").textContent, "check failed");
  assert.equal(prefs.$("pt-env-setup").disabled, false);
});

test("an older environment check cannot overwrite the post-setup status", async () => {
  let finishInitial;
  let calls = 0;
  let prefs = pane({
    checkEnvironment: () => ++calls === 1
      ? new Promise(resolve => { finishInitial = resolve; })
      : Promise.resolve({ python: "3.12", babeldoc: "1" }),
    ensureEnvironment: async () => {},
    detectHardware: async () => null,
  });
  let initial = prefs.refreshEnvironmentStatus();
  await prefs.setUpEnvironment();
  finishInitial(null);
  await initial;
  assert.equal(prefs.environmentReady, true);
  assert.equal(prefs.$("pt-env-status").textContent, "pt-status-ready");
});
