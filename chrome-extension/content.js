(function bootstrap() {
  void recordTrace("content_bootstrap", { pageUrl: window.location.href });
  injectPageHook();
  window.addEventListener("message", onPageMessage);
})();

function injectPageHook() {
  if (document.documentElement.dataset.ceairMonitorHooked === "1") {
    return;
  }
  document.documentElement.dataset.ceairMonitorHooked = "1";
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-hook.js");
  script.async = false;
  document.documentElement.appendChild(script);
  script.remove();
  void recordTrace("page_hook_injected", { pageUrl: window.location.href });
}

function onPageMessage(event) {
  if (event.source !== window) {
    return;
  }
  if (event.data?.type !== "CEAIR_SHOPPINGV2_CAPTURE") {
    if (event.data?.type === "CEAIR_SHOPPINGV2_BLOCKED") {
      void recordTrace("shoppingv2_blocked", {
        pageUrl: window.location.href,
        details: event.data.payload || {}
      });
      chrome.runtime.sendMessage({
        type: "CEAIR_CAPTURED_BLOCKED",
        pageUrl: window.location.href,
        details: event.data.payload || {}
      });
    }
    return;
  }

  const context = parseFlightListContext(window.location.href);
  if (!context) {
    void recordTrace("context_parse_failed", { pageUrl: window.location.href });
    return;
  }

  const flights = normalizeFlights(event.data.payload);
  if (flights.length === 0) {
    void recordTrace("shoppingv2_empty_flights", {
      pageUrl: window.location.href,
      context,
      payloadSummary: summarizePayload(event.data.payload)
    });
    return;
  }

  void recordTrace("shoppingv2_captured", {
    pageUrl: window.location.href,
    context,
    flightCount: flights.length
  });
  chrome.runtime.sendMessage({
    type: "CEAIR_CAPTURED_FLIGHTS",
    ...context,
    flights
  });
}

function parseFlightListContext(urlText) {
  try {
    const url = new URL(urlText);
    const newParam = url.searchParams.get("newParam");
    if (newParam) {
      return parseMFlightListContext(newParam);
    }

    const encodedObj = url.searchParams.get("obj");
    if (encodedObj) {
      return parseExchangeContext(encodedObj);
    }

    return null;
  } catch {
    return null;
  }
}

function parseMFlightListContext(encoded) {
  const payload = JSON.parse(decodeURIComponent(encoded));
  const flightDate = String(payload.flightDate || "");
  if (!payload.depCode || !payload.arrCode || flightDate.length !== 8) {
    return null;
  }
  return {
    origin: String(payload.depCode).toUpperCase(),
    destination: String(payload.arrCode).toUpperCase(),
    date: `${flightDate.slice(0, 4)}-${flightDate.slice(4, 6)}-${flightDate.slice(6, 8)}`
  };
}

function parseExchangeContext(encodedObj) {
  const payload = JSON.parse(decodeBase64Json(encodedObj));
  const flightDate = String(payload.depDate || "");
  const origin = String(payload.oriCityCode || payload.depCityCode || "").toUpperCase();
  const destination = String(payload.desCityCode || payload.depCode || "").toUpperCase();
  if (!origin || !destination || !/^\d{4}-\d{2}-\d{2}$/.test(flightDate)) {
    return null;
  }
  return {
    origin,
    destination,
    date: flightDate
  };
}

function decodeBase64Json(input) {
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function normalizeFlights(payload) {
  const normalizedPayload = unwrapShoppingPayload(payload);
  const flights = normalizedPayload?.data?.flights;
  if (!Array.isArray(flights)) {
    return [];
  }

  return flights
    .map((flight) => ({
      flight_no: String(flight.flightNo || flight.marketingFlightNo || flight.flightCode || "").trim(),
      dep_time: String(flight.depTime || "").trim(),
      arr_time: String(flight.arrTime || "").trim(),
      flight_key: String(flight.flightKey || "").trim()
    }))
    .filter((flight) => flight.flight_no && flight.dep_time);
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      kind: typeof payload
    };
  }

  const normalizedPayload = unwrapShoppingPayload(payload);
  const data = normalizedPayload?.data && typeof normalizedPayload.data === "object" ? normalizedPayload.data : null;
  return {
    topLevelKeys: Object.keys(payload).slice(0, 20),
    normalizedTopLevelKeys:
      normalizedPayload && typeof normalizedPayload === "object"
        ? Object.keys(normalizedPayload).slice(0, 20)
        : [],
    dataKeys: data ? Object.keys(data).slice(0, 30) : [],
    code: normalizedPayload?.code ?? payload.code ?? null,
    success: normalizedPayload?.success ?? payload.success ?? null,
    message: normalizedPayload?.message ?? normalizedPayload?.msg ?? payload.message ?? payload.msg ?? "",
    flightListType: Array.isArray(data?.flights) ? "array" : typeof data?.flights,
    flightListLength: Array.isArray(data?.flights) ? data.flights.length : null,
    firstDataArrayKey: findFirstArrayKey(data),
    firstDataArrayLength: firstArrayLength(data)
  };
}

function unwrapShoppingPayload(payload) {
  let current = payload;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object") {
      return null;
    }
    if (current.data && typeof current.data === "object") {
      return current;
    }
    if (!("res" in current)) {
      return current;
    }
    current = parseNestedPayload(current.res);
  }
  return current && typeof current === "object" ? current : null;
}

function parseNestedPayload(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? value : null;
}

function findFirstArrayKey(data) {
  if (!data || typeof data !== "object") {
    return "";
  }
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      return key;
    }
  }
  return "";
}

function firstArrayLength(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  return null;
}

async function recordTrace(stage, details) {
  try {
    await chrome.storage.local.set({
      lastTrace: {
        stage,
        details,
        recordedAt: new Date().toISOString()
      }
    });
  } catch {
    // ignore storage failures
  }
}
