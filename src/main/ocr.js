// Offline OCR engine built on tesseract.js (runs inside the app, no internet needed for English).
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createWorker, OEM } = require('tesseract.js');

// Languages offered in the UI. English ships inside the app; the others are
// downloaded once (a few MB each) the first time they are used, then cached.
const LANGUAGES = [
  { code: 'eng', name: 'English', bundled: true },
  { code: 'hin', name: 'Hindi (हिन्दी)', bundled: true },
  { code: 'mar', name: 'Marathi (मराठी)' },
  { code: 'guj', name: 'Gujarati (ગુજરાતી)' },
  { code: 'ben', name: 'Bengali (বাংলা)' },
  { code: 'tam', name: 'Tamil (தமிழ்)' },
  { code: 'tel', name: 'Telugu (తెలుగు)' },
  { code: 'kan', name: 'Kannada (ಕನ್ನಡ)' },
  { code: 'pan', name: 'Punjabi (ਪੰਜਾਬੀ)' },
  { code: 'urd', name: 'Urdu (اردو)' },
  { code: 'spa', name: 'Spanish' },
  { code: 'fra', name: 'French' },
  { code: 'deu', name: 'German' },
  { code: 'ita', name: 'Italian' },
  { code: 'por', name: 'Portuguese' },
  { code: 'ara', name: 'Arabic' },
  { code: 'rus', name: 'Russian' },
  { code: 'chi_sim', name: 'Chinese (Simplified)' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'kor', name: 'Korean' },
];

const CDN = (code) =>
  `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${code}/4.0.0_best_int/${code}.traineddata.gz`;

