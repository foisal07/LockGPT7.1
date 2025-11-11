const CHAT_URL = "https://chat.openai.com/";

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.remove(["pinKey", "lockedChat", "lockedChats"], () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.warn("ChatGPT lock: unable to clear old state", err);
      }
    });
    chrome.tabs.create({
      url: chrome.runtime.getURL("options/options.html#onboarding"),
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "chatgpt-lock:open-chat") {
    chrome.tabs.create({ url: CHAT_URL }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error("ChatGPT lock: failed to open chat", err);
        sendResponse(false);
      } else {
        sendResponse(true);
      }
    });
    return true;
  }
  if (message?.type === "chatgpt-lock:open-options") {
    chrome.runtime.openOptionsPage(() => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error("ChatGPT lock: failed to open options", err);
        sendResponse(false);
      } else {
        sendResponse(true);
      }
    });
    return true;
  }
  return undefined;
});
