import {robotLetter, robotLetterBadge} from '@/features/media/icons';
import {ROBOT_KITS} from '../data/robotLetters';
import {h} from './domHelpers';
import {
  currentPresentationTheme,
  registerThemePainter,
  type PresentationTheme
} from './presentation';
import {cachedImageObjectUrls, engineObjectUrl} from '../engine/contract';
import {MEDIA_RETRY_WINDOW_MS, MEDIA_RETRY_BACKOFF_MS} from '@/shared/mediaRetry';

// Window/backoff/give-up policy is the shared image-load retry policy in
// @/shared/mediaRetry, the same one features/media/resolveImage.ts uses. It
// lives in shared/ so this component need not depend on features/ yet cannot
// drift from the resolver.
const AVATAR_RETRY_WINDOW_MS = MEDIA_RETRY_WINDOW_MS;
const AVATAR_RETRY_BACKOFF_MS = MEDIA_RETRY_BACKOFF_MS;

// url -> resolved object URL, filled the moment a photo load settles (and at
// boot by warmAvatarPhotoCache). This is what makes a revisit paint the photo
// SYNCHRONOUSLY: avatarView consults it before ever drawing a fallback, so a
// known photo never flashes a placeholder. The `?v=` in every session-photo
// URL keys freshness: an updated photo is a new URL, never a stale hit.
const readyPhotoSrcs = new Map<string, string>();
const photoSrcs = new Map<string, Promise<string>>();
function photoSrc(url: string): Promise<string> {
  let p = photoSrcs.get(url);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + AVATAR_RETRY_WINDOW_MS;
      const attempt = (): void =>
        void engineObjectUrl(url, {cache: true}).then(resolve, (err: unknown) => {
          const status = (err as {status?: number} | null)?.status;
          if (status === 404 || Date.now() >= deadline) reject(err);
          else setTimeout(attempt, AVATAR_RETRY_BACKOFF_MS);
        });
      attempt();
    });
    p.then(
      (src) => readyPhotoSrcs.set(url, src),
      () => {
        photoSrcs.delete(url);
      }
    );
    photoSrcs.set(url, p);
  }
  return p;
}

/** Boot-time warm: lift every durably cached session photo into the
 *  synchronous map, so the very first paint after an app open renders photos
 *  from cache with no placeholder swap. Cheap: createObjectURL only, no
 *  decode, no wire. */
export async function warmAvatarPhotoCache(): Promise<void> {
  const cached = await cachedImageObjectUrls('/session-photo/').catch(
    () => new Map<string, string>()
  );
  for (const [url, src] of cached) {
    if (readyPhotoSrcs.has(url)) continue;
    readyPhotoSrcs.set(url, src);
    if (!photoSrcs.has(url)) photoSrcs.set(url, Promise.resolve(src));
  }
}

const CYC_AVATAR_HUES = [
  '#c05252',
  '#a8842f',
  '#7f9a35',
  '#4c9f5a',
  '#3f9c8c',
  '#3d90b5',
  '#4f7fc4',
  '#6d6fc7',
  '#8f63bf',
  '#b45ca3',
  '#bd5878'
];

export function cyrb53(str: string, hashSeed = 0): number {
  let a = 0xdeadbeef ^ hashSeed,
    b = 0x41c6ce57 ^ hashSeed;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return 4294967296 * (2097151 & b) + (a >>> 0);
}

export function avatarColor(seed: string): string {
  return CYC_AVATAR_HUES[cyrb53(seed) % CYC_AVATAR_HUES.length];
}

export function avatarKit(seed: string): number {
  return cyrb53(seed, 1) % ROBOT_KITS.length;
}

export const avatarSeed = (s: {id?: string; name: string}): string => s.id || s.name;

const AVATAR_TILE: Record<PresentationTheme, (hue: string) => string> = {
  day: (hue) => `color-mix(in srgb, ${hue} 16%, #ffffff)`,
  night: (hue) => `color-mix(in srgb, ${hue} 20%, #0e0e10)`
};
const AVATAR_INK: Record<PresentationTheme, (hue: string) => string> = {
  day: (hue) => `color-mix(in srgb, ${hue} 72%, #000000)`,
  night: (hue) => `color-mix(in srgb, ${hue} 78%, #ffffff)`
};

// One style attribute: jsdom drops color-mix/var via CSSOM setters.
function avatarTintStyle(
  color: string,
  size: number,
  theme: PresentationTheme,
  extra: string
): string {
  return (
    `--cyc-avatar-tile:${AVATAR_TILE[theme](color)};` +
    `width:${size}px;height:${size}px;line-height:${size}px;` +
    'background:var(--cyc-avatar-tile);' +
    `color:${AVATAR_INK[theme](color)};` +
    'font-weight:600;position:relative' +
    extra
  );
}

