(() => {
  const EVENT = "wa-sheet-contact";
  const DIR_EVENT = "wa-sheet-directory";
  const PREFERRED_KEYS = [
    "phoneNumber",
    "pnJid",
    "phone",
    "wid",
    "jid",
    "chatId",
    "contact",
    "chat",
    "id",
    "user"
  ];
  let timer;
  let dirTimer;
  let lastKey = "";
  let lastDirKey = "";
  let observedMain;
  let observedHeader;
  let observedPane;
  let mainShellObserver;
  let headerObserver;
  let paneObserver;
  let attachTimer;
  const reactKeyCache = new WeakMap();

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

  function digitsFrom(value) {
    if (value == null) return "";
    if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
    const text = String(value);
    const jid = jidFrom(text);
    if (jid && /@(c\.us|s\.whatsapp\.net)$/i.test(jid)) return jid.split("@")[0];
    const match = text.match(/\+?\d[\d\s()-]{6,}\d/);
    return match ? match[0].replace(/\D/g, "").replace(/^00/, "") : "";
  }

  function hasPhoneJid(jids) {
    for (const jid of jids) {
      if (/@(c\.us|s\.whatsapp\.net)$/i.test(jid)) return true;
    }
    return false;
  }

  function collectJids(value, output, seen, depth = 0, budget = { count: 0 }) {
    if (!value || depth > 4 || budget.count++ > 260) return;
    try {
      const direct = jidFrom(value);
      if (direct) output.add(direct);
      if (typeof value !== "object" || seen.has(value)) return;
      seen.add(value);

      for (const key of PREFERRED_KEYS) {
        if (key in value) collectJids(value[key], output, seen, depth + 1, budget);
      }
      if (hasPhoneJid(output) || [...output].some(jid => /@g\.us$/i.test(jid))) return;

      for (const key of Object.keys(value)) {
        if (!PREFERRED_KEYS.includes(key)) {
          collectJids(value[key], output, seen, depth + 1, budget);
          if (hasPhoneJid(output)) return;
        }
      }
    } catch {}
  }

  function phoneFromModel(model) {
    if (!model) return "";
    if (typeof model !== "object") return digitsFrom(model);
    const candidates = [
      model.phoneNumber,
      model.pnJid,
      model.phone,
      model.contact?.phoneNumber,
      model.contact?.pnJid,
      model.contact?.phone,
      model.__x_phoneNumber,
      model.contact?.__x_phoneNumber,
      model.id,
      model.wid,
      model.contact?.id,
      model.contact?.wid
    ];
    for (const candidate of candidates) {
      const jid = jidFrom(candidate);
      if (jid && /@(c\.us|s\.whatsapp\.net)$/i.test(jid)) return jid.split("@")[0];
      const digits = digitsFrom(candidate);
      if (digits.length >= 7 && digits.length <= 15) return digits;
    }
    return "";
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

  function reactJids(element) {
    const output = new Set();
    const direct = new Set();
    const seen = new WeakSet();
    const { fiberKey, propsKey } = reactKeys(element);
    if (propsKey) collectJids(element[propsKey], output, seen);

    let fiber = fiberKey ? element[fiberKey] : null;
    for (let step = 0; fiber && step < 18; step++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      try {
        [
          props?.chat,
          props?.data?.chat,
          props?.contact,
          props?.data?.contact,
          props?.msg?.chat,
          props?.data
        ].map(phoneFromModel).filter(Boolean).forEach(phone => {
          // Store as fake jid for downstream split compatibility
          direct.add(`${phone}@c.us`);
        });
      } catch {}
      if (direct.size) return [...direct];
      collectJids(props, output, seen);
      collectJids(fiber.memoizedState, output, seen);
      if (hasPhoneJid(output) || [...output].some(jid => /@g\.us$/i.test(jid))) break;
    }
    return [...direct, ...output];
  }

  function phoneFromElement(element) {
    const jids = reactJids(element);
    if (jids.some(jid => /@g\.us$/i.test(jid))) return { phone: "", isGroup: true };
    const phoneJid = jids.find(jid => /@(c\.us|s\.whatsapp\.net)$/i.test(jid));
    if (phoneJid) return { phone: phoneJid.split("@")[0], isGroup: false };
    return { phone: "", isGroup: false };
  }

  function headerTitle(header) {
    return [...header.querySelectorAll("span[title], span[dir=auto]")]
      .map(node => (node.getAttribute("title") || node.textContent || "").trim())
      .find(text => text && !/^(online|typing|last seen|en ligne|écrit)/i.test(text)) || "";
  }

  function detect() {
    const header = document.querySelector('[data-testid="conversation-header"], #main header');
    if (!header) return { phone: "", title: "", source: "no-chat" };
    const title = headerTitle(header);

    const visiblePhone = title.match(/\+?[\d\s()-]{7,}/)?.[0];
    if (visiblePhone) return { phone: visiblePhone, title, source: "header" };

    const elements = [
      header,
      header.querySelector("img"),
      header.querySelector("[role=button]"),
      document.querySelector("#main")
    ].filter(Boolean);

    for (const el of elements) {
      const found = phoneFromElement(el);
      if (found.isGroup) return { phone: "", title, source: "group", isGroup: true };
      if (found.phone) return { phone: found.phone, title, source: "react" };
    }

    const jids = elements.flatMap(el => reactJids(el));
    if (jids.some(jid => /@lid$/i.test(jid))) {
      return { phone: "", title, source: "lid-only" };
    }
    return { phone: "", title, source: "not-found" };
  }

  function contactKey(contact) {
    return `${contact.phone || ""}|${contact.title || ""}|${contact.isGroup || false}|${contact.source || ""}`;
  }

  function publish(force = false) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const contact = detect();
      const key = contactKey(contact);
      if (force || key !== lastKey) {
        lastKey = key;
        document.dispatchEvent(new CustomEvent(EVENT, { detail: contact }));
      }
    }, 250);
  }

  function rowTitle(row) {
    const span = row.querySelector(
      '[data-testid="cell-frame-title"] span[title], [data-testid="cell-frame-title"] span[dir=auto]'
    );
    return (span?.getAttribute("title") || span?.textContent || "").trim();
  }

  function phoneFromListRow(row) {
    const title = rowTitle(row);
    const visible = title.match(/\+?[\d\s()-]{7,}/)?.[0];
    if (visible) {
      return {
        title,
        phone: visible.replace(/\D/g, "").replace(/^00/, ""),
        source: "title"
      };
    }

    const els = [
      row,
      row.querySelector('[data-testid="cell-frame-container"]'),
      row.querySelector('[data-testid="cell-frame-title"]'),
      row.querySelector("img"),
      row.querySelector("[role=button]"),
      row.querySelector('[data-testid="cell-frame-primary"]')
    ].filter(Boolean);

    for (const el of els) {
      const found = phoneFromElement(el);
      if (found.isGroup) return { title, phone: "", source: "group" };
      if (found.phone) return { title, phone: found.phone, source: "react" };
    }
    return { title, phone: "", source: "none" };
  }

  /**
   * Scan visible chat list and publish title↔phone directory.
   * This is what lets watch-list tags show without opening each chat.
   */
  function scanDirectory(force = false) {
    clearTimeout(dirTimer);
    dirTimer = setTimeout(() => {
      const byTitle = {};
      const byPhone = {};
      const rows = document.querySelectorAll(
        '#pane-side [data-testid="cell-frame-container"], #pane-side [data-testid="list-item-"]'
      );
      let found = 0;
      for (const row of rows) {
        const { title, phone } = phoneFromListRow(row);
        if (!title || !phone || phone.length < 7) continue;
        byTitle[title] = phone;
        byPhone[phone] = title;
        found += 1;
      }
      const key = `${found}|${Object.keys(byTitle).slice(0, 8).join(",")}`;
      if (!force && key === lastDirKey) return;
      lastDirKey = key;
      if (!found) return;
      document.dispatchEvent(new CustomEvent(DIR_EVENT, {
        detail: { byTitle, byPhone, count: found }
      }));
    }, 200);
  }

  function attachHeaderObserver(header) {
    if (header === observedHeader) return;
    headerObserver?.disconnect();
    observedHeader = header;
    if (!header) return;
    headerObserver = new MutationObserver(() => publish());
    headerObserver.observe(header, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["title", "data-id"]
    });
  }

  function attachMainObserver() {
    const main = document.querySelector("#main");
    const header = document.querySelector('[data-testid="conversation-header"], #main header');
    attachHeaderObserver(header);

    if (main === observedMain) return;
    mainShellObserver?.disconnect();
    observedMain = main;
    if (main) {
      mainShellObserver = new MutationObserver(() => {
        attachHeaderObserver(
          document.querySelector('[data-testid="conversation-header"], #main header')
        );
        publish(true);
      });
      mainShellObserver.observe(main, { childList: true, subtree: false });
    }
    publish(true);
  }

  function attachPaneObserver() {
    const pane = document.querySelector("#pane-side");
    if (!pane || pane === observedPane) {
      scanDirectory();
      return;
    }
    paneObserver?.disconnect();
    observedPane = pane;
    paneObserver = new MutationObserver(() => scanDirectory());
    paneObserver.observe(pane, { childList: true, subtree: true });
    scanDirectory(true);
  }

  function scheduleAttach() {
    clearTimeout(attachTimer);
    attachTimer = setTimeout(() => {
      attachMainObserver();
      attachPaneObserver();
    }, 100);
  }

  document.addEventListener("wa-sheet-request-contact", () => {
    publish(true);
    scanDirectory(true);
  });
  document.addEventListener("wa-sheet-request-directory", () => scanDirectory(true));

  attachMainObserver();
  attachPaneObserver();
  setInterval(() => {
    attachMainObserver();
    attachPaneObserver();
    scanDirectory();
  }, 3000);

  const app = document.querySelector("#app");
  if (app) {
    new MutationObserver(scheduleAttach).observe(app, { childList: true, subtree: false });
  }
})();
