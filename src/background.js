// 点击工具栏图标时，通知当前 Discord 标签页切换悬浮窗显隐。
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id || !tab.url || !tab.url.startsWith("https://discord.com/")) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "DME_TOGGLE_PANEL" });
  } catch (e) {
    // content.js 可能还没注入（例如刚装好扩展），提示刷新
    // 这里静默失败即可，用户刷新页面后再点
  }
});
