/** Regenerate the explicitly synthetic Excel examples with Node 22.18+ or Node 24+. */
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as XLSX from "xlsx";
import { demoRecords } from "../lib/analytics.ts";

const directory = fileURLToPath(new URL("../examples/", import.meta.url));
await mkdir(directory, { recursive: true });
const headers = ["Task Id", "Client Id", "Question", "Time", "Answer", "Scene"];
const dateSerial = (time) => (Date.parse(`${time}Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;

function workbook(name, records) {
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...records.map((r) => [r.taskId, r.clientId, r.question, dateSerial(r.time), r.answer, r.scene]),
  ]);
  sheet["!cols"] = [{ wch: 27 }, { wch: 18 }, { wch: 54 }, { wch: 22 }, { wch: 80 }, { wch: 22 }];
  sheet["!autofilter"] = { ref: sheet["!ref"] };
  for (let row = 2; row <= records.length + 1; row++) sheet[`D${row}`].z = "m/d/yyyy h:mm";
  const book = XLSX.utils.book_new();
  book.Props = { Title: "FMEMate synthetic example — not production data", Subject: "Excel import format and Task Id deduplication example", Author: "FMEMate Project Pulse" };
  XLSX.utils.book_append_sheet(book, sheet, "Logs");
  XLSX.writeFile(book, path.join(directory, name), { compression: true });
}

const sample = demoRecords.filter((r) => r.date === "2026-10-23").slice(0, 20);
const additional = sample.slice(10).map((r, i) => ({
  ...r,
  taskId: `DEMO-20261024-${String(i + 1).padStart(3, "0")}`,
  date: "2026-10-24",
  time: `2026-10-24${r.time.slice(10)}`,
}));
workbook("FMEmate_Sample_Logs.xlsx", sample);
workbook("FMEmate_Blank_Template.xlsx", []);
workbook("FMEmate_Overlap_Logs.xlsx", [...sample.slice(0, 10), ...additional]);
console.log("Generated examples: 20 sample rows; header-only template; 10 overlapping + 10 new rows.");
