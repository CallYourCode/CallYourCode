import {cyclog} from '@/shared/logging';
import {
  globalSettings,
  refreshGlobalSettings,
  serverHasReplyDials,
  setGlobalSettings
} from '../settings';
import {RUNGS, promptBitList, type ReplyStringOverrides} from '../../config/replyStrings';
import {conns} from './registry';
import {pluginRpc} from './plugins';

export async function setReplyStrings(strings: ReplyStringOverrides): Promise<boolean> {
  const ok = await setGlobalSettings({strings});
  if (ok) pushReplyDials();
  return ok;
}

export async function setReplyDial(key: string, n: number): Promise<boolean> {
  const patch =
    key === 'verbosity' ? {replyLevel: n} : key === 'complexity' ? {complexity: n} : null;
  if (!patch) return false;
  const ok = await setGlobalSettings(patch);
  if (ok) pushReplyDials();
  return ok;
}

type WordingPatch = {
  reply: Record<number, {name: string | null; text: string | null}>;
  complexity: Record<number, {name: string | null; text: string | null}>;
};

function wordingPatch(strings: ReplyStringOverrides): WordingPatch {
  const reply: WordingPatch['reply'] = {};
  const complexity: WordingPatch['complexity'] = {};
  for (const n of RUNGS) {
    reply[n] = {
      name: strings.reply?.[n]?.name ?? null,
      text: strings.reply?.[n]?.text ?? null
    };
    complexity[n] = {
      name: strings.complexity?.[n]?.name ?? null,
      text: strings.complexity?.[n]?.text ?? null
    };
  }
  return {reply, complexity};
}

async function pushReplyDialsTo(engineKey: string): Promise<void> {
  const stated = serverHasReplyDials();
  if (!stated) return;
  const g = globalSettings();
  if (stated.replyLevel) {
    await pluginRpc(engineKey, 'reply-dials', 'set', null, {key: 'verbosity', n: g.replyLevel});
  }
  if (stated.complexity) {
    await pluginRpc(engineKey, 'reply-dials', 'set', null, {key: 'complexity', n: g.complexity});
  }
  await pluginRpc(engineKey, 'reply-dials', 'toggle', null, {
    verbosityOn: g.verbosityOn,
    complexityOn: g.complexityOn,
    promptBitsOn: g.promptBitsOn
  });
  await pluginRpc(engineKey, 'reply-dials', 'wording', null, wordingPatch(g.strings));
  await pluginRpc(
    engineKey,
    'reply-dials',
    'bits',
    null,
    g.strings.bits === undefined ? {reset: true} : {bits: promptBitList(g.strings)}
  );
}

const replyDialPushes = new Map<string, Promise<void>>();
export function pushReplyDials(): void {
  if (!serverHasReplyDials()) return;
  for (const c of conns) {
    const previous = replyDialPushes.get(c.key) ?? Promise.resolve();
    const next = previous.then(() => pushReplyDialsTo(c.key)).catch(() => {});
    replyDialPushes.set(c.key, next);
    void next.finally(() => {
      if (replyDialPushes.get(c.key) === next) replyDialPushes.delete(c.key);
    });
  }
}

type EngineDials = {level?: number; complexity?: number; migrated?: boolean};

async function askDials(engineKey: string): Promise<EngineDials | null> {
  const answer = await pluginRpc(engineKey, 'reply-dials', 'get', null, {});
  if (!answer.ok || !answer.result || typeof answer.result !== 'object') return null;
  return answer.result as EngineDials;
}

let adopting: Promise<void> | null = null;
export function syncReplyDials(_engineKey?: string): void {
  void _engineKey;
  adopting = (adopting ?? Promise.resolve())
    .then(async () => {
      await refreshGlobalSettings();

      const known = serverHasReplyDials();
      if (known === null) {
        cyclog('dials.no-home', {});
        return;
      }

      if (known.replyLevel) {
        pushReplyDials();
        return;
      }

      const engineKeys = conns.map((c) => c.key);
      const answers = await Promise.all(engineKeys.map(askDials));

      let take: EngineDials | null = null;
      for (const a of answers) {
        if (!a?.migrated || !Number.isInteger(a.level)) continue;
        if (!take || a.level! > take.level!) take = a;
      }

      if (take) {
        cyclog('dials.adopt', {
          level: take.level,
          asked: engineKeys.length,
          answered: answers.filter(Boolean).length
        });

        await setGlobalSettings({replyLevel: take.level});
        pushReplyDials();
        return;
      }

      cyclog('dials.no-level-chosen', {
        asked: engineKeys.length,
        answered: answers.filter(Boolean).length
      });
      pushReplyDials();
    })
    .catch(() => {});
}
