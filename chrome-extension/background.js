const DEFAULT_SETTINGS = {
  enabled: true,
  endpoint: "http://127.0.0.1:8766/api/flight-result",
  autoOpenEnabled: true
};
const HOURLY_CLEANUP_PREFIX = "https://ecactivity.ceair.com/";
const AUTO_OPEN_ALARM_MINUTES = 10;
const AUTO_OPEN_TIMEOUT_MS = 120000;
const AUTO_OPEN_ALARM_NAME = "ceair-auto-open";
const AUTO_OPEN_FOLLOWUP_ALARM_NAME = "ceair-auto-open-followup";
const HOURLY_CLEANUP_ALARM_NAME = "ceair-hourly-cleanup";

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
  chrome.alarms.create(AUTO_OPEN_ALARM_NAME, { periodInMinutes: AUTO_OPEN_ALARM_MINUTES });
  chrome.alarms.create(HOURLY_CLEANUP_ALARM_NAME, { periodInMinutes: 60 });
  await chrome.storage.local.set({
    lastTrace: {
      stage: "extension_installed",
      details: {},
      recordedAt: new Date().toISOString()
    }
  });
});

chrome.runtime.onStartup?.addListener(() => {
  chrome.alarms.create(AUTO_OPEN_ALARM_NAME, { periodInMinutes: AUTO_OPEN_ALARM_MINUTES });
  chrome.alarms.create(HOURLY_CLEANUP_ALARM_NAME, { periodInMinutes: 60 });
  void pollAutoOpenTasks("startup");
  void closeHourlyCleanupTabs("startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HOURLY_CLEANUP_ALARM_NAME) {
    void closeHourlyCleanupTabs("alarm");
    return;
  }
  if (alarm.name === AUTO_OPEN_ALARM_NAME) {
    void pollAutoOpenTasks("alarm");
    return;
  }
  if (alarm.name === AUTO_OPEN_FOLLOWUP_ALARM_NAME) {
    void pollAutoOpenTasks("followup_alarm");
    return;
  }
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
    await closeStaleAutoOpenedTabs(body, statusEndpoint, endpoint);
    const tasks = extractAutoOpenTasks(body);
    const autoOpenedTaskKeys = settings.autoOpenedTaskKeys || {};
    const lastSuccessfulPollAt = String(body?.state?.last_successful_poll_at || "");
    let openedCount = 0;

    const pendingTasks = [];
    for (const task of tasks) {
      const taskKey = `${task.origin}-${task.destination}:${task.date}:${lastSuccessfulPollAt}`;
      if (autoOpenedTaskKeys[taskKey]) {
        continue;
      }
      pendingTasks.push({ ...task, taskKey });
    }
    const autoOpenPlan = buildAutoOpenPlan(pendingTasks.length);

    for (const task of pendingTasks.slice(0, autoOpenPlan.batchSize)) {
      const url = buildFlightListUrl(task.origin, task.destination, task.date, task.productCode, task.routeType);
      const tabId = await openOrFocusTab(url, task.taskKey);
      autoOpenedTaskKeys[task.taskKey] = new Date().toISOString();
      if (tabId) {
        const autoOpenedTabIds = (await chrome.storage.local.get(["autoOpenedTabIds"])).autoOpenedTabIds || {};
        autoOpenedTabIds[String(tabId)] = {
          taskKey: task.taskKey,
          origin: task.origin,
          destination: task.destination,
          date: task.date,
          url,
          openedAt: new Date().toISOString()
        };
        await chrome.storage.local.set({ autoOpenedTabIds });
      }
      openedCount += 1;
      if (openedCount < autoOpenPlan.batchSize && openedCount < pendingTasks.length) {
        await sleep(autoOpenPlan.spacingMs);
      }
    }

    await chrome.storage.local.set({ autoOpenedTaskKeys });
    const deferredCount = Math.max(pendingTasks.length - openedCount, 0);
    if (deferredCount > 0) {
      chrome.alarms.create(AUTO_OPEN_FOLLOWUP_ALARM_NAME, {
        delayInMinutes: autoOpenPlan.followupDelayMinutes
      });
    } else {
      await chrome.alarms.clear(AUTO_OPEN_FOLLOWUP_ALARM_NAME);
    }
    await setTrace("auto_open_poll_completed", {
      reason,
      endpoint: statusEndpoint,
      lastSuccessfulPollAt,
      taskCount: tasks.length,
      pendingTaskCount: pendingTasks.length,
      openedCount,
      deferredCount,
      batchSize: autoOpenPlan.batchSize,
      spacingMs: autoOpenPlan.spacingMs,
      followupScheduled: deferredCount > 0,
      followupDelayMinutes: deferredCount > 0 ? autoOpenPlan.followupDelayMinutes : 0
    });
  } catch (error) {
    await setTrace("auto_open_poll_failed", {
      reason,
      endpoint: statusEndpoint,
      error: String(error)
    });
  }
}

function buildAutoOpenPlan(taskCount) {
  if (taskCount <= 2) {
    return {
      batchSize: 1,
      spacingMs: 30000,
      followupDelayMinutes: 3
    };
  }
  if (taskCount <= 4) {
    return {
      batchSize: 2,
      spacingMs: 25000,
      followupDelayMinutes: 3
    };
  }
  if (taskCount <= 8) {
    return {
      batchSize: 3,
      spacingMs: 20000,
      followupDelayMinutes: 2
    };
  }
  if (taskCount <= 12) {
    return {
      batchSize: 4,
      spacingMs: 15000,
      followupDelayMinutes: 2
    };
  }
  return {
    batchSize: 5,
    spacingMs: 15000,
    followupDelayMinutes: 2
  };
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
  if (statusBody?.runtime?.polling_window_active === false) {
    return [];
  }
  if (statusBody?.state?.last_error) {
    return [];
  }
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
  return tasks.sort((left, right) => left.date.localeCompare(right.date));
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

async function closeStaleAutoOpenedTabs(statusBody, statusEndpoint, endpoint) {
  const now = Date.now();
  const data = await chrome.storage.local.get(["autoOpenedTabIds"]);
  const autoOpenedTabIds = data.autoOpenedTabIds || {};
  let closedCount = 0;
  let warnedCount = 0;

  for (const [tabId, meta] of Object.entries(autoOpenedTabIds)) {
    const openedAtMs = Date.parse(String(meta?.openedAt || ""));
    if (!openedAtMs || now - openedAtMs < AUTO_OPEN_TIMEOUT_MS) {
      continue;
    }
    await chrome.tabs.remove(Number(tabId)).catch(() => {});
    delete autoOpenedTabIds[tabId];
    closedCount += 1;
    if (meta?.origin && meta?.destination && meta?.date) {
      const warned = await reportFlightWarning(endpoint, meta.origin, meta.destination, meta.date, "capture_timeout");
      if (warned) {
        warnedCount += 1;
      }
    }
  }

  await chrome.storage.local.set({ autoOpenedTabIds });
  if (closedCount > 0 || warnedCount > 0) {
    await setTrace("auto_open_timeout_cleanup", {
      endpoint: statusEndpoint,
      timeoutMs: AUTO_OPEN_TIMEOUT_MS,
      closedCount,
      warnedCount
    });
  }
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

async function reportFlightWarning(endpoint, origin, destination, date, reason) {
  const warningEndpoint = deriveWarningEndpoint(endpoint);
  if (!warningEndpoint) {
    return false;
  }
  try {
    const response = await fetch(warningEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ origin, destination, date, reason })
    });
    return response.ok;
  } catch {
    return false;
  }
}

function deriveWarningEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    url.pathname = "/api/flight-warning";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
