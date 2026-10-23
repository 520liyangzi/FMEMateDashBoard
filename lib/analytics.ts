/** Canonical times preserve the wall-clock time in the workbook; no timezone is inferred. */
export type LogRecord = {
  taskId: string;
  clientId: string;
  question: string;
  time: string;
  date: string;
  answer: string;
  scene: string;
};

export type RejectedRow = { sheet: string; row: number; reason: string; values: unknown[] };
export type ParseResult = { records: LogRecord[]; rejected: RejectedRow[]; warnings: string[] };
export type UserRanking = { clientId: string; uses: number; failures: number; custom: number; lastActive: string };
export type QuestionRanking = { question: string; key: string; uses: number; users: number; isPreset: boolean; mmlUses: number; customUses: number; presetUses: number };
export type Analysis = {
  filtered: LogRecord[];
  users: UserRanking[];
  questions: QuestionRanking[];
  /** Only non-MML unmatched rows; uses/users and breakdown are recomputed for this subset. */
  customQuestions: QuestionRanking[];
  customRecords: LogRecord[];
  failures: LogRecord[];
  daily: { date: string; uses: number; users: number; failures: number; custom: number }[];
  scenes: { scene: string; uses: number }[];
  totals: { uses: number; browserUses: number; identifiedUses: number; users: number; failures: number; failureRate: number; custom: number; customUsers: number; mmlEmpty: number; newUsers: number; returningUsers: number };
  previous: { from: string; to: string; uses: number; users: number; failures: number; failureRate: number };
  /** Uses/users changes are percentages; failureRate is the change in percentage points. A null change means no prior baseline. */
  changes: { uses: number | null; users: number | null; failureRate: number };
  range: { from: string; to: string; days: number };
};

const DAY = 86_400_000;
const pad = (v: number) => String(v).padStart(2, "0");

function calendarParts(y: number, m: number, d: number, h = 0, min = 0, sec = 0) {
  if (![y, m, d, h, min, sec].every(Number.isInteger) || y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31 || h < 0 || h > 23 || min < 0 || min > 59 || sec < 0 || sec > 59) return null;
  const date = new Date(Date.UTC(y, m - 1, d, h, min, sec));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const day = `${y}-${pad(m)}-${pad(d)}`;
  return { time: `${day}T${pad(h)}:${pad(min)}:${pad(sec)}`, date: day };
}

/** Excel serial dates and explicit M/D/YYYY or ISO wall-clock strings; never guesses D/M/YYYY. */
export function parseTime(value: unknown): { time: string; date: string } | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return calendarParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds());
  }
  if (typeof value === "number" || (typeof value === "string" && /^\d{1,7}(?:\.\d+)?$/.test(value.trim()))) {
    const serial = Number(value);
    if (!Number.isFinite(serial) || serial <= 0 || serial >= 2_958_466 || Math.floor(serial) === 60) return null;
    // Excel pretends 1900 was a leap year. Serial 60 has no real calendar date.
    const epoch = Date.UTC(1899, 11, serial < 60 ? 31 : 30);
    const stamp = epoch + Math.round(serial * 86_400) * 1000;
    const date = new Date(stamp);
    return calendarParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
  }
  if (typeof value !== "string") return null;
  const v = value.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?)?$/i.exec(v);
  if (us) {
    let h = Number(us[4] ?? 0);
    if (us[7]) {
      if (h < 1 || h > 12) return null;
      h = h % 12 + (us[7].toUpperCase() === "PM" ? 12 : 0);
    }
    return calendarParts(+us[3], +us[1], +us[2], h, +(us[5] ?? 0), +(us[6] ?? 0));
  }
  // Offsets are retained as the clock shown in the input, rather than shifted to this device's zone.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)?)?$/.exec(v);
  if (iso) return calendarParts(+iso[1], +iso[2], +iso[3], +(iso[4] ?? 0), +(iso[5] ?? 0), +(iso[6] ?? 0));
  return null;
}

