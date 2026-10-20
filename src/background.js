importScripts('sniff.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'sniff' || !sender.tab) return;
  self.__streamInspectorSniff.sniffFile(String(msg.src)).then(sendResponse, () => sendResponse(null));
  return true; // async response
});
