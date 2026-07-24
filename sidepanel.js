import {
  buildPhoneIndex,
  cellText,
  columnIndex,
  columnName,
  columnRanges,
  columnsToText,
  expandColumnRows,
  fallbackTagColor,
  linkHref,
  normalizePhone,
  parseTagColors,
  parseWatchPhones,
  phonesLooselyEqual,
  prepareSource,
  resolveTagColor,
  safeHref,
  sheetApiRows,
  tagColorsToText,
  toColorInputValue
} from "./shared.mjs";

const sourceDefaults = {
  name: "",
  sheetId: "",
  tabName: "",
  phoneColumn: "AA",
  resultColumns: "D=客户等级\nBI=负责人\nBJ=备注",
  editableColumns: "",
  tagColumns: "",
  nameColorColumn: "",
  tagPlacement: "message",
  tagColors: ""
};

const elements = {
  contact: document.querySelector("#contact"),
  contactTags: document.querySelector("#contact-tags"),
  status: document.querySelector("#status"),
  results: document.querySelector("#results"),
  resultsHint: document.querySelector("#results-hint"),
  settings: document.querySelector("#settings"),
  settingsError: document.querySelector("#settings-error"),
  sources: document.querySelector("#sources"),
  sourceTabs: document.querySelector("#source-tabs"),
  template: document.querySelector("#source-template")
};

let config = { watchPhones: "", sources: [{ ...sourceDefaults }] };
let preparedSources = [];
let contact = { phone: "", title: "" };
let lastQueriedPhone = "";
let lastMatch = null;
let activeSourceIndex = 0;
let googleToken = "";
let queryNumber = 0;
let queryController;
let dragColumn = "";
let sourceHitOrder = [];
let persistCacheTimer;
let watchRefreshTimer;
const cachedIndexes = new Map();
const cacheLifetime = 5 * 60 * 1000;
const watchRefreshMs = 2 * 60 * 1000;
const maxCacheEntries = 8;
const PERSIST_CACHE_KEY = "sheetIndexCache";
const HIT_ORDER_KEY = "sourceHitOrder";

function normalizeConfig(value) {
  const watchPhones = String(value?.watchPhones ?? "");
  if (Array.isArray(value?.sources) && value.sources.length) {
    return {
      watchPhones,
      sources: value.sources.map(source => ({ ...sourceDefaults, ...source }))
    };
  }
  if (value?.sheetId || value?.tabName) {
    return { watchPhones, sources: [{ ...sourceDefaults, ...value }] };
  }
  return { watchPhones: "", sources: [{ ...sourceDefaults }] };
}

function syncWatchPhonesField() {
  const input = document.querySelector("#watch-phones");
  if (input) input.value = config.watchPhones || "";
  renderWatchStatus();
}

function readWatchPhonesField() {
  return document.querySelector("#watch-phones")?.value.trim() || "";
}

function normalizeVisual(value) {
  if (!value) return { tags: [], nameColor: "", tagPlacement: "message" };
  if (Array.isArray(value)) {
    return { tags: value, nameColor: "", tagPlacement: "message" };
  }
  return {
    tags: Array.isArray(value.tags) ? value.tags : [],
    nameColor: value.nameColor || "",
    tagPlacement: value.tagPlacement === "name" ? "name" : "message"
  };
}

function tagsForWatchPhone(phone, map = buildTagMapFromCaches()) {
  const direct = map[phone];
  if (direct) return normalizeVisual(direct).tags;
  for (const [key, value] of Object.entries(map)) {
    if (phonesLooselyEqual(key, phone)) return normalizeVisual(value).tags;
  }
  return [];
}

function renderWatchStatus(map = buildTagMapFromCaches()) {
  const root = document.querySelector("#watch-status");
  if (!root) return;

  const phones = parseWatchPhones(readWatchPhonesField() || config.watchPhones);
  if (!phones.length) {
    root.replaceChildren();
    root.classList.add("hidden");
    return;
  }

  root.classList.remove("hidden");
  let foundCount = 0;
  const rows = phones.map(phone => {
    let visual = normalizeVisual(map[phone]);
    if (!visual.tags.length && !visual.nameColor) {
      for (const [key, value] of Object.entries(map)) {
        if (phonesLooselyEqual(key, phone)) {
          visual = normalizeVisual(value);
          break;
        }
      }
    }
    const tags = visual.tags;
    const row = document.createElement("div");
    const found = tags.length > 0 || Boolean(visual.nameColor);
    if (found) foundCount += 1;
    row.className = `watch-status-row ${found ? "found" : "missing"}`;

    const mark = document.createElement("span");
    mark.className = "watch-status-mark";
    mark.textContent = found ? "✓" : "○";
    mark.title = found ? "已在表格中匹配" : "尚未匹配";

    const number = document.createElement("span");
    number.className = "watch-status-phone";
    number.textContent = phone;
    if (visual.nameColor) number.style.color = visual.nameColor;

    const meta = document.createElement("span");
    meta.className = "watch-status-meta";
    meta.textContent = found
      ? (visual.nameColor && !tags.length ? "已查询 · 名字颜色" : "已查询")
      : "未匹配";

    row.append(mark, number, meta);

    if (tags.length) {
      const chips = document.createElement("div");
      chips.className = "watch-status-tags";
      for (const item of tags) {
        const chip = document.createElement("span");
        chip.className = "watch-status-tag";
        chip.textContent = item.text;
        chip.style.background = item.color || "#00a884";
        chips.append(chip);
      }
      row.append(chips);
    }

    return row;
  });

  const summary = document.createElement("p");
  summary.className = "watch-status-summary";
  summary.textContent = `进度：已匹配 ${foundCount}/${phones.length}`
    + (foundCount < phones.length ? "（○ 未匹配：可点「查询新增」或「全部重查」）" : "");

  root.replaceChildren(summary, ...rows);
}

