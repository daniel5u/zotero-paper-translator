pref("extensions.paper-translator.baseURL", "https://api.openai.com/v1");
pref("extensions.paper-translator.apiKey", "");
pref("extensions.paper-translator.model", "");
pref("extensions.paper-translator.langOut", "zh");
// How to turn off thinking: "auto" or a field from THINKING_OFF in translation.py
pref("extensions.paper-translator.thinkingMethod", "auto");
// "auto", "max_tokens" or "max_completion_tokens"
pref("extensions.paper-translator.tokenField", "auto");
// 0: start at 8192 and double when an answer is cut off
pref("extensions.paper-translator.maxTokens", "0");
// What Test Connection or a rejected request found for the current API and model
pref("extensions.paper-translator.detectedOptions", "");
pref("extensions.paper-translator.qps", "8");
pref("extensions.paper-translator.customPrompt", "You are a professional translator of academic papers. Translate into fluent, accurate text using the standard terminology of the field. Never translate person names, author lists, citations (e.g. 'Xu et al., 2019'), URLs, email addresses, code identifiers or dataset/model names; keep them exactly as in the source.");
pref("extensions.paper-translator.openWhenDone", true);
pref("extensions.paper-translator.uvPath", "");
