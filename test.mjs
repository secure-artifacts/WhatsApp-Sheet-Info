import assert from "node:assert/strict";
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
  normalizeTagColor,
  parseColumns,
  parseCsv,
  parseEditableColumns,
  parseFreshColumns,
  parseTagColors,
  parseNameColorColumn,
  parseTagColumns,
  parseTagPlacement,
  parseTabNames,
  parseWatchPhones,
  phonesLooselyEqual,
  prepareSource,
  resolveTagColor,
  safeHref,
  sheetApiRows,
  spreadsheetId,
  tagColorsToText,
  toColorInputValue
} from "./shared.mjs";

assert.equal(normalizePhone("+33 (0)6 12 34 56 78"), "330612345678");
assert.deepEqual(parseWatchPhones("+225 07 08 12 34 56\n33612345678, 22508123456"), [
  "22508123456",
  "33612345678"
]);
assert.equal(phonesLooselyEqual("22508123456", "+225 08 12 34 56"), true);
assert.equal(normalizePhone("0033 6 12 34 56 78"), "33612345678");
assert.equal(normalizePhone("+225 07 08 12 34 56"), "22508123456");
assert.equal(normalizePhone("00225 05 04 12 34 56"), "22504123456");
assert.equal(normalizePhone("225 01 02 12 34 56"), "22502123456");
assert.equal(normalizePhone("225 08 12 34 56"), "22508123456");
assert.equal(cellText({ text: "显示名称", href: "https://example.com" }), "显示名称");
assert.equal(
  linkHref({ text: "群组：https://chat.whatsapp.com/abc" }),
  "https://chat.whatsapp.com/abc"
);
assert.equal(safeHref("javascript:alert(1)"), "");
assert.equal(safeHref(""), "");
assert.equal(safeHref("/spreadsheets/d/example"), "");
assert.equal(
  safeHref("https://www.google.com/url?q=https%3A%2F%2Fchat.whatsapp.com%2Fabc"),
  "https://chat.whatsapp.com/abc"
);
assert.equal(columnIndex("A"), 0);
assert.equal(columnIndex("AA"), 26);
assert.equal(columnIndex("BJ"), 61);
assert.equal(columnName(61), "BJ");

const indexed = buildPhoneIndex([["A", "123"], ["B", "+456"], ["C", "123"]], 1);
assert.equal(indexed.get("123").cells[0], "A");
assert.equal(indexed.get("123").sheetRow, 1);
assert.equal(indexed.get("456").sheetRow, 2);

assert.equal(buildPhoneIndex([["A", { text: "+789" }]], 1).get("789").cells[0], "A");
assert.equal(
  buildPhoneIndex([["科特迪瓦", "+225 07 08 12 34 56"]], 1).get(normalizePhone("225 08 12 34 56")).cells[0],
  "科特迪瓦"
);

const slim = buildPhoneIndex(
  [[{ text: "x" }, { text: "123" }, { text: "vip" }, { text: "extra" }]],
  1,
  [1, 2]
).get("123");
assert.equal(slim.sheetRow, 1);
assert.equal(slim.cells[1].text, "123");
assert.equal(slim.cells[2].text, "vip");
assert.equal(slim.cells[3], undefined);
assert.equal(slim.cells[0], undefined);

assert.deepEqual(columnRanges([61, 3, 26, 4, 26]), [[3, 4], [26, 26], [61, 61]]);
assert.deepEqual(
  expandColumnRows([[{ text: "p" }, { text: "v" }]], [26, 3]),
  (() => {
    const row = [];
    row[26] = { text: "p" };
    row[3] = { text: "v" };
    return [row];
  })()
);

assert.deepEqual(
  sheetApiRows({ sheets: [{ data: [{ rowData: [{ values: [
    { formattedValue: "123" },
    { formattedValue: "群组", hyperlink: "https://chat.whatsapp.com/abc" }
  ] }] }] }] }),
  [[
    { text: "123", href: "" },
    { text: "群组", href: "https://chat.whatsapp.com/abc" }
  ]]
);

assert.deepEqual(
  sheetApiRows({
    sheets: [{
      data: [
        {
          startColumn: 26,
          rowData: [{ values: [{ formattedValue: "123" }] }]
        },
        {
          startColumn: 3,
          rowData: [{ values: [{ formattedValue: "vip", hyperlink: "https://example.com" }] }]
        }
      ]
    }]
  }),
  (() => {
    const row = [];
    row[26] = { text: "123", href: "" };
    row[3] = { text: "vip", href: "https://example.com/" };
    return [row];
  })()
);