function rebuildPreparedSources() {
  preparedSources = [];
  config.sources.forEach((source, index) => {
    if (!source.sheetId || !source.tabName) return;
    try {
      // Soft-load optional fields so a bad value does not drop the whole table.
      preparedSources.push({
        ...prepareSource(source, index, { strictOptional: false }),
        configIndex: index
      });
    } catch {}
  });
}

function showView(viewId) {
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("hidden", view.id !== viewId));
  document.querySelectorAll(".tab").forEach(tab => {
    const active = tab.dataset.view === viewId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
}

function sourceLabel(sourceOrName, index) {
  const name = typeof sourceOrName === "string"
    ? sourceOrName
    : (sourceOrName?.name ?? "");
  const trimmed = String(name || "").trim();
  return trimmed || `表格 ${index + 1}`;
}

function editorSourceName(editor) {
  return editor.querySelector('[data-field="name"]')?.value.trim() || "";
}

function updateSourceNavigation() {
  const editors = [...elements.sources.querySelectorAll(".source-editor")];
  activeSourceIndex = Math.max(0, Math.min(activeSourceIndex, editors.length - 1));

  editors.forEach((editor, index) => {
    const label = sourceLabel(editorSourceName(editor), index);
    editor.querySelector(".source-title").textContent = label;
    editor.querySelector(".remove-source").disabled = editors.length === 1;
    editor.classList.toggle("hidden", index !== activeSourceIndex);
  });

  elements.sourceTabs.replaceChildren(...editors.map((editor, index) => {
    const tab = document.createElement("button");
    const active = index === activeSourceIndex;
    const label = sourceLabel(editorSourceName(editor), index);
    tab.type = "button";
    tab.className = `source-tab${active ? " active" : ""}`;
    tab.textContent = label;
    tab.title = label;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(active));
    tab.addEventListener("click", () => {
      activeSourceIndex = index;
      updateSourceNavigation();
    });
    return tab;
  }));
}

function syncTagColorStore(editor) {
  const list = editor.querySelector("[data-tag-color-rules]");
  const hidden = editor.querySelector('[data-field="tagColors"]');
  if (!list || !hidden) return;
  const rules = [...list.querySelectorAll(".tag-color-rule")].map(row => ({
    column: row.querySelector(".tag-col")?.value.trim().toUpperCase() || "",
    text: row.querySelector(".tag-text")?.value.trim() || "",
    color: row.querySelector(".tag-color")?.value || "#00a884"
  })).filter(rule => rule.text);
  hidden.value = tagColorsToText(rules);
}

function addTagColorRuleRow(editor, rule = { column: "", text: "", color: "#00a884" }) {
  const list = editor.querySelector("[data-tag-color-rules]");
  if (!list) return;

  const row = document.createElement("div");
  row.className = "tag-color-rule";

  const col = document.createElement("input");
  col.type = "text";
  col.className = "tag-col";
  col.placeholder = "列";
  col.maxLength = 4;
  col.title = "可留空：默认对「名称标签列」里匹配到的文字都生效；填了才只作用于该列（如 D）";
  col.value = rule.column || "";

  const text = document.createElement("input");
  text.type = "text";
  text.className = "tag-text";
  text.placeholder = "关键词，如 下 / 上 / Normale";
  text.value = rule.text || "";
  text.title = "单元格包含该文字即上色，不必写完整句子";

  const color = document.createElement("input");
  color.type = "color";
  color.className = "tag-color";
  color.title = "选择颜色";
  color.value = toColorInputValue(rule.color || "#00a884");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "tag-color-remove";
  remove.textContent = "删除";

  const onChange = () => syncTagColorStore(editor);
  col.addEventListener("input", onChange);
  text.addEventListener("input", onChange);
  color.addEventListener("input", onChange);
  remove.addEventListener("click", () => {
    row.remove();
    syncTagColorStore(editor);
  });

  row.append(col, text, color, remove);
  list.append(row);
  syncTagColorStore(editor);
}

function setupTagColorEditor(editor, rawValue = "") {
  const list = editor.querySelector("[data-tag-color-rules]");
  const hidden = editor.querySelector('[data-field="tagColors"]');
  const addBtn = editor.querySelector(".add-tag-color");
  if (!list || !hidden || !addBtn) return;

  list.replaceChildren();
  hidden.value = rawValue || "";

  let rules = [];
  try {
    rules = parseTagColors(rawValue || "");
  } catch {
    rules = [];
  }
  for (const rule of rules) addTagColorRuleRow(editor, rule);

  addBtn.onclick = () => addTagColorRuleRow(editor);
  syncTagColorStore(editor);
}

function addSourceEditor(source = sourceDefaults, activate = true) {
  const editor = elements.template.content.firstElementChild.cloneNode(true);
  const merged = { ...sourceDefaults, ...source };
  for (const [field, value] of Object.entries(merged)) {
    const input = editor.querySelector(`[data-field="${field}"]`);
    if (input) input.value = value;
  }
  setupTagColorEditor(editor, merged.tagColors || "");
  editor.querySelector('[data-field="name"]')?.addEventListener("input", () => {
    updateSourceNavigation();
  });
  editor.querySelector(".remove-source").addEventListener("click", () => {
    const removedIndex = [...elements.sources.children].indexOf(editor);
    editor.remove();
    if (removedIndex < activeSourceIndex) activeSourceIndex--;
    else if (removedIndex === activeSourceIndex) {
      activeSourceIndex = Math.min(activeSourceIndex, elements.sources.children.length - 1);
    }
    updateSourceNavigation();
  });
  elements.sources.append(editor);
  if (activate) activeSourceIndex = elements.sources.children.length - 1;
  updateSourceNavigation();
}

