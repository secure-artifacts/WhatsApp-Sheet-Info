export function normalizePhone(value) {
  return cellText(value)
    .replace(/\D/g, "")
    .replace(/^00/, "")
    .replace(/^225(?:01|05|07)(?=\d{8}$)/, "225");
}

/** Watch-list phones: one per line/comma; returns unique normalized numbers. */
export function parseWatchPhones(value) {
  return [...new Set(
    String(value ?? "")
      .split(/[\n,;]+/)
      .map(line => normalizePhone(line))
      .filter(phone => phone.length >= 7)
  )];
}

export function phonesLooselyEqual(a, b) {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  if (!left || !right) return false;
  return left === right || left.endsWith(right) || right.endsWith(left);
}

export function cellText(value) {
  return String(value?.text ?? value ?? "");
}

export function safeHref(value) {
  try {
    const input = String(value ?? "").trim();
    if (!input) return "";
    const isGoogleRedirect = /^\/url\?/i.test(input);
    if (!/^https?:\/\//i.test(input) && !isGoogleRedirect) return "";
    const url = new URL(input, "https://docs.google.com");
    const redirected = /(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === "/url"
      ? url.searchParams.get("q")
      : "";
    if (redirected) return safeHref(redirected);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function linkHref(value) {
  const textUrl = cellText(value).match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;!?]+$/, "");
  return safeHref(value?.href || textUrl || "");
}

function mapCell(cell) {
  return {
    text: cell.formattedValue ?? "",
    href: safeHref(
      cell.hyperlink
      || cell.textFormatRuns?.find(run => run.format?.link?.uri)?.format.link.uri
      || ""
    )
  };
}

/**
 * Build phone → { cells, sheetRow } index.
 * sheetRow is 1-based A1 row number (array index + 1).
 */
export function buildPhoneIndex(rows, phoneColumnIndex, keepColumns = null) {
  const index = new Map();
  const keep = keepColumns ? [...new Set(keepColumns)] : null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const phone = normalizePhone(row[phoneColumnIndex]);
    if (!phone || index.has(phone)) continue;
    let cells;
    if (!keep) {
      cells = row;
    } else {
      cells = {};
      for (const column of keep) {
        const cell = row[column];
        if (cell != null) cells[column] = cell;
      }
    }
    index.set(phone, { cells, sheetRow: i + 1 });
  }
  return index;
}

export function columnIndex(column) {
  const value = String(column).trim().toUpperCase();
  if (!/^[A-Z]+$/.test(value)) throw new Error(`无效列名：${column}`);
  return [...value].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

export function columnName(index) {
  if (!Number.isInteger(index) || index < 0) throw new Error("列序号无效");
  let name = "";
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

/** Merge contiguous column indexes into [start, end] pairs for API ranges. */
export function columnRanges(indexes) {
  const sorted = [...new Set(indexes)].filter(index => Number.isInteger(index) && index >= 0).sort((a, b) => a - b);
  if (!sorted.length) return [];
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push([start, end]);
      start = end = sorted[i];
    }
  }
  ranges.push([start, end]);
  return ranges;
}

/** Remap dense rows (from a column subset fetch) onto sparse rows keyed by real column indexes. */
export function expandColumnRows(denseRows, columnIndexes) {
  const cols = [...columnIndexes];
  return denseRows.map(dense => {
    const row = [];
    cols.forEach((column, index) => {
      row[column] = dense[index] ?? null;
    });
    return row;
  });
}

export function sheetApiRows(response) {
  const grids = response?.sheets?.[0]?.data || [];
  if (!grids.length) return [];

  let maxRow = 0;
  for (const grid of grids) {
    const startRow = grid.startRow || 0;
    maxRow = Math.max(maxRow, startRow + (grid.rowData?.length || 0));
  }

  const rows = Array.from({ length: maxRow }, () => []);
  for (const grid of grids) {
    const startCol = grid.startColumn || 0;
    const startRow = grid.startRow || 0;
    (grid.rowData || []).forEach((row, rowOffset) => {
      const target = rows[startRow + rowOffset];
      (row.values || []).forEach((cell, colOffset) => {
        target[startCol + colOffset] = mapCell(cell);
      });
    });
  }
  return rows;
}

export function parseColumns(value) {
  const columns = String(value)
    .split(/[\n,]+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [column, ...label] = line.split(/[=:：]/);
      const normalized = column.trim().toUpperCase();
      columnIndex(normalized);
      return { column: normalized, label: label.join(":").trim() || normalized };
    });
  if (!columns.length) throw new Error("请至少填写一个结果列");
  return columns;
}

