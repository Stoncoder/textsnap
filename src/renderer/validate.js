// Format checks. These never change a value — they only decide whether to show "Please verify".

// Verhoeff checksum used by every real Aadhaar number. Catches any single misread digit.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export function verhoeffValid(num) {
  let c = 0;
  const digits = num.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = D[c][P[i % 8][digits[i]]];
  return c === 0;
}

export function validateField(key, value) {
  const v = String(value ?? '');
  if (v === 'UNREADABLE' || v === 'NOT FOUND') return { ok: true };
  if (key === 'pan_number') {
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)
      ? { ok: true }
      : { ok: false, reason: 'A PAN should be 5 letters, 4 digits, then 1 letter (e.g. ABCDE1234F).' };
  }
  if (key === 'aadhaar_number') {
    const compact = v.replace(/\s/g, '');
    if (!/^\d{12}$/.test(compact)) return { ok: false, reason: 'An Aadhaar number should be exactly 12 digits.' };
    if (/^[01]/.test(compact)) return { ok: false, reason: 'Aadhaar numbers never start with 0 or 1.' };
    if (!verhoeffValid(compact)) return { ok: false, reason: 'This number fails the Aadhaar checksum, so a digit is probably misread.' };
    return { ok: true };
  }
  if (key === 'ifsc_code') {
    return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v)
      ? { ok: true }
      : { ok: false, reason: 'An IFSC should be 4 letters, then 0, then 6 letters/digits (e.g. SBIN0001234).' };
  }
  if (key === 'account_number') {
    return /^\d{9,18}$/.test(v) ? { ok: true } : { ok: false, reason: 'Bank account numbers are usually 9–18 digits.' };
  }
  return { ok: true };
}
