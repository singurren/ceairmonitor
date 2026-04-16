const DEFAULT_SETTINGS = {
  enabled: true,
  endpoint: "http://127.0.0.1:8766/api/flight-result"
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["enabled", "endpoint"]);
  const next = {};
  if (typeof current.enabled !== "boolean") {
    next.enabled = DEFAULT_SETTINGS.enabled;
  }
  if (!current.endpoint) {
    next.endpoint = DEFAULT_SETTINGS.endpoint;
  }
  if (Object.keys(next).length > 0) {
    await chrome.storage.local.set(next);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CEAIR_CAPTURED_BLOCKED") {
    void handleBlockedCapture(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type !== "CEAIR_CAPTURED_FLIGHTS") {
    return false;
  }

  void handleCapturedFlights(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

async function handleCapturedFlights(message) {
  const settings = await chrome.storage.local.get(["enabled", "endpoint"]);
  if (settings.enabled === false) {
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
    sentAt: new Date().toISOString(),
    flightCount: Array.isArray(message.flights) ? message.flights.length : 0,
    route: `${message.origin}-${message.destination}`,
    date: message.date
  };
  await chrome.storage.local.set({ lastResult: result });
  return result;
}

async function handleBlockedCapture(message) {
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
  return result;
}
