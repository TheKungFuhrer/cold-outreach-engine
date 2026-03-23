/**
 * CSV read/write helpers using csv-parse and csv-stringify.
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { ensureDir } = require("./utils");

/**
 * Read a CSV file, returning records and column names.
 * @param {string} filepath
 * @returns {{ records: object[], columns: string[] }}
 */
function readCsv(filepath) {
  if (!fs.existsSync(filepath)) return { records: [], columns: [] };
  let raw = fs.readFileSync(filepath, "utf8");
  // Strip BOM
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const records = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true });
  const columns = records.length > 0 ? Object.keys(records[0]) : [];
  return { records, columns };
}

/**
 * Write records to a CSV file.
 * @param {string} filepath
 * @param {object[]} records
 * @param {string[]} [columns] - if omitted, derived from first record
 */
function writeCsv(filepath, records, columns) {
  ensureDir(path.dirname(filepath));
  if (!columns && records.length > 0) columns = Object.keys(records[0]);
  fs.writeFileSync(filepath, stringify(records, { header: true, columns }));
}

/**
 * Stream CSV files matching a glob pattern, calling onRecord for each row.
 * Processes files one at a time to keep memory low.
 * @param {string[]} filePaths - array of file paths to process
 * @param {(record: object, filePath: string) => void} onRecord
 */
function streamCsvFiles(filePaths, onRecord) {
  for (const fp of filePaths) {
    let raw;
    try {
      raw = fs.readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const records = parse(raw, { columns: true, skip_empty_lines: true, relax_column_count: true });
    for (const record of records) {
      onRecord(record, fp);
    }
  }
}

/**
 * Find a field value by trying multiple candidate column names.
 * @param {object} row
 * @param {string[]} candidates
 * @returns {string}
 */
function findField(row, candidates) {
  for (const f of candidates) {
    const val = row[f];
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return "";
}

module.exports = { readCsv, writeCsv, streamCsvFiles, findField };
