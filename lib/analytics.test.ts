import assert from "node:assert/strict";
import test from "node:test";
import { analyze, demoRecords, isCountableClient, isFailure, isMmlEmpty, isMmlScene, isCustomQuestion, normalizeQuestion, parseTime, parseWorkbook, type LogRecord } from "./analytics.ts";

test("preset matching ignores case, whitespace, Unicode punctuation and symbols", () => {
  assert.equal(normalizeQuestion(" Which CELL is faulty？ "), normalizeQuestion("Which cell is faulty?"));
  assert.equal(normalizeQuestion("Help me—analyze this ticket!!!"), normalizeQuestion("help me analyze this ticket"));
  assert.equal(normalizeQuestion("请查询，光功率。"), normalizeQuestion("请查询光功率"));
});

test("US workbook clocks and Excel serials are stable across device timezones", () => {
  assert.deepEqual(parseTime("9/22/2026 16:57"), { date: "2026-09-22", time: "2026-09-22T16:57:00" });
  const serial = (Date.UTC(2026, 8, 22, 16, 57) - Date.UTC(1899, 11, 30)) / 86_400_000;
  assert.deepEqual(parseTime(serial), parseTime("9/22/2026 16:57"));
  assert.equal(parseTime("2026-09-22T16:57:12+07:00")?.time, "2026-09-22T16:57:12");
  assert.equal(parseTime("9/22/2026 12:57 AM")?.time, "2026-09-22T00:57:00");
  assert.equal(parseTime(1)?.date, "1900-01-01");
  assert.equal(parseTime(59)?.date, "1900-02-28");
  assert.equal(parseTime(61)?.date, "1900-03-01");
});

test("invalid dates never roll into a different calendar day", () => {
  for (const value of ["2/30/2026 16:57", "13/22/2026 16:57", "9/22/2026 24:00", "22/9/2026 16:57", "2026-09-31T00:00:00", "junk", "", null, 60]) assert.equal(parseTime(value), null, String(value));
});

const row = (taskId: string, clientId: string, date: string, question: string, answer = "OK", scene = "Ticket diagnosis"): LogRecord => ({ taskId, clientId, date, time: `${date}T16:57:00`, question, answer, scene });

test("Sorry is the only failure rule; an empty MML answer remains normal", () => {
  assert.equal(isFailure({ answer: "I am SORRY: upstream error" }), true);
  assert.equal(isFailure({ answer: "" }), false);
  assert.equal(isMmlEmpty({ answer: " ", scene: " mml " }), true);
  const data = [row("1", "a", "2026-09-22", "Which cell is faulty?", "" , "MML"), row("2", "b", "2026-09-22", "which cell is faulty", "Sorry, error"), row("3", "b", "2026-09-22", "Check temperature", "", "MML")];
  const result = analyze(data, ["Which cell is faulty?"]);
  assert.equal(result.totals.uses, 3);
  assert.equal(result.totals.users, 2);
  assert.equal(result.totals.failures, 1);
  assert.equal(result.totals.mmlEmpty, 2);
  assert.equal(result.totals.custom, 0);
  assert.equal(result.totals.customUsers, 0);
  assert.equal(result.questions[0].uses, 2);
  assert.equal(result.questions[0].users, 2);
  assert.equal(result.failures[0].taskId, "2");
});

test("daily unique users, new vs returning, date filters and prior period use the same population", () => {
  const result = analyze([row("1", "old", "2026-09-20", "a"), row("2", "old", "2026-09-22", "a"), row("3", "new", "2026-09-22", "a"), row("4", "new", "2026-09-22", "b"), row("5", "new", "2026-09-23", "b")], [], "2026-09-22", "2026-09-23");
  assert.equal(result.totals.uses, 4);
  assert.equal(result.totals.newUsers, 1);
  assert.equal(result.totals.returningUsers, 1);
  assert.deepEqual(result.daily.map((d) => d.users), [2, 1]);
  assert.equal(result.previous.uses, 1);
  assert.equal(result.previous.from, "2026-09-20");
  assert.equal(result.previous.to, "2026-09-21");
  assert.equal(result.changes.uses, 300);
  assert.equal(analyze([], []).totals.failureRate, 0);
});

test("demo rows are synthetic and cover 21 dates", () => {
  assert.equal(new Set(demoRecords.map((r) => r.date)).size, 21);
  assert.equal(new Set(demoRecords.map((r) => r.taskId)).size, demoRecords.length);
  assert.ok(demoRecords.every((r) => r.taskId.startsWith("DEMO-") && r.clientId.startsWith("DEMO-")));
});

