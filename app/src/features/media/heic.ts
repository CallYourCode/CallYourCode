import {lazy} from '@/shared/lazy';

type HeicDecoder = (blob: Blob) => Promise<Blob>;

function decoderOverride(): HeicDecoder | undefined {
  return (window as unknown as {__cycHeicDecoder?: HeicDecoder}).__cycHeicDecoder;
}

export function isHeic(file: File): boolean {
  const type = (file.type || '').toLowerCase();
  if (
    type === 'image/heic' ||
    type === 'image/heif' ||
    type === 'image/heic-sequence' ||
    type === 'image/heif-sequence'
  )
    return true;
  if (type) return false;
  return /\.(heic|heif)$/i.test(file.name || '');
}

function jpegName(name: string): string {
  const base = (name || 'image').replace(/\.(heic|heif)$/i, '');
  return `${base || 'image'}.jpg`;
}

// Draw a decoded bitmap to a canvas and read it back as JPEG. Prefers an
// OffscreenCanvas (a worker-safe path with a promise API) and falls back to a
// DOM <canvas>. Returns null on any failure (no 2D context, a tainted read),
// leaving decode() free to try the next strategy.
async function bitmapToJpeg(bitmap: ImageBitmap): Promise<Blob | null> {
  const {width, height} = bitmap;
  if (!width || !height) return null;
  try {
    if (typeof OffscreenCanvas === 'function') {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      return await canvas.convertToBlob({type: 'image/jpeg', quality: 0.92});
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)
    );
  } catch {
    return null;
  }
}

// Decode a blob to a bitmap with EXIF orientation applied. iPhone HEICs carry
// an orientation tag that the JPEG canvas export strips, so a bitmap decoded
// without honoring it lands sideways or upside-down. Request 'from-image'
// first and fall back to the plain call when an older engine rejects the
// options bag with a TypeError.
async function bitmapFromBlob(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, {imageOrientation: 'from-image'});
  } catch (err) {
    if (err instanceof TypeError) return createImageBitmap(blob);
    throw err;
  }
}

// The native decode: iOS Safari (where HEIC comes from) decodes HEIC in the
// platform, so createImageBitmap + a canvas readback is fast and never touches
// the WASM. Returns null when the browser cannot decode HEIC natively (desktop
// Chrome throws on the bitmap) or the canvas readback is unavailable (jsdom),
// so decode() falls back to heic2any.
async function nativeDecode(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await bitmapFromBlob(blob);
  } catch {
    return null;
  }
  try {
    return await bitmapToJpeg(bitmap);
  } finally {
    bitmap.close?.();
  }
}

async function heic2anyDecode(blob: Blob): Promise<Blob> {
  const mod = await lazy(() => import('heic2any'), 'the HEIC converter');
  const heic2any = (
    mod as unknown as {
      default: (o: {blob: Blob; toType?: string; quality?: number}) => Promise<Blob | Blob[]>;
    }
  ).default;
  const out = await heic2any({blob, toType: 'image/jpeg', quality: 0.92});
  return Array.isArray(out) ? out[0] : out;
}

// Strategy order: the test override first (a fake decoder the tests inject),
// then the native platform decode (fast, no WASM), then heic2any as the
// fallback for browsers that cannot decode HEIC natively.
async function decode(blob: Blob): Promise<Blob> {
  const override = decoderOverride();
  if (override) return override(blob);

  const native = await nativeDecode(blob);
  if (native) return native;

  return heic2anyDecode(blob);
}

async function convertHeicToJpeg(file: File): Promise<File> {
  const jpeg = await decode(file);
  return new File([jpeg], jpegName(file.name), {
    type: 'image/jpeg',
    lastModified: file.lastModified
  });
}

// The single shared attachment-intake normalizer. EVERY path that brings a
// File into the composer (the file picker, drag-and-drop, and paste) routes
// through here so the HEIC decision lives in exactly one place: a HEIC/HEIF
// image becomes a viewable JPEG, anything else passes straight through. On a
// decode failure it REJECTS rather than falling back to the raw bytes -- an
// undecodable .heic is unusable to the agent, so the caller surfaces the
// failure (a failed chip that can be retried) instead of silently uploading it.
export async function heicToJpegForUpload(file: File): Promise<File> {
  if (!isHeic(file)) return file;
  return convertHeicToJpeg(file);
}
