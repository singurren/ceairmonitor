(function bootstrapState() {
  window.__ceairMonitorState = window.__ceairMonitorState || {
    domObserverStarted: false,
    domCaptureTimer: 0,
    lastCaptureSignature: "",
    lastDomTraceSignature: ""
  };
})();

(function bootstrap() {
  void recordTrace("content_bootstrap", { pageUrl: window.location.href });
  injectPageHook();
  startDomFlightObserver();
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
    scheduleDomFlightCheck("shoppingv2_empty_flights");
    return;
  }

  void recordTrace("shoppingv2_captured", {
    pageUrl: window.location.href,
    context,
    flightCount: flights.length
  });
  sendCapturedFlights(context, flights, "shoppingv2_payload");
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
    resType: typeof payload.res,
    resLength: typeof payload.res === "string" ? payload.res.length : null,
    resPreview: previewValue(payload.res),
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

function previewValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value.slice(0, 200);
  }
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
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

function startDomFlightObserver() {
  if (window.__ceairMonitorState.domObserverStarted) {
    return;
  }
  window.__ceairMonitorState.domObserverStarted = true;

  const kick = () => scheduleDomFlightCheck("dom_observer");
  if (document.body) {
    installDomObserver(kick);
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        installDomObserver(kick);
        kick();
      },
      { once: true }
    );
  }

  window.addEventListener("load", kick, { once: true });
  window.setTimeout(() => scheduleDomFlightCheck("bootstrap_1s"), 1000);
  window.setTimeout(() => scheduleDomFlightCheck("bootstrap_3s"), 3000);
  window.setTimeout(() => scheduleDomFlightCheck("bootstrap_6s"), 6000);
}

function installDomObserver(onChange) {
  if (!document.body || document.body.dataset.ceairMonitorDomObserved === "1") {
    return;
  }
  document.body.dataset.ceairMonitorDomObserved = "1";
  const observer = new MutationObserver(() => onChange());
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function scheduleDomFlightCheck(reason) {
  if (window.__ceairMonitorState.domCaptureTimer) {
    window.clearTimeout(window.__ceairMonitorState.domCaptureTimer);
  }
  window.__ceairMonitorState.domCaptureTimer = window.setTimeout(() => {
    window.__ceairMonitorState.domCaptureTimer = 0;
    void captureFlightsFromDom(reason);
  }, 800);
}

async function captureFlightsFromDom(reason) {
  const context = parseFlightListContext(window.location.href);
  if (!context || !document.body) {
    return;
  }
  const flights = scrapeFlightsFromDom(document.body);
  if (flights.length === 0) {
    const traceSignature = `${reason}:${document.body.innerText.slice(0, 120)}`;
    if (window.__ceairMonitorState.lastDomTraceSignature !== traceSignature) {
      window.__ceairMonitorState.lastDomTraceSignature = traceSignature;
      await recordTrace("dom_flights_not_found", {
        pageUrl: window.location.href,
        context,
        reason
      });
    }
    return;
  }

  await recordTrace("dom_flights_captured", {
    pageUrl: window.location.href,
    context,
    reason,
    flightCount: flights.length
  });
  sendCapturedFlights(context, flights, "rendered_dom");
}

function scrapeFlightsFromDom(root) {
  const candidates = [];
  const seenElements = new Set();
  const elements = root.querySelectorAll("*");
  for (const element of elements) {
    if (!(element instanceof HTMLElement) || seenElements.has(element)) {
      continue;
    }
    const text = normalizeElementText(element.innerText || "");
    if (text.length < 6 || text.length > 220) {
      continue;
    }
    const flightNos = extractFlightNumbers(text);
    const times = extractTimes(text);
    if (flightNos.length !== 1 || times.length === 0 || times.length > 4) {
      continue;
    }
    if (element.querySelector("*")) {
      const childHasSameSignal = Array.from(element.children).some((child) => {
        if (!(child instanceof HTMLElement)) {
          return false;
        }
        const childText = normalizeElementText(child.innerText || "");
        return extractFlightNumbers(childText).length > 0 && extractTimes(childText).length > 0;
      });
      if (childHasSameSignal) {
        continue;
      }
    }
    seenElements.add(element);
    candidates.push({
      flight_no: flightNos[0],
      dep_time: times[0] || "",
      arr_time: times[1] || "",
      flight_key: ""
    });
  }

  const deduped = [];
  const seenFlights = new Set();
  for (const flight of candidates) {
    if (!flight.flight_no || !flight.dep_time) {
      continue;
    }
    const key = `${flight.flight_no}:${flight.dep_time}:${flight.arr_time}`;
    if (seenFlights.has(key)) {
      continue;
    }
    seenFlights.add(key);
    deduped.push(flight);
  }
  return deduped;
}

function normalizeElementText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function extractFlightNumbers(text) {
  return Array.from(text.matchAll(/\b([A-Z]{2}\d{3,4})\b/g), (match) => match[1]);
}

function extractTimes(text) {
  return Array.from(text.matchAll(/\b([01]\d|2[0-3]):[0-5]\d\b/g), (match) => match[0]);
}

function sendCapturedFlights(context, flights, source) {
  const signature = `${context.origin}-${context.destination}-${context.date}:${flights
    .map((flight) => `${flight.flight_no}@${flight.dep_time}`)
    .sort()
    .join("|")}`;
  if (window.__ceairMonitorState.lastCaptureSignature === signature) {
    return;
  }
  window.__ceairMonitorState.lastCaptureSignature = signature;
  chrome.runtime.sendMessage({
    type: "CEAIR_CAPTURED_FLIGHTS",
    captureSource: source,
    ...context,
    flights
  });
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
