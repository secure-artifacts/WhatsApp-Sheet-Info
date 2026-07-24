const WATCH_ALARM = "wa-sheet-watch-refresh";
const WATCH_PERIOD_MINUTES = 2;

function ensureWatchAlarm() {
  chrome.alarms.create(WATCH_ALARM, { periodInMinutes: WATCH_PERIOD_MINUTES });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureWatchAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensureWatchAlarm();
});

// Ask open sidepanel (if any) to refresh watch-list tags from sheets.
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== WATCH_ALARM) return;
  const at = Date.now();
  chrome.storage.local.set({ watchRefreshRequestedAt: at }).catch(() => {});
  chrome.runtime.sendMessage({ type: "watch-refresh-please", at }).catch(() => {});
});