const resultColumns = parseColumns("D=等级\nBI：负责人,BJ");
assert.deepEqual(resultColumns, [
  { column: "D", label: "等级" },
  { column: "BI", label: "负责人" },
  { column: "BJ", label: "BJ" }
]);
assert.deepEqual(parseEditableColumns("BJ\nD", resultColumns), ["BJ", "D"]);
assert.deepEqual(parseEditableColumns("", resultColumns), []);
assert.throws(() => parseEditableColumns("ZZ", resultColumns), /必须同时出现在结果列中/);
assert.deepEqual(parseTagColumns("D", resultColumns), ["D"]);
assert.throws(() => parseTagColumns("ZZ", resultColumns), /名称标签列/);
assert.equal(parseNameColorColumn("BH", parseColumns("D=状态\nBH=进度")), "BH");
assert.equal(parseNameColorColumn("", resultColumns), "");
assert.throws(() => parseNameColorColumn("ZZ", resultColumns), /名字颜色列/);
assert.deepEqual(parseFreshColumns("BH\nD", parseColumns("D=状态\nBH=进度")), ["BH", "D"]);
assert.deepEqual(parseFreshColumns("", resultColumns), []);
assert.throws(() => parseFreshColumns("ZZ", resultColumns), /快速刷新列/);
assert.equal(parseTagPlacement("name"), "name");
assert.equal(parseTagPlacement(""), "message");
assert.equal(normalizeTagColor("green"), "#00a884");
assert.equal(normalizeTagColor("Green"), "#00a884");
assert.equal(normalizeTagColor("绿色"), "#00a884");
assert.equal(normalizeTagColor("红色"), "#e5484d");
assert.equal(normalizeTagColor("#E5484D"), "#e5484d");
assert.equal(toColorInputValue("#abc"), "#aabbcc");
assert.deepEqual(parseTagColors("Normale正常 = Green\nD|VIP=#e5484d"), [
  { column: "", text: "Normale正常", color: "#00a884" },
  { column: "D", text: "VIP", color: "#e5484d" }
]);
assert.equal(
  tagColorsToText([{ text: "Normale正常", color: "green" }, { column: "D", text: "VIP", color: "#e5484d" }]),
  "Normale正常=#00a884\nD|VIP=#e5484d"
);
assert.equal(resolveTagColor("Normale正常", "D", parseTagColors("Normale正常=green")), "#00a884");
assert.equal(resolveTagColor("VIP客户", "D", parseTagColors("D|VIP=red")), "#e5484d");
// Contains keyword (default): full cell text need not equal the rule text.
assert.equal(
  resolveTagColor("拉-下听了17分钟", "D", parseTagColors("下=green\n上=red")),
  "#00a884"
);
assert.equal(
  resolveTagColor("已经接上了电话", "D", parseTagColors("下=green\n上=red")),
  "#e5484d"
);
// Longer keyword wins over shorter substring.
assert.equal(
  resolveTagColor("Pas encore reçu没接上", "D", parseTagColors("上=red\n没接上=orange")),
  "#f59e0b"
);
assert.equal(typeof fallbackTagColor("hello"), "string");
assert.equal(columnsToText(resultColumns), "D=等级\nBI=负责人\nBJ");

assert.deepEqual(parseTabNames("客户资料\n历史客户, 客户资料"), ["客户资料", "历史客户"]);
assert.deepEqual(parseCsv('号码,备注\r\n"123","含,逗号"\r\n"456","两行\n文字"'), [
  ["号码", "备注"],
  ["123", "含,逗号"],
  ["456", "两行\n文字"]
]);
assert.equal(
  spreadsheetId("https://docs.google.com/spreadsheets/d/abc-123_X/edit"),
  "abc-123_X"
);

const prepared = prepareSource({
  sheetId: "https://docs.google.com/spreadsheets/d/abc-123_X/edit",
  tabName: "客户资料\n历史",
  phoneColumn: "aa",
  resultColumns: "D=等级\nBI=负责人",
  editableColumns: "D",
  tagColumns: "D",
  tagColors: "VIP=red"
});
assert.equal(prepared.sheetId, "abc-123_X");
assert.deepEqual(prepared.tabNames, ["客户资料", "历史"]);
assert.equal(prepared.phoneIndex, 26);
assert.deepEqual(prepared.keepColumns, [26, 3, 60]);
assert.deepEqual(prepared.editableColumns, ["D"]);
assert.deepEqual(prepared.tagColumns, ["D"]);
assert.deepEqual(prepared.tagColors, [{ column: "", text: "VIP", color: "#e5484d" }]);
assert.equal(prepared.editableSet.has("D"), true);
assert.equal(prepared.editableSet.has("BI"), false);

const soft = prepareSource({
  sheetId: "abc-123_X",
  tabName: "客户资料",
  phoneColumn: "AA",
  resultColumns: "D=等级\nBJ=备注",
  editableColumns: "A"
}, 0, { strictOptional: false });
assert.deepEqual(soft.editableColumns, []);
assert.throws(
  () => prepareSource({
    sheetId: "abc-123_X",
    tabName: "客户资料",
    phoneColumn: "AA",
    resultColumns: "D=等级",
    editableColumns: "A"
  }),
  /可编辑列 A/
);

console.log("测试通过");
