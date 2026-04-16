(function installHook() {
  if (window.__ceairMonitorPageHookInstalled) {
    return;
  }
  window.__ceairMonitorPageHookInstalled = true;

  installCryptoHooks();
  installTextDecoderHook();

  const originalJsonParse = JSON.parse;
  JSON.parse = function patchedJsonParse(...args) {
    const parsed = originalJsonParse.apply(this, args);
    inspectParsedValue(parsed, {
      source: "json_parse",
      inputPreview: typeof args[0] === "string" ? String(args[0]).slice(0, 120) : ""
    });
    return parsed;
  };

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
      inspectParsedValue(payload, {
        source: "network_response",
        responseUrl: url,
        status: meta.status || 0
      });
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

  function inspectParsedValue(value, meta = {}) {
    const payload = unwrapShoppingPayload(value);
    const flights = payload?.data?.flights;
    if (!Array.isArray(flights) || flights.length === 0) {
      return;
    }
    window.postMessage(
      {
        type: "CEAIR_SHOPPINGV2_CAPTURE",
        payload,
        meta: {
          source: meta.source || "unknown",
          responseUrl: meta.responseUrl || "",
          status: meta.status || 0,
          inputPreview: meta.inputPreview || ""
        }
      },
      "*"
    );
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
        return originalJsonParse(value);
      } catch {
        return null;
      }
    }
    return typeof value === "object" ? value : null;
  }

  function installTextDecoderHook() {
    if (!window.TextDecoder || window.TextDecoder.prototype.__ceairDecodeHooked) {
      return;
    }
    const originalDecode = window.TextDecoder.prototype.decode;
    window.TextDecoder.prototype.decode = function patchedDecode(...args) {
      const text = originalDecode.apply(this, args);
      inspectStringValue(text, {
        source: "text_decoder_decode"
      });
      return text;
    };
    window.TextDecoder.prototype.__ceairDecodeHooked = true;
  }

  function installCryptoHooks() {
    let hooked = false;
    const tryInstall = () => {
      const cryptoJs = window.CryptoJS;
      if (!cryptoJs || hooked) {
        return;
      }
      hooked = true;
      if (cryptoJs.AES && typeof cryptoJs.AES.decrypt === "function") {
        const originalDecrypt = cryptoJs.AES.decrypt;
        cryptoJs.AES.decrypt = function patchedAesDecrypt(...args) {
          const result = originalDecrypt.apply(this, args);
          inspectStringValue(result, {
            source: "cryptojs_aes_decrypt_result"
          });
          return result;
        };
      }
      if (cryptoJs.enc?.Utf8 && typeof cryptoJs.enc.Utf8.stringify === "function") {
        const originalStringify = cryptoJs.enc.Utf8.stringify;
        cryptoJs.enc.Utf8.stringify = function patchedUtf8Stringify(...args) {
          const result = originalStringify.apply(this, args);
          inspectStringValue(result, {
            source: "cryptojs_utf8_stringify"
          });
          return result;
        };
      }
    };

    tryInstall();
    const timer = window.setInterval(() => {
      tryInstall();
      if (hooked) {
        window.clearInterval(timer);
      }
    }, 500);
  }

  function inspectStringValue(value, meta = {}) {
    if (typeof value !== "string" || value.length < 20) {
      return;
    }
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
      return;
    }
    try {
      const parsed = originalJsonParse(trimmed);
      inspectParsedValue(parsed, {
        source: meta.source || "string_value"
      });
    } catch {
      // ignore non-json strings
    }
  }

  function isShoppingUrl(url) {
    return typeof url === "string" && url.includes("/m-base/sale/shoppingv2");
  }
})();