test("invalid or inverted date filters are safe and enormous ranges remain sparse", () => {
  const data = [row("1", "a", "2026-09-22", "Hello")];
  const invalid = analyze(data, [], "2026-02-30", "bad-date");
  assert.equal(invalid.totals.uses, 1);
  assert.equal(invalid.range.from, "2026-09-22");
  const inverted = analyze(data, [], "2026-09-23", "2026-09-22");
  assert.equal(inverted.totals.uses, 0);
  assert.equal(inverted.range.days, 0);
  assert.deepEqual(inverted.daily, []);
  const huge = analyze(data, [], "1900-01-01", "9999-12-31");
  assert.equal(huge.daily.length, 1);
  assert.equal(huge.range.days, 2_958_464);
  assert.equal(huge.previous.from, "1900-01-01");
});

test("Excel import handles all sheets, formatted IDs, duplicates and rejected rows without loss", async () => {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();
  const serial = (Date.UTC(2026, 8, 22, 16, 57) - Date.UTC(1899, 11, 30)) / 86_400_000;
  const sheet = XLSX.utils.aoa_to_sheet([["Task Id", "Client Id", "Question", "Time", "Answer", "Scene"], [123, "C1", "Which cell is faulty?", serial, "", "MML"], ["T2", "C2", "Help", "9/22/2026 16:57", "Sorry", "Diagnosis"], ["T2", "C2", "Help", "9/22/2026 16:57", "OK", "Diagnosis"], ["T3", "C3", "Bad date", "2/30/2026 16:57", "", ""], ["", "C4", "No task", serial, "", ""]]);
  sheet.A2.z = "000000";
  XLSX.utils.book_append_sheet(book, sheet, "Logs");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Task Id", "Client Id", "Question", "Time"], ["T4", "C4", "Extra sheet", "9/23/2026 08:00"]]), "More");
  const parsed = await parseWorkbook(XLSX.write(book, { type: "array", bookType: "xlsx" }), "test.xlsx");
  assert.equal(parsed.records.length, 4);
  assert.equal(parsed.records[0].taskId, "000123");
  assert.equal(parsed.records[0].time, "2026-09-22T16:57:00");
  assert.equal(parsed.records.filter((r) => r.taskId === "T2").length, 2, "deduplication is owned by durable import, never the parser");
  assert.equal(parsed.rejected.length, 2);
  assert.equal(parsed.rejected[0].row, 5);
  assert.ok(parsed.warnings.some((w) => w.includes("optional columns")));
});

test("partial recognized headers do not silently use positional columns", async () => {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Task Id", "Wrong Client", "Question", "Time"], ["T1", "C1", "Hello", "9/22/2026 16:57"]]), "Bad headers");
  const parsed = await parseWorkbook(XLSX.write(book, { type: "array", bookType: "xlsx" }), "test.xlsx");
  assert.equal(parsed.records.length, 0);
  assert.equal(parsed.rejected.length, 1);
  assert.match(parsed.rejected[0].reason, /clientId/);
});

test("CSV headerless fallback retains its first data row and 1904 workbooks keep calendar dates", async () => {
  const csv = 'T1,C1,Hello,9/22/2026 16:57,OK,MML\r\nT2,C2,Hi,9/23/2026 09:00,,MML';
  const parsed = await parseWorkbook(new TextEncoder().encode(csv).buffer, "logs.csv");
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].taskId, "T1");
  assert.ok(parsed.warnings.some((w) => w.includes("no recognized headers")));
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();
  const serial1904 = (Date.UTC(2026, 8, 22, 16, 57) - Date.UTC(1904, 0, 1)) / 86_400_000;
  book.Workbook = { WBProps: { date1904: true } };
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Task Id", "Client Id", "Question", "Time"], ["T1", "C1", "Hello", serial1904]]), "Logs");
  const oldSystem = await parseWorkbook(XLSX.write(book, { type: "array", bookType: "xlsx" }), "mac.xlsx");
  assert.equal(oldSystem.records[0].time, "2026-09-22T16:57:00");
});

