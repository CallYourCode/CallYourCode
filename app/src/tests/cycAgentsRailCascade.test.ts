import {afterAll, beforeEach, describe, expect, test} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from 'tailwindcss';
import {chromium, type Browser} from 'playwright';

// Browser cascade coverage for the agents progress rail.

import {createAgentsBar} from '../features/sessions/components/agentsBar';
import type {EngineAgentRun} from '../engine/contract';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(HERE, '..', 'shell');
const require = createRequire(import.meta.url);
const TW_DIR = dirname(require.resolve('tailwindcss/package.json'));

async function compileTailwind(candidates: string[]): Promise<string> {
  const entry = readFileSync(resolve(SHELL, 'tailwind.css'), 'utf8');
  const compiler = await compile(entry, {
    base: SHELL,
    async loadStylesheet(id: string, base: string) {
      const path =
        id === 'tailwindcss'
          ? resolve(TW_DIR, 'index.css')
          : resolve(base, id.replace(/^tailwindcss\//, `${TW_DIR}/`));
      return {base: dirname(path), content: readFileSync(path, 'utf8'), path};
    },
    async loadModule(id: string) {
      return {path: id, base: SHELL, module: {} as never};
    }
  });
  return compiler.build(candidates);
}

const THEME_VARS = `
:root {
  --cyc-accent: rgb(1, 2, 3);
  --cyc-surface: rgb(20, 21, 22);
}
html[data-theme='dark'] {
  --cyc-accent: rgb(10, 11, 12);
  --cyc-surface: rgb(23, 24, 25);
}
`;

const base: EngineAgentRun = {
  toolUseId: 't1',
  agentId: 'a1',
  ts: Date.now(),
  desc: 'render the corpus',
  endedTs: null,
  tokens: null,
  source: 'pi',
  model: 'opus'
};
const running = (id: string): EngineAgentRun => ({...base, toolUseId: id, agentId: id});

function tokensOf(root: Element): string[] {
  const out: string[] = [];
  const push = (c: string | null) => {
    if (c) out.push(...c.split(/\s+/).filter(Boolean));
  };
  push(root.getAttribute('class'));
  root.querySelectorAll('*').forEach((n) => push(n.getAttribute('class')));
  return out;
}

function producedRails(): {
  idleRootClass: string;
  singleRail: string;
  multiRail: string;
  tokens: string[];
} {
  const single = createAgentsBar();
  single.update([{...base, endedTs: Date.now()}]); // one done run -> total 1, idle
  const singleEl = single.el.querySelector('.cyc-agents-rail')!;
  const idleRootClass = single.el.className;

  const multi = createAgentsBar();
  multi.update([running('m1'), running('m2')]); // two running -> total 2
  const multiEl = multi.el.querySelector('.cyc-agents-rail')!;

  return {
    idleRootClass,
    singleRail: singleEl.outerHTML,
    multiRail: multiEl.outerHTML,
    tokens: [...tokensOf(singleEl), ...tokensOf(multiEl)]
  };
}

let browser: Browser;
const getBrowser = async () => (browser ??= await chromium.launch());

async function measure(rails: ReturnType<typeof producedRails>, theme: 'day' | 'night') {
  const utilities = await compileTailwind(rails.tokens);
  const shell =
    readFileSync(resolve(SHELL, 'chrome.css'), 'utf8') +
    '\n' +
    readFileSync(resolve(SHELL, 'utilities.css'), 'utf8') +
    '\n' +
    THEME_VARS;
  const themeAttr = theme === 'night' ? " data-theme='dark'" : '';
  const html =
    `<!DOCTYPE html><html${themeAttr}><head><meta charset="utf-8"><style>${utilities}\n` +
    `/* un-layered shell */\n${shell}</style></head><body>` +
    `<div id="single" class="${rails.idleRootClass}">${rails.singleRail}</div>` +
    `<div id="multi">${rails.multiRail}</div>` +
    `<div id="multiRtl" dir="rtl">${rails.multiRail}</div>` +
    `</body></html>`;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent(html, {waitUntil: 'load'});
    return await page.evaluate(() => {
      const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!);
      const singleRail = cs('#single .cyc-agents-rail');
      const singleSlots = cs('#single .cyc-agents-rail-slots');
      const singleActive = cs('#single .cyc-agents-rail-active');
      const active = cs('#multi .cyc-agents-rail-active');
      const activeRtl = cs('#multiRtl .cyc-agents-rail-active');
      return {
        railPosition: singleRail.position,
        railWidth: singleRail.width,
        railHeight: singleRail.height,
        railFlex: `${singleRail.flexGrow} ${singleRail.flexShrink} ${singleRail.flexBasis}`,
        railOpacity: singleRail.opacity,
        slotsBgImage: singleSlots.backgroundImage,
        slotsOpacity: singleSlots.opacity,
        singleActiveBg: singleActive.backgroundColor,
        activePosition: active.position,
        activeLeft: active.left,
        activeTop: active.top,
        activeHeight: active.height,
        activeBg: active.backgroundColor,
        activeRadius: active.borderTopLeftRadius,
        activeTransitionProp: active.transitionProperty,
        activeTransitionDur: active.transitionDuration,
        activeRtlLeft: activeRtl.left
      };
    });
  } finally {
    await page.close();
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterAll(async () => {
  await browser?.close();
});

describe('agents-rail cascade: run progress rail geometry resolves under the un-layered shell', () => {
  for (const [theme, accent] of [
    ['day', 'rgb(1, 2, 3)'],
    ['night', 'rgb(10, 11, 12)']
  ] as const) {
    test(`${theme}: rail box + dim gradient + active overlay geometry/ink`, async () => {
      const m = await measure(producedRails(), theme);

      expect(m.railPosition).toBe('relative');
      expect(m.railWidth).toBe('3px'); // w-[0.1875rem]
      expect(m.railHeight).toBe('40px'); // h-10 = 2.5rem
      expect(m.railFlex).toBe('0 0 auto');
      expect(m.railOpacity).toBe('0.45'); // dimmed under `.cyc-agents-idle` parent
      expect(m.slotsBgImage.startsWith('repeating-linear-gradient(')).toBe(true);
      expect(m.slotsOpacity).toBe('0.4');
      expect(m.singleActiveBg).toBe(accent);

      expect(m.activePosition).toBe('absolute');
      expect(m.activeLeft).toBe('0px');
      expect(m.activeBg).toBe(accent);
      expect(m.activeRadius).toBe('3px'); // rounded-[3px]
      expect(m.activeTransitionProp).toBe('top');
      expect(m.activeTransitionDur).toBe('0.25s');
      expect(m.activeHeight).toBe('17px');
      expect(m.activeTop).toBe('1.5px');
      expect(m.activeRtlLeft).toBe('0px');
    });
  }
});
