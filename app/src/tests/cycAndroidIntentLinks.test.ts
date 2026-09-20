import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {installAndroidIntentLinks} from '../shared/browser';
const realUA = navigator.userAgent;
function setUA(ua: string) {
  Object.defineProperty(navigator, 'userAgent', {value: ua, configurable: true});
}
function setStandalone(matches: boolean) {
  window.matchMedia = (q: string) =>
    ({
      matches,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {}
    }) as unknown as MediaQueryList;
}

function click(href: string, init: MouseEventInit = {}): boolean {
  const a = document.createElement('a');
  a.href = href;
  document.body.append(a);
  const ev = new MouseEvent('click', {bubbles: true, cancelable: true, button: 0, ...init});
  let claimed = false;
  const tail = (e: Event) => {
    claimed = e.defaultPrevented;
    e.preventDefault();
  };
  window.addEventListener('click', tail);
  a.dispatchEvent(ev);
  window.removeEventListener('click', tail);
  a.remove();
  return claimed;
}
beforeEach(() => {
  document.body.textContent = '';
});
afterEach(() => {
  setUA(realUA);
});
describe('android intent links', () => {
  test('not Android, or not installed: the listener is never added', () => {
    setUA('Mozilla/5.0 (iPhone; like Mac OS X)');
    setStandalone(true);
    installAndroidIntentLinks();
    expect(click('https://elsewhere.example/page')).toBe(false);
    setUA('Mozilla/5.0 (Linux; Android 14)');
    setStandalone(false);
    installAndroidIntentLinks();
    expect(click('https://elsewhere.example/page')).toBe(false);
  });
  test('installed Android: only a plain left click on a cross-origin http(s) link is claimed', () => {
    setUA('Mozilla/5.0 (Linux; Android 14)');
    setStandalone(true);
    installAndroidIntentLinks();

    expect(click(location.origin + '/inside')).toBe(false);

    expect(click('mailto:someone@example.com')).toBe(false);

    expect(click('https://elsewhere.example/page', {ctrlKey: true})).toBe(false);
    expect(click('https://elsewhere.example/page', {button: 1})).toBe(false);

    expect(click('https://elsewhere.example/page')).toBe(true);
  });
});
