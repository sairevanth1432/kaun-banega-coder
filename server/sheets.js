// CSV / Excel reading shared by the question import and the roster import (from saturday-sprint/server/students.js).
export function parseCSV(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"' && field === '') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

// Excel: first sheet, every cell as text.
export async function rowsFromXlsx(buffer) {
  const readXlsxFile = (await import('read-excel-file/node')).default;
  const out = await readXlsxFile(buffer);
  const data = Array.isArray(out) && out[0] && out[0].data !== undefined ? out[0].data : out;
  return data
    .map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))))
    .filter((r) => r.some((x) => x.trim() !== ''));
}

// Accepts rows, CSV text, { csv } or { xlsxBase64 } (admin upload).
export async function rowsFrom(input) {
  if (Array.isArray(input)) return input;
  if (input && input.xlsxBase64) return rowsFromXlsx(Buffer.from(input.xlsxBase64, 'base64'));
  return parseCSV(input && typeof input === 'object' ? input.csv || '' : input);
}

// Header cell → field name, ignoring case, spaces and punctuation.
export const headerKey = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // no formula injection when opened in Excel
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCSV = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