/** Columns listed against result columns (editable / name tags). */
export function parseListedColumns(value, resultColumns, fieldLabel) {
  const allowed = new Set(resultColumns.map(({ column }) => column));
  const columns = [...new Set(
    String(value ?? "")
      .split(/[\n,]+/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const column = line.split(/[=:：]/)[0].trim().toUpperCase();
        columnIndex(column);
        return column;
      })
  )];
  for (const column of columns) {
    if (!allowed.has(column)) {
      throw new Error(`${fieldLabel} ${column} 必须同时出现在结果列中`);
    }
  }
  return columns;
}

/** Editable columns must be listed in result columns (prevents editing hidden fields). */
export function parseEditableColumns(value, resultColumns) {
  return parseListedColumns(value, resultColumns, "可编辑列");
}

/** Name-tag columns must be listed in result columns. */
export function parseTagColumns(value, resultColumns) {
  return parseListedColumns(value, resultColumns, "名称标签列");
}

/** Optional single column used only to tint the contact name (no badge text). */
export function parseNameColorColumn(value, resultColumns) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const column = raw.split(/[=:：]/)[0].trim().toUpperCase();
  columnIndex(column);
  const allowed = new Set(resultColumns.map(item => item.column));
  if (!allowed.has(column)) {
    throw new Error(`名字颜色列 ${column} 必须同时出现在结果列中`);
  }
  return column;
}

export function parseTagPlacement(value) {
  const placement = String(value ?? "").trim().toLowerCase();
  return placement === "name" ? "name" : "message";
}

/**
 * Columns that need frequent refresh on the watch list (e.g. online status).
 * Must appear in result columns. Empty = watch refresh reloads all used columns.
 */
export function parseFreshColumns(value, resultColumns) {
  return parseListedColumns(value, resultColumns, "快速刷新列");
}

const NAMED_TAG_COLORS = {
  green: "#00a884",
  red: "#e5484d",
  orange: "#f59e0b",
  blue: "#3b82f6",
  gray: "#667781",
  grey: "#667781",
  purple: "#8b5cf6",
  yellow: "#ca8a04",
  teal: "#14b8a6",
  pink: "#ec4899",
  // 中文别名，方便非英文用户
  绿: "#00a884",
  绿色: "#00a884",
  红: "#e5484d",
  红色: "#e5484d",
  橙: "#f59e0b",
  橙色: "#f59e0b",
  蓝: "#3b82f6",
  蓝色: "#3b82f6",
  灰: "#667781",
  灰色: "#667781",
  紫: "#8b5cf6",
  紫色: "#8b5cf6",
  黄: "#ca8a04",
  黄色: "#ca8a04",
  青: "#14b8a6",
  青色: "#14b8a6",
  粉: "#ec4899",
  粉色: "#ec4899"
};

/** Common presets for the color picker UI. */
export const TAG_COLOR_PRESETS = [
  { label: "绿", color: "#00a884" },
  { label: "红", color: "#e5484d" },
  { label: "橙", color: "#f59e0b" },
  { label: "蓝", color: "#3b82f6" },
  { label: "紫", color: "#8b5cf6" },
  { label: "黄", color: "#ca8a04" },
  { label: "青", color: "#14b8a6" },
  { label: "粉", color: "#ec4899" },
  { label: "灰", color: "#667781" }
];

export function normalizeTagColor(input) {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("颜色不能为空");
  const named = NAMED_TAG_COLORS[value] || NAMED_TAG_COLORS[value.toLowerCase()];
  if (named) return named;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
    const hex = value.toLowerCase();
    if (hex.length === 4) {
      return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    }
    return hex;
  }
  if (/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return normalizeTagColor(`#${value}`);
  throw new Error(`无效颜色：${input}（请用取色器，或中文色名如「绿色」，或 #RRGGBB）`);
}

/** Ensure #rrggbb for <input type="color">. */
export function toColorInputValue(input) {
  try {
    return normalizeTagColor(input || "#00a884");
  } catch {
    return "#00a884";
  }
}

/**
 * Parse tag color rules.
 * Lines: `值=颜色` or `列|值=颜色`
 * Example: Normale正常=green  /  D|VIP=#e5484d
 */
export function parseTagColors(value) {
  return String(value ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const match = line.match(/^(?:([A-Za-z]+)\s*\|\s*)?(.+?)\s*[=:：]\s*(.+)$/);
      if (!match) throw new Error(`标签颜色格式无效：${line}`);
      const column = match[1] ? match[1].trim().toUpperCase() : "";
      if (column) columnIndex(column);
      const text = match[2].trim();
      if (!text) throw new Error(`标签颜色缺少匹配文字：${line}`);
      return { column, text, color: normalizeTagColor(match[3]) };
    });
}