function renderSourceEditors() {
  elements.sources.replaceChildren();
  config.sources.forEach(source => addSourceEditor(source, false));
  activeSourceIndex = 0;
  updateSourceNavigation();
}

function readSources() {
  return [...elements.sources.querySelectorAll(".source-editor")].map((editor, index) => {
    syncTagColorStore(editor);
    const source = Object.fromEntries(
      [...editor.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input.value.trim()])
    );
    source.phoneColumn = source.phoneColumn.toUpperCase();
    prepareSource(source, index);
    return source;
  });
}

function setStatus(message, hidden = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("hidden", hidden);
}

function setContactName(text) {
  elements.contact.textContent = text;
}

function buildTagItems(match) {
  if (!match?.tagColumns?.length) return [];
  const tags = [];
  for (const column of match.tagColumns) {
    const text = cellText(match.cells[columnIndex(column)]).trim();
    if (!text) continue;
    tags.push({
      text,
      color: resolveTagColor(text, column, match.tagColors) || fallbackTagColor(text)
    });
  }
  return tags;
}

function buildNameColor(match) {
  const column = String(match?.nameColorColumn || "").trim().toUpperCase();
  if (!column || !match?.cells) return "";
  const text = cellText(match.cells[columnIndex(column)]).trim();
  if (!text) return "";
  // No random fallback: name color only when a rule matches.
  return resolveTagColor(text, column, match.tagColors || []) || "";
}

function buildContactVisual(match) {
  return {
    tags: buildTagItems(match),
    nameColor: buildNameColor(match),
    tagPlacement: match?.tagPlacement === "name" ? "name" : "message"
  };
}

let titlePhoneAliases = {};

async function notifyWhatsAppTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
    await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
  } catch {}
}

async function publishWhatsAppTags(match) {
  const visual = match ? buildContactVisual(match) : { tags: [], nameColor: "", tagPlacement: "message" };
  const payload = {
    phone: match?.phone || normalizePhone(contact.phone) || "",
    title: contact.title || match?.title || "",
    tags: visual.tags,
    nameColor: visual.nameColor,
    tagPlacement: visual.tagPlacement
  };
  if (payload.title && payload.phone) {
    titlePhoneAliases = {
      ...titlePhoneAliases,
      [payload.title]: payload.phone
    };
  }
  try {
    await chrome.storage.local.set({
      waSheetTags: payload,
      waSheetTitlePhones: titlePhoneAliases
    });
  } catch {}
  await notifyWhatsAppTabs({ type: "sheet-tags", payload });
  // Tint sidepanel contact name when rule matches.
  if (payload.nameColor) {
    elements.contact.style.color = payload.nameColor;
  } else {
    elements.contact.style.removeProperty("color");
  }
}

/** Only: 关注号码 + 点开过的聊天 + 当前聊天。不上千人全量映射。 */
function focusPhones() {
  const watch = parseWatchPhones(config.watchPhones);
  const clicked = Object.values(titlePhoneAliases).map(value => normalizePhone(value)).filter(Boolean);
  const current = normalizePhone(contact.phone);
  return [...new Set([...watch, ...clicked, current].filter(phone => phone.length >= 7))];
}

function indexEntryForPhone(index, phone) {
  if (!index || !phone) return null;
  if (index.has(phone)) return index.get(phone);
  for (const [key, entry] of index) {
    if (phonesLooselyEqual(key, phone)) return entry;
  }
  return null;
}

function buildTagMapFromCaches() {
  const focus = focusPhones();
  if (!focus.length) return {};
  const map = {};
  for (const source of preparedSources) {
    if (!source.tagColumns?.length && !source.nameColorColumn) continue;
    for (const tabName of source.tabNames) {
      const cached = cachedIndexes.get(cacheKey(source, tabName));
      if (!cached?.index) continue;
      for (const phone of focus) {
        if (map[phone]) continue;
        const entry = indexEntryForPhone(cached.index, phone);
        if (!entry) continue;
        const visual = buildContactVisual({
          cells: entry.cells,
          tagColumns: source.tagColumns,
          nameColorColumn: source.nameColorColumn,
          tagPlacement: source.tagPlacement,
          tagColors: source.tagColors
        });
        if (visual.tags.length || visual.nameColor) map[phone] = visual;
      }
    }
  }
  return map;
}

let lastPublishedVisualMap = {};

function mapHasPhone(map, phone) {
  if (map[phone] && (map[phone].tags?.length || map[phone].nameColor || Array.isArray(map[phone]))) {
    return true;
  }
  return Object.keys(map).some(key => phonesLooselyEqual(key, phone));
}

async function publishWhatsAppTagMap(map = buildTagMapFromCaches()) {
  lastPublishedVisualMap = map;
  try {
    await chrome.storage.local.set({
      waSheetTagMap: map,
      waSheetTitlePhones: titlePhoneAliases,
      waSheetWatchPhones: parseWatchPhones(config.watchPhones)
    });
  } catch {}
  await notifyWhatsAppTabs({
    type: "sheet-tag-map",
    map,
    titlePhones: titlePhoneAliases,
    watchPhones: parseWatchPhones(config.watchPhones)
  });
  renderWatchStatus(map);
}

/**
 * Load sheet indexes as needed and publish visuals for focus phones.
 * @param {{ mode?: "all"|"incremental", forceReload?: boolean, phones?: string[] }} options
 */
