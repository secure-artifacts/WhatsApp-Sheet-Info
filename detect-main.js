(() => {
  const EVENT = "wa-sheet-contact";
  const PREFERRED_KEYS = ["phoneNumber", "pnJid", "wid", "jid", "chatId", "contact", "chat", "id"];
  let timer;
  let lastKey = "";
  let observedMain;
  let observedHeader;
  let mainShellObserver;
  let headerObserver;
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

  function hasPhoneJid(jids) {
    for (const jid of jids) {
      if (/@(c\.us|s\.whatsapp\.net)$/i.test(jid)) return true;
    }
    return false;
  }

  function collectJids(value, output, seen, depth = 0, budget = { count: 0 }) {
    if (!value || depth > 3 || budget.count++ > 200) return;
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
    const candidates = typeof model === "object"
      ? [
          model.phoneNumber,
          model.pnJid,
          model.contact?.phoneNumber,
          model.contact?.pnJid,
          model.contact?.id,
          model.contact?.wid,
          model.id,
          model.wid
        ]
      : [model];
    return candidates.map(jidFrom).find(jid => /@(c\.us|s\.whatsapp\.net)$/i.test(jid)) || "";
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
    for (let step = 0; fiber && step < 16; step++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      try {
        [
          props?.chat,
          props?.data?.chat,
          props?.contact,
          props?.data?.contact
        ].map(phoneFromModel).filter(Boolean).forEach(jid => direct.add(jid));
      } catch {}
      if (direct.size) return [...direct];
      collectJids(props, output, seen);
      if (hasPhoneJid(output) || [...output].some(jid => /@g\.us$/i.test(jid))) break;
    }
    return [...direct, ...output];
  }

  function headerTitle(header) {
    return [...header.querySelectorAll("span[title], span[dir=auto]")]
      .map(node => (node.getAttribute("title") || node.textContent || "").trim())
      .find(text => text && !/^(online|typing|last seen)/i.test(text)) || "";
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
      header.querySelector("[role=button]")
    ].filter(Boolean);
    const jids = elements.flatMap(reactJids);
    if (jids.some(jid => /@g\.us$/i.test(jid))) {
      return { phone: "", title, source: "group", isGroup: true };
    }

    const phoneJid = jids.find(jid => /@(c\.us|s\.whatsapp\.net)$/i.test(jid));
    return {
      phone: phoneJid?.split("@")[0] || "",
      title,
      source: phoneJid ? "react" : (jids.some(jid => /@lid$/i.test(jid)) ? "lid-only" : "not-found")
    };
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
      // Only direct children: chat switches replace header/panel, not every message bubble.
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

  function scheduleAttach() {
    clearTimeout(attachTimer);
    attachTimer = setTimeout(attachMainObserver, 100);
  }

  document.addEventListener("wa-sheet-request-contact", () => publish(true));
  attachMainObserver();
  // Fallback if #main is late-mounted; keep light (no message-list observation).
  setInterval(attachMainObserver, 3000);

  const app = document.querySelector("#app");
  if (app) {
    new MutationObserver(scheduleAttach).observe(app, { childList: true, subtree: false });
  }
})();