class OcrEngine {
  constructor(dataDir) {
    this.langDir = path.join(dataDir, 'tessdata');
    this.cacheDir = path.join(dataDir, 'tesscache');
    fs.mkdirSync(this.langDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.worker = null;
    this.workerLangs = '';
    this.onProgress = null; // set per job
    this.queue = Promise.resolve();
  }

  languages() {
    return LANGUAGES.map((l) => ({
      ...l,
      installed: !!l.bundled || fs.existsSync(path.join(this.langDir, `${l.code}.traineddata.gz`)),
    }));
  }

  async ensureLanguage(code) {
    if (!LANGUAGES.some((l) => l.code === code)) throw new Error(`Unknown language: ${code}`);
    const dest = path.join(this.langDir, `${code}.traineddata.gz`);
    if (fs.existsSync(dest)) return;
    if (code === 'eng' || code === 'hin') {
      // Copy the bundled English / Hindi model out of the app package.
      const src = path.join(path.dirname(require.resolve(`@tesseract.js-data/${code}`)), '4.0.0_best_int', `${code}.traineddata.gz`);
      fs.writeFileSync(dest, fs.readFileSync(src));
      return;
    }
    this._emit({ status: `Downloading ${code} language pack (one time only)…`, progress: 0 });
    await download(CDN(code), dest, (p) => this._emit({ status: `Downloading ${code} language pack…`, progress: p }));
  }

  _emit(msg) {
    if (this.onProgress) this.onProgress(msg);
  }

  async _getWorker(langs) {
    const key = langs.join('+');
    if (this.worker && this.workerLangs === key) return this.worker;
    if (this.worker) await this.worker.terminate().catch(() => {});
    for (const l of langs) await this.ensureLanguage(l);
    this._emit({ status: 'Starting OCR engine…', progress: 0 });
    // If the engine ever fails to start (rare), give up after a while and try once more.
    for (let attempt = 1; ; attempt++) {
      try {
        this.worker = await withTimeout(this._createWorker(langs), 60_000);
        break;
      } catch (err) {
        this.worker = null;
        if (attempt >= 2) throw new Error('The OCR engine did not start. Please close TextSnap and open it again.');
        this._emit({ status: 'Restarting OCR engine…', progress: 0 });
      }
    }
    this.workerLangs = key;
    return this.worker;
  }

  async _createWorker(langs) {
    let worker;
    const pending = createWorker(langs, OEM.LSTM_ONLY, {
      langPath: this.langDir,
      cachePath: this.cacheDir,
      gzip: true,
      logger: (m) => {
        if (m.status === 'recognizing text') this._emit({ status: 'Reading text…', progress: m.progress });
      },
    });
    pending.then((w) => (worker = w)).catch(() => {});
    try {
      return await pending;
    } catch (err) {
      if (worker) worker.terminate().catch(() => {});
      throw err;
    }
  }

  // Jobs run one at a time so progress messages stay meaningful.
  // withLines: also return every text line with its confidence (used by the free KYC mode).
  // whitelist/psm: optional Tesseract settings for one job (used to re-read passport MRZ lines).
  recognize(imageBytes, langs, onProgress, opts = {}) {
    const job = this.queue.then(async () => {
      this.onProgress = onProgress;
      try {
        // Every job has a time limit. A stuck engine is shut down and the job is retried
        // once with a fresh engine. The strict MRZ re-read is only a bonus, so it gets a
        // short limit and no retry (the caller simply skips it).
        const strict = !!(opts.whitelist || opts.psm);
        const limit = strict ? 20_000 : 120_000;
        for (let attempt = 1; ; attempt++) {
          try {
            return await this._guarded(() => this._recognizeOnce(imageBytes, langs, opts), limit);
          } catch (err) {
            const timedOut = err && err.message === 'timeout';
            if (!timedOut) throw err;
            if (strict || attempt >= 2) throw new Error('Reading this file took too long. Please try again.');
            this._emit({ status: 'Restarting OCR engine…', progress: 0 });
          }
        }
      } finally {
        this.onProgress = null;
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async _guarded(fn, ms) {
    let timer;
    try {
      return await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]);
    } catch (err) {
      if (err && err.message === 'timeout') {
        const stuck = this.worker;
        this.worker = null;
        this.workerLangs = '';
        if (stuck) stuck.terminate().catch(() => {}); // force-stops the engine thread
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _recognizeOnce(imageBytes, langs, { withLines = false, whitelist = '', psm = '' } = {}) {
    const worker = await this._getWorker(langs && langs.length ? langs : ['eng']);
    const custom = whitelist || psm;
    if (custom) await worker.setParameters({ tessedit_char_whitelist: whitelist, tessedit_pageseg_mode: psm || '3' });
    let data;
    try {
      ({ data } = await worker.recognize(Buffer.from(imageBytes), {}, { text: true, blocks: withLines }));
    } finally {
      if (custom && this.worker === worker) await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });
    }
    const result = { text: tidy(data.text), confidence: Math.round(data.confidence || 0) };
    if (withLines) {
      result.lines = [];
      let paraId = 0;
      for (const block of data.blocks || [])
        for (const para of block.paragraphs || []) {
          paraId++;
          for (const line of para.lines || []) {
            const text = (line.text || '').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            const words = (line.words || [])
              .filter((w) => (w.text || '').trim())
              .map((w) => ({ text: w.text.trim(), conf: Math.round(w.confidence || 0), x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
            result.lines.push({ text, confidence: Math.round(line.confidence || 0), words, para: paraId });
          }
        }
    }
    return result;
  }

  async dispose() {
    if (this.worker) await this.worker.terminate().catch(() => {});
    this.worker = null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        // a worker that starts late is shut down so it doesn't linger
        promise.then((w) => w && w.terminate && w.terminate()).catch(() => {});
        reject(new Error('timeout'));
      }, ms);
    }),
  ]);
}

function tidy(text) {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Could not download language pack (HTTP ${res.statusCode}). Check your internet connection.`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const tmp = `${dest}.part`;
        const out = fs.createWriteStream(tmp);
        res.on('data', (c) => {
          got += c.length;
          if (total) onProgress(got / total);
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
        out.on('error', reject);
      })
      .on('error', () => reject(new Error('Could not download language pack. Check your internet connection.')));
  });
}

module.exports = { OcrEngine };