async function warmWhatsAppTagMap(options = {}) {
  const mode = options.mode === "incremental" ? "incremental" : "all";
  const forceReload = Boolean(options.forceReload);
  const sources = preparedSources.filter(
    source => source.tagColumns?.length || source.nameColorColumn
  );
  const focus = options.phones?.length ? options.phones : focusPhones();
  if (!sources.length || !focus.length) {
    if (mode === "incremental") {
      await publishWhatsAppTagMap({ ...lastPublishedVisualMap });
    } else {
      await publishWhatsAppTagMap({});
    }
    return { requested: 0, matched: 0 };
  }

  let targets = focus;
  if (mode === "incremental") {
    targets = focus.filter(phone => !mapHasPhone(lastPublishedVisualMap, phone));
    if (!targets.length) {
      renderWatchStatus(lastPublishedVisualMap);
      const error = document.querySelector("#watch-error");
      if (error) error.textContent = "";
      return { requested: 0, matched: 0, skipped: true };
    }
  }

  const status = document.querySelector("#watch-status");
  if (status && parseWatchPhones(config.watchPhones).length) {
    status.classList.remove("hidden");
    status.replaceChildren(Object.assign(document.createElement("p"), {
      className: "watch-status-summary",
      textContent: mode === "incremental"
        ? `正在增量查询 ${targets.length} 个新号码…`
        : `正在查询关注号码（${targets.length}）…`
    }));
  }

  if (forceReload) await clearAllIndexCaches();

  const controller = new AbortController();
  for (const source of sources) {
    for (const tabName of source.tabNames) {
      try {
        await loadIndex(source, tabName, controller.signal);
        const partial = buildTagMapFromCaches();
        renderWatchStatus(mode === "incremental"
          ? { ...lastPublishedVisualMap, ...partial }
          : partial);
      } catch (error) {
        if (error.name === "AbortError") return { requested: targets.length, matched: 0 };
      }
    }
  }

  const fresh = buildTagMapFromCaches();
  const map = mode === "incremental"
    ? { ...lastPublishedVisualMap, ...fresh }
    : fresh;
  // Drop removed watch phones from published map (keep clicked/current if still focused).
  const allowed = new Set(focusPhones());
  const pruned = {};
  for (const [phone, visual] of Object.entries(map)) {
    if (allowed.has(phone) || [...allowed].some(item => phonesLooselyEqual(item, phone))) {
      pruned[phone] = visual;
    }
  }
  await publishWhatsAppTagMap(pruned);
  const matched = targets.filter(phone => mapHasPhone(pruned, phone)).length;
  return { requested: targets.length, matched };
}

function startWatchRefreshTimer() {
  clearInterval(watchRefreshTimer);
  watchRefreshTimer = setInterval(() => {
    if (!parseWatchPhones(config.watchPhones).length) return;
    // Background refresh uses cache when valid; does not clear config.
    warmWhatsAppTagMap({ mode: "all" }).catch(() => {});
  }, watchRefreshMs);
}

async function saveWatchListOnly() {
  config = {
    ...config,
    watchPhones: readWatchPhonesField(),
    sources: config.sources?.length ? config.sources : [{ ...sourceDefaults }]
  };
  await chrome.storage.sync.set({ config });
  syncWatchPhonesField();
  startWatchRefreshTimer();
}

function clearContactTags({ publish = true } = {}) {
  elements.contactTags.replaceChildren();
  // Only clear current-contact highlight tags; keep full list tag map.
  if (publish) publishWhatsAppTags(null);
}

function renderContactTags(match) {
  clearContactTags({ publish: false });
  const tags = buildTagItems(match);
  for (const item of tags) {
    const tag = document.createElement("span");
    tag.className = "contact-tag";
    tag.textContent = item.text;
    tag.title = item.text;
    tag.style.background = item.color;
    elements.contactTags.append(tag);
  }
  publishWhatsAppTags(match);
}

function updateResultsHint(visible) {
  elements.resultsHint.classList.toggle("hidden", !visible);
}

function renderValue(valueEl, cell, { editableEmpty = false } = {}) {
  valueEl.replaceChildren();
  const text = cellText(cell);
  const href = linkHref(cell);
  if (!text && editableEmpty) {
    const hint = document.createElement("span");
    hint.className = "empty-edit-hint";
    hint.textContent = "点击编辑";
    valueEl.append(hint);
    return;
  }
  const display = text || "—";
  if (href) {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = display;
    valueEl.append(link);
  } else {
    valueEl.textContent = display;
  }
}

function createResultCard(columnConfig, match, editable) {
  const { column, label } = columnConfig;
  const card = document.createElement("section");
  card.className = "card result-card";
  card.draggable = true;
  card.dataset.column = column;

  const head = document.createElement("div");
  head.className = "result-card-head";

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.title = "拖动排序";
  handle.setAttribute("aria-hidden", "true");
  handle.textContent = "⠿";

  const name = document.createElement("p");
  name.className = "result-label";
  name.textContent = label;

  head.append(handle, name);

  if (editable) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "result-edit";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", event => {
      event.stopPropagation();
      openInlineEditor(card, columnConfig, match);
    });
    head.append(editBtn);
  }

  const value = document.createElement("p");
  value.className = "result-value";
  value.dataset.role = "value";
  renderValue(value, match.cells[columnIndex(column)], { editableEmpty: editable });

  card.append(head, value);
  bindCardDrag(card);
  return card;
}

