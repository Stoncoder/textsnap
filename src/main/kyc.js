// KYC document extraction using Claude's vision API.
// Documents are sent straight from this computer to the API and are never stored.
const Anthropic = require('@anthropic-ai/sdk').default;

const MODEL = 'claude-opus-5-5';

const FIELD_KEYS = [
  'name',
  'fathers_name',
  'pan_number',
  'date_of_birth',
  'aadhaar_number',
  'address',
  'account_holder_name',
  'account_number',
  'ifsc_code',
  'bank_branch_name',
];

// Strict JSON shape the model must answer in (structured outputs).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['document_type', 'fields'],
  properties: {
    document_type: { type: 'string', enum: ['PAN', 'AADHAAR', 'BANK_PASSBOOK', 'UNKNOWN'] },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'confidence'],
        properties: {
          key: { type: 'string', enum: FIELD_KEYS },
          value: { type: 'string' },
          confidence: { type: 'string', enum: ['High', 'Low'] },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a careful data-entry assistant for Indian KYC documents. You transcribe what is printed on the document. You never guess.

STEP 1 - Identify the document:
- "PAN": Income Tax Department PAN card.
- "AADHAAR": UIDAI Aadhaar card or Aadhaar letter (front and/or back).
- "BANK_PASSBOOK": the front page of a bank passbook (or a bank account details page).
- "UNKNOWN": anything else, or if you are not sure. Do not pick a type unless the document clearly is one. If UNKNOWN, return an empty fields list.

STEP 2 - Extract only these fields for the identified type:
- PAN: name, fathers_name, pan_number, date_of_birth
- AADHAAR: name, fathers_name, aadhaar_number, address
- BANK_PASSBOOK: account_holder_name, account_number, ifsc_code, bank_branch_name
Return exactly one entry per field listed for that type, no other keys.

ACCURACY RULES (most important):
1. Copy every value character-for-character exactly as printed: same spelling, same capitalisation, same spacing, same punctuation. Never correct spelling, never expand abbreviations, never complete partial words, never reformat dates or numbers.
2. If a field is blurred, cut off, covered, partly visible, or you are not certain of every character, set its value to exactly "UNREADABLE". Never fill in characters you cannot clearly see.
3. If a field is simply not printed on this document (for example many Aadhaar cards do not print a father's name), set its value to exactly "NOT FOUND".
4. For Aadhaar fathers_name: only fill it if a father's/guardian's name is clearly printed (for example after "S/O", "D/O", "C/O" or "Father"). Copy just the name as printed.
5. For address, copy the full printed address, keeping the printed order. Use ", " where the document breaks lines.
6. For bank_branch_name, copy the bank name and branch as printed, separated by " - " if they appear separately.
7. If the same document shows text in English and a regional language, copy the English version.
8. Numbers (Aadhaar, PAN, account number, IFSC, dates): read each character one at a time. Do not confuse similar shapes (0/O/D/Q, 1/I/l/7, 2/Z, 5/S, 6/G/b, 8/B, 9/g). Count the digits: an Aadhaar number has exactly 12 digits. If you are not sure of even one character, use "UNREADABLE".
9. confidence: "High" only when every character is crisp and unambiguous. Otherwise "Low". UNREADABLE and NOT FOUND values always have "Low".`;

function keyFingerprint(key) {
  return key ? `${key.slice(0, 7)}…${key.slice(-4)}` : '';
}

class KycExtractor {
  constructor(getApiKey) {
    this.getApiKey = getApiKey;
  }

  // Reads the document twice independently and compares the answers.
  // Any field where the two reads disagree is flagged for the user to verify.
  async extract({ mediaType, base64, doubleCheck = true }) {
    if (!doubleCheck) return finalize(await this._once({ mediaType, base64 }), null);
    const [a, b] = await Promise.all([this._once({ mediaType, base64 }), this._once({ mediaType, base64 })]);
    return finalize(a, b);
  }

  async _once({ mediaType, base64 }) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      const e = new Error('Add your Anthropic API key in Settings first.');
      e.code = 'NO_KEY';
      throw e;
    }
    const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 180_000 });

    const docBlock =
      mediaType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // Server-side fallback re-runs the request on another model if this one declines.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [docBlock, { type: 'text', text: 'Identify this document and extract its fields. Answer in the required JSON format.' }],
          },
        ],
      });
    } catch (err) {
      throw friendlyError(err);
    }

    if (response.stop_reason === 'refusal') {
      throw new Error('The document could not be processed. Please try a clearer photo of a supported document.');
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('The response was cut off. Please try again.');
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('No answer was returned. Please try again.');

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      throw new Error('The answer was not valid JSON. Please try again.');
    }
    return parsed;
  }
}

const clean = (v) => String(v ?? '').trim();
// Only whitespace is removed (as the user asked), digits/letters are never changed.
const NO_SPACE_KEYS = new Set(['aadhaar_number', 'pan_number', 'ifsc_code', 'account_number']);
const SPECIAL = new Set(['UNREADABLE', 'NOT FOUND']);

function normalize(result) {
  const fields = {};
  for (const f of result.fields || []) {
    let v = clean(f.value);
    if (NO_SPACE_KEYS.has(f.key) && !SPECIAL.has(v)) v = v.replace(/\s+/g, '');
    fields[f.key] = { value: v, confidence: SPECIAL.has(v) ? 'Low' : f.confidence };
  }
  return { document_type: result.document_type, fields };
}

function finalize(rawA, rawB) {
  const a = normalize(rawA);
  if (!rawB) return { ...a, checked: false };
  const b = normalize(rawB);
  if (a.document_type !== b.document_type) {
    // The two reads could not even agree what the document is: do not guess.
    return { document_type: 'UNKNOWN', fields: {}, checked: true, note: 'The document type could not be identified reliably.' };
  }
  for (const [key, fa] of Object.entries(a.fields)) {
    const fb = b.fields[key];
    if (!fb || fb.value !== fa.value) {
      fa.confidence = 'Low';
      fa.mismatch = true;
      // If one read could not read it at all, trust the cautious answer.
      if (fb && SPECIAL.has(fb.value) && !SPECIAL.has(fa.value)) fa.value = 'UNREADABLE';
    } else if (fb.confidence === 'Low') {
      fa.confidence = 'Low';
    }
  }
  return { ...a, checked: true };
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('Your API key was rejected. Check it in Settings.');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('This API key does not have access to the model.');
  if (err instanceof Anthropic.RateLimitError) return new Error('Too many requests right now. Wait a minute and try again.');
  if (err instanceof Anthropic.BadRequestError) return new Error(`The document could not be sent: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new Error('Could not reach the Claude API. Check your internet connection.');
  if (err instanceof Anthropic.APIError) return new Error(`Claude API error (${err.status ?? 'network'}). Please try again.`);
  return err;
}

module.exports = { KycExtractor, keyFingerprint, FIELD_KEYS, finalize };
