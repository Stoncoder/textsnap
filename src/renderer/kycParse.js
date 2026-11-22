// Free offline KYC mode: turns OCR text lines into PAN / Aadhaar / Bank passbook fields.
// Rules: values are copied as the OCR read them (only stray symbols at the edges and,
// for ID numbers, spaces are removed). Nothing is guessed: if a value can't be found
// cleanly it becomes "UNREADABLE" (or "NOT FOUND" for fields many cards don't print).
import { validateField } from './validate.js';

const HIGH_CONF = 85; // tesseract line confidence (0-100) needed for "High"
const DEVANAGARI = /[ऀ-ॿ]/;
const PAN_RE = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/;
const AADHAAR_RE = /(?<![\d])(\d{4}\s?\d{4}\s?\d{4})(?![\d])/;
const IFSC_RE = /\b([A-Z]{4}0[A-Z0-9]{6})\b/;
const DATE_RE = /\b(\d{2}[/\-.]\d{2}[/\-.]\d{4})\b/;

// Removes Hindi text and stray OCR symbols from the start/end of a value.
function englishPart(text) {
  // "नाम / Name" style bilingual text: drop only the "/"-separated parts written in Hindi.
  let t = text;
  if (DEVANAGARI.test(t)) {
    t = t
      .split(/\s*\/\s*/)
      .filter((part) => part && !DEVANAGARI.test(part))
      .join(' / ');
  }
  return t
    .replace(/[ऀ-ॿ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.)]+$/g, '')
    .trim();
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();

