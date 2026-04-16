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
      captureRawResponse(this.__ceairMonitorUrl, this.responseText);
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
      captureRawResponse(url, text);
    } catch {
      // ignore parse failures from page hook
    }
  }

  function captureRawResponse(url, text) {
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
      // ignore non-json responses
    }
  }

  function isShoppingUrl(url) {
    return typeof url === "string" && url.includes("/m-base/sale/shoppingv2");
  }
})();
