// File helpers that run in the window: decoding images, reading PDFs, making thumbnails.
import * as pdfjs from '../../node_modules/pdfjs-dist/build/pdf.min.mjs';

const PDF_BASE = new URL('../../node_modules/pdfjs-dist/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = PDF_BASE + 'build/pdf.worker.min.mjs';

export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'avif', 'ico'];
export const TEXT_EXT = ['txt', 'md', 'csv', 'json', 'log', 'xml', 'tsv', 'yml', 'yaml'];

export const ext = (name) => (name.split('.').pop() || '').toLowerCase();

export function kindOf(file) {
  const e = ext(file.name);
  if (file.type === 'application/pdf' || e === 'pdf') return 'pdf';
  if (file.type.startsWith('image/') || IMAGE_EXT.includes(e)) return 'image';
  if (e === 'docx') return 'docx';
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'rtf') return 'rtf';
  if (TEXT_EXT.includes(e) || file.type.startsWith('text/')) return 'text';
  return 'unsupported';
}

export async function openPdf(bytes) {
  return pdfjs.getDocument({
    data: bytes,
    cMapUrl: PDF_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: PDF_BASE + 'standard_fonts/',
    wasmUrl: PDF_BASE + 'wasm/',
    iccUrl: PDF_BASE + 'iccs/',
    isEvalSupported: false,
  }).promise;
}

// Text that is already stored inside a PDF page (digital PDFs).
export async function pdfPageText(page) {
  const content = await page.getTextContent();
  let out = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    out += item.str;
    out += item.hasEOL ? '\n' : (item.str && !item.str.endsWith(' ') ? ' ' : '');
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
}

export async function renderPdfPage(page, scale = 2.5, type = 'image/png', quality) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return canvasToBlob(canvas, type, quality);
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, quality));
}

// Decodes an image (respecting phone-camera rotation) and redraws it at a good size.
export async function normalizeImage(blob, { maxSide = 4000, minSide = 1200, type = 'image/png', quality } = {}) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return null; // Format the browser can't draw (e.g. TIFF) — caller falls back to raw bytes.
  }
  const long = Math.max(bmp.width, bmp.height);
  let scale = 1;
  if (long > maxSide) scale = maxSide / long;
  else if (long < minSide) scale = Math.min(2, minSide / long); // small images read better enlarged
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvasToBlob(canvas, type, quality);
}

export async function thumbnailFor(file) {
  if (kindOf(file) === 'pdf') {
    const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
    const page = await doc.getPage(1);
    const blob = await renderPdfPage(page, 1.6, 'image/jpeg', 0.85);
    doc.loadingTask.destroy();
    return URL.createObjectURL(blob);
  }
  return URL.createObjectURL(file);
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
  return (doc.body?.innerText || doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

export function rtfToText(rtf) {
  return rtf
    .replace(/\\par[d]?/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
