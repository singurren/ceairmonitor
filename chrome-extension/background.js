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
  await chrome.storage.local.set({
    lastTrace: {
      stage: "extension_installed",
      details: {},
      recordedAt: new Date().toISOString()
    }
  });
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
  await setTrace("background_received_flights", {
    route: `${message.origin}-${message.destination}`,
    date: message.date,
    flightCount: Array.isArray(message.flights) ? message.flights.length : 0,
    captureSource: message.captureSource || "",
    captureMeta: message.captureMeta || {}
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
      captureMeta: message.captureMeta || {}
    };
    await chrome.storage.local.set({ lastResult: result });
    await setTrace("forward_completed", result);
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
      captureMeta: message.captureMeta || {}
    };
    await chrome.storage.local.set({ lastResult: result });
    await setTrace("forward_failed", result);
    throw error;
  }
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
  await setTrace("blocked_response_seen", result);
  return result;
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