export function avatarView(
  name: string,
  size: number,
  extraClass = '',
  avatarUrl?: string,
  seed?: string
): HTMLDivElement {
  const color = avatarColor(seed || name);
  const el = h(
    'div',
    (
      'cyc-face text-white text-center text-lg uppercase font-semibold rounded-xl! ' +
      `cyc-face-${size} ${extraClass}`
    ).trim()
  );

  let extraStyle = '';
  const paintTint = () =>
    el.setAttribute('style', avatarTintStyle(color, size, currentPresentationTheme(), extraStyle));
  paintTint();
  registerThemePainter(el, paintTint);

  const drawRobot = () => {
    const initial = name.trim().charAt(0).toUpperCase();
    const robot = robotLetter(initial, avatarKit(seed || name));
    if (robot) el.append(robot);
    else {
      extraStyle = `;font-size:${Math.max(13, Math.round(size * 0.36))}px`;
      paintTint();
      el.textContent = initial;
    }
  };
  if (avatarUrl) {
    if (avatarUrl.includes('/session-photo/')) {
      avatarUrl += (avatarUrl.includes('?') ? '&' : '?') + 'w=' + (size <= 64 ? 128 : 640);
    }

    const faceImg = (cls: string) =>
      h('img', ('cyc-face-photo block object-cover! object-center! rounded-xl! ' + cls).trim(), {
        alt: name,
        draggable: 'false',
        style: `width:${size}px;height:${size}px`
      });

    if (/^https?:/i.test(avatarUrl)) {
      const ready = readyPhotoSrcs.get(avatarUrl);
      if (ready) {
        // Cached photo: the img gets its source SYNCHRONOUSLY, no fallback is
        // ever drawn, so a revisit paints the real face with no swap at all.
        const photo = faceImg('');
        photo.src = ready;
        photo.dataset.cycCached = '1';
        photo.addEventListener('error', () => {
          photo.remove();
          if (!el.childElementCount) drawRobot();
        });
        el.append(photo);
      } else {
        // Photo not in memory yet (first-ever load, or cache still warming):
        // paint the deterministic name-derived robot instantly and swap the
        // real photo in only once it has actually decoded. On any failure the
        // robot stays -- never a broken glyph. The photo img gets a src only
        // after the loader resolves, so it never holds a failing/empty src.
        drawRobot();
        const photo = faceImg('invisible');
        photo.addEventListener('load', () => {
          photo.classList.remove('invisible');
          for (const node of [...el.childNodes]) if (node !== photo) node.remove();
        });
        photo.addEventListener('error', () => photo.remove());
        void photoSrc(avatarUrl).then(
          (u) => {
            photo.src = u;
            el.append(photo);
          },
          () => {
            /* stay on the robot fallback silently */
          }
        );
      }
    } else {
      const img = faceImg('');
      img.src = avatarUrl;
      img.addEventListener('error', () => {
        img.remove();
        if (!el.childElementCount) drawRobot();
      });
      el.append(img);
    }
  } else drawRobot();
  return el;
}

// color-mix() resolved to a literal hex: a standalone SVG document rendered as
// an image (a notification icon) has no CSS cascade, so its paints must be
// plain colors. Same math as `color-mix(in srgb, hue pct%, base)`.
function mixHex(hue: string, pct: number, base: string): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = Math.round(ch(hue, i) * (pct / 100) + ch(base, i) * (1 - pct / 100));
    out += v.toString(16).padStart(2, '0');
  }
  return out;
}

/** The same name-derived fallback as a STANDALONE SVG document string:
 *  deterministic for a given seed (tile color, robot kit, letter), painted in
 *  concrete day-theme colors so it renders anywhere -- notification icons,
 *  data URIs -- with no CSS cascade around it. */
export function avatarFallbackSvg(name: string, seed?: string, size = 96): string {
  const s = seed || name;
  const hue = avatarColor(s);
  const tile = mixHex(hue, 16, '#ffffff'); // AVATAR_TILE.day
  const ink = mixHex(hue, 72, '#000000'); // AVATAR_INK.day
  const initial = name.trim().charAt(0).toUpperCase();
  const badge = robotLetterBadge(initial, avatarKit(s), tile, ink, size);
  if (badge) return badge;
  const glyph = initial.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"` +
    ` viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.25)}" fill="${tile}"/>` +
    `<text x="50%" y="50%" dy="0.36em" text-anchor="middle" fill="${ink}"` +
    ` font-family="system-ui,sans-serif" font-size="${Math.round(size * 0.42)}"` +
    ` font-weight="600">${glyph}</text>` +
    '</svg>'
  );
}