/** Same question despite case, whitespace, ASCII/Unicode punctuation and symbols. */
export function normalizeQuestion(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

/** The collapsed browser ID cannot identify a person; its activity is still counted. */
export function isCountableClient(clientId: string): boolean {
  return clientId.trim().toLowerCase() !== "browser";
}

export function isFailure(record: Pick<LogRecord, "answer">): boolean {
  return /sorry/i.test(record.answer);
}

export function isMmlScene(record: Pick<LogRecord, "scene">): boolean {
  return record.scene.trim().toUpperCase() === "MML";
}

/** MML is excluded even when its question does not match a configured preset. */
export function isCustomQuestion(record: Pick<LogRecord, "scene" | "question">, presets: readonly string[]): boolean {
  const key = normalizeQuestion(record.question);
  return !isMmlScene(record) && !presets.some(preset => { const presetKey = normalizeQuestion(preset); return !!presetKey && presetKey === key; });
}

export function isMmlEmpty(record: Pick<LogRecord, "scene" | "answer">): boolean {
  return isMmlScene(record) && !record.answer.trim();
}

const headerAliases: Record<keyof Omit<LogRecord, "date">, string[]> = {
  taskId: ["taskid", "taskidentifier", "任务id", "任务编号"],
  clientId: ["clientid", "clientidentifier", "客户id", "用户id", "客户编号", "用户编号"],
  question: ["question", "questions", "query", "问题", "提问"],
  time: ["time", "timestamp", "datetime", "createtime", "createdtime", "createdat", "时间", "提问时间"],
  answer: ["answer", "response", "回答", "回复"],
  scene: ["scene", "scenario", "场景"],
};
const required = ["taskId", "clientId", "question", "time"] as const;

/** Reads all nonempty worksheets. Row numbers are 1-based Excel row numbers. */
export async function parseWorkbook(buffer: ArrayBuffer, fileName: string): Promise<ParseResult> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(buffer, { type: "array", cellDates: false, cellText: true, cellNF: true, dense: false });
  const result: ParseResult = { records: [], rejected: [], warnings: [] };
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    if (!sheet?.["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const rows: { index: number; values: unknown[] }[] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const values: unknown[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) values.push(sheet[XLSX.utils.encode_cell({ r, c })]?.v ?? "");
      if (values.some((v) => String(v ?? "").trim() !== "")) rows.push({ index: r, values });
    }
    if (!rows.length) continue;
    const mapFor = (values: unknown[]) => {
      const map: Partial<Record<keyof Omit<LogRecord, "date">, number>> = {};
      values.forEach((v, index) => {
        const key = normalizeQuestion(v);
        for (const [field, aliases] of Object.entries(headerAliases)) if (aliases.includes(key) && map[field as keyof typeof map] === undefined) map[field as keyof typeof map] = index;
      });
      return map;
    };
    let headerPosition = rows.slice(0, 30).findIndex((row) => required.every((k) => mapFor(row.values)[k] !== undefined));
    let map = headerPosition >= 0 ? mapFor(rows[headerPosition].values) : mapFor(rows[0].values);
    let start = headerPosition >= 0 ? headerPosition + 1 : 1;
    if (Object.keys(map).length === 0) {
      map = { taskId: 0, clientId: 1, question: 2, time: 3, answer: 4, scene: 5 };
      start = parseTime(rows[0].values[3]) ? 0 : 1;
      result.warnings.push(`${sheetName}: no recognized headers; using the first six columns in Task Id / Client Id / Question / Time / Answer / Scene order.`);
    } else {
      const missing = required.filter((k) => map[k] === undefined);
      if (missing.length) {
        const reason = `Missing required columns: ${missing.join(", ")}`;
        result.warnings.push(`${sheetName}: ${reason}. This worksheet was not imported.`);
        rows.slice(1).forEach((row) => result.rejected.push({ sheet: sheetName, row: row.index + 1, reason, values: row.values }));
        continue;
      }
      const optional = (["answer", "scene"] as const).filter((k) => map[k] === undefined);
      if (optional.length) result.warnings.push(`${sheetName}: optional columns absent (${optional.join(", ")}); these values are empty.`);
    }
    for (const row of rows.slice(start)) {
      const get = (field: keyof typeof map, formatted = false) => {
        const column = map[field];
        if (column === undefined) return "";
        const cell = sheet[XLSX.utils.encode_cell({ r: row.index, c: range.s.c + column })];
        if (!cell) return "";
        if (formatted && typeof cell.v === "number") return String(cell.w ?? XLSX.utils.format_cell(cell));
        return cell.v ?? "";
      };
      const taskId = String(get("taskId", true)).trim();
      const clientId = String(get("clientId", true)).trim();
      const question = String(get("question")).trim();
      const rawTime = get("time");
      // Mac-origin workbooks may use Excel's alternate 1904 date system.
      const date1904 = book.Workbook?.WBProps?.date1904;
      const parsed = parseTime(typeof rawTime === "number" && date1904 ? rawTime + 1462 : rawTime);
      const reason = !taskId ? "Task Id is empty" : !clientId ? "Client Id is empty" : !question ? "Question is empty" : !parsed ? "Invalid Time; expected M/D/YYYY H:mm or an Excel date" : "";
      if (reason || !parsed) {
        result.rejected.push({ sheet: sheetName, row: row.index + 1, reason, values: row.values });
        continue;
      }
      for (const field of ["taskId", "clientId"] as const) if (typeof get(field) === "number" && !Number.isSafeInteger(get(field) as number)) result.warnings.push(`${sheetName} row ${row.index + 1}: numeric ${field} exceeds safe precision; use a text-formatted ID in the source workbook.`);
      result.records.push({ taskId, clientId, question, ...parsed, answer: String(get("answer")), scene: String(get("scene")).trim() });
    }
  }
  if (!result.records.length && !result.rejected.length) result.warnings.push(`${fileName}: no data rows found.`);
  result.warnings = [...new Set(result.warnings)];
  return result;
}

