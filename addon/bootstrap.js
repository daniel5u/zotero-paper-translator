var PaperTranslator;
var PaperTranslatorTextTranslation;
var PaperTranslatorNativeReader;
var chromeHandle;

function install() {}

async function startup({ id, version, rootURI }) {
  let aomStartup = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
    ["content", "paper-translator", "content/"],
  ]);
  Services.scriptloader.loadSubScript(rootURI + "content/native-reader.js");
  Services.scriptloader.loadSubScript(rootURI + "content/text-translation-controller.js");
  Services.scriptloader.loadSubScript(rootURI + "content/paper-translator.js");
  PaperTranslator.init({ id, version, rootURI });
  await PaperTranslator.startup();
}

function onMainWindowLoad({ window }) {
  PaperTranslator.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  PaperTranslator.removeFromWindow(window);
}

function shutdown() {
  PaperTranslator.shutdown();
  PaperTranslator = undefined;
  chromeHandle?.destruct();
  chromeHandle = undefined;
}

function uninstall() {}
