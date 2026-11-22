// Offline OCR engine built on tesseract.js (runs inside the app, no internet needed for English).
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createWorker, OEM } = require('tesseract.js');

// Languages offered in the UI. English ships inside the app; the others are
// downloaded once (a few MB each) the first time they are used, then cached.
const LANGUAGES = [
  { code: 'eng', name: 'English', bundled: true },
  { code: 'hin', name: 'Hindi (हिन्दी)' },
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
    if (code === 'eng') {
      // Copy the bundled English model out of the app package.
      const src = path.join(path.dirname(require.resolve('@tesseract.js-data/eng')), '4.0.0_best_int', 'eng.traineddata.gz');
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
    this.worker = await createWorker(langs, OEM.LSTM_ONLY, {
      langPath: this.langDir,
      cachePath: this.cacheDir,
      gzip: true,
      logger: (m) => {
        if (m.status === 'recognizing text') this._emit({ status: 'Reading text…', progress: m.progress });
      },
    });
    this.workerLangs = key;
    return this.worker;
  }

  // Jobs run one at a time so progress messages stay meaningful.
  recognize(imageBytes, langs, onProgress) {
    const job = this.queue.then(async () => {
      this.onProgress = onProgress;
      try {
        const worker = await this._getWorker(langs && langs.length ? langs : ['eng']);
        const { data } = await worker.recognize(Buffer.from(imageBytes));
        return { text: tidy(data.text), confidence: Math.round(data.confidence || 0) };
      } finally {
        this.onProgress = null;
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async dispose() {
    if (this.worker) await this.worker.terminate().catch(() => {});
    this.worker = null;
  }
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
