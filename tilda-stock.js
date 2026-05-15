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

  const CART_BUTTON_TEXT = "Добавить в корзину";
  const DISABLED_BUTTON_TEXT = "Нет в наличии";

  const CLIENT_CACHE_TTL_MS = 60 * 1000;

  window.__KonturStockCache = window.__KonturStockCache || new Map();
  window.__KonturStockPending = window.__KonturStockPending || new Map();

  const cache = window.__KonturStockCache;
  const pending = window.__KonturStockPending;

  let lastHref = window.location.href;
  let updateInProgress = false;
  let rerunRequested = false;
  let lastAppliedSku = "";
  let lastAppliedAvailable = null;
  let suppressUntil = 0;

  function isCurrentInstance() {
    return window.__KonturStockInstanceId === INSTANCE_ID;
  }

  function suppressUpdates(ms) {
    suppressUntil = Math.max(suppressUntil, Date.now() + ms);
  }

  function isSuppressed() {
    return Date.now() < suppressUntil;
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

  function getCleanText(el) {
    if (!el) return "";

    const ignoredTags = {
      SCRIPT: true,
      STYLE: true,
      NOSCRIPT: true,
      TEMPLATE: true,
    };

    function walk(node) {
      if (!node) return "";

      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent || "";
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }

      if (ignoredTags[node.tagName]) {
        return "";
      }

      return Array.from(node.childNodes)
        .map(walk)
        .join(" ");
    }

    return normalizeText(walk(el));
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

  function isCloseControl(target) {
    if (!target || !target.closest) return false;

    return Boolean(
      target.closest(".t-popup__close") ||
      target.closest(".t-popup__close-wrapper") ||
      target.closest(".t-store__prod-popup__close") ||
      target.closest(".js-store-close-text") ||
      target.closest(".js-store-prod-popup-close") ||
      target.closest("[data-popup-close]") ||
      target.closest("[aria-label='Close']") ||
      target.closest("[aria-label='Закрыть']")
    );
  }

  function isCartButtonText(text) {
    const normalized = normalizeText(text);

    return (
      normalized.includes(CART_BUTTON_TEXT) ||
      normalized.includes(DISABLED_BUTTON_TEXT)
    );
  }

  function sanitizeButtonText(text) {
    const normalized = normalizeText(text);

    if (!normalized) return CART_BUTTON_TEXT;
    if (normalized.includes(CART_BUTTON_TEXT)) return CART_BUTTON_TEXT;
    if (normalized.includes(DISABLED_BUTTON_TEXT)) return CART_BUTTON_TEXT;
    if (normalized.length > 60) return CART_BUTTON_TEXT;

    return normalized;
  }

  function getPossibleCartButtons(scope) {
    if (!scope) return [];

    return Array.from(
      scope.querySelectorAll("a, button, [role='button'], .t-btn")
    );
  }

  function findButtonLabelElement(button) {
    if (!button) return null;

    const selectors = [
      ".t-btn__text",
      ".tn-atom",
      ".js-store-prod-popup-buy-btn-txt",
      "span",
    ];

    for (const selector of selectors) {
      const label = button.querySelector(selector);

      if (!label) continue;
      if (!isVisible(label)) continue;

      const text = getCleanText(label);

      if (!text) continue;
      if (text.length > 80) continue;

      return label;
    }

    return null;
  }

  function setButtonText(button, text) {
    if (!button) return;

    const directTextNodes = Array.from(button.childNodes).filter(function (node) {
      return node.nodeType === Node.TEXT_NODE && normalizeText(node.textContent);
    });

    if (directTextNodes.length) {
      directTextNodes[0].textContent = text;

      directTextNodes.slice(1).forEach(function (node) {
        node.textContent = "";
      });

      return;
    }

    const label = findButtonLabelElement(button);

    if (label) {
      label.textContent = text;
      return;
    }

    button.textContent = text;
  }

  function hasCartButtonInScope(scope) {
    return getPossibleCartButtons(scope).some(function (el) {
      if (!isVisible(el)) return false;

      if (el.dataset && el.dataset.konturStockButton === "1") {
        return true;
      }

      const text = getCleanText(el);

      if (!isCartButtonText(text)) return false;

      return text.length <= 120;
    });
  }

  function restoreCartButton(button) {
    if (!button) return;

    const originalText = sanitizeButtonText(button.dataset.konturOriginalText);

    setButtonText(button, originalText);

    button.disabled = false;
    button.removeAttribute("aria-disabled");

    if (button.dataset.konturOriginalHref) {
      button.setAttribute("href", button.dataset.konturOriginalHref);
    }

    if (button.dataset.konturOriginalTabindex === "__none__") {
      button.removeAttribute("tabindex");
    } else if (button.dataset.konturOriginalTabindex) {
      button.setAttribute("tabindex", button.dataset.konturOriginalTabindex);
    } else {
      button.removeAttribute("tabindex");
    }

    button.style.pointerEvents = "";
    button.style.opacity = "";
    button.style.cursor = "";

    button.dataset.konturStockDisabled = "0";
  }

  function resetCartButtons() {
    document.querySelectorAll("[data-kontur-stock-button='1']").forEach(function (button) {
      restoreCartButton(button);
    });
  }

  function removeAllStatuses() {
    document.querySelectorAll("." + STATUS_CLASS).forEach(function (el) {
      el.remove();
    });

    resetCartButtons();

    lastAppliedSku = "";
    lastAppliedAvailable = null;
  }

  function findProductScope(articleElement) {
    let current = articleElement;

    for (let i = 0; i < 14 && current && current !== document.body; i++) {
      if (!isVisible(current)) {
        current = current.parentElement;
        continue;
      }

      const text = getCleanText(current);

      const hasArticle = text.includes("Артикул");
      const hasOptions =
        text.includes("Размер") ||
        text.includes("Цвет") ||
        text.includes("Материал");

      if (hasArticle && hasOptions && hasCartButtonInScope(current)) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  function getArticleTextForElement(el) {
    const ownText = normalizeText(getOwnText(el));
    const cleanText = getCleanText(el);

    if (extractSku(ownText)) {
      return ownText;
    }

    if (cleanText.length <= 90 && extractSku(cleanText)) {
      return cleanText;
    }

    return "";
  }

  function findBestArticleElement() {
    if (!isProductUrl()) {
      removeAllStatuses();
      return null;
    }

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          const value = normalizeText(node.textContent);

          if (!value.includes("Артикул")) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    const candidates = [];
    let node;

    while ((node = walker.nextNode())) {
      const el = node.parentElement;

      if (!el) continue;
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
      statusEl.style.display = "none";
      statusEl.style.position = "static";

      articleElement.insertAdjacentElement("afterend", statusEl);
    }

    return statusEl;
  }

  function findCartButton(articleElement) {
    const scope = findProductScope(articleElement);

    if (!scope) return null;

    const candidates = getPossibleCartButtons(scope)
      .filter(function (el) {
        if (!isVisible(el)) return false;

        if (el.dataset && el.dataset.konturStockButton === "1") {
          return true;
        }

        const text = getCleanText(el);

        if (!isCartButtonText(text)) return false;

        return text.length <= 120;
      })
      .map(function (el) {
        const rect = el.getBoundingClientRect();

        return {
          element: el,
          text: getCleanText(el),
          area: rect.width * rect.height,
        };
      });

    if (!candidates.length) return null;

    candidates.sort(function (a, b) {
      return a.area - b.area || a.text.length - b.text.length;
    });

    return candidates[0].element;
  }

  function setCartButtonAvailability(articleElement, available) {
    const button = findCartButton(articleElement);

    if (!button) return;

    button.dataset.konturStockButton = "1";

    if (!button.dataset.konturOriginalText) {
      button.dataset.konturOriginalText = sanitizeButtonText(getCleanText(button));
    }

    if (!button.dataset.konturOriginalTabindex) {
      button.dataset.konturOriginalTabindex = button.hasAttribute("tabindex")
        ? button.getAttribute("tabindex")
        : "__none__";
    }

    if (button.tagName && button.tagName.toLowerCase() === "a") {
      if (!button.dataset.konturOriginalHref && button.hasAttribute("href")) {
        button.dataset.konturOriginalHref = button.getAttribute("href");
      }
    }

    if (available) {
      restoreCartButton(button);
      return;
    }

    setButtonText(button, DISABLED_BUTTON_TEXT);

    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    button.setAttribute("tabindex", "-1");

    if (button.tagName && button.tagName.toLowerCase() === "a") {
      button.removeAttribute("href");
    }

    button.style.pointerEvents = "auto";
    button.style.opacity = "0.45";
    button.style.cursor = "not-allowed";

    button.dataset.konturStockDisabled = "1";
  }

  function blockDisabledCartClick(event) {
    const target = event.target;

    if (isCloseControl(target)) {
      suppressUpdates(1200);
      return;
    }

    if (!target || !target.closest) return;

    const button = target.closest("[data-kontur-stock-button='1']");

    if (!button) return;

    if (button.dataset.konturStockDisabled !== "1") return;

    event.preventDefault();
    event.stopPropagation();

    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }

    return false;
  }

  function setStatus(statusEl, available, isUnknown) {
    if (isUnknown) {
      statusEl.textContent = "";
      statusEl.style.display = "none";
      statusEl.style.color = "#777";
      return;
    }

    if (available) {
      statusEl.textContent = "";
      statusEl.style.display = "none";
      return;
    }

    statusEl.textContent = STATUS_NOT_AVAILABLE;
    statusEl.style.display = "block";
    statusEl.style.color = "#b3261e";
  }

  function getCachedStock(sku) {
    const cached = cache.get(sku);

    if (!cached) return null;

    if (Date.now() - cached.savedAt > CLIENT_CACHE_TTL_MS) {
      cache.delete(sku);
      return null;
    }

    return cached.value;
  }

  function setCachedStock(sku, value) {
    cache.set(sku, {
      savedAt: Date.now(),
      value: value,
    });
  }

  function fetchStock(sku) {
    const cached = getCachedStock(sku);

    if (cached) {
      return Promise.resolve(cached);
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

        setCachedStock(sku, result);
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
    if (isSuppressed()) return;

    if (updateInProgress) {
      rerunRequested = true;
      return;
    }

    updateInProgress = true;

    try {
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

      if (
        sku === lastAppliedSku &&
        statusEl.dataset.loaded === "1" &&
        lastAppliedAvailable !== null
      ) {
        setStatus(statusEl, lastAppliedAvailable, false);
        setCartButtonAvailability(article.element, lastAppliedAvailable);
        return;
      }

      statusEl.dataset.sku = sku;
      statusEl.dataset.loaded = "0";
      statusEl.textContent = "";
      statusEl.style.display = "none";
      statusEl.style.color = "#777";

      const item = await fetchStock(sku);

      if (!isCurrentInstance()) return;

      const available = Boolean(item.available);

      statusEl.dataset.loaded = "1";
      statusEl.dataset.available = available ? "1" : "0";

      lastAppliedSku = sku;
      lastAppliedAvailable = available;

      setStatus(statusEl, available, false);
      setCartButtonAvailability(article.element, available);
    } catch (error) {
      console.warn("[Kontur stock] Ошибка проверки остатка:", error);

      const article = findBestArticleElement();

      if (!article) return;

      const statusEl = ensureStatusElement(article.element);

      statusEl.dataset.loaded = "0";
      statusEl.dataset.available = "1";

      setStatus(statusEl, true, true);
      setCartButtonAvailability(article.element, true);
    } finally {
      updateInProgress = false;

      if (rerunRequested && !isSuppressed()) {
        rerunRequested = false;
        setTimeout(updateStockSafe, 300);
      }
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
    if (isSuppressed()) return;

    if (!isProductUrl()) {
      removeAllStatuses();
      return;
    }

    setTimeout(updateStockSafe, 200);
    setTimeout(updateStockSafe, 900);
  }

  function debounce(fn, delay) {
    let timer = null;

    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, delay);
    };
  }

  const debouncedUpdate = debounce(updateStockSafe, 500);

  function shouldScheduleFromUserEvent(event) {
    const target = event.target;

    if (!isProductUrl()) return false;
    if (isSuppressed()) return false;

    if (isCloseControl(target)) {
      suppressUpdates(1200);
      return false;
    }

    if (!target || !target.closest) return false;

    if (target.closest("[data-kontur-stock-button='1']")) {
      return false;
    }

    const clickable = target.closest("a, button, label, div, span");

    if (!clickable) return false;

    const text = getCleanText(clickable);

    if (
      text === "S" ||
      text === "M" ||
      text === "L" ||
      text === "XL" ||
      text === "XXL" ||
      text === "XXXL"
    ) {
      return true;
    }

    if (
      text.includes("Размер") ||
      text.includes("Цвет") ||
      text.includes("Материал")
    ) {
      return true;
    }

    return Boolean(
      target.closest(".t-product__option") ||
      target.closest(".t-product__option-item") ||
      target.closest(".t-store__prod-popup__option") ||
      target.closest(".js-product-option-name") ||
      target.closest(".t-img-select__control") ||
      target.closest("[data-product-option]")
    );
  }

  function watchUrlChanges() {
    setInterval(function () {
      if (!isCurrentInstance()) return;

      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        lastAppliedSku = "";
        lastAppliedAvailable = null;

        if (!isProductUrl()) {
          removeAllStatuses();
          return;
        }

        scheduleUpdate();
      }
    }, 700);

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function () {
      originalPushState.apply(this, arguments);
      lastAppliedSku = "";
      lastAppliedAvailable = null;
      scheduleUpdate();
    };

    history.replaceState = function () {
      originalReplaceState.apply(this, arguments);
      lastAppliedSku = "";
      lastAppliedAvailable = null;
      scheduleUpdate();
    };

    window.addEventListener("popstate", scheduleUpdate);
    window.addEventListener("hashchange", scheduleUpdate);
  }

  function initKonturStock() {
    if (!isProductUrl()) {
      removeAllStatuses();
    } else {
      scheduleUpdate();
    }

    watchUrlChanges();

    document.addEventListener("click", blockDisabledCartClick, true);

    document.body.addEventListener("click", function (event) {
      if (!shouldScheduleFromUserEvent(event)) {
        return;
      }

      lastAppliedSku = "";
      lastAppliedAvailable = null;
      scheduleUpdate();
    });

    document.body.addEventListener("change", function () {
      if (!isProductUrl() || isSuppressed()) {
        return;
      }

      lastAppliedSku = "";
      lastAppliedAvailable = null;
      scheduleUpdate();
    });

    const observer = new MutationObserver(function () {
      if (isSuppressed()) {
        return;
      }

      if (!isProductUrl()) {
        if (lastAppliedSku || document.querySelector("." + STATUS_CLASS)) {
          removeAllStatuses();
        }

        return;
      }

      debouncedUpdate();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    window.KonturStock = {
      update: updateStockSafe,
      apiUrl: STOCK_API_URL,
      debug: function () {
        const article = findBestArticleElement();
        const button = article ? findCartButton(article.element) : null;

        return {
          href: window.location.href,
          isProductUrl: isProductUrl(),
          lastAppliedSku: lastAppliedSku,
          lastAppliedAvailable: lastAppliedAvailable,
          updateInProgress: updateInProgress,
          suppressed: isSuppressed(),
          article: article
            ? {
                sku: article.sku,
                text: article.text,
                area: article.area,
              }
            : null,
          button: button
            ? {
                text: getCleanText(button),
                disabled: button.disabled === true,
                ariaDisabled: button.getAttribute("aria-disabled"),
                stockDisabled: button.dataset.konturStockDisabled,
                href: button.getAttribute("href"),
              }
            : null,
          statuses: Array.from(document.querySelectorAll("." + STATUS_CLASS)).map(function (el) {
            return {
              text: normalizeText(el.textContent),
              sku: el.dataset.sku,
              loaded: el.dataset.loaded,
              available: el.dataset.available,
              visible: el.style.display !== "none",
              parentText: getCleanText(el.parentElement).slice(0, 200),
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