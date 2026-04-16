(function installHook() {
  if (window.__ceairMonitorPageHookInstalled) {
    return;
  }
  window.__ceairMonitorPageHookInstalled = true;

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    captureFetchResponse(args[0], response);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__ceairMonitorUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    this.addEventListener("load", function onLoad() {
      captureRawResponse(this.__ceairMonitorUrl, this.responseText, {
        status: this.status,
        contentType: this.getResponseHeader("content-type") || ""
      });
    });
    return originalSend.call(this, body);
  };

  async function captureFetchResponse(input, response) {
    const url = typeof input === "string" ? input : input?.url;
    if (!isShoppingUrl(url)) {
      return;
    }
    try {
      const cloned = response.clone();
      const text = await cloned.text();
      captureRawResponse(url, text, {
        status: response.status,
        contentType: response.headers.get("content-type") || ""
      });
    } catch {
      // ignore parse failures from page hook
    }
  }

  function captureRawResponse(url, text, meta = {}) {
    if (!isShoppingUrl(url)) {
      return;
    }
    try {
      const payload = JSON.parse(text);
      window.postMessage(
        {
          type: "CEAIR_SHOPPINGV2_CAPTURE",
          payload
        },
        "*"
      );
    } catch {
      window.postMessage(
        {
          type: "CEAIR_SHOPPINGV2_BLOCKED",
          payload: {
            status: meta.status || 0,
            contentType: meta.contentType || "",
            bodyPreview: String(text || "").slice(0, 200)
          }
        },
        "*"
      );
    }
  }

  function isShoppingUrl(url) {
    return typeof url === "string" && url.includes("/m-base/sale/shoppingv2");
  }
})();
