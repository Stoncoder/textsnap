// Turns raw OCR lines (with word boxes + confidence) into clean, readable text.
//  - cleanLines():   removes OCR "noise" (stray marks from photos, holograms, backgrounds)
//  - toPlainText():  clean text with paragraphs
//  - formatFields(): for ID cards / forms, pairs each printed label with its value
//                    ("Surname: FARR"), plus a passport MRZ reader with check digits.
// Values are always copied as the OCR read them; only labels are tidied.

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;
const alnumCount = (s) => (s.match(LETTER_OR_DIGIT) || []).length;
const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};
const isMrzText = (t) => /<{2,}/.test(t) || (/</.test(t) && /^[A-Z0-9<]{30,}$/.test(t.replace(/\s/g, '')));

function lineBox(words) {
  return {
    x0: Math.min(...words.map((w) => w.x0)),
    y0: Math.min(...words.map((w) => w.y0)),
    x1: Math.max(...words.map((w) => w.x1)),
    y1: Math.max(...words.map((w) => w.y1)),
  };
}

// ---------- 1. Noise removal ----------
export function cleanLines(lines) {
  const goodHeights = [];
  for (const l of lines) for (const w of l.words || []) if (w.conf >= 70 && alnumCount(w.text) >= 2) goodHeights.push(w.y1 - w.y0);
  const h = median(goodHeights) || 20;

  const out = [];
  for (const line of lines) {
    const words = [...(line.words || [])].sort((a, b) => a.x0 - b.x0);
    if (!words.length) continue;
    const mrzLine = isMrzText(line.text);
    const kept = words.filter((w, i) => {
      if (mrzLine) return true;
      const a = alnumCount(w.text);
      const prev = words[i - 1];
      const next = words[i + 1];
      const gapL = prev ? w.x0 - prev.x1 : Infinity;
      const gapR = next ? next.x0 - w.x1 : Infinity;
      const isolated = Math.min(gapL, gapR) > 3 * h;
      if (/^\(\d{1,2}\)$/.test(w.text)) return true; // "(1)" style field numbers
      if (a === 0) return w.conf >= 85 && !isolated && w.text.length <= 2; // stray symbols
      if (w.conf < 60 && a <= 3) return false; // short, low-confidence fragments
      if (w.conf < 20 && a <= 5) return false;
      if (a <= 2 && w.conf < 80 && /^[\p{Ll}\p{P}]+$/u.test(w.text)) return false; // "y", "fg", "ow" specks
      if (isolated && (w.conf < 75 || (a <= 2 && w.conf < 85))) return false; // lone marks far from other text
      if (w.y1 - w.y0 < h * 0.35 && w.conf < 80) return false; // tiny specks
      return true;
    });
    if (!kept.length) continue;
    const text = kept.map((w) => w.text).join(' ');
    if (alnumCount(text) === 0) continue;
    out.push({ ...line, words: kept, text, box: lineBox(kept), mrz: mrzLine });
  }
  // top-to-bottom reading order
  out.sort((a, b) => (a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2 || a.box.x0 - b.box.x0);
  return out;
}

export function toPlainText(clean) {
  let text = '';
  let prev = null;
  for (const l of clean) {
    if (prev) text += l.para !== prev.para ? '\n\n' : '\n';
    text += l.text;
    prev = l;
  }
  return text.trim();
}

// ---------- 2. Field: value layout ----------
const CANONICAL_LABELS = [
  'Surname', 'Given names', 'Name', 'Full name', "Father's name", "Mother's name", 'Husband name',
  'Nationality', 'Date of birth', 'DOB', 'Sex', 'Gender', 'Place of birth', 'Place of issue',
  'Date of issue', 'Date of expiry', 'Expiry date', 'Valid until', 'Authority', 'Type', 'Code',
  'Country code', 'Passport No', 'Document No', 'Card No', 'ID No', 'Licence No', 'License No',
  'Address', 'Blood group', 'Height', 'Signature', 'Holder', 'Issued by', 'Personal No',
  'Account No', 'IFSC Code', 'Branch', 'Customer ID', 'Mobile', 'Email', 'Phone',
];

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// Fixes OCR typos in a *label* (never in a value), e.g. "Sumame" -> "Surname".
function canonicalLabel(raw) {
  const plain = raw.toLowerCase().replace(/[^a-z' ]/g, '').trim();
  if (!plain) return null;
  let best = null;
  for (const c of CANONICAL_LABELS) {
    const target = c.toLowerCase();
    for (const len of [target.length - 1, target.length, target.length + 1]) {
      if (len < 2) continue;
      const cand = plain.slice(0, len);
      const d = editDistance(cand, target);
      const score = 1 - d / Math.max(target.length, cand.length);
      // only accept when the candidate is (almost) the whole label
      if (score >= 0.7 && plain.length >= target.length - 1 && plain.length <= target.length + 4 && (!best || score > best.score))
        best = { label: c, score };
    }
  }
  return best ? best.label : null;
}

function tidyLabel(words) {
  let t = words.map((w) => w.text).join(' ');
  t = t.replace(/\(\d{1,2}\)/g, ' ').replace(/\s+/g, ' ').trim();
  // bilingual "Date of birth/Date de naissance" -> "Date of birth"
  const slash = t.search(/\s?\//);
  if (slash >= 2) t = t.slice(0, slash);
  t = t.replace(/[\s:.,;\-]+$/, '').replace(/^[\s:.,;\-]+/, '').trim();
  // "Type. Type" (English/French label that reads the same) -> "Type"
  t = t.replace(/\b([\p{L}]+)[.,]?\s+\1\b/giu, '$1');
  if (!t) return '';
  const canon = canonicalLabel(t);
  if (canon) return canon;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function looksLikeLabelLine(line) {
  const ws = line.words;
  let score = 0;
  for (const w of ws) {
    if (/^\(\d{1,2}\)$/.test(w.text)) score += 2;
    if (/\p{L}{2,}\/\p{L}{2,}/u.test(w.text)) score += 2; // "names/Prénoms"
  }
  if (canonicalLabel(tidyLabel(ws.slice(0, 4))) && ws.length <= 6 && !/\d{3,}/.test(line.text)) score += 2;
  return score >= 2;
}

function splitGroups(words, h) {
  const groups = [];
  for (const w of [...words].sort((a, b) => a.x0 - b.x0)) {
    const g = groups[groups.length - 1];
    if (g && w.x0 - g.x1 <= 1.6 * h) {
      g.words.push(w);
      g.x1 = w.x1;
    } else groups.push({ x0: w.x0, x1: w.x1, words: [w] });
  }
  return groups;
}

export function formatFields(clean) {
  const lines = clean.filter((l) => !l.mrz);
  const h = median(lines.flatMap((l) => l.words.map((w) => w.y1 - w.y0))) || 20;
  const blocks = []; // { kind: 'text', text } | { kind: 'pair', label, value }
  const used = new Set();
  let pairs = 0;

  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const line = lines[i];

    // "Label : value" on one line
    const colon = line.text.match(/^([\p{L}'’ .\/]{2,32}?)\s*[:：]\s*(.+)$/u);
    if (colon && colon[1].trim().split(/\s+/).length <= 4) {
      const label = tidyLabel([{ text: colon[1] }]);
      if (label) {
        blocks.push({ kind: 'pair', label, value: colon[2].trim() });
        pairs++;
        used.add(i);
        continue;
      }
    }

    const next = lines[i + 1];
    if (looksLikeLabelLine(line) && next && !looksLikeLabelLine(next) && !used.has(i + 1) && next.box.y0 - line.box.y1 < 2.5 * h) {
      const groups = splitGroups(next.words, h);
      const assigned = groups.map(() => []);
      const leftovers = [];
      for (const w of line.words) {
        let gi = -1;
        for (let g = 0; g < groups.length; g++) if (groups[g].x0 <= w.x0 + 0.8 * h) gi = g;
        if (gi === -1 && w.x0 >= groups[0].x0 - 2 * h) gi = 0;
        if (gi === -1) leftovers.push(w);
        else assigned[gi].push(w);
      }
      if (leftovers.length) blocks.push({ kind: 'text', text: leftovers.map((w) => w.text).join(' ') });
      groups.forEach((g, gi) => {
        const value = g.words.map((w) => w.text).join(' ');
        // A real label is written in mixed case or bilingual ("Name", "Sex/Sexe (5)");
        // an ALL-CAPS heading such as "PASSPORT" is ordinary text.
        const lw = assigned[gi];
        const labelish = lw.length && lw.some((w) => /\p{Ll}/u.test(w.text) || /\//.test(w.text) || /^\(\d{1,2}\)$/.test(w.text));
        const label = labelish ? tidyLabel(lw) : '';
        if (lw.length && !labelish) blocks.push({ kind: 'text', text: lw.map((w) => w.text).join(' ') });
        if (label) {
          blocks.push({ kind: 'pair', label, value });
          pairs++;
        } else if (alnumCount(value) > 2 || groups.length === 1) {
          blocks.push({ kind: 'text', text: value }); // tiny unlabeled bits next to fields are usually specks
        }
      });
      used.add(i);
      used.add(i + 1);
      continue;
    }
    blocks.push({ kind: 'text', text: line.text });
    used.add(i);
  }

  if (pairs < 2) return null;

  // Render: free text lines, then "Label: value" lines, keeping reading order.
  let out = '';
  let prevKind = null;
  for (const b of blocks) {
    if (prevKind && prevKind !== b.kind) out += '\n';
    out += b.kind === 'pair' ? `${b.label}: ${b.value}\n` : `${b.text}\n`;
    prevKind = b.kind;
  }
  return out.trim();
}

// ---------- 3. Passport / ID machine-readable zone ----------
const MRZ_VALUES = (c) => (c === '<' ? 0 : /\d/.test(c) ? +c : c.charCodeAt(0) - 55);
export function mrzCheck(field) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < field.length; i++) sum += MRZ_VALUES(field[i]) * weights[i % 3];
  return String(sum % 10);
}

const mrzDate = (yymmdd, isBirth) => {
  const yy = +yymmdd.slice(0, 2);
  const nowYY = new Date().getFullYear() % 100;
  const century = isBirth ? (yy > nowYY ? 1900 : 2000) : 2000;
  return `${yymmdd.slice(4, 6)}/${yymmdd.slice(2, 4)}/${century + yy}`;
};

export function mrzLinesFrom(lines) {
  return lines
    .map((l) => l.text.replace(/\s+/g, '').toUpperCase())
    .filter((t) => isMrzText(t) && t.length >= 25);
}

// Picks the best name line and data line out of one or more OCR passes.
export function readMrz(...passes) {
  const all = passes.flat().filter(Boolean);
  if (!all.length) return null;
  const dataLines = all.filter((l) => /([A-Z<]{3})(\d{6})(\d)([MFX<])(\d{6})(\d)/.test(l));
  const scoreData = (l) => {
    const m = l.match(/([A-Z<]{3})(\d{6})(\d)([MFX<])(\d{6})(\d)/);
    const pre = l.slice(0, m.index);
    return (mrzCheck(m[2]) === m[3]) + (mrzCheck(m[5]) === m[6]) + (pre.length === 10 && mrzCheck(pre.slice(0, 9)) === pre[9]) * 2;
  };
  dataLines.sort((a, b) => scoreData(b) - scoreData(a));
  const nat = dataLines[0] ? dataLines[0].match(/([A-Z<]{3})\d{6}\d[MFX<]/)[1].replace(/</g, '') : null;
  const nameLines = all.filter((l) => /^[PIAC][A-Z<]/.test(l) && /<</.test(l) && !/\d{6}/.test(l));
  // prefer a name line where the country code sits right after the document type
  const nameScore = (l) => {
    const at = nat ? l.indexOf(nat) : -1;
    const placed = at >= 1 && at <= 2 ? 100 : 0;
    const head = l.slice(0, 32);
    // a clean read has "<<" between surname and given names and few stray letters
    return placed + (head.match(/</g) || []).length * 2 + (/<</.test(l.slice(at + 3, at + 30)) ? 5 : 0);
  };
  nameLines.sort((a, b) => nameScore(b) - nameScore(a));
  return readMrzLines([nameLines[0], dataLines[0]].filter(Boolean));
}

function readMrzLines(mrzLines) {
  if (!mrzLines.length) return null;
  const fields = [];
  let verified = 0;
  let checked = 0;
  const mark = (ok) => {
    checked++;
    if (ok) verified++;
    return ok ? ' ✓' : ' ⚠ please verify';
  };

  // Data line: ...<docNo><check><nationality><DOB><check><sex><expiry><check>...
  let nationality = null;
  for (const line of mrzLines) {
    const m = line.match(/([A-Z<]{3})(\d{6})(\d)([MFX<])(\d{6})(\d)/);
    if (!m) continue;
    const pre = line.slice(0, m.index);
    nationality = m[1].replace(/</g, '');
    if (pre.length === 10) {
      const doc = pre.slice(0, 9);
      fields.push(`Document No: ${doc.replace(/<+$/, '')}${mark(mrzCheck(doc) === pre[9])}`);
    } // if characters are missing the number can't be checked, so it's left out
    fields.push(`Nationality: ${nationality}`);
    fields.push(`Date of birth: ${mrzDate(m[2], true)}${mark(mrzCheck(m[2]) === m[3])}`);
    fields.push(`Sex: ${m[4] === '<' ? 'Not specified' : m[4]}`);
    fields.push(`Date of expiry: ${mrzDate(m[5], false)}${mark(mrzCheck(m[5]) === m[6])}`);
    break;
  }

  // Names in the MRZ have no check digit and photos often blur the "<" separators,
  // so they are not shown here; the printed fields above already contain them.

  if (!fields.length) return null;
  const head =
    checked && verified === checked
      ? 'Machine-readable zone (MRZ), all check digits valid ✓'
      : 'Machine-readable zone (MRZ), ⚠ marks a value that failed its check digit';
  return `${head}\n${fields.join('\n')}`;
}