function looksLikeName(v) {
  if (!v || v.length < 3 || v.length > 60) return false;
  const letters = (v.match(/[A-Za-z]/g) || []).length;
  if (letters / v.replace(/\s/g, '').length < 0.9) return false;
  if (/\d/.test(v)) return false;
  return /^[A-Za-z][A-Za-z .']*$/.test(v);
}

const field = (value, lines, extraOk = true) => {
  const conf = lines.length ? Math.min(...lines.map((l) => l.confidence)) : 0;
  return { value, confidence: conf >= HIGH_CONF && extraOk ? 'High' : 'Low' };
};
const unreadable = () => ({ value: 'UNREADABLE', confidence: 'Low' });
const notFound = () => ({ value: 'NOT FOUND', confidence: 'Low' });

function withValidation(key, f) {
  if (f.value === 'UNREADABLE' || f.value === 'NOT FOUND') return f;
  if (!validateField(key, f.value).ok) f.confidence = 'Low';
  return f;
}

// ---------- Document type ----------
export function detectType(lines) {
  const all = lines.map((l) => l.text).join('\n');
  const low = norm(all);
  const score = { PAN: 0, AADHAAR: 0, BANK_PASSBOOK: 0 };
  if (/income tax/.test(low)) score.PAN += 3;
  if (/permanent account number/.test(low)) score.PAN += 3;
  if (PAN_RE.test(all)) score.PAN += 2;
  if (/aadhaar|aadhar|unique identification|uidai/.test(low)) score.AADHAAR += 3;
  if (/आधार/.test(all)) score.AADHAAR += 3;
  if (/\bvid\b/.test(low)) score.AADHAAR += 1;
  if (/\b(male|female)\b/.test(low)) score.AADHAAR += 1;
  if (/authority of india/.test(low)) score.AADHAAR += 2;
  const aadhaarNums = lines
    .filter((l) => !/vid/i.test(l.text))
    .map((l) => (l.text.match(AADHAAR_RE) || [])[1])
    .filter(Boolean)
    .map((n) => n.replace(/\s/g, ''));
  if (aadhaarNums.length) score.AADHAAR += 2;
  if (aadhaarNums.some((n) => validateField('aadhaar_number', n).ok)) score.AADHAAR += 2; // passes the checksum
  if (/\b[sdc]\s*\/\s*o\b/i.test(all) && /\b\d{6}\b/.test(all)) score.AADHAAR += 1;
  if (/\bifsc\b/.test(low)) score.BANK_PASSBOOK += 3;
  if (IFSC_RE.test(all)) score.BANK_PASSBOOK += 2;
  if (/pass ?book/.test(low)) score.BANK_PASSBOOK += 2;
  if (/\b(a\/?c|account) ?(no|number)\b/.test(low)) score.BANK_PASSBOOK += 2;
  if (/\bbank\b/.test(low)) score.BANK_PASSBOOK += 1;
  if (/\b(micr|cif)\b/.test(low)) score.BANK_PASSBOOK += 1;

  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  // Must be clearly one type; otherwise say Unknown instead of guessing.
  if (best[1] < 4 || best[1] - second[1] < 2) return { type: 'UNKNOWN', score: best[1] };
  return { type: best[0], score: best[1] };
}

// Value on the same line after the label ("Name : X") or on the next line.
function afterLabel(lines, labelRe, { skip } = {}) {
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text;
    const m = t.match(labelRe);
    if (!m || (skip && skip.test(t))) continue;
    // Remove the label itself (in English and Hindi) from what follows it.
    const rest = englishPart(
      t.slice(m.index + m[0].length).replace(new RegExp(labelRe.source, 'gi'), ' ').replace(/^[\s:\-.|/]+/, '')
    ).replace(/^(name|father'?s? name|date of birth)\b\s*[:\-]?\s*/i, '');
    if (rest.length >= 2) return { value: rest, lines: [lines[i]] };
    for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
      const v = englishPart(lines[j].text);
      if (v.length >= 2 && !/^(name|father'?s? name|date of birth|address)$/i.test(v)) return { value: v, lines: [lines[j]] };
    }
    return { value: '', lines: [] };
  }
  return null;
}

// ---------- PAN ----------
function parsePan(lines) {
  const out = {};
  const panLine = lines.find((l) => PAN_RE.test(l.text));
  out.pan_number = panLine ? field(panLine.text.match(PAN_RE)[1], [panLine]) : unreadable();

  const dobLine = lines.find((l) => DATE_RE.test(l.text));
  out.date_of_birth = dobLine ? field(dobLine.text.match(DATE_RE)[1], [dobLine]) : unreadable();

  // New-style card: "Name" and "Father's Name" labels.
  const fatherRe = /father'?s?\s*name|पिता/i;
  const nameHit = afterLabel(lines, /\bname\b|नाम/i, { skip: fatherRe });
  const fatherHit = afterLabel(lines, fatherRe);
  let name = nameHit && looksLikeName(nameHit.value) ? nameHit : null;
  let father = fatherHit && looksLikeName(fatherHit.value) ? fatherHit : null;

  // Old-style card: name and father's name are the two English lines above the date of birth.
  if ((!name || !father) && dobLine) {
    const dobIdx = lines.indexOf(dobLine);
    const headerIdx = lines.findIndex((l) => /govt|government|department/i.test(l.text));
    const candidates = lines
      .slice(Math.max(headerIdx + 1, 0), dobIdx)
      .map((l) => ({ l, v: englishPart(l.text) }))
      .filter(({ v }) => looksLikeName(v) && !/income|tax|govt|india|department|account|number|card|signature/i.test(v));
    if (!name && candidates[0]) name = { value: candidates[0].v, lines: [candidates[0].l] };
    if (!father && candidates[1]) father = { value: candidates[1].v, lines: [candidates[1].l] };
  }
  out.name = name ? field(name.value, name.lines) : unreadable();
  out.fathers_name = father ? field(father.value, father.lines) : unreadable();
  return out;
}

// ---------- Aadhaar ----------
function parseAadhaar(lines) {
  const out = {};
  // 12-digit number (never the 16-digit VID).
  const candidates = [];
  for (const l of lines) {
    if (/\bvid\b/i.test(l.text)) continue;
    const m = l.text.match(AADHAAR_RE);
    if (m) candidates.push({ value: m[1].replace(/\s/g, ''), line: l });
  }
  const valid = candidates.find((c) => validateField('aadhaar_number', c.value).ok);
  const pick = valid || candidates[0];
  out.aadhaar_number = pick ? field(pick.value, [pick.line]) : unreadable();

  // Name: the English line just above "DOB" / "Year of Birth" / gender.
  const dobIdx = lines.findIndex((l) => /\b(dob|d\.o\.b|date of birth|year of birth|yob)\b|जन्म/i.test(l.text));
  const genderIdx = lines.findIndex((l) => /\b(male|female)\b/i.test(l.text));
  const anchor = dobIdx >= 0 ? dobIdx : genderIdx;
  let name = null;
  if (anchor > 0) {
    for (let i = anchor - 1; i >= Math.max(0, anchor - 3); i--) {
      const v = englishPart(lines[i].text);
      if (looksLikeName(v) && !/government|india|aadhaar|identification/i.test(v)) { name = { value: v, lines: [lines[i]] }; break; }
    }
  }
  const isBack = /address|पता/i.test(lines.map((l) => l.text).join(' '));
  out.name = name ? field(name.value, name.lines) : isBack ? notFound() : unreadable();

  // Address (usually on the back): from "Address" up to the line with the 6-digit PIN code.
  let addrIdx = lines.findIndex((l) => /\baddress\b/i.test(l.text));
  if (addrIdx < 0) addrIdx = lines.findIndex((l) => /पता/.test(l.text));
  let addressLines = [];
  if (addrIdx >= 0) {
    for (let i = addrIdx; i < Math.min(lines.length, addrIdx + 12); i++) {
      let t = i === addrIdx ? lines[i].text.replace(/.*?(address|पता)\s*[:\-]?/i, '') : lines[i].text;
      t = englishPart(t);
      if (t) addressLines.push({ text: t, line: lines[i] });
      if (/\b\d{6}\b/.test(t)) break; // English PIN code ends the address
    }
  }
  const addressText = addressLines.map((a) => a.text).join(', ').replace(/,\s*,/g, ',');
  out.address = addressLines.length
    ? field(addressText, addressLines.map((a) => a.line), /\b\d{6}\b/.test(addressText))
    : notFound();

  // Father's name: "S/O: Name" or "D/O: Name" (often at the start of the address).
  const all = lines.map((l) => l.text);
  let father = null;
  for (let i = 0; i < all.length; i++) {
    const m = all[i].match(/\b([SD])\s*\/\s*O\s*[:\-]?\s*([A-Za-z][A-Za-z .]+?)(?:,|$)/i) || all[i].match(/father'?s?\s*name\s*[:\-]?\s*([A-Za-z][A-Za-z .]+?)(?:,|$)/i);
    if (m) {
      const v = englishPart(m[m.length - 1]);
      if (looksLikeName(v)) { father = { value: v, lines: [lines[i]] }; break; }
    }
  }
  out.fathers_name = father ? field(father.value, father.lines) : notFound();
  return out;
}

// ---------- Bank passbook ----------
function parseBank(lines) {
  const out = {};
  const all = lines.map((l) => l.text).join('\n');

  const ifscLine = lines.find((l) => IFSC_RE.test(l.text));
  if (ifscLine) out.ifsc_code = field(ifscLine.text.match(IFSC_RE)[1], [ifscLine]);
  else {
    const hit = afterLabel(lines, /\bifsc\b(\s*code)?/i);
    out.ifsc_code = hit && hit.value ? field(hit.value.split(' ')[0], hit.lines, false) : unreadable();
  }

  let acct = null;
  for (const l of lines) {
    const m = l.text.match(/\b(?:a\s*[\/l1|iI]?\s*c|account)\s*(?:no|number|num)?\.?\s*[:\-]?\s*([0-9][0-9 ]{7,22}[0-9])/i);
    if (m) { acct = { value: m[1].replace(/\s/g, ''), lines: [l] }; break; }
  }
  out.account_number = acct ? field(acct.value, acct.lines) : unreadable();

  const holder = afterLabel(lines, /\b(account holder'?s?|a\/?c holder|customer|holder)?\s*name\b/i, {
    skip: /branch|bank|father|nominee|guardian|mother|spouse/i,
  });
  out.account_holder_name = holder && looksLikeName(holder.value) ? field(holder.value, holder.lines) : unreadable();

  const bankLine = lines.find((l) => /\bbank\b/i.test(l.text) && !/pass ?book|bank\s*(name|code)\s*:/i.test(l.text));
  const branchHit = afterLabel(lines, /\bbranch(\s*name)?\b/i, { skip: /code/i });
  const parts = [];
  const used = [];
  if (bankLine) { parts.push(englishPart(bankLine.text)); used.push(bankLine); }
  if (branchHit && branchHit.value) { parts.push(branchHit.value); used.push(...branchHit.lines); }
  out.bank_branch_name = parts.length ? field(parts.join(' - '), used, parts.length === 2) : unreadable();
  void all;
  return out;
}

const PARSERS = { PAN: parsePan, AADHAAR: parseAadhaar, BANK_PASSBOOK: parseBank };

// Main entry: OCR lines in, the same result shape the Claude engine returns.
export function parseKyc(lines) {
  const clean = lines.filter((l) => l.text && l.text.trim());
  const { type, score } = detectType(clean);
  if (type === 'UNKNOWN') return { document_type: 'UNKNOWN', fields: {}, checked: false, engine: 'offline', score };
  const fields = PARSERS[type](clean);
  for (const [k, f] of Object.entries(fields)) fields[k] = withValidation(k, f);
  return { document_type: type, fields, checked: false, engine: 'offline', score };
}