function openInlineEditor(card, columnConfig, match) {
  if (card.querySelector(".result-editor")) return;
  const { column, label } = columnConfig;
  const colIndex = columnIndex(column);
  const current = cellText(match.cells[colIndex]);
  const valueEl = card.querySelector('[data-role="value"]');
  const editBtn = card.querySelector(".result-edit");
  if (valueEl) valueEl.classList.add("hidden");
  if (editBtn) editBtn.disabled = true;
  card.draggable = false;

  const editor = document.createElement("div");
  editor.className = "result-editor";

  const input = document.createElement("textarea");
  input.rows = 3;
  input.value = current;
  input.setAttribute("aria-label", `编辑 ${label}`);

  const actions = document.createElement("div");
  actions.className = "result-editor-actions";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";

  const save = document.createElement("button");
  save.type = "button";
  save.className = "save-edit";
  save.textContent = "保存到表格";

  const errorEl = document.createElement("p");
  errorEl.className = "edit-error hidden";
  errorEl.setAttribute("role", "alert");

  const closeEditor = () => {
    editor.remove();
    if (valueEl) valueEl.classList.remove("hidden");
    if (editBtn) editBtn.disabled = false;
    card.draggable = true;
  };

  cancel.addEventListener("click", closeEditor);
  save.addEventListener("click", async () => {
    const next = input.value;
    if (next === current) {
      closeEditor();
      return;
    }
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
    save.disabled = true;
    cancel.disabled = true;
    save.textContent = "保存中…";
    try {
      await ensureGoogleWriteAccess();
      const sheetRow = await resolveSheetRow(match);
      match.sheetRow = sheetRow;
      await updateSheetCell({
        sheetId: match.sheetId,
        tabName: match.tabName,
        column,
        sheetRow,
        value: next
      });
      const cell = match.cells[colIndex] && typeof match.cells[colIndex] === "object"
        ? { ...match.cells[colIndex], text: next, href: match.cells[colIndex].href || "" }
        : { text: next, href: "" };
      match.cells[colIndex] = cell;
      patchCachedCell(match, colIndex, cell);
      renderValue(valueEl, cell, { editableEmpty: true });
      if (match.tagColumns?.includes(column)) renderContactTags(match);
      closeEditor();
      setStatus(`已更新「${label}」· ${match.sourceLabel || sourceLabel("", match.sourceNumber)} / “${match.tabName}”第 ${sheetRow} 行`);
    } catch (error) {
      save.disabled = false;
      cancel.disabled = false;
      save.textContent = "保存到表格";
      errorEl.textContent = error.message;
      errorEl.classList.remove("hidden");
    }
  });

  actions.append(cancel, save);
  editor.append(input, actions, errorEl);
  card.append(editor);
  input.focus();
  input.select();
}