const dateStamp = (date: string) => Date.parse(`${date}T00:00:00Z`);
const dayString = (stamp: number) => new Date(stamp).toISOString().slice(0, 10);
const percentageChange = (current: number, previous: number) => previous ? ((current - previous) / previous) * 100 : current ? null : 0;

export function analyze(records: LogRecord[], presets: string[], from?: string, to?: string, scene?: string): Analysis {
  const validDate = (date: unknown): date is string => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && parseTime(date)?.date === date;
  const dates = records.map((r) => r.date).filter(validDate).sort();
  const start = validDate(from) ? from : dates[0] || new Date().toISOString().slice(0, 10);
  const end = validDate(to) ? to : dates[dates.length - 1] || start;
  const days = Math.max(0, Math.round((dateStamp(end) - dateStamp(start)) / DAY) + 1);
  const sceneMatches = (r: LogRecord) => !scene || (scene === "\u0000" ? !r.scene : r.scene === scene);
  const filtered = records.filter((r) => r.date >= start && r.date <= end && sceneMatches(r));
  const presetKeys = new Set(presets.map(normalizeQuestion).filter(Boolean));
  const userMap = new Map<string, UserRanking>();
  const questions = new Map<string, { question: string; key: string; uses: number; clients: Set<string>; customClients: Set<string>; isPreset: boolean; mmlUses: number; customUses: number; presetUses: number }>();
  const firstSeen = new Map<string, string>();
  for (const r of records) if (isCountableClient(r.clientId) && (!firstSeen.has(r.clientId) || r.date < firstSeen.get(r.clientId)!)) firstSeen.set(r.clientId, r.date);
  const dailyMap = new Map<string, { date: string; uses: number; clients: Set<string>; failures: number; custom: number }>();
  // Dense daily charts remain bounded for malformed or extremely broad date ranges.
  if (days <= 3660) for (let stamp = dateStamp(start); stamp <= dateStamp(end); stamp += DAY) {
    const date = dayString(stamp);
    dailyMap.set(date, { date, uses: 0, clients: new Set(), failures: 0, custom: 0 });
  }
  const sceneMap = new Map<string, number>();
  const failures: LogRecord[] = [], customRecords: LogRecord[] = [];
  let mmlEmpty = 0, browserUses = 0;
  const customUsers = new Set<string>();
  for (const r of filtered) {
    const fail = isFailure(r), key = normalizeQuestion(r.question), preset = presetKeys.has(key), countable = isCountableClient(r.clientId), mml = isMmlScene(r), custom = !mml && !preset;
    if (!countable) browserUses++;
    if (countable) {
      const u = userMap.get(r.clientId) || { clientId: r.clientId, uses: 0, failures: 0, custom: 0, lastActive: r.time };
      u.uses++; u.failures += +fail; u.custom += +custom; if (r.time > u.lastActive) u.lastActive = r.time; userMap.set(r.clientId, u);
    }
    const q = questions.get(key) || { question: r.question, key, uses: 0, clients: new Set<string>(), customClients: new Set<string>(), isPreset: preset, mmlUses: 0, customUses: 0, presetUses: 0 };
    q.uses++; q.mmlUses += +mml; q.customUses += +custom; q.presetUses += +(!mml && preset); if (countable) { q.clients.add(r.clientId); if (custom) q.customClients.add(r.clientId); } questions.set(key, q);
    const d = dailyMap.get(r.date) || { date: r.date, uses: 0, clients: new Set<string>(), failures: 0, custom: 0 };
    d.uses++; if (countable) d.clients.add(r.clientId); d.failures += +fail; d.custom += +custom; dailyMap.set(r.date, d);
    sceneMap.set(r.scene, (sceneMap.get(r.scene) ?? 0) + 1);
    if (fail) failures.push(r);
    if (custom) { customRecords.push(r); if (countable) customUsers.add(r.clientId); }
    if (isMmlEmpty(r)) mmlEmpty++;
  }
  const questionOrder = (a: QuestionRanking, b: QuestionRanking) => b.uses - a.uses || a.question.localeCompare(b.question);
  const rankedQuestions = [...questions.values()].map(({ clients, customClients, ...q }) => ({ ...q, users: clients.size })).sort(questionOrder);
  const rankedCustomQuestions = [...questions.values()].filter(q => q.customUses > 0).map(({ clients, customClients, ...q }) => ({ ...q, uses: q.customUses, users: customClients.size, mmlUses: 0, presetUses: 0 })).sort(questionOrder);
  const previousEnd = dayString(dateStamp(start) - DAY);
  // A previous comparison can predate the minimum supported workbook year;
  // no imported records can exist there, so bound the query to that minimum.
  const previousStart = dayString(Math.max(Date.UTC(1900, 0, 1), dateStamp(start) - days * DAY));
  const prior = records.filter((r) => r.date >= previousStart && r.date <= previousEnd && sceneMatches(r));
  const priorUsers = new Set(prior.filter((r) => isCountableClient(r.clientId)).map((r) => r.clientId)).size;
  const priorFailures = prior.filter(isFailure).length;
  const failureRate = filtered.length ? failures.length / filtered.length * 100 : 0;
  const priorFailureRate = prior.length ? priorFailures / prior.length * 100 : 0;
  const newUsers = [...userMap.keys()].filter((id) => (firstSeen.get(id) ?? "") >= start).length;
  return {
    filtered,
    users: [...userMap.values()].sort((a, b) => b.uses - a.uses || a.clientId.localeCompare(b.clientId)),
    questions: rankedQuestions,
    customQuestions: rankedCustomQuestions,
    customRecords,
    failures: failures.sort((a, b) => b.time.localeCompare(a.time)),
    daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map(({ clients, ...d }) => ({ ...d, users: clients.size })),
    scenes: [...sceneMap].map(([scene, uses]) => ({ scene, uses })).sort((a, b) => b.uses - a.uses),
    totals: { uses: filtered.length, browserUses, identifiedUses: filtered.length - browserUses, users: userMap.size, failures: failures.length, failureRate, custom: customRecords.length, customUsers: customUsers.size, mmlEmpty, newUsers, returningUsers: userMap.size - newUsers },
    previous: { from: previousStart, to: previousEnd, uses: prior.length, users: priorUsers, failures: priorFailures, failureRate: priorFailureRate },
    changes: { uses: percentageChange(filtered.length, prior.length), users: percentageChange(userMap.size, priorUsers), failureRate: failureRate - priorFailureRate },
    range: { from: start, to: end, days },
  };
}

