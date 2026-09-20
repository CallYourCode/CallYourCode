import type {EngineAgentRun, EngineReadThrough, EngineSessionSettings} from '../contract';
import type {CycMessage, CycSession, CycSessionEvent} from '../../types';

export type CycEngineSession = CycSession & {
  engineKey: string;
  paneId: string;

  tabKey: string;
  alive: boolean;

  settings?: EngineSessionSettings;

  confirmedSettings?: EngineSessionSettings;

  sessionAgentId?: string;
  claudeSessionId: string | null;
  /** the session records held for this agent: rows of the same pages as
   *  `messages`, kept apart so the chat surface can merge them by ts */
  events: CycSessionEvent[];
  agentRuns: EngineAgentRun[];
  heardTs?: number;
  /* THE ENGINE'S READ-THROUGH ROW IDENTITY as last broadcast (fix-unread):
   * the durable key and instant of the newest row read, session-global across
   * every device. The one authority the divider, landing and speech anchor on,
   * overlaid at display time with this device's own pending sightings
   * (readState.ts effectiveMarkerOf). Never recomputed from row timestamps. */
  readThrough?: EngineReadThrough | null;
  replayed?: boolean;

  historyAdded?: number;

  historyPending?: boolean;

  awaitingChatStart?: boolean;
  historyAskedAt?: number;

  churnGrey?: boolean;
  replyLevel?: number;

  notOnEngine?: boolean;

  engineTotal?: number;
  /* Highest seq the engine has confirmed this device holds contiguously.
   * Mirror of the persisted |meta.frontier. -1 / absent = never confirmed. */
  frontier?: number;
  loadingOlder?: boolean;
  /* The lowest page loadOlder has already probed. On a sparse seq axis (an
   * engine log with persisted seq gaps serves sealed pages with NO rows) an
   * empty page admits nothing, so lowestHeldSeq alone would ask for the same
   * page forever; this floor makes each probe move down one page regardless. */
  olderFloor?: number;

  paintSource?: 'cache' | 'replay';

  pointer?: number;
  pointerPage?: number;
  tailPage?: number;
  pageSize?: number;
};
export type CycEngineMessage = CycMessage & {
  msgId?: string;

  /** the engine's durable per-row id (contract EngineChatMessage.mid): the
   *  restart- and renumber-invariant identity this row is deduped on */
  mid?: string;

  dedupeKey?: string;

  fromReplay?: boolean;

  wireText?: string;

  cid?: string;

  seq?: number;
};
