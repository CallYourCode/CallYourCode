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
  /* THE CHAT LOG'S AXIS EPOCH as the engine last stated it (roster, attach-ok),
   * persisted with the roster so a cold open knows it before any network: the
   * open compares it with the epoch its stored rows carry (rows/repl.ts) and
   * drops a dead axis before painting it. Absent from an older engine. */
  axis?: string;
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
  /* THE ENGINE'S UNREAD COUNT as last broadcast, kept UNZEROED even for the
   * attached (open) chat whose badge `unread` above is forced to 0 (you are
   * reading it). Speech-on-open reads THIS as the same authority the divider
   * uses for WHETHER anything is unheard, and as the count of newest clips to
   * speak when the read-through row has aged out of the loaded window. Runtime
   * only: it never persists and never paints the list. */
  engineUnread?: number;
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

  /* The open chat's known holes inside its window, as list markers (kind
   * 'gap'): the store is fetching those pages from the engine, and the list
   * shows a "Loading N missing messages..." row in their place instead of
   * joining the rows on either side as if nothing were between them. */
  gaps?: CycSessionEvent[];

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

  /** the engine's edit count for this row (contract EngineChatMessage.rev) */
  rev?: number;
};
