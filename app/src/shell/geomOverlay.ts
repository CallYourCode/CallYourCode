import * as engine from '../engine/store';
import {h} from '../components/domHelpers';

export function installGeomOverlay() {
  let geomBox: HTMLElement | null = null;
  let geomTimer = 0;
  const syncGeom = () => {
    const want = engine.globalSettings().geom;
    if (want === !!geomBox) return;
    if (!want) {
      geomBox!.remove();
      geomBox = null;

      clearInterval(geomTimer);
      geomTimer = 0;
      return;
    }
    const box = (geomBox = h(
      'div',
      [
        'cyc-geom absolute top-16 start-2 z-30 max-w-60 whitespace-pre rounded-lg px-2.5 py-2 [&.cyc-geom-min]:opacity-[0.15]',
        'bg-[rgba(0,0,0,0.82)] text-[#7fff9f] [font:500_11px/1.35_ui-monospace,Menlo,monospace]'
      ].join(' ')
    ));
    const paint = () => {
      const cs = getComputedStyle(document.documentElement);
      const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
      const bx = (sel: string) => {
        const el = q(sel);
        return el ? el.getBoundingClientRect() : null;
      };
      const input = bx('.cyc-composer');
      const wrap = bx('.cyc-composer-pill') ?? bx('.cyc-composer .cyc-composer-rows');
      const send = bx('.cyc-composer .cyc-send-btn');
      const whole = bx('#cyc-stage') ?? bx('#cyc-app');
      const n = (x: number | undefined | null) =>
        x === null || x === undefined ? '-' : String(Math.round(x));
      box.textContent = [
        `screen ${n(screen.width)}x${n(screen.height)}`,
        `avail ${n(screen.availWidth)}x${n(screen.availHeight)}`,
        `win ${n(window.innerWidth)}x${n(window.innerHeight)}`,
        `docEl ${n(document.documentElement.clientHeight)}`,
        `vv ${n(window.visualViewport?.width)}x${n(window.visualViewport?.height)}`,
        `dpr ${window.devicePixelRatio}`,
        `safe top ${cs.getPropertyValue('--cyc-safe-top').trim() || '?'}`,
        `safe bot ${cs.getPropertyValue('--cyc-safe-bottom').trim() || '?'}`,
        `whole h ${n(whole?.height)} bot ${n(whole?.bottom)}`,
        `input top ${n(input?.top)} bot ${n(input?.bottom)}`,
        `input pad-b ${q('.cyc-composer') ? getComputedStyle(q('.cyc-composer')!).paddingBottom : '-'}`,
        `wrap bot ${n(wrap?.bottom)}`,
        `send bot ${n(send?.bottom)}`,
        `GAP under send ${n(send ? window.innerHeight - send.bottom : null)}`,
        `GAP under app ${n(whole ? window.innerHeight - whole.bottom : null)}`,
        `nav.standalone ${String((navigator as unknown as {standalone?: boolean}).standalone)}`,
        `dm standalone ${String(matchMedia('(display-mode: standalone)').matches)}`,
        `dm fullscreen ${String(matchMedia('(display-mode: fullscreen)').matches)}`,
        `ua ${navigator.userAgent.slice(-28)}`
      ].join('\n');
    };
    box.addEventListener('click', () => box.classList.toggle('cyc-geom-min'));
    (document.getElementById('cyc-stage') ?? document.body).append(box);
    paint();
    geomTimer = window.setInterval(paint, 1000);
  };

  engine.onGlobalSettings(syncGeom);
  syncGeom();
}