function bindCardDrag(card) {
  card.addEventListener("dragstart", event => {
    if (event.target.closest(".result-editor, .result-edit, a, textarea, button")) {
      event.preventDefault();
      return;
    }
    dragColumn = card.dataset.column;
    card.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragColumn);
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    dragColumn = "";
    elements.results.querySelectorAll(".drag-over").forEach(node => node.classList.remove("drag-over"));
  });
  card.addEventListener("dragover", event => {
    if (!dragColumn || dragColumn === card.dataset.column) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    card.classList.add("drag-over");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
  card.addEventListener("drop", event => {
    event.preventDefault();
    card.classList.remove("drag-over");
    const from = dragColumn || event.dataTransfer.getData("text/plain");
    const to = card.dataset.column;
    if (!from || !to || from === to || !lastMatch) return;
    reorderResultColumns(from, to);
  });
}

function reorderResultColumns(fromColumn, toColumn) {
  if (!lastMatch) return;
  const columns = [...lastMatch.columns];
  const fromIndex = columns.findIndex(item => item.column === fromColumn);
  const toIndex = columns.findIndex(item => item.column === toColumn);
  if (fromIndex < 0 || toIndex < 0) return;

  const [moved] = columns.splice(fromIndex, 1);
  columns.splice(toIndex, 0, moved);
  lastMatch.columns = columns;

  const source = config.sources[lastMatch.configIndex];
  if (source) {
    source.resultColumns = columnsToText(columns);
    const prepared = preparedSources.find(item => item.configIndex === lastMatch.configIndex);
    if (prepared) prepared.columns = columns.map(item => ({ ...item }));
    chrome.storage.sync.set({ config });
    syncEditorResultColumns(lastMatch.configIndex, source.resultColumns);
  }

  renderResults(lastMatch);
}

function syncEditorResultColumns(sourceNumber, text) {
  const editor = elements.sources.querySelectorAll(".source-editor")[sourceNumber];
  const input = editor?.querySelector('[data-field="resultColumns"]');
  if (input) input.value = text;
}

function renderResults(match) {
  lastMatch = match;
  const editableSet = match.editableSet || new Set();
  elements.results.replaceChildren(
    ...match.columns.map(columnConfig =>
      createResultCard(columnConfig, match, editableSet.has(columnConfig.column))
    )
  );
  renderContactTags(match);
  updateResultsHint(true);
}

function parseHtmlRows(text) {
  const document = new DOMParser().parseFromString(text, "text/html");
  const table = document.querySelector("table");
  if (!table) throw new Error("表格不可公开读取，请检查共享权限、登录状态和子表名称");
  return [...table.querySelectorAll("tr")].map(row =>
    [...row.querySelectorAll("th, td")].map(cell => ({
      text: cell.textContent.trim(),
      href: safeHref(cell.querySelector("a[href]")?.getAttribute("href") || "")
    }))
  );
}

function updateAuthUi() {
  const loggedIn = Boolean(googleToken);
  document.querySelector("#auth-status").textContent = loggedIn ? "已登录" : "未登录 · 公开只读";
  document.querySelector("#auth-button").textContent = loggedIn ? "退出" : "登录";
  const hint = document.querySelector("#auth-hint");
  if (hint) {
    hint.textContent = loggedIn ? "" : "编辑表格或读取非公开表时需登录";
    hint.classList.toggle("hidden", loggedIn);
  }
}

async function getGoogleToken(interactive) {
  const result = await chrome.identity.getAuthToken({ interactive });
  return typeof result === "string" ? result : (result?.token || "");
}

async function ensureGoogleWriteAccess() {
  if (!googleToken) {
    googleToken = await getGoogleToken(true);
    updateAuthUi();
  }
  if (!googleToken) throw new Error("请先登录 Google，才能把修改写回表格");
}

function sheetRange(tabName, startColumn, endColumn) {
  const escaped = tabName.replaceAll("'", "''");
  return `'${escaped}'!${columnName(startColumn)}:${columnName(endColumn)}`;
}

async function loadPrivateRows(source, tabName, keepColumns, signal) {
  const id = source.sheetId;
  const ranges = columnRanges(keepColumns).map(([start, end]) => sheetRange(tabName, start, end));
  const fields = "sheets(data(startRow,startColumn,rowData(values(formattedValue,hyperlink,textFormatRuns(format(link))))))";
  const params = new URLSearchParams({ includeGridData: "true", fields });
  for (const range of ranges) params.append("ranges", range);
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?${params}`, {
    headers: { Authorization: `Bearer ${googleToken}` },
    signal
  });
  if (response.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token: googleToken });
    googleToken = "";
    updateAuthUi();
    throw new Error("Google 登录已过期，请重新登录");
  }
  if (response.status === 403) throw new Error("当前 Google 账号无权查看表格，或尚未启用 Sheets API");
  if (response.status === 404) throw new Error(`找不到表格或子表“${tabName}”`);
  if (!response.ok) throw new Error(`Google Sheets API 读取失败（HTTP ${response.status}）`);
  return sheetApiRows(await response.json());
}

async function fetchPublicHtml(id, tabName, tq, signal) {
  const params = new URLSearchParams({
    tqx: "out:html",
    sheet: tabName
  });
  if (tq) params.set("tq", tq);
  const response = await fetch(
    `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?${params}`,
    { signal }
  );
  if (!response.ok) throw new Error(`无法读取表格（HTTP ${response.status}）`);
  return response.text();
}

function projectedRowsLookValid(denseRows, columnCount) {
  if (!denseRows.length || columnCount < 1) return false;
  // Reject sparse/truncated projections (common when gviz treats header labels as column ids).
  const sample = denseRows.slice(0, Math.min(20, denseRows.length));
  return sample.some(row => Array.isArray(row) && row.length >= columnCount);
}

async function loadPublicRows(source, tabName, keepColumns, signal) {
  const id = source.sheetId;
  const ordered = [...new Set(keepColumns)].sort((a, b) => a - b);
  // Use ColN (1-based positions). Letter ids like "D"/"AA" break when row 1 is headers.
  const tq = `select ${ordered.map(index => `Col${index + 1}`).join(",")}`;

  try {
    const dense = parseHtmlRows(await fetchPublicHtml(id, tabName, tq, signal));
    if (projectedRowsLookValid(dense, ordered.length)) {
      return expandColumnRows(dense, ordered);
    }
  } catch (error) {
    if (error.name === "AbortError") throw error;
  }

  // Full sheet is the reliable path (same behavior as before column projection).
  return parseHtmlRows(await fetchPublicHtml(id, tabName, "", signal));
}

function cacheKey(source, tabName) {
  const mode = googleToken ? "private" : "public";
  // v3: persistent slim index + hit priority era.
  return `v3|${mode}|${source.sheetId}|${tabName}|${source.phoneColumn}|${source.keepColumns.join(",")}`;
}

function deserializeIndex(entries) {
  const index = new Map();
  for (const item of entries || []) {
    const phone = item?.[0];
    const body = item?.[1];
    if (!phone || !body) continue;
    const cells = {};
    for (const [key, value] of Object.entries(body.cells || {})) {
      cells[Number.isInteger(Number(key)) ? Number(key) : key] = value;
    }
    index.set(phone, { sheetRow: body.sheetRow, cells });
  }
  return index;
}

function serializeIndex(index) {
  return [...index.entries()].map(([phone, entry]) => [
    phone,
    { sheetRow: entry.sheetRow, cells: entry.cells }
  ]);
}

function touchCache(key, entry, { persist = true } = {}) {
  cachedIndexes.delete(key);
  cachedIndexes.set(key, entry);
  while (cachedIndexes.size > maxCacheEntries) {
    const oldest = cachedIndexes.keys().next().value;
    cachedIndexes.delete(oldest);
  }
  if (persist) schedulePersistCache();
}

function schedulePersistCache() {
  clearTimeout(persistCacheTimer);
  persistCacheTimer = setTimeout(() => {
    persistCacheNow().catch(() => {});
  }, 400);
}

async function persistCacheNow() {
  const bag = {};
  const now = Date.now();
  for (const [key, entry] of cachedIndexes) {
    if (!entry?.expiresAt || entry.expiresAt <= now || !entry.index) continue;
    bag[key] = {
      expiresAt: entry.expiresAt,
      entries: serializeIndex(entry.index)
    };
  }
  await chrome.storage.local.set({ [PERSIST_CACHE_KEY]: bag });
}

async function hydrateCacheFromStorage() {
  const stored = await chrome.storage.local.get(PERSIST_CACHE_KEY);
  const bag = stored[PERSIST_CACHE_KEY] || {};
  const now = Date.now();
  for (const [key, value] of Object.entries(bag)) {
    if (!value?.expiresAt || value.expiresAt <= now) continue;
    touchCache(key, {
      index: deserializeIndex(value.entries),
      expiresAt: value.expiresAt
    }, { persist: false });
  }
}

async function clearAllIndexCaches() {
  cachedIndexes.clear();
  clearTimeout(persistCacheTimer);
  try {
    await chrome.storage.local.remove(PERSIST_CACHE_KEY);
  } catch {}
}

function rememberSourceHit(configIndex) {
  sourceHitOrder = [configIndex, ...sourceHitOrder.filter(index => index !== configIndex)].slice(0, 20);
  chrome.storage.local.set({ [HIT_ORDER_KEY]: sourceHitOrder }).catch(() => {});
}

function orderedPreparedSources() {
  return [...preparedSources].sort((a, b) => {
    const ai = sourceHitOrder.indexOf(a.configIndex);
    const bi = sourceHitOrder.indexOf(b.configIndex);
    if (ai < 0 && bi < 0) return a.configIndex - b.configIndex;
    if (ai < 0) return 1;
    if (bi < 0) return -1;
    return ai - bi;
  });
}

function patchCachedCell(match, colIndex, cell) {
  const source = preparedSources.find(item => item.configIndex === match.configIndex);
  if (!source) return;
  const key = cacheKey(source, match.tabName);
  const cached = cachedIndexes.get(key);
  const entry = cached?.index?.get(match.phone);
  if (entry?.cells) {
    entry.cells[colIndex] = cell;
    schedulePersistCache();
  }
}

async function loadIndex(source, tabName, signal) {
  const key = cacheKey(source, tabName);
  const cached = cachedIndexes.get(key);
  if (cached?.expiresAt > Date.now()) {
    touchCache(key, cached);
    return cached.index;
  }

  const rows = googleToken
    ? await loadPrivateRows(source, tabName, source.keepColumns, signal)
    : await loadPublicRows(source, tabName, source.keepColumns, signal);
  const index = buildPhoneIndex(rows, source.phoneIndex, source.keepColumns);
  touchCache(key, { index, expiresAt: Date.now() + cacheLifetime });
  return index;
}

async function readSheetCell(sheetId, tabName, column, sheetRow) {
  const range = `'${tabName.replaceAll("'", "''")}'!${column}${sheetRow}`;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${googleToken}` } }
  );
  if (response.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token: googleToken });
    googleToken = "";
    updateAuthUi();
    throw new Error("Google 登录已过期，请重新登录后再保存");
  }
  if (!response.ok) throw new Error(`校验行号失败（HTTP ${response.status}）`);
  const data = await response.json();
  return data?.values?.[0]?.[0] ?? "";
}