test('empty-scene sentinel filters empty Scene independently of named scenes',()=>{
 const records=[{taskId:'empty-scene',clientId:'c',question:'q',time:'2026-10-23T00:00:00',date:'2026-10-23',answer:'',scene:''},{taskId:'named-scene',clientId:'c',question:'q',time:'2026-10-23T01:00:00',date:'2026-10-23',answer:'ok',scene:'all'}];
 assert.equal(analyze(records,[],undefined,undefined,'\u0000').totals.uses,1);
 assert.equal(analyze(records,[],undefined,undefined,'all').filtered[0].taskId,'named-scene');
});


test("browser IDs keep activity but never inflate people or leaderboards", () => {
  const data = [
    row("p1", "old", "2026-09-20", "Preset"),
    row("p2", "browser", "2026-09-20", "Preset", "Sorry prior"),
    row("p3", " BROWSER ", "2026-09-21", "Custom"),
    row("c1", "old", "2026-09-22", "Preset"),
    row("c2", "browser", "2026-09-22", "Preset", "Sorry current"),
    row("c3", " BROWSER ", "2026-09-22", "Custom", "", "MML"),
    row("c4", "new", "2026-09-23", "Custom"),
    row("c5", "Browser", "2026-09-23", "Custom"),
    row("c6", "new", "2026-09-23", "Custom"),
  ];
  const result = analyze(data, ["Preset"], "2026-09-22", "2026-09-23");
  assert.equal(result.totals.uses, 6);
  assert.equal(result.totals.browserUses, 3);
  assert.equal(result.totals.identifiedUses, 3);
  assert.equal(result.totals.users, 2);
  assert.equal(result.totals.custom, 3);
  assert.equal(result.totals.customUsers, 1);
  assert.equal(result.totals.newUsers, 1);
  assert.equal(result.totals.returningUsers, 1);
  assert.equal(result.totals.failures, 1);
  assert.equal(result.totals.mmlEmpty, 1);
  assert.equal(result.totals.failureRate, 1 / 6 * 100);
  assert.deepEqual(result.users.map(u => u.clientId), ["new", "old"]);
  assert.equal(result.users.reduce((sum, u) => sum + u.uses, 0), 3);
  assert.deepEqual(result.daily.map(d => [d.uses, d.users, d.custom]), [[3, 1, 0], [3, 1, 3]]);
  assert.equal(result.questions.find(q => q.question === "Preset")?.uses, 2);
  assert.equal(result.questions.find(q => q.question === "Preset")?.users, 1);
  assert.equal(result.questions.find(q => q.question === "Custom")?.uses, 4);
  assert.equal(result.questions.find(q => q.question === "Custom")?.users, 1);
  assert.equal(result.previous.uses, 3);
  assert.equal(result.previous.users, 1);
  assert.equal(result.previous.failures, 1);
  assert.equal(result.changes.users, 100);
  assert.equal(result.filtered.find(r => r.taskId === "c3")?.clientId, " BROWSER ");
  assert.equal(result.failures[0].taskId, "c2");
  assert.equal(result.customRecords.length, 3);
  assert.equal(result.scenes.reduce((sum, item) => sum + item.uses, 0), 6);
});

test("browser-only logs have no identifiable people and preserve complete statistics", () => {
  const data = [row("1", "browser", "2026-09-22", "Preset", "Sorry"), row("2", "BROWSER", "2026-09-22", "Custom", "", "MML")];
  const result = analyze(data, ["Preset"]);
  assert.equal(result.totals.uses, 2);
  assert.equal(result.totals.browserUses, 2);
  assert.equal(result.totals.identifiedUses, 0);
  assert.equal(result.totals.users, 0);
  assert.equal(result.totals.customUsers, 0);
  assert.equal(result.totals.newUsers, 0);
  assert.equal(result.totals.returningUsers, 0);
  assert.equal(result.totals.custom, 0);
  assert.equal(result.totals.failures, 1);
  assert.equal(result.totals.failureRate, 50);
  assert.equal(result.totals.mmlEmpty, 1);
  assert.deepEqual(result.users, []);
  assert.equal(result.daily[0].uses, 2);
  assert.equal(result.daily[0].users, 0);
  assert.ok(result.questions.every(q => q.users === 0));
  assert.equal(result.filtered.length, 2);
  assert.equal(result.failures[0].taskId, "1");
  assert.deepEqual(result.customRecords, []);
  assert.equal(isCountableClient(" browser "), false);
  assert.equal(isCountableClient("BrOwSeR"), false);
  assert.equal(isCountableClient("browser-123"), true);
  assert.equal(isCountableClient("real-user"), true);
  const mmlOnly = analyze(data, [], undefined, undefined, "MML");
  assert.equal(mmlOnly.totals.browserUses, 1);
  assert.equal(mmlOnly.totals.uses, 1);
  assert.equal(mmlOnly.totals.users, 0);
});

