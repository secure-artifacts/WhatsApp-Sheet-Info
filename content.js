/** Filter page console by: [WA-Sheet] */
const LOG_PREFIX = "[WA-Sheet]";
function cLog(scope, message, data) {
  if (data !== undefined) console.log(LOG_PREFIX, scope, message, data);
  else console.log(LOG_PREFIX, scope, message);
}
function cWarn(scope, message, data) {
  if (data !== undefined) console.warn(LOG_PREFIX, scope, message, data);
  else console.warn(LOG_PREFIX, scope, message);
}
function cError(scope, error, extra) {
  console.error(LOG_PREFIX, scope, {
    message: error?.message || String(error),
    name: error?.name,
    stack: error?.stack,
    ...extra
  });
}

let lastContact = "";
let timer;
let tagsTimer;
let tagObserver;
let rowIntersectionObserver;
let applyingTags = false;
let activeSheetTags = {
  phone: "",
  title: "",
  tags: [],
  nameColor: "",
  tagPlacement: "message"
};
/** phone → { tags, nameColor, tagPlacement } */
let visualMap = {};
let titlePhoneMap = {};
/** title → visual：滚动回来时同步命中，避免先空白再闪 */
const titleVisualCache = new Map();

const RECENT_MESSAGE_LIMIT = 30;
const TAG_CLASS = "wa-sheet-info-tag";
const TAGS_WRAP = "wa-sheet-info-tags";
const STYLE_ID = "wa-sheet-info-style";
const PREFERRED_KEYS = ["phoneNumber", "pnJid", "wid", "jid", "chatId", "contact", "chat", "id"];
const reactKeyCache = new WeakMap();
const rowPhoneCache = new WeakMap();
const observedRows = new WeakSet();

function normalizePhoneDigits(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .replace(/^00/, "")
    .replace(/^225(?:01|05|07)(?=\d{8}$)/, "225");
}

function extractContact() {
  const title = document.querySelector("#main header span[title]")?.title?.trim() || "";
  const numberInTitle = title.match(/\+?[\d\s()-]{7,}/)?.[0];
  if (numberInTitle) return { phone: numberInTitle, title, source: "header" };

  const main = document.querySelector("#main");
  if (!main) return { phone: "", title };

  const messages = main.querySelectorAll("[data-id]");
  const start = Math.max(0, messages.length - RECENT_MESSAGE_LIMIT);
  let messagePhone = "";
  for (let i = messages.length - 1; i >= start; i--) {
    const id = messages[i].getAttribute("data-id") || "";
    if (/@g\.us/i.test(id)) return { phone: "", title, source: "group", isGroup: true };
    if (!messagePhone) {
      messagePhone = id.match(/(\d{7,15})@(?:c\.us|s\.whatsapp\.net)/)?.[1] || "";
    }
  }

  if (messagePhone) return { phone: messagePhone, title, source: "message" };
  return { phone: "", title };
}

let mainWorldContact = null;

function publishContact(force = false) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const domContact = extractContact();
    const contact = domContact.isGroup || domContact.phone ? domContact : (mainWorldContact || domContact);
    const key = `${contact.phone || ""}|${contact.title || ""}|${contact.isGroup || false}`;
    if (force || key !== lastContact) {
      lastContact = key;
      cLog("contact", "changed", {
        phone: contact.phone || "",
        title: contact.title || "",
        source: contact.source || "",
        isGroup: Boolean(contact.isGroup),
        from: domContact.phone ? "dom" : (mainWorldContact ? "main-world" : "empty")
      });
      if (!chrome.runtime?.id) {
        cWarn("contact", "extension context invalidated, skip sendMessage");
        return;
      }
      try {
        chrome.runtime.sendMessage({ type: "contact-changed", contact }).catch(error => {
          cError("contact/sendMessage", error);
        });
      } catch (error) {
        cError("contact/sendMessage", error);
      }
    }
    scheduleApplyTags();
  }, 250);
}

function injectTagStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${TAGS_WRAP} {
      display: inline-flex !important;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      margin-right: 4px;
      max-width: 100%;
      vertical-align: middle;
      flex: 1 1 auto;
      min-width: 0;
    }
    .${TAGS_WRAP}--header,
    .${TAGS_WRAP}--name {
      margin-left: 6px;
      margin-right: 0;
      flex: 0 1 auto;
      max-width: min(280px, 70%);
    }
    .${TAG_CLASS} {
      display: inline-flex !important;
      align-items: center;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 11px !important;
      font-weight: 600 !important;
      line-height: 1.4 !important;
      color: #fff !important;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
      max-width: 100%;
      flex: 0 1 auto;
      pointer-events: none;
    }
    /* Prefer full tag text over last-message preview. */
    [data-testid="last-msg-status"]:has(.${TAGS_WRAP}) > span[dir],
    [data-testid="last-msg-status"]:has(.${TAGS_WRAP}) > span:not(.${TAGS_WRAP}):not(:has(svg)) {
      display: none !important;
    }
    [data-testid="last-msg-status"]:has(.${TAGS_WRAP}) {
      align-items: center !important;
      flex-wrap: wrap !important;
      max-width: 100% !important;
      overflow: visible !important;
    }
  `;
  (document.head || document.documentElement).append(style);
}

function restorePreview(root = document) {
  root.querySelectorAll?.("[data-wa-sheet-hidden-preview]").forEach(node => {
    node.style.removeProperty("display");
    node.removeAttribute("data-wa-sheet-hidden-preview");
  });
}

function removeInjectedTags() {
  document.querySelectorAll(`.${TAGS_WRAP}`).forEach(node => node.remove());
  restorePreview(document);
}

function tagsSignature(tags) {
  return (tags || []).map(item => `${item.text}\u0001${item.color || ""}`).join("\u0002");
}

function hideMessagePreview(lastMsg) {
  for (const child of [...lastMsg.children]) {
    if (child.querySelector?.("svg")) continue;
    if (child.classList?.contains(TAGS_WRAP)) continue;
    if (child.matches?.("span, div")) {
      child.style.setProperty("display", "none", "important");
      child.setAttribute("data-wa-sheet-hidden-preview", "1");
    }
  }
}

function isOurMutation(mutations) {
  return mutations.every(mutation => {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (!nodes.length && mutation.target?.closest?.(`.${TAGS_WRAP}`)) return true;
    return nodes.every(node => {
      if (node.nodeType !== 1) return false;
      return node.classList?.contains(TAGS_WRAP)
        || node.classList?.contains(TAG_CLASS)
        || node.closest?.(`.${TAGS_WRAP}`)
        || node.hasAttribute?.("data-wa-sheet-hidden-preview");
    });
  });
}

function phonesMatch(a, b) {
  const left = normalizePhoneDigits(a);
  const right = normalizePhoneDigits(b);
  if (!left || !right) return false;
  return left === right || left.endsWith(right) || right.endsWith(left);
}

function emptyVisual() {
  return { tags: [], nameColor: "", tagPlacement: "message" };
}

function normalizeVisual(value) {
  if (!value) return emptyVisual();
  if (Array.isArray(value)) {
    return { tags: value.filter(item => item?.text), nameColor: "", tagPlacement: "message" };
  }
  return {
    tags: Array.isArray(value.tags) ? value.tags.filter(item => item?.text) : [],
    nameColor: value.nameColor || "",
    tagPlacement: value.tagPlacement === "name" ? "name" : "message"
  };
}

function visualHasSignal(visual) {
  return Boolean(visual?.tags?.length || visual?.nameColor);
}

function lookupVisual(phone, title) {
  const normalized = normalizePhoneDigits(phone);
  if (normalized && visualMap[normalized] && visualHasSignal(visualMap[normalized])) {
    return visualMap[normalized];
  }
  if (normalized) {
    for (const [key, visual] of Object.entries(visualMap)) {
      if (phonesMatch(key, normalized) && visualHasSignal(visual)) return visual;
    }
  }

  const name = String(title || "").trim();
  if (name) {
    const cached = titleVisualCache.get(name) || titleVisualCache.get(name.toLowerCase());
    if (cached && visualHasSignal(cached)) return cached;
  }
  if (name && titlePhoneMap[name]) return lookupVisual(titlePhoneMap[name], "");
  if (name) {
    const lower = name.toLowerCase();
    for (const [key, phoneValue] of Object.entries(titlePhoneMap)) {
      if (key.toLowerCase() === lower) return lookupVisual(phoneValue, "");
    }
  }
  return emptyVisual();
}

function lookupTags(phone, title) {
  return lookupVisual(phone, title).tags;
}

function jidFrom(value) {
  if (typeof value === "string") {
    return value.match(/\d{6,18}@(c\.us|s\.whatsapp\.net|lid|g\.us)/i)?.[0] || "";
  }
  if (!value || typeof value !== "object") return "";
  const serialized = value._serialized || value.serialized;
  if (typeof serialized === "string") return jidFrom(serialized);
  if (value.user && value.server) return jidFrom(`${value.user}@${value.server}`);
  return "";
}

function collectJids(value, output, seen, depth = 0, budget = { count: 0 }) {
  if (!value || depth > 3 || budget.count++ > 160) return;
  try {
    const direct = jidFrom(value);
    if (direct) output.add(direct);
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of PREFERRED_KEYS) {
      if (key in value) collectJids(value[key], output, seen, depth + 1, budget);
    }
    if ([...output].some(jid => /@(c\.us|s\.whatsapp\.net)$/i.test(jid))) return;
    for (const key of Object.keys(value)) {
      if (!PREFERRED_KEYS.includes(key)) {
        collectJids(value[key], output, seen, depth + 1, budget);
        if ([...output].some(jid => /@(c\.us|s\.whatsapp\.net)$/i.test(jid))) return;
      }
    }
  } catch {}
}

function reactKeys(element) {
  const cached = reactKeyCache.get(element);
  if (cached) return cached;
  let fiberKey = "";
  let propsKey = "";
  for (const key of Object.getOwnPropertyNames(element || {})) {
    if (!fiberKey && (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"))) {
      fiberKey = key;
    } else if (!propsKey && key.startsWith("__reactProps$")) {
      propsKey = key;
    }
    if (fiberKey && propsKey) break;
  }
  const keys = { fiberKey, propsKey };
  if (element) reactKeyCache.set(element, keys);
  return keys;
}

function phoneFromElement(element) {
  if (!element) return "";
  const jids = new Set();
  const seen = new WeakSet();
  const { fiberKey, propsKey } = reactKeys(element);
  if (propsKey) collectJids(element[propsKey], jids, seen);
  let fiber = fiberKey ? element[fiberKey] : null;
  for (let step = 0; fiber && step < 14; step++, fiber = fiber.return) {
    collectJids(fiber.memoizedProps, jids, seen);
    collectJids(fiber.memoizedState, jids, seen);
    const phoneJid = [...jids].find(jid => /@(c\.us|s\.whatsapp\.net)$/i.test(jid));
    if (phoneJid) return phoneJid.split("@")[0];
  }
  const phoneJid = [...jids].find(jid => /@(c\.us|s\.whatsapp\.net)$/i.test(jid));
  return phoneJid ? phoneJid.split("@")[0] : "";
}

function findChatListRows() {
  const rows = new Set();
  document.querySelectorAll(
    '#pane-side [data-testid="cell-frame-container"], #pane-side [data-testid="list-item-"], #pane-side [role="listitem"]'
  ).forEach(row => rows.add(row));
  // Fallback: any node that has both title + last message preview.
  document.querySelectorAll('#pane-side [data-testid="cell-frame-title"]').forEach(title => {
    const row = title.closest('[data-testid="cell-frame-container"]')
      || title.closest('[role="listitem"]')
      || title.parentElement?.parentElement?.parentElement;
    if (row) rows.add(row);
  });
  return [...rows];
}

function rowTitle(row) {
  const span = row.querySelector(
    '[data-testid="cell-frame-title"] span[title], [data-testid="cell-frame-title"] span[dir="auto"], span[title]'
  );
  return (span?.getAttribute("title") || span?.textContent || "").trim();
}

function extractPhoneFromRow(row) {
  if (rowPhoneCache.has(row)) return rowPhoneCache.get(row);

  const title = rowTitle(row);
  const fromTitle = title.match(/\+?[\d\s()-]{7,}/)?.[0];
  if (fromTitle) {
    const phone = normalizePhoneDigits(fromTitle);
    rowPhoneCache.set(row, phone);
    return phone;
  }

  const mapped = phoneFromTitleMap(title);
  if (mapped) {
    rowPhoneCache.set(row, mapped);
    return mapped;
  }

  const candidates = [
    row,
    row.querySelector('[data-testid="cell-frame-container"]'),
    row.querySelector('[data-testid="cell-frame-title"]'),
    row.querySelector("img"),
    row.querySelector("[role=button]")
  ].filter(Boolean);

  for (const el of candidates) {
    const phone = phoneFromElement(el);
    if (phone) {
      const normalized = normalizePhoneDigits(phone);
      rowPhoneCache.set(row, normalized);
      return normalized;
    }
  }
  rowPhoneCache.set(row, "");
  return "";
}

function createTagWrap(tags, variant = "") {
  const wrap = document.createElement("span");
  wrap.className = variant ? `${TAGS_WRAP} ${TAGS_WRAP}--${variant}` : TAGS_WRAP;
  wrap.setAttribute("data-wa-sheet-tags", "1");
  for (const item of tags) {
    const tag = document.createElement("span");
    tag.className = TAG_CLASS;
    tag.textContent = item.text;
    tag.title = item.text;
    tag.style.background = item.color || "#00a884";
    wrap.append(tag);
  }
  return wrap;
}

function rowTitleSpan(row) {
  return row.querySelector(
    '[data-testid="cell-frame-title"] span[title], [data-testid="cell-frame-title"] span[dir="auto"], span[title]'
  );
}

function applyNameColorToSpan(span, color) {
  if (!span) return;
  if (color) {
    span.style.setProperty("color", color, "important");
    span.dataset.waSheetNameColor = color;
  } else if (span.dataset.waSheetNameColor) {
    span.style.removeProperty("color");
    delete span.dataset.waSheetNameColor;
  }
}

function clearNameSideTags(row) {
  const titleSpan = rowTitleSpan(row);
  const parent = titleSpan?.parentElement;
  parent?.querySelectorAll(`.${TAGS_WRAP}`).forEach(node => node.remove());
  if (titleSpan?.nextElementSibling?.classList?.contains(TAGS_WRAP)) {
    titleSpan.nextElementSibling.remove();
  }
}

function insertTagsAfterName(row, tags) {
  const titleSpan = rowTitleSpan(row);
  if (!titleSpan) return false;
  const signature = tagsSignature(tags);
  const existing = titleSpan.parentElement?.querySelector(`.${TAGS_WRAP}`)
    || (titleSpan.nextElementSibling?.classList?.contains(TAGS_WRAP)
      ? titleSpan.nextElementSibling
      : null);
  if (existing?.dataset.waSheetSig === signature) return true;
  const wrap = createTagWrap(tags, "name");
  wrap.dataset.waSheetSig = signature;
  if (existing) existing.replaceWith(wrap);
  else titleSpan.insertAdjacentElement("afterend", wrap);
  return true;
}

function insertTagsInLastMessage(row, tags) {
  const lastMsg = row.querySelector('[data-testid="last-msg-status"]');
  if (!lastMsg) {
    requestAnimationFrame(() => {
      if (row.isConnected) insertTagsInLastMessage(row, tags);
    });
    return false;
  }

  const signature = tagsSignature(tags);
  const existing = lastMsg.querySelector(`.${TAGS_WRAP}`);
  if (existing?.dataset.waSheetSig === signature) {
    hideMessagePreview(lastMsg);
    return true;
  }

  const wrap = createTagWrap(tags);
  wrap.dataset.waSheetSig = signature;
  hideMessagePreview(lastMsg);
  if (existing) {
    existing.replaceWith(wrap);
    return true;
  }

  const icon = [...lastMsg.children].find(node => node.querySelector?.("svg"));
  if (icon?.nextSibling) lastMsg.insertBefore(wrap, icon.nextSibling);
  else if (icon) icon.insertAdjacentElement("afterend", wrap);
  else lastMsg.prepend(wrap);
  return true;
}

function clearRowTags(row) {
  const lastMsg = row.querySelector('[data-testid="last-msg-status"]');
  if (lastMsg) {
    const existing = lastMsg.querySelector(`.${TAGS_WRAP}`);
    if (existing) {
      existing.remove();
      restorePreview(lastMsg);
    }
  }
  clearNameSideTags(row);
}

function applyRowVisual(row, visual) {
  const titleSpan = rowTitleSpan(row);
  applyNameColorToSpan(titleSpan, visual.nameColor || "");

  // Always clear both placements first for this row, then put tags in the chosen place.
  const lastMsg = row.querySelector('[data-testid="last-msg-status"]');
  if (lastMsg?.querySelector(`.${TAGS_WRAP}`)) {
    lastMsg.querySelector(`.${TAGS_WRAP}`).remove();
    restorePreview(lastMsg);
  }
  clearNameSideTags(row);

  if (!visual.tags?.length) return;
  if (visual.tagPlacement === "name") insertTagsAfterName(row, visual.tags);
  else insertTagsInLastMessage(row, visual.tags);
}

function applyHeaderVisual() {
  const header = document.querySelector(
    '#main header, [data-testid="conversation-header"]'
  );
  if (!header) return;
  const titleSpan = [...header.querySelectorAll('span[title], span[dir="auto"]')]
    .map(span => ({
      span,
      label: (span.getAttribute("title") || span.textContent || "").trim()
    }))
    .find(({ label }) => label && label.length <= 80 && !/^(online|typing|last seen|en ligne|écrit)/i.test(label));
  if (!titleSpan) return;

  const phone = normalizePhoneDigits(activeSheetTags.phone)
    || phoneFromElement(header)
    || phoneFromElement(titleSpan.span);
  const visual = visualHasSignal(activeSheetTags)
    ? normalizeVisual(activeSheetTags)
    : lookupVisual(phone, titleSpan.label);

  applyNameColorToSpan(titleSpan.span, visual.nameColor || "");

  const parent = titleSpan.span.parentElement;
  const existing = parent?.querySelector(`.${TAGS_WRAP}`)
    || (titleSpan.span.nextElementSibling?.classList?.contains(TAGS_WRAP)
      ? titleSpan.span.nextElementSibling
      : null);

  if (!visual.tags?.length) {
    existing?.remove();
    return;
  }

  // Header always shows badge beside the name (roomier than list).
  const signature = tagsSignature(visual.tags);
  if (existing?.dataset.waSheetSig === signature) return;
  const wrap = createTagWrap(visual.tags, "header");
  wrap.dataset.waSheetSig = signature;
  if (existing) existing.replaceWith(wrap);
  else titleSpan.span.insertAdjacentElement("afterend", wrap);
}

function phoneFromTitleMap(title) {
  const name = String(title || "").trim();
  if (!name) return "";
  if (titlePhoneMap[name]) return normalizePhoneDigits(titlePhoneMap[name]);
  const lower = name.toLowerCase();
  for (const [key, phoneValue] of Object.entries(titlePhoneMap)) {
    if (key.toLowerCase() === lower) return normalizePhoneDigits(phoneValue);
  }
  return "";
}

function rememberTitleVisual(title, visual) {
  const name = String(title || "").trim();
  if (!name || !visualHasSignal(visual)) return;
  titleVisualCache.set(name, visual);
  titleVisualCache.set(name.toLowerCase(), visual);
}

let titlePhonePersistTimer;
function persistTitlePhonesSoon() {
  clearTimeout(titlePhonePersistTimer);
  titlePhonePersistTimer = setTimeout(() => {
    try {
      chrome.storage.local.set({ waSheetTitlePhones: titlePhoneMap });
    } catch {}
  }, 800);
}

function rememberTitlePhone(title, phone) {
  const name = String(title || "").trim();
  const n = normalizePhoneDigits(phone);
  if (!name || !n || name.length > 80) return;
  if (titlePhoneMap[name] === n) return;
  titlePhoneMap[name] = n;
  persistTitlePhonesSoon();
}

function resolveRowVisual(row, hasMap, hasCurrent) {
  const title = rowTitle(row);

  if (title) {
    const cached = titleVisualCache.get(title) || titleVisualCache.get(title.toLowerCase());
    if (cached && visualHasSignal(cached)) return cached;
  }

  // For watch-list map: always try to resolve phone from the row (no need to open chat).
  let phone = "";
  if (hasMap) {
    phone = extractPhoneFromRow(row) || phoneFromTitleMap(title);
  } else {
    phone = phoneFromTitleMap(title);
  }

  if (!phone && hasCurrent) {
    if (activeSheetTags.title && title === activeSheetTags.title) {
      phone = normalizePhoneDigits(activeSheetTags.phone);
    } else if (activeSheetTags.phone && phonesMatch(title, activeSheetTags.phone)) {
      phone = normalizePhoneDigits(activeSheetTags.phone);
    }
  }

  // Phone shown in title (unsaved contacts).
  if (!phone && title) {
    const m = title.match(/\+?\d[\d\s()-]{6,}\d/);
    if (m) phone = normalizePhoneDigits(m[0]);
  }

  let visual = emptyVisual();
  if (visualHasSignal(activeSheetTags) && (
    (activeSheetTags.title && title === activeSheetTags.title)
    || (activeSheetTags.phone && phonesMatch(phone, activeSheetTags.phone))
  )) {
    visual = normalizeVisual(activeSheetTags);
  } else if (phone || title) {
    visual = lookupVisual(phone, title);
  }

  // Only inject for people we already queried (watch map / current). Non-watch stay empty until opened.
  if (visualHasSignal(visual)) {
    rememberTitleVisual(title, visual);
    if (phone && title) rememberTitlePhone(title, phone);
  }
  return visual;
}

function focusFlags() {
  return {
    hasMap: Object.keys(visualMap).length > 0,
    hasCurrent: Boolean(
      activeSheetTags.tags?.length
      || activeSheetTags.nameColor
      || activeSheetTags.phone
      || activeSheetTags.title
    )
  };
}

function ensureRowsTagged(rows) {
  if (!rows?.length || applyingTags) return;
  applyingTags = true;
  try {
    const { hasMap, hasCurrent } = focusFlags();
    if (!hasMap && !hasCurrent) return;
    injectTagStyles();
    for (const row of rows) {
      if (!row?.isConnected) continue;
      watchRow(row);
      applyRowVisual(row, resolveRowVisual(row, hasMap, hasCurrent));
    }
  } finally {
    applyingTags = false;
  }
}

function applyWhatsAppTags() {
  if (applyingTags) return;
  applyingTags = true;
  try {
    const { hasMap, hasCurrent } = focusFlags();
    if (!hasMap && !hasCurrent) {
      removeInjectedTags();
      document.querySelectorAll("[data-wa-sheet-name-color]").forEach(span => {
        span.style.removeProperty("color");
        delete span.dataset.waSheetNameColor;
      });
      titleVisualCache.clear();
      return;
    }
    injectTagStyles();

    for (const row of findChatListRows()) {
      watchRow(row);
      applyRowVisual(row, resolveRowVisual(row, hasMap, hasCurrent));
    }

    applyHeaderVisual();
  } finally {
    applyingTags = false;
  }
}

function scheduleApplyTags() {
  if (applyingTags) return;
  clearTimeout(tagsTimer);
  // Soft full sweep only as backup; new rows are handled immediately.
  tagsTimer = setTimeout(applyWhatsAppTags, 300);
}

function collectAddedRows(mutations) {
  const rows = new Set();
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.classList?.contains(TAGS_WRAP) || node.classList?.contains(TAG_CLASS)) continue;
      if (
        node.matches?.('[data-testid="cell-frame-container"], [data-testid="list-item-"], [role="listitem"]')
      ) {
        rows.add(node);
      }
      node.querySelectorAll?.(
        '[data-testid="cell-frame-container"], [data-testid="cell-frame-title"]'
      ).forEach(el => {
        const row = el.matches?.('[data-testid="cell-frame-container"]')
          ? el
          : el.closest?.('[data-testid="cell-frame-container"], [role="listitem"]');
        if (row) rows.add(row);
      });
    }
  }
  return [...rows];
}

function ensureRowIntersectionObserver() {
  if (rowIntersectionObserver) return rowIntersectionObserver;
  const root = document.querySelector("#pane-side") || null;
  rowIntersectionObserver = new IntersectionObserver(
    entries => {
      if (applyingTags) return;
      const rows = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const row = entry.target.closest?.(
          '[data-testid="cell-frame-container"], [role="listitem"]'
        ) || entry.target;
        if (row) rows.push(row);
      }
      if (rows.length) ensureRowsTagged(rows);
    },
    {
      root,
      // Prefetch slightly before the row enters the viewport.
      rootMargin: "180px 0px",
      threshold: 0
    }
  );
  return rowIntersectionObserver;
}

function watchRow(row) {
  if (!row || observedRows.has(row)) return;
  observedRows.add(row);
  try {
    ensureRowIntersectionObserver().observe(row);
  } catch {}
}

function setSheetTags(payload) {
  activeSheetTags = {
    phone: payload?.phone || "",
    title: payload?.title || "",
    tags: Array.isArray(payload?.tags) ? payload.tags.filter(item => item?.text) : [],
    nameColor: payload?.nameColor || "",
    tagPlacement: payload?.tagPlacement === "name" ? "name" : "message"
  };
  cLog("tags", "setSheetTags", {
    phone: activeSheetTags.phone,
    title: activeSheetTags.title,
    tagCount: activeSheetTags.tags.length,
    nameColor: activeSheetTags.nameColor || "",
    placement: activeSheetTags.tagPlacement
  });
  if (activeSheetTags.title && activeSheetTags.phone) {
    titlePhoneMap[activeSheetTags.title] = normalizePhoneDigits(activeSheetTags.phone);
  }
  if (activeSheetTags.title && visualHasSignal(activeSheetTags)) {
    rememberTitleVisual(activeSheetTags.title, normalizeVisual(activeSheetTags));
  }
  applyWhatsAppTags();
}

function setTagMap(map, titlePhones) {
  if (map && typeof map === "object") {
    const next = {};
    for (const [phone, value] of Object.entries(map)) {
      const key = normalizePhoneDigits(phone);
      if (!key) continue;
      const visual = normalizeVisual(value);
      if (!visualHasSignal(visual)) continue;
      next[key] = visual;
    }
    visualMap = next;
    cLog("tags", "setTagMap", { phones: Object.keys(next).length });
  }
  if (titlePhones && typeof titlePhones === "object") {
    titlePhoneMap = { ...titlePhoneMap, ...titlePhones };
    for (const [title, phone] of Object.entries(titlePhones)) {
      const visual = lookupVisual(phone, title);
      if (visualHasSignal(visual)) rememberTitleVisual(title, visual);
    }
  }
  applyWhatsAppTags();
}

const observedTagRoots = new WeakSet();

function ensureTagObserver() {
  if (!tagObserver) {
    tagObserver = new MutationObserver(mutations => {
      if (applyingTags || isOurMutation(mutations)) return;

      // Immediate: tag rows as soon as WhatsApp inserts them (same turn, less flash).
      const added = collectAddedRows(mutations);
      if (added.length) ensureRowsTagged(added);

      scheduleApplyTags();
    });
  }
  ensureRowIntersectionObserver();
  const roots = [
    document.querySelector("#pane-side"),
    document.querySelector("#main"),
    document.querySelector('[data-testid="chat-list"]'),
    document.querySelector("#app")
  ].filter(Boolean);
  for (const root of roots) {
    if (observedTagRoots.has(root)) continue;
    observedTagRoots.add(root);
    tagObserver.observe(root, {
      childList: true,
      subtree: root.id === "app" ? false : true
    });
  }
  // Rebind IO root if pane-side mounted later.
  findChatListRows().forEach(watchRow);
}

document.addEventListener("wa-sheet-contact", event => {
  mainWorldContact = event.detail;
  publishContact(true);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "get-contact") {
    document.dispatchEvent(new CustomEvent("wa-sheet-request-contact"));
    const domContact = extractContact();
    sendResponse(domContact.isGroup || domContact.phone ? domContact : (mainWorldContact || domContact));
    return false;
  }
  if (message.type === "sheet-tags") {
    setSheetTags(message.payload || {});
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "sheet-tag-map") {
    setTagMap(message.map || {}, message.titlePhones || {});
    sendResponse({ ok: true });
    return false;
  }
});

chrome.storage.local.get(["waSheetTags", "waSheetTagMap", "waSheetTitlePhones"], data => {
  if (data.waSheetTitlePhones) titlePhoneMap = { ...titlePhoneMap, ...data.waSheetTitlePhones };
  if (data.waSheetTagMap) setTagMap(data.waSheetTagMap, data.waSheetTitlePhones);
  if (data.waSheetTags) setSheetTags(data.waSheetTags);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.waSheetTitlePhones?.newValue) {
    titlePhoneMap = { ...titlePhoneMap, ...changes.waSheetTitlePhones.newValue };
  }
  if (changes.waSheetTagMap) {
    setTagMap(changes.waSheetTagMap.newValue || {}, titlePhoneMap);
  }
  if (changes.waSheetTags) {
    setSheetTags(changes.waSheetTags.newValue || {});
  }
});

// MAIN-world list scan: title↔phone without opening each chat.
document.addEventListener("wa-sheet-directory", event => {
  const byTitle = event.detail?.byTitle || {};
  let added = 0;
  for (const [title, phone] of Object.entries(byTitle)) {
    const n = normalizePhoneDigits(phone);
    const name = String(title || "").trim();
    if (!name || !n) continue;
    if (titlePhoneMap[name] === n) continue;
    titlePhoneMap[name] = n;
    const lower = name.toLowerCase();
    titlePhoneMap[lower] = n;
    const norm = normalizePersonNameLocal(name);
    if (norm) titlePhoneMap[norm] = n;
    added += 1;
  }
  if (added) {
    cLog("directory", "merged MAIN list phones", {
      added,
      totalTitles: Object.keys(titlePhoneMap).length,
      scanned: event.detail?.count || 0
    });
    persistTitlePhonesSoon();
    scheduleApplyTags();
  }
});

cLog("boot", "content script loaded", { href: location.href });
document.dispatchEvent(new CustomEvent("wa-sheet-request-contact"));
document.dispatchEvent(new CustomEvent("wa-sheet-request-directory"));
publishContact(true);
ensureTagObserver();
// Keep asking MAIN world to rescan list phones (watch tags without click).
setInterval(() => {
  document.dispatchEvent(new CustomEvent("wa-sheet-request-directory"));
}, 4000);
setInterval(ensureTagObserver, 3000);
// Rare safety net only — main path is immediate mutation + intersection prefetch.
setInterval(() => {
  if (!applyingTags) findChatListRows().forEach(watchRow);
}, 5000);