/** Explicitly synthetic preview data. Never write these rows to the real database. */
export const demoRecords: LogRecord[] = (() => {
  const list: LogRecord[] = [];
  const prompts = [
    ["Help me analyze this ticket", "Ticket diagnosis"],
    ["Help me analyze this ticket?", "Ticket diagnosis"],
    ["Query the optical power", "Network query"],
    ["Which cell is faulty?", "Ticket diagnosis"],
    ["Any other alarms?", "Network query"],
    ["Is the alarm cleared?", "Network query"],
    ["Can you check why this site is still down?", "Ticket diagnosis"],
    ["Show me the board temperature", "MML"],
    ["How do I restore the link after a power outage?", "Knowledge"],
    ["Query the board model", "Network query"],
    ["Please check the fan speed", "MML"],
    ["What should I check before visiting the site?", "Knowledge"],
  ];
  for (let day = 0; day < 21; day++) {
    const date = dayString(Date.UTC(2026, 9, 3 + day));
    const count = 19 + Math.floor(day * 2.1) + (day % 5) * 3;
    const available = Math.min(48, 12 + day * 2);
    for (let i = 0; i < count; i++) {
      const pick = i % 5 === 0 ? 0 : (day * 3 + i * 7) % prompts.length;
      const [question, scene] = prompts[pick];
      const hour = 8 + (i % 11), minute = (i * 13 + day * 7) % 60;
      const fail = (day * 19 + i) % 23 === 0;
      const answer = fail ? "Sorry, I could not retrieve the diagnosis result. Please try again later." : scene === "MML" ? "" : "The query completed. Diagnosis results and next actions are available.";
      list.push({ taskId: `DEMO-${date.replaceAll("-", "")}-${String(i + 1).padStart(3, "0")}`, clientId: `DEMO-C${String(i < 8 ? i % 3 + 1 : (i * 7 + day) % available + 1).padStart(3, "0")}`, question, time: `${date}T${pad(hour)}:${pad(minute)}:00`, date, answer, scene });
    }
  }
  return list;
})();
