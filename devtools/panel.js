const inspectedTabId = chrome.devtools.inspectedWindow.tabId;
document.getElementById('workspace').src = chrome.runtime.getURL(
    `popup/popup.html?devtools=1&tabId=${encodeURIComponent(inspectedTabId)}`
);