test("MML is excluded from every custom metric while all other activity remains counted", () => {
  const data = [
    row("m1", "first", "2026-09-22", "Unmatched command", "", " MML "),
    row("m2", "second", "2026-09-22", "Preset?", "Sorry command failed", "mMl"),
    row("m3", "browser", "2026-09-23", "Unknown command", "OK", "mml"),
  ];
  const result = analyze(data, ["Preset"]);
  assert.equal(result.totals.uses, 3);
  assert.equal(result.totals.users, 2);
  assert.equal(result.totals.browserUses, 1);
  assert.equal(result.totals.identifiedUses, 2);
  assert.equal(result.totals.failures, 1);
  assert.equal(result.totals.mmlEmpty, 1);
  assert.equal(result.totals.custom, 0);
  assert.equal(result.totals.customUsers, 0);
  assert.deepEqual(result.customRecords, []);
  assert.deepEqual(result.customQuestions, []);
  assert.ok(result.users.every(u => u.custom === 0));
  assert.ok(result.daily.every(d => d.custom === 0));
  assert.equal(result.questions.reduce((n, q) => n + q.uses, 0), 3);
  assert.ok(result.questions.every(q => q.mmlUses === q.uses && q.customUses === 0 && q.presetUses === 0));
  assert.equal(result.filtered.length, 3);
  assert.equal(result.failures[0].taskId, "m2");
  assert.equal(isMmlScene({ scene: " mMl " }), true);
  assert.equal(isMmlScene({ scene: "MML tool" }), false);
  assert.equal(isCustomQuestion({ scene: " mml ", question: "New question?" }, []), false);
  assert.equal(isCustomQuestion({ scene: "Ticket", question: "Preset?" }, ["preset"]), false);
  assert.equal(isCustomQuestion({ scene: "Ticket", question: "New question?" }, ["preset"]), true);
  assert.equal(isCustomQuestion({ scene: "Ticket", question: "???" }, ["?"]), true, "empty normalized preset keys are ignored consistently");
});

test("mixed MML and normal scenes share frequency but custom ranking uses only eligible rows and people", () => {
  const data = [
    row("m1", "mml-only-person", "2026-09-22", "Same question?", "", "MML"),
    row("c1", "real", "2026-09-22", "same question", "OK", "Ticket"),
    row("c2", "browser", "2026-09-23", "SAME QUESTION!", "Sorry", "Knowledge"),
    row("p1", "real", "2026-09-23", "Preset?", "OK", "Ticket"),
    row("p2", "real", "2026-09-23", "preset", "", "MML"),
  ];
  const result = analyze(data, ["Preset"]);
  assert.equal(result.totals.uses, 5);
  assert.equal(result.totals.users, 2);
  assert.equal(result.totals.custom, 2);
  assert.equal(result.totals.customUsers, 1);
  assert.deepEqual(result.customRecords.map(r => r.taskId), ["c1", "c2"]);
  assert.deepEqual(result.daily.map(d => d.custom), [1, 1]);
  assert.equal(result.users.find(u => u.clientId === "real")?.custom, 1);
  assert.equal(result.users.find(u => u.clientId === "mml-only-person")?.custom, 0);
  const mixed = result.questions.find(q => q.key === normalizeQuestion("same question"))!;
  assert.equal(mixed.uses, 3);
  assert.equal(mixed.users, 2);
  assert.equal(mixed.isPreset, false);
  assert.deepEqual([mixed.mmlUses, mixed.customUses, mixed.presetUses], [1, 2, 0]);
  const preset = result.questions.find(q => q.isPreset)!;
  assert.deepEqual([preset.uses, preset.mmlUses, preset.customUses, preset.presetUses], [2, 1, 0, 1]);
  assert.equal(result.customQuestions.length, 1);
  assert.deepEqual([result.customQuestions[0].uses, result.customQuestions[0].users, result.customQuestions[0].mmlUses, result.customQuestions[0].customUses, result.customQuestions[0].presetUses], [2, 1, 0, 2, 0]);
  assert.ok(result.questions.every(q => q.uses === q.mmlUses + q.customUses + q.presetUses));
});
