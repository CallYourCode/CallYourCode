import {failed, type FsFail} from '@/engine/fsFail';
import {callRead, readMs} from './cyc';

export type {FsFail};
export {failed};

export type FsEntry = {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;

  children?: boolean;
  link?: boolean;
};

type FsOkList = {
  ok: true;
  path: string;
  root: string;
  name: string;
  entries: FsEntry[];
  total: number;
  truncated: boolean;
};
type FsList = FsOkList | FsFail;

type FsOkText = {
  ok: true;
  kind: 'text';
  path: string;
  name: string;
  size: number;
  mtime: number;
  lines: number;
  text: string;
  truncated: boolean;
};
type FsOkImage = {ok: true; kind: 'image'; path: string; name: string; size: number; mtime: number};
type FsOkBinary = {
  ok: true;
  kind: 'binary';
  path: string;
  name: string;
  size: number;
  mtime: number;
};
export type FsRead = FsOkText | FsOkImage | FsOkBinary | FsFail;

export type GitCode = 'M' | 'A' | 'D' | 'R' | 'U' | 'C' | 'I';

type GitStatus =
  | {ok: true; repo: true; root: string; files: Record<string, GitCode>; truncated: boolean}
  | {ok: true; repo: false}
  | FsFail;

export type DiffMark = {line: number; kind: 'added' | 'modified' | 'deleted'};

type GitDiff =
  | {ok: true; repo: true; marks: DiffMark[]; added: number; modified: number; deleted: number}
  | {ok: true; repo: false}
  | FsFail;

const TIMEOUT_MS = readMs();

async function ask<T>(
  _sessionId: string,
  route: string,
  params: Record<string, string>,
  signal?: AbortSignal
): Promise<T | FsFail> {
  return callRead<T>(route, params, TIMEOUT_MS, signal) as Promise<T | FsFail>;
}

export function fsList(sessionId: string, path: string, signal?: AbortSignal): Promise<FsList> {
  return ask<FsList>(sessionId, 'list', {path}, signal) as Promise<FsList>;
}

export function fsRead(sessionId: string, path: string, signal?: AbortSignal): Promise<FsRead> {
  return ask<FsRead>(sessionId, 'read', {path}, signal) as Promise<FsRead>;
}

export function fsGit(sessionId: string, signal?: AbortSignal): Promise<GitStatus> {
  return ask<GitStatus>(sessionId, 'git', {}, signal) as Promise<GitStatus>;
}

export function fsDiff(sessionId: string, path: string, signal?: AbortSignal): Promise<GitDiff> {
  return ask<GitDiff>(sessionId, 'diff', {path}, signal) as Promise<GitDiff>;
}

export async function fsRaw(sessionId: string, path: string): Promise<string> {
  const r = await callRead<{ok: true; base64: string; mime: string}>('raw', {path}, TIMEOUT_MS);
  if (failed(r) || !('base64' in r) || !r.base64) return '';
  return `data:${r.mime};base64,${r.base64}`;
}

const SEVERITY: GitCode[] = ['C', 'D', 'M', 'A', 'R', 'U'];

export function foldDirs(files: Record<string, GitCode>): Record<string, GitCode> {
  const out: Record<string, GitCode> = {...files};
  for (const [path, code] of Object.entries(files)) {
    if (code === 'I') continue;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const had = out[dir];

      if (had === 'I') continue;
      if (!had || SEVERITY.indexOf(code) < SEVERITY.indexOf(had)) out[dir] = code;
    }
  }
  return out;
}
