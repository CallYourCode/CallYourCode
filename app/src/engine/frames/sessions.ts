import type {EngineAskChoice, EngineSession, EngineTab} from '../contract';
import type {FrameHandler} from './types';

const sessions: FrameHandler = (ctx, frame) => {
  const raw: any[] = Array.isArray(frame.list) ? frame.list : [];
  const list: EngineSession[] = raw.map((s) => {
    const es: EngineSession = {
      id: String(s.id),
      name: String(s.name ?? s.id),
      cwd: String(s.cwd ?? ''),
      unread: Number(s.unread) || 0,
      muted: false,
      alive: s.alive !== false,
      claudeSessionId:
        typeof s.claudeSessionId === 'string' && s.claudeSessionId ? s.claudeSessionId : null
    };

    if (s.settings && typeof s.settings === 'object') {
      const o = s.settings as Record<string, unknown>;
      es.settings = {};
      if (typeof o.muted === 'boolean') es.settings.muted = o.muted;
      if (typeof o.notify === 'boolean') es.settings.notify = o.notify;
      if (typeof o.activity === 'boolean') es.settings.activity = o.activity;
    }

    es.photo = typeof s.photo === 'string' && s.photo ? ctx.engineObjectUrl(s.photo) : null;

    if (typeof s.thinking === 'boolean') es.thinking = s.thinking;

    if (Number.isFinite(s.contextPct) && s.contextPct >= 0 && s.contextPct <= 100) {
      es.contextPct = Number(s.contextPct);
    }

    if (typeof s.status === 'string') es.status = s.status as EngineSession['status'];

    if (s.title && typeof s.title.text === 'string') {
      es.title = {
        text: s.title.text,
        detail: typeof s.title.detail === 'string' && s.title.detail ? s.title.detail : null
      };
    }

    if (typeof s.tab === 'string') es.tab = s.tab;
    if (Number.isFinite(s.turnSince)) es.turnSince = Number(s.turnSince);

    if (Number.isFinite(s.lastActivity)) es.lastActivity = Number(s.lastActivity);

    if (typeof s.agent === 'string' && s.agent.trim()) es.agent = s.agent.trim();

    if (typeof s.agentId === 'string' && s.agentId.trim()) es.agentId = s.agentId.trim();

    if (typeof s.sessionAgentId === 'string' && s.sessionAgentId.trim())
      es.sessionAgentId = s.sessionAgentId.trim();
    if (typeof s.displayAgent === 'string') es.displayAgent = s.displayAgent;
    else if (s.displayAgent === null) es.displayAgent = null;

    if (typeof s.model === 'string' && s.model.trim()) es.model = s.model.trim();
    else if (s.model === null) es.model = null;
    if (Number.isFinite(s.stateChangeSeq)) es.stateChangeSeq = Number(s.stateChangeSeq);

    if (Number.isFinite(s.heardTs)) es.heardTs = Number(s.heardTs);
    if (s.readThrough === null) es.readThrough = null;
    else if (
      s.readThrough &&
      typeof s.readThrough === 'object' &&
      Number.isFinite(s.readThrough.ts)
    ) {
      es.readThrough = {ts: Number(s.readThrough.ts)};
      if (typeof s.readThrough.mid === 'string' && s.readThrough.mid)
        es.readThrough.mid = s.readThrough.mid;
    }

    if (Number.isFinite(s.replyLevel)) es.replyLevel = Number(s.replyLevel);
    if (Number.isFinite(s.order)) es.order = Number(s.order);

    if (
      s.ask &&
      typeof s.ask === 'object' &&
      typeof s.ask.question === 'string' &&
      typeof s.ask.fingerprint === 'string' &&
      Array.isArray(s.ask.choices)
    ) {
      const choices: EngineAskChoice[] = [];
      for (const c of s.ask.choices) {
        if (!c || typeof c !== 'object') continue;
        if (!Number.isFinite(c.n) || typeof c.label !== 'string' || !c.label) continue;
        const choice: EngineAskChoice = {n: Number(c.n), label: c.label};
        if (typeof c.detail === 'string' && c.detail) choice.detail = c.detail;
        if (c.freeText === true) choice.freeText = true;
        choices.push(choice);
      }
      if (choices.length === s.ask.choices.length && choices.length > 1) {
        es.ask = {
          question: s.ask.question,
          context: Array.isArray(s.ask.context)
            ? s.ask.context.filter((l: unknown) => typeof l === 'string')
            : [],
          choices,
          fingerprint: s.ask.fingerprint
        };
      }
    }

    if (s.askUnknown === true || (es.status === 'blocked' && !es.ask)) es.askUnknown = true;
    return es;
  });

  const rawTabs: any[] = Array.isArray(frame.tabs) ? frame.tabs : [];
  const tabs: EngineTab[] = [];
  for (const t of rawTabs) {
    if (!t || typeof t.key !== 'string') continue;
    if (!t.title || typeof t.title.text !== 'string' || !t.title.text) continue;
    tabs.push({
      key: t.key,
      title: {
        text: t.title.text,
        detail: typeof t.title.detail === 'string' && t.title.detail ? t.title.detail : null
      }
    });
  }
  ctx.emit('sessions', list, tabs);
};

const sessionIdChanged: FrameHandler = (ctx, frame) => {
  const from = String(frame.from ?? '');
  const to = String(frame.to ?? '');
  if (!from || !to || from === to) return;

  if (ctx.attachedId === from) ctx.attachedId = to;
  if (ctx.tailedId === from) ctx.tailedId = to;
  const term = ctx.terms.get(from);
  if (term !== undefined) {
    ctx.terms.delete(from);
    ctx.terms.set(to, term);
  }
  ctx.emit('sessionIdChanged', from, to);
};

const compactResult: FrameHandler = (ctx, frame) => {
  ctx.emit(
    'compactResult',
    String(frame.id ?? ''),
    frame.ok === true,
    typeof frame.tell === 'string' ? frame.tell : ''
  );
};

const answerResult: FrameHandler = (ctx, frame) => {
  ctx.emit(
    'answerResult',
    String(frame.id ?? ''),
    frame.ok === true,
    typeof frame.reason === 'string' ? frame.reason : undefined,
    typeof frame.detail === 'string' ? frame.detail : undefined
  );
};

export const sessionFrameHandlers: [string, FrameHandler][] = [
  ['sessions', sessions],
  ['session-id-changed', sessionIdChanged],
  ['compact-result', compactResult],
  ['answer-result', answerResult]
];
