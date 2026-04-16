const DEFAULT_ENDPOINT = "http://127.0.0.1:8766/api/flight-result";

document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get(["enabled", "endpoint", "lastResult", "lastTrace"]);
  document.getElementById("enabled").checked = data.enabled !== false;
  document.getElementById("endpoint").value = data.endpoint || DEFAULT_ENDPOINT;
  renderLastResult(data.lastResult);
  renderLastTrace(data.lastTrace);

  document.getElementById("save").addEventListener("click", saveOptions);
  chrome.storage.onChanged.addListener(onStorageChanged);
});

async function saveOptions() {
  const enabled = document.getElementById("enabled").checked;
  const endpoint = document.getElementById("endpoint").value.trim() || DEFAULT_ENDPOINT;
  await chrome.storage.local.set({ enabled, endpoint });
  document.getElementById("status").textContent = "已保存";
  setTimeout(() => {
    document.getElementById("status").textContent = "";
  }, 1500);
}

function renderLastResult(lastResult) {
  const node = document.getElementById("last-result");
  if (!lastResult) {
    node.textContent = "暂无";
    return;
  }
  node.textContent = JSON.stringify(lastResult, null, 2);
}

function renderLastTrace(lastTrace) {
  const node = document.getElementById("last-trace");
  if (!lastTrace) {
    node.textContent = "暂无";
    return;
  }
  node.textContent = JSON.stringify(lastTrace, null, 2);
}

function onStorageChanged(changes, areaName) {
  if (areaName !== "local") {
    return;
  }
  if (changes.lastResult) {
    renderLastResult(changes.lastResult.newValue);
  }
  if (changes.lastTrace) {
    renderLastTrace(changes.lastTrace.newValue);
  }
}
