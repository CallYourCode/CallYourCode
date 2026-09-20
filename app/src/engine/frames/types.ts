import type {EngineEvents} from '../contract';

export type TermSize = {cols: number; rows: number};

export interface FrameContext {
  readonly url: string;

  emit<K extends keyof EngineEvents>(ev: K, ...args: Parameters<EngineEvents[K]>): void;

  engineObjectUrl(path: string): string;

  rememberUserHost(uh: string): void;

  canDo: Set<string>;

  voiceHealthyState: boolean;

  attachedId: string;
  tailedId: string | null;

  readonly terms: Map<string, TermSize>;
}

export type FrameHandler = (ctx: FrameContext, frame: any) => void;