/** Confirm A1 row still holds this phone; try ±1 for header/offset drift. */
async function resolveSheetRow(match) {
  const phoneColumn = match.phoneColumn;
  if (!phoneColumn || !match.phone) return match.sheetRow;
  const base = Number(match.sheetRow) || 1;
  const candidates = [...new Set([base, base + 1, Math.max(1, base - 1)])];
  for (const row of candidates) {
    const value = await readSheetCell(match.sheetId, match.tabName, phoneColumn, row);
    if (normalizePhone(value) === match.phone) return row;
  }
  throw new Error("行号校验失败：表格可能已变动，请点 ↻ 刷新后再编辑");
}

async function updateSheetCell({ sheetId, tabName, column, sheetRow, value }) {
  const range = `'${tabName.replaceAll("'", "''")}'!${column}${sheetRow}`;
  const params = new URLSearchParams({ valueInputOption: "USER_ENTERED" });
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?${params}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${googleToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: [[value]] })
    }
  );
  if (response.status === 401) {
    await chrome.identity.removeCachedAuthToken({ token: googleToken });
    googleToken = "";
    updateAuthUi();
    throw new Error("Google 登录已过期，请重新登录后再保存");
  }
  if (response.status === 403) {
    throw new Error("没有写权限：请确认已登录且对表格有编辑权限，必要时退出后重新登录授权");
  }
  if (!response.ok) throw new Error(`写入失败（HTTP ${response.status}）`);
}

async function queryContact(options = {}) {
  const { force = false } = options;
  const currentQuery = ++queryNumber;
  queryController?.abort();
  const controller = new AbortController();
  queryController = controller;

  const phone = normalizePhone(contact.phone);
  setContactName(contact.title || (phone ? `+${phone}` : "请在 WhatsApp 中打开一个聊天"));

  if (contact.isGroup) {
    lastQueriedPhone = "";
    lastMatch = null;
    elements.results.replaceChildren();
    clearContactTags();
    updateResultsHint(false);
    return setStatus("群组聊天已忽略");
  }
  if (!phone) {
    lastQueriedPhone = "";
    lastMatch = null;
    elements.results.replaceChildren();
    clearContactTags();
    updateResultsHint(false);
    return setStatus(contact.source === "lid-only"
      ? "当前联系人只暴露了 WhatsApp LID，暂未解析到真实号码"
      : "没有识别到当前联系人的号码");
  }
  if (!preparedSources.length) {
    showView("settings-view");
    elements.results.replaceChildren();
    clearContactTags();
    updateResultsHint(false);
    return setStatus("请先添加一个表格");
  }

  if (!force && phone === lastQueriedPhone && lastMatch && elements.results.childElementCount) {
    renderContactTags(lastMatch);
    return;
  }

  elements.results.replaceChildren();
  clearContactTags();
  updateResultsHint(false);

  try {
    setStatus("正在查询…");
    const searched = [];
    for (const source of orderedPreparedSources()) {
      for (const tabName of source.tabNames) {
        const label = sourceLabel(source, source.configIndex);
        searched.push(`${label}/“${tabName}”`);
        const index = await loadIndex(source, tabName, controller.signal);
        if (currentQuery !== queryNumber) return;
        const hit = index.get(phone);
        if (hit) {
          lastQueriedPhone = phone;
          rememberSourceHit(source.configIndex);
          const match = {
            phone,
            cells: hit.cells,
            sheetRow: hit.sheetRow,
            sheetId: source.sheetId,
            phoneColumn: source.phoneColumn,
            tabName,
            configIndex: source.configIndex,
            sourceNumber: source.configIndex,
            sourceLabel: label,
            columns: source.columns.map(item => ({ ...item })),
            editableSet: source.editableSet,
            tagColumns: [...(source.tagColumns || [])],
            nameColorColumn: source.nameColorColumn || "",
            tagPlacement: source.tagPlacement || "message",
            tagColors: [...(source.tagColors || [])]
          };
          setStatus(`来自 ${label} / 子表“${tabName}”`);
          renderResults(match);
          lastPublishedVisualMap = {
            ...lastPublishedVisualMap,
            [phone]: buildContactVisual(match)
          };
          return;
        }
      }
    }
    lastQueriedPhone = phone;
    lastMatch = null;
    clearContactTags();
    setStatus(`在 ${searched.join("、")} 中未找到 ${phone}`);
  } catch (error) {
    if (error.name !== "AbortError") setStatus(error.message);
  }
}

