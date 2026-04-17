const DEFAULT_SETTINGS = {
  enabled: true,
  endpoint: "http://127.0.0.1:8766/api/flight-result",
  autoOpenEnabled: true
};
const HOURLY_CLEANUP_PREFIX = "https://ecactivity.ceair.com/";

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["enabled", "endpoint", "autoOpenEnabled"]);
  const next = {};
  if (typeof current.enabled !== "boolean") {
    next.enabled = DEFAULT_SETTINGS.enabled;
  }
  if (!current.endpoint) {
    next.endpoint = DEFAULT_SETTINGS.endpoint;
  }
  if (typeof current.autoOpenEnabled !== "boolean") {
    next.autoOpenEnabled = DEFAULT_SETTINGS.autoOpenEnabled;
  }
  if (Object.keys(next).length > 0) {
    await chrome.storage.local.set(next);
  }
  chrome.alarms.create("ceair-auto-open", { periodInMinutes: 1 });
  chrome.alarms.create("ceair-hourly-cleanup", { periodInMinutes: 60 });
  await chrome.storage.local.set({
    lastTrace: {
      stage: "extension_installed",
      details: {},
      recordedAt: new Date().toISOString()
    }
  });
});

chrome.runtime.onStartup?.addListener(() => {
  chrome.alarms.create("ceair-auto-open", { periodInMinutes: 1 });
  chrome.alarms.create("ceair-hourly-cleanup", { periodInMinutes: 60 });
  void pollAutoOpenTasks("startup");
  void closeHourlyCleanupTabs("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ceair-hourly-cleanup") {
    void closeHourlyCleanupTabs("alarm");
    return;
  }
  if (alarm.name !== "ceair-auto-open") {
    return;
  }
  void pollAutoOpenTasks("alarm");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CEAIR_CAPTURED_BLOCKED") {
    void handleBlockedCapture(message, _sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type !== "CEAIR_CAPTURED_FLIGHTS") {
    return false;
  }

  void handleCapturedFlights(message, _sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

async function handleCapturedFlights(message, sender) {
  await setTrace("background_received_flights", {
    route: `${message.origin}-${message.destination}`,
    date: message.date,
    flightCount: Array.isArray(message.flights) ? message.flights.length : 0,
    captureSource: message.captureSource || "",
    captureMeta: message.captureMeta || {},
    flights: Array.isArray(message.flights) ? message.flights : []
  });
  const settings = await chrome.storage.local.get(["enabled", "endpoint"]);
  if (settings.enabled === false) {
    await setTrace("forward_skipped_disabled", {});
    return { skipped: true, reason: "disabled" };
  }

  const endpoint = settings.endpoint || DEFAULT_SETTINGS.endpoint;
  const payload = {
    source: "windows-chrome-extension",
    date: message.date,
    origin: message.origin,
    destination: message.destination,
    flights: message.flights
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }

    const result = {
      ok: response.ok,
      status: response.status,
      body,
      endpoint,
      sentAt: new Date().toISOString(),
      flightCount: Array.isArray(message.flights) ? message.flights.length : 0,
      route: `${message.origin}-${message.destination}`,
      date: message.date,
      captureSource: message.captureSource || "",
      captureMeta: message.captureMeta || {},
      flights: Array.isArray(message.flights) ? message.flights : []
    };
    await chrome.storage.local.set({ lastResult: result });
    await setTrace("forward_completed", result);
    await maybeCloseAutoOpenedTab(sender);
    return result;
  } catch (error) {
    const result = {
      ok: false,
      networkError: true,
      error: String(error),
      endpoint,
      sentAt: new Date().toISOString(),
      flightCount: Array.isArray(message.flights) ? message.flights.length : 0,
      route: `${message.origin}-${message.destination}`,
      date: message.date,
      captureSource: message.captureSource || "",
      captureMeta: message.captureMeta || {},
      flights: Array.isArray(message.flights) ? message.flights : []
    };
    await chrome.storage.local.set({ lastResult: result });
    await setTrace("forward_failed", result);
    throw error;
  }
}

async function pollAutoOpenTasks(reason) {
  const settings = await chrome.storage.local.get([
    "enabled",
    "endpoint",
    "autoOpenEnabled",
    "autoOpenedTaskKeys",
    "autoOpenedTabIds"
  ]);
  if (settings.enabled === false || settings.autoOpenEnabled === false) {
    return;
  }

  const endpoint = String(settings.endpoint || DEFAULT_SETTINGS.endpoint);
  const statusEndpoint = deriveStatusEndpoint(endpoint);
  if (!statusEndpoint) {
    await setTrace("auto_open_invalid_endpoint", { endpoint, reason });
    return;
  }

  try {
    const response = await fetch(statusEndpoint);
    const body = await response.json();
    const tasks = extractAutoOpenTasks(body);
    const autoOpenedTaskKeys = settings.autoOpenedTaskKeys || {};
    const lastPollAt = String(body?.state?.last_poll_at || "");
    let openedCount = 0;

    for (const task of tasks) {
      const taskKey = `${task.origin}-${task.destination}:${task.date}:${lastPollAt}`;
      if (autoOpenedTaskKeys[taskKey]) {
        continue;
      }
      const url = buildFlightListUrl(task.origin, task.destination, task.date, task.productCode, task.routeType);
      const tabId = await openOrFocusTab(url, taskKey);
      autoOpenedTaskKeys[taskKey] = new Date().toISOString();
      if (tabId) {
        const autoOpenedTabIds = (await chrome.storage.local.get(["autoOpenedTabIds"])).autoOpenedTabIds || {};
        autoOpenedTabIds[String(tabId)] = {
          taskKey,
          url,
          openedAt: new Date().toISOString()
        };
        await chrome.storage.local.set({ autoOpenedTabIds });
      }
      openedCount += 1;
    }

    await chrome.storage.local.set({ autoOpenedTaskKeys });
    await setTrace("auto_open_poll_completed", {
      reason,
      endpoint: statusEndpoint,
      lastPollAt,
      taskCount: tasks.length,
      openedCount
    });
  } catch (error) {
    await setTrace("auto_open_poll_failed", {
      reason,
      endpoint: statusEndpoint,
      error: String(error)
    });
  }
}

function deriveStatusEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    url.pathname = "/api/status";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function extractAutoOpenTasks(statusBody) {
  const ruleMatches = statusBody?.state?.last_summary?.rule_matches;
  if (!Array.isArray(ruleMatches)) {
    return [];
  }
  const tasks = [];
  const seen = new Set();
  for (const item of ruleMatches) {
    if (!item || item.status !== "2") {
      continue;
    }
    const origin = String(item.origin || "").toUpperCase();
    const destination = String(item.destination || "").toUpperCase();
    const date = String(item.date || "");
    const productCode = String(item.product_code || statusBody?.config?.product_code || "").trim();
    const routeType = String(item.route_type || statusBody?.config?.route_type || "OW").trim();
    if (!origin || !destination || !date || !productCode) {
      continue;
    }
    const key = `${origin}-${destination}:${date}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tasks.push({ origin, destination, date, productCode, routeType });
  }
  return tasks;
}

function buildFlightListUrl(origin, destination, dateText, productCode, routeType) {
  const tripType = routeType === "OW" ? 0 : 1;
  const payload = {
    tripType,
    depCode: origin,
    arrCode: destination,
    dt: "1",
    at: "1",
    depN: "",
    arrN: "",
    flightDate: String(dateText).replace(/-/g, ""),
    carryChd: "0",
    carryInf: "0",
    productType: "CASH",
    curIndex: 0,
    zoneCode: "PROMOTION_PRODUCT_ZONE",
    productCode
  };
  return `https://m.ceair.com/mapp/reserve/flightList?newParam=${encodeURIComponent(JSON.stringify(payload))}`;
}

async function openOrFocusTab(url, taskKey) {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url === url);
  if (existing?.id) {
    await chrome.tabs.remove(existing.id).catch(() => {});
  }
  const tab = await chrome.tabs.create({ url, active: false });
  await setTrace("auto_open_tab_created", {
    url,
    taskKey,
    tabId: tab.id || 0
  });
  return tab.id || 0;
}

async function handleBlockedCapture(message, sender) {
  const result = {
    ok: false,
    blocked: true,
    reason: "shoppingv2_non_json",
    pageUrl: message.pageUrl || "",
    status: Number(message.details?.status || 0),
    contentType: String(message.details?.contentType || ""),
    bodyPreview: String(message.details?.bodyPreview || ""),
    sentAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ lastResult: result });
  await setTrace("blocked_response_seen", result);
  await maybeCloseAutoOpenedTab(sender);
  return result;
}

async function maybeCloseAutoOpenedTab(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) {
    return;
  }
  const data = await chrome.storage.local.get(["autoOpenedTabIds"]);
  const autoOpenedTabIds = data.autoOpenedTabIds || {};
  if (!autoOpenedTabIds[String(tabId)]) {
    return;
  }
  delete autoOpenedTabIds[String(tabId)];
  await chrome.storage.local.set({ autoOpenedTabIds });
  await chrome.tabs.remove(tabId).catch(() => {});
  await setTrace("auto_open_tab_closed", {
    tabId
  });
}

async function closeHourlyCleanupTabs(reason) {
  const tabs = await chrome.tabs.query({});
  const closableTabs = tabs.filter((tab) => String(tab.url || "").startsWith(HOURLY_CLEANUP_PREFIX));
  let closedCount = 0;
  for (const tab of closableTabs) {
    if (!tab.id) {
      continue;
    }
    await chrome.tabs.remove(tab.id).catch(() => {});
    closedCount += 1;
  }
  await setTrace("hourly_cleanup_completed", {
    reason,
    prefix: HOURLY_CLEANUP_PREFIX,
    scannedCount: tabs.length,
    closedCount
  });
}

async function setTrace(stage, details) {
  await chrome.storage.local.set({
    lastTrace: {
      stage,
      details,
      recordedAt: new Date().toISOString()
    }
  });
}