/** Serialize rules back to storage text. */
export function tagColorsToText(rules) {
  return (rules || [])
    .filter(rule => rule?.text)
    .map(rule => {
      const color = normalizeTagColor(rule.color || "#00a884");
      const text = String(rule.text).trim();
      const column = String(rule.column || "").trim().toUpperCase();
      return column ? `${column}|${text}=${color}` : `${text}=${color}`;
    })
    .join("\n");
}

/**
 * Color rules match by default when the cell text **contains** the keyword.
 * Priority: exact full text → longest contained keyword → earlier rule as tie-break.
 * Example: keyword「下」matches「拉-下听了17分钟」;「没接上」beats shorter「上」.
 */
export function resolveTagColor(text, column, rules) {
  if (!text || !rules?.length) return "";
  const value = String(text);
  const applicable = rules.filter(rule => !rule.column || rule.column === column);
  if (!applicable.length) return "";

  const exact = applicable.find(rule => rule.text === value);
  if (exact) return exact.color;

  let best = null;
  let bestIndex = -1;
  applicable.forEach((rule, index) => {
    const keyword = String(rule.text || "");
    if (!keyword || !value.includes(keyword)) return;
    if (
      !best
      || keyword.length > best.text.length
      || (keyword.length === best.text.length && (bestIndex < 0 || index < bestIndex))
    ) {
      best = rule;
      bestIndex = index;
    }
  });
  return best?.color || "";
}

/** Stable fallback color when no rule matches. */
export function fallbackTagColor(text) {
  const palette = ["#00a884", "#3b82f6", "#8b5cf6", "#f59e0b", "#e5484d", "#667781", "#14b8a6"];
  let hash = 0;
  for (const char of String(text)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

export function columnsToText(columns) {
  return columns
    .map(({ column, label }) => (label && label !== column ? `${column}=${label}` : column))
    .join("\n");
}

export function parseTabNames(value) {
  const names = [...new Set(String(value).split(/[\n,]+/).map(name => name.trim()).filter(Boolean))];
  if (!names.length) throw new Error("请至少填写一个子表名称");
  return names;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function spreadsheetId(value) {
  const input = String(value).trim();
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const id = match?.[1] || input;
  if (!/^[a-zA-Z0-9-_]+$/.test(id)) throw new Error("表格链接或 ID 无效");
  return id;
}

/**
 * Prepare a source once so query loops skip repeated parsing.
 * @param {{ strictOptional?: boolean }} options
 *   strictOptional (default true): invalid editable/tag fields throw.
 *   Use false when loading saved config so a bad optional field does not disable the whole source.
 */
export function prepareSource(source, index = 0, options = {}) {
  const strictOptional = options.strictOptional !== false && options.strictEditable !== false;
  try {
    const id = spreadsheetId(source.sheetId);
    const tabNames = parseTabNames(source.tabName);
    const phoneColumn = String(source.phoneColumn || "").trim().toUpperCase();
    const phoneIndex = columnIndex(phoneColumn);
    const columns = parseColumns(source.resultColumns);
    let editableColumns = [];
    let tagColumns = [];
    let tagColors = [];
    let nameColorColumn = "";
    let freshColumns = [];
    const tagPlacement = parseTagPlacement(source.tagPlacement);
    try {
      editableColumns = parseEditableColumns(source.editableColumns, columns);
    } catch (error) {
      if (strictOptional) throw error;
    }
    try {
      tagColumns = parseTagColumns(source.tagColumns, columns);
    } catch (error) {
      if (strictOptional) throw error;
    }
    try {
      nameColorColumn = parseNameColorColumn(source.nameColorColumn, columns);
    } catch (error) {
      if (strictOptional) throw error;
    }
    try {
      freshColumns = parseFreshColumns(source.freshColumns, columns);
    } catch (error) {
      if (strictOptional) throw error;
    }
    try {
      tagColors = parseTagColors(source.tagColors);
    } catch (error) {
      if (strictOptional) throw error;
    }
    const resultIndexes = columns.map(({ column }) => columnIndex(column));
    const nameColorIndex = nameColorColumn ? columnIndex(nameColorColumn) : -1;
    const freshIndexes = freshColumns.map(column => columnIndex(column));
    const keepColumns = [...new Set([
      phoneIndex,
      ...resultIndexes,
      ...(nameColorIndex >= 0 ? [nameColorIndex] : []),
      ...freshIndexes
    ])];
    return {
      ...source,
      sheetId: id,
      phoneColumn,
      tabNames,
      phoneIndex,
      columns,
      editableColumns,
      editableSet: new Set(editableColumns),
      tagColumns,
      nameColorColumn,
      freshColumns,
      freshIndexes,
      tagPlacement,
      tagColors,
      keepColumns
    };
  } catch (error) {
    throw new Error(`表格 ${index + 1}：${error.message}`);
  }
}