async function requestCurrentContact() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const current = await chrome.tabs.sendMessage(tab.id, { type: "get-contact" });
    if (current) {
      contact = current;
      queryContact({ force: true });
    }
  } catch {
    setStatus(tab.url?.startsWith("https://web.whatsapp.com/")
      ? "插件刚刚更新过：请刷新 WhatsApp Web 页面"
      : "请打开 WhatsApp Web，然后选择一个聊天");
  }
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    showView(tab.dataset.view);
    if (tab.dataset.view === "watch-view") renderWatchStatus();
  });
});

document.querySelector("#toggle-settings").addEventListener("click", () => {
  showView("settings-view");
});

document.querySelector("#watch-phones")?.addEventListener("input", () => {
  renderWatchStatus();
});

document.querySelector("#save-watch")?.addEventListener("click", async () => {
  const error = document.querySelector("#watch-error");
  if (error) error.textContent = "";
  try {
    await saveWatchListOnly();
    renderWatchStatus(lastPublishedVisualMap);
    setStatus(`关注名单已保存（${parseWatchPhones(config.watchPhones).length} 个），未自动查询`);
  } catch (err) {
    if (error) error.textContent = err.message;
  }
});

document.querySelector("#query-watch-new")?.addEventListener("click", async () => {
  const error = document.querySelector("#watch-error");
  if (error) error.textContent = "";
  try {
    await saveWatchListOnly();
    const result = await warmWhatsAppTagMap({ mode: "incremental" });
    if (result.skipped) {
      if (error) error.textContent = "没有需要增量查询的新号码（都已查过或名单为空）";
      setStatus("关注号码：无新增可查");
      return;
    }
    setStatus(`增量查询完成：新增请求 ${result.requested}，匹配 ${result.matched}`);
  } catch (err) {
    if (error) error.textContent = err.message;
  }
});

document.querySelector("#query-watch-all")?.addEventListener("click", async () => {
  const error = document.querySelector("#watch-error");
  if (error) error.textContent = "";
  try {
    await saveWatchListOnly();
    const result = await warmWhatsAppTagMap({ mode: "all", forceReload: true });
    setStatus(`全部重查完成：请求 ${result.requested}，匹配 ${result.matched}`);
  } catch (err) {
    if (error) error.textContent = err.message;
  }
});

document.querySelector("#refresh-data").addEventListener("click", async () => {
  await clearAllIndexCaches();
  lastQueriedPhone = "";
  lastMatch = null;
  showView("results-view");
  await queryContact({ force: true });
  // Refresh current contact only; watch list re-query stays on 关注号码 page.
});

document.querySelector("#add-source").addEventListener("click", () => addSourceEditor());

document.querySelector("#auth-button").addEventListener("click", async () => {
  elements.settingsError.textContent = "";
  try {
    if (googleToken) {
      await chrome.identity.clearAllCachedAuthTokens();
      googleToken = "";
    } else {
      googleToken = await getGoogleToken(true);
      if (!googleToken) throw new Error("Google 登录未完成");
    }
    await clearAllIndexCaches();
    lastQueriedPhone = "";
    lastMatch = null;
    updateAuthUi();
    // Auth change only; user can re-query watch list manually.
  } catch (error) {
    elements.settingsError.textContent = error.message;
  }
});

elements.settings.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const watchText = document.querySelector("#watch-phones")
      ? readWatchPhonesField()
      : (config.watchPhones || "");
    config = {
      watchPhones: watchText,
      sources: readSources()
    };
    rebuildPreparedSources();
    // Config save only — do not auto-query sheets/watch list.
    await chrome.storage.sync.set({ config });
    syncWatchPhonesField();
    elements.settingsError.textContent = "";
    setStatus("表格配置已保存（未自动查询）");
  } catch (error) {
    elements.settingsError.textContent = error.message;
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "contact-changed") {
    contact = message.contact;
    queryContact();
  }
});

const boot = await chrome.storage.local.get([HIT_ORDER_KEY, "waSheetTitlePhones"]);
sourceHitOrder = Array.isArray(boot[HIT_ORDER_KEY]) ? boot[HIT_ORDER_KEY] : [];
titlePhoneAliases = boot.waSheetTitlePhones && typeof boot.waSheetTitlePhones === "object"
  ? boot.waSheetTitlePhones
  : {};
config = normalizeConfig((await chrome.storage.sync.get("config")).config);
rebuildPreparedSources();
renderSourceEditors();
syncWatchPhonesField();
try {
  googleToken = await getGoogleToken(false);
} catch {}
// Hydrate after auth mode is known so public/private cache keys match.
await hydrateCacheFromStorage();
updateAuthUi();
showView("results-view");
// Restore focused tags (watchlist + clicked), not entire sheet.
try {
  const { waSheetTags, waSheetTagMap } = await chrome.storage.local.get(["waSheetTags", "waSheetTagMap"]);
  if (waSheetTagMap) {
    lastPublishedVisualMap = waSheetTagMap;
    await notifyWhatsAppTabs({
      type: "sheet-tag-map",
      map: waSheetTagMap,
      titlePhones: titlePhoneAliases,
      watchPhones: parseWatchPhones(config.watchPhones)
    });
  }
  if (waSheetTags) {
    await notifyWhatsAppTabs({ type: "sheet-tags", payload: waSheetTags });
  }
} catch {}
// Boot: restore cached visuals only; no automatic full re-query.
renderWatchStatus(lastPublishedVisualMap);
startWatchRefreshTimer();
requestCurrentContact();
