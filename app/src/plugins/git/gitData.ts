import {failed, type FsFail} from '@/engine/fsFail';
import {callRead, readMs} from './cyc';

export type {FsFail};
export {failed};

export type GitCode = 'M' | 'A' | 'D' | 'R' | 'U' | 'C' | 'I';

export type GitRow = {
  path: string;
  code: GitCode;
  from?: string;

  outside?: true;
};

export type GitCommit = {
  sha: string;
  short: string;
  subject: string;
  author: string;
  when: number;
  refs: string;
};

export type GitPaneState = {
  ok: true;
  repo: true;
  root: string;
  name: string;
  cwdInRepo: string;
  branch: string;
  detached: string;
  upstream: string;
  ahead: number;
  behind: number;
  staged: GitRow[];
  unstaged: GitRow[];
  truncated: boolean;
  log: GitCommit[];
  logError: string;
  lastMessage: string;
};

export type GitPane = GitPaneState | {ok: true; repo: false} | FsFail;

type PatchLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
type PatchLine = {k: PatchLineKind; o: number; n: number; t: string};

export type GitPatch =
  | {
      ok: true;
      lines: PatchLine[];
      added: number;
      deleted: number;
      files: number;
      binary: boolean;
      truncated: boolean;
    }
  | FsFail;

export type ChangeWhat = 'commit' | 'staged' | 'unstaged';

export type ChangeFile = {
  path: string;
  from?: string;
  code: GitCode;
  added: number;
  deleted: number;
  binary: boolean;
  lines: PatchLine[];
  truncated: boolean;

  skipped: boolean;
};

export type GitChange =
  | {
      ok: true;
      what: ChangeWhat;
      commit: GitCommit | null;
      files: ChangeFile[];
      fileCount: number;
      added: number;
      deleted: number;
      truncated: boolean;
    }
  | FsFail;

export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string;
  ahead: number;
  behind: number;
};

type GitBranches =
  | {
      ok: true;
      repo: true;
      branches: GitBranch[];
      head: string;
      detached: string;
      defaultBranch: string;
    }
  | {ok: true; repo: false}
  | FsFail;

type GitRefLog = {ok: true; ref: string; log: GitCommit[]} | FsFail;

export type CompareAgainst = 'mergebase' | 'main';

type GitCompare =
  | {
      ok: true;
      ref: string;
      against: CompareAgainst;
      base: string;
      commits: GitCommit[];
      files: ChangeFile[];
      fileCount: number;
      added: number;
      deleted: number;
      truncated: boolean;
    }
  | FsFail;

const READ_MS = readMs();

async function ask<T>(
  _sessionId: string,
  route: string,
  opts: {
    params?: Record<string, string>;
    ms: number;
    signal?: AbortSignal;
  }
): Promise<T | FsFail> {
  return callRead<T>(route, opts.params ?? {}, opts.ms, opts.signal) as Promise<T | FsFail>;
}

export function gitPane(sessionId: string, signal?: AbortSignal): Promise<GitPane> {
  return ask<GitPane>(sessionId, 'pane', {ms: READ_MS, signal}) as Promise<GitPane>;
}

export function gitPatch(
  sessionId: string,
  path: string,
  side: 'staged' | 'unstaged',
  signal?: AbortSignal
): Promise<GitPatch> {
  return ask<GitPatch>(sessionId, 'patch', {
    params: {path, side},
    ms: READ_MS,
    signal
  }) as Promise<GitPatch>;
}

export function gitShow(sessionId: string, sha: string, signal?: AbortSignal): Promise<GitPatch> {
  return ask<GitPatch>(sessionId, 'show', {
    params: {sha},
    ms: READ_MS,
    signal
  }) as Promise<GitPatch>;
}

export function gitChange(
  sessionId: string,
  what: ChangeWhat,
  sha: string,
  signal?: AbortSignal
): Promise<GitChange> {
  return ask<GitChange>(sessionId, 'change', {
    params: {what, sha},
    ms: READ_MS,
    signal
  }) as Promise<GitChange>;
}

export function gitBranches(sessionId: string, signal?: AbortSignal): Promise<GitBranches> {
  return ask<GitBranches>(sessionId, 'branches', {ms: READ_MS, signal}) as Promise<GitBranches>;
}

export function gitRefLog(
  sessionId: string,
  ref: string,
  signal?: AbortSignal
): Promise<GitRefLog> {
  return ask<GitRefLog>(sessionId, 'log', {
    params: {ref},
    ms: READ_MS,
    signal
  }) as Promise<GitRefLog>;
}

export function gitCompare(
  sessionId: string,
  ref: string,
  against: CompareAgainst,
  signal?: AbortSignal
): Promise<GitCompare> {
  return ask<GitCompare>(sessionId, 'compare', {
    params: {ref, against},
    ms: READ_MS,
    signal
  }) as Promise<GitCompare>;
}
