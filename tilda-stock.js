(function () {
  "use strict";

  const INSTANCE_ID = Date.now().toString(36) + Math.random().toString(36).slice(2);
  window.__KonturStockInstanceId = INSTANCE_ID;

  const FALLBACK_API_ORIGIN = "https://149-154-67-63.sslip.io";

  const currentScript = document.currentScript;
  const scriptOrigin =
    currentScript && currentScript.src
      ? new URL(currentScript.src).origin
      : FALLBACK_API_ORIGIN;

  const STOCK_API_URL = scriptOrigin + "/api/stock";

  const STATUS_CLASS = "kontur-stock-status";
  const STATUS_LOADING = "Проверяем наличие...";
  const STATUS_NOT_AVAILABLE = "Нет в наличии";
  const STATUS_UNKNOWN = "Наличие уточняется";

  window.__KonturStockCache = window.__KonturStockCache || new Map();
  window.__KonturStockPending = window.__KonturStockPending || new Map();

  const cache = window.__KonturStockCache;
  const pending = window.__KonturStockPending;

  let lastHref = window.location.href;

  function isCurrentInstance() {
    return window.__KonturStockInstanceId === INSTANCE_ID;
  }

  function isProductUrl() {
    return window.location.pathname.includes("/tproduct/");
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getOwnText(el) {
    return Array.from(el.childNodes)
      .filter(function (node) {
        return node.nodeType === Node.TEXT_NODE;
      })
      .map(function (node) {
        return node.textContent;
      })
      .join(" ");
  }

  function extractSku(text) {
    const normalized = normalizeText(text);
    const match = normalized.match(/Артикул\s*[:：]\s*([0-9A-Za-zА-Яа-яЁё_-]+)/i);
    return match ? match[1].trim() : "";
  }

  function isVisible(el) {
    if (!el) return false;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function removeAllStatuses() {
    document.querySelectorAll("." + STATUS_CLASS).forEach(function (el) {
      el.remove();
    });
  }

  function findProductScope(articleElement) {
    let current = articleElement;

    for (let i = 0; i < 14 && current && current !== document.body; i++) {
      if (!isVisible(current)) {
        current = current.parentElement;
        continue;
      }

      const text = normalizeText(current.textContent);

      if (
        text.includes("Артикул") &&
        text.includes("Добавить в корзину") &&
        (
          text.includes("Размер") ||
          text.includes("Цвет") ||
          text.includes("Материал")
        )
      ) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function getArticleTextForElement(el) {
    const ownText = normalizeText(getOwnText(el));
    const fullText = normalizeText(el.textContent);

    if (extractSku(ownText)) {
      return ownText;
    }

    if (fullText.length <= 90 && extractSku(fullText)) {
      return fullText;
    }

    return "";
  }

  function findBestArticleElement() {
    if (!isProductUrl()) {
      removeAllStatuses();
      return null;
    }

    const elements = Array.from(document.querySelectorAll("body *"));
    const candidates = [];

    for (const el of elements) {
      if (el.classList && el.classList.contains(STATUS_CLASS)) continue;
      if (!isVisible(el)) continue;

      const articleText = getArticleTextForElement(el);
      const sku = extractSku(articleText);

      if (!sku) continue;

      const scope = findProductScope(el);
      if (!scope) continue;

      const rect = el.getBoundingClientRect();

      candidates.push({
        element: el,
        sku: sku,
        text: articleText,
        area: rect.width * rect.height,
      });
    }

    if (!candidates.length) {
      removeAllStatuses();
      return null;
    }

    candidates.sort(function (a, b) {
      return a.area - b.area || a.text.length - b.text.length;
    });

    return candidates[0];
  }

  function ensureStatusElement(articleElement) {
    const parent = articleElement.parentElement || articleElement;

    document.querySelectorAll("." + STATUS_CLASS).forEach(function (el) {
      if (el.parentElement !== parent) {
        el.remove();
      }
    });

    let statusEl = parent.querySelector("." + STATUS_CLASS);

    if (!statusEl) {
      statusEl = document.createElement("div");
      statusEl.className = STATUS_CLASS;
      statusEl.style.marginTop = "8px";
      statusEl.style.marginBottom = "8px";
      statusEl.style.fontSize = "15px";
      statusEl.style.fontWeight = "600";
      statusEl.style.lineHeight = "1.4";
      statusEl.style.display = "block";
      statusEl.style.position = "static";

      articleElement.insertAdjacentElement("afterend", statusEl);
    }

    return statusEl;
  }

  function setStatus(statusEl, available, text, isUnknown) {
    statusEl.textContent = text;

    if (isUnknown) {
      statusEl.style.color = "#777";
      return;
    }

    statusEl.style.color = available ? "#248a3d" : "#b3261e";
  }

  function fetchStock(sku) {
    if (cache.has(sku)) {
      return Promise.resolve(cache.get(sku));
    }

    if (pending.has(sku)) {
      return pending.get(sku);
    }

    const url = STOCK_API_URL + "?keys=" + encodeURIComponent(sku);

    const request = fetch(url, {
      method: "GET",
      cache: "no-store",
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Stock API error: " + response.status);
        }

        return response.json();
      })
      .then(function (data) {
        const item = data && data.items ? data.items[sku] : null;

        const result =
          item || {
            found: false,
            available: false,
            rest: 0,
            displayStatus: STATUS_NOT_AVAILABLE,
          };

        cache.set(sku, result);
        pending.delete(sku);

        return result;
      })
      .catch(function (error) {
        pending.delete(sku);
        throw error;
      });

    pending.set(sku, request);

    return request;
  }

  async function updateStock() {
    if (!isCurrentInstance()) return;

    if (!isProductUrl()) {
      removeAllStatuses();
      return;
    }

    const article = findBestArticleElement();

    if (!article) {
      return;
    }

    const statusEl = ensureStatusElement(article.element);
    const sku = article.sku;

    if (statusEl.dataset.sku === sku && statusEl.dataset.loaded === "1") {
      return;
    }

    statusEl.dataset.sku = sku;
    statusEl.dataset.loaded = "0";
    statusEl.textContent = STATUS_LOADING;
    statusEl.style.color = "#777";

    try {
      const item = await fetchStock(sku);

      if (!isCurrentInstance()) return;

      statusEl.dataset.loaded = "1";

      const text = item.displayStatus || STATUS_NOT_AVAILABLE;
      setStatus(statusEl, Boolean(item.available), text, false);
    } catch (error) {
      console.warn("[Kontur stock] Ошибка проверки остатка:", error);

      if (!isCurrentInstance()) return;

      statusEl.dataset.loaded = "0";
      setStatus(statusEl, false, STATUS_UNKNOWN, true);
    }
  }

  function updateStockSafe() {
    try {
      updateStock();
    } catch (error) {
      console.warn("[Kontur stock] Ошибка обновления:", error);
    }
  }

  function scheduleUpdate() {
    setTimeout(updateStockSafe, 150);
    setTimeout(updateStockSafe, 500);
    setTimeout(updateStockSafe, 1000);
    setTimeout(updateStockSafe, 1800);
  }

  function debounce(fn, delay) {
    let timer = null;

    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, delay);
    };
  }

  const debouncedUpdate = debounce(updateStockSafe, 250);

  function watchUrlChanges() {
    setInterval(function () {
      if (!isCurrentInstance()) return;

      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        scheduleUpdate();
      }
    }, 400);

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function () {
      originalPushState.apply(this, arguments);
      scheduleUpdate();
    };

    history.replaceState = function () {
      originalReplaceState.apply(this, arguments);
      scheduleUpdate();
    };

    window.addEventListener("popstate", scheduleUpdate);
    window.addEventListener("hashchange", scheduleUpdate);
  }

  function initKonturStock() {
    scheduleUpdate();
    watchUrlChanges();

    document.body.addEventListener("click", function () {
      scheduleUpdate();
    });

    document.body.addEventListener("change", function () {
      scheduleUpdate();
    });

    const observer = new MutationObserver(function () {
      if (!isProductUrl()) {
        removeAllStatuses();
        return;
      }

      debouncedUpdate();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    window.KonturStock = {
      update: updateStockSafe,
      apiUrl: STOCK_API_URL,
      debug: function () {
        const article = findBestArticleElement();

        return {
          href: window.location.href,
          isProductUrl: isProductUrl(),
          article: article
            ? {
                sku: article.sku,
                text: article.text,
                area: article.area,
              }
            : null,
          statuses: Array.from(document.querySelectorAll("." + STATUS_CLASS)).map(function (el) {
            return {
              text: normalizeText(el.textContent),
              parentText: normalizeText(el.parentElement ? el.parentElement.textContent : "").slice(0, 200),
            };
          }),
        };
      },
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initKonturStock);
  } else {
    initKonturStock();
  }
})();