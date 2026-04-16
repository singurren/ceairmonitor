(function bootstrap() {
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
}

function onPageMessage(event) {
  if (event.source !== window) {
    return;
  }
  if (event.data?.type !== "CEAIR_SHOPPINGV2_CAPTURE") {
    if (event.data?.type === "CEAIR_SHOPPINGV2_BLOCKED") {
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
    return;
  }

  const flights = normalizeFlights(event.data.payload);
  if (flights.length === 0) {
    return;
  }

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
  const flights = payload?.data?.flights;
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
