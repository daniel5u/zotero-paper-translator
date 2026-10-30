pref("extensions.paper-translator.baseURL", "https://api.openai.com/v1");
pref("extensions.paper-translator.apiKey", "");
pref("extensions.paper-translator.model", "");
pref("extensions.paper-translator.langOut", "zh");
// Keep reasoning from consuming the translation's output budget.
pref("extensions.paper-translator.reasoning", "minimal");
pref("extensions.paper-translator.maxTokens", "8192");
pref("extensions.paper-translator.thinking", "");
pref("extensions.paper-translator.qps", "8");
pref("extensions.paper-translator.customPrompt", "You are a professional translator of academic papers. Translate into fluent, accurate text using the standard terminology of the field. Never translate person names, author lists, citations (e.g. 'Xu et al., 2019'), URLs, email addresses, code identifiers or dataset/model names; keep them exactly as in the source.");
pref("extensions.paper-translator.openWhenDone", true);
pref("extensions.paper-translator.uvPath", "");
