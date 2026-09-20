import type {CycFileRef, CycMediaItem, CycMessage, CycSession} from '../../types';
import {cyclog} from '@/shared/logging';
import {sessionMedia, shownKey} from '@/features/chat/content';
import {localUploadUrl} from '@/features/composer/localUploadUrls';
import {saveBlob} from '@/features/media/downloads';
import {toast} from '../../components/widgets';
import {openImageViewer, type ViewerItem} from './imageViewer';
import {openFileViewer} from './fileViewer';
import {openHtmlViewer, type HtmlViewerOptions} from './htmlViewer';
import {openPluginPanelById} from '../../components/pluginPanel';
import * as engine from '../../engine/store';
import {engineCapFetch, engineObjectUrl} from '../../engine/contract';
import * as showVault from '../../engine/showVault';
import {sessionState, bootUrlNav, dataState} from '../../sessionState';

interface MediaViewersDeps {
  active(): CycSession | null;
  allSessions(): CycSession[];

  attachToComposer(file: File, fromPage: {label: string; page: string}): void;

  onShownDocNav(): void;

  restored(what: 'doc' | 'profile'): void;

  restoreGraceMs(): number;
  setView(view: 'list' | 'chat' | 'profile'): void;
  goToMessage(
    sessionId: string,
    ref: {ts: number; role: 'user' | 'claude'; seq?: number}
  ): Promise<boolean>;
}

export function createMediaViewers(deps: MediaViewersDeps) {
  const {active, allSessions} = deps;

  function sessionAttachments(): CycMediaItem[] {
    const s = active();
    if (!s || dataState.mode !== 'live') return [];

    return sessionMedia(s, (i) =>
      i.from === 'upload'
        ? (localUploadUrl(i.refId) ?? engine.uploadUrl(s.id, i.refId))
        : engine.docUrl(s.id, i.refId) + (i.kind === 'image' ? '/raw' : '')
    );
  }

  // The viewer gets the engine URL (the image cache key) and, for a picture this
  // device sent, a live lookup of its local object URL; never the local URL
  // itself, which the upload cache may revoke while the viewer holds it.
  function shownImageItem(i: CycMediaItem): ViewerItem & {key: string} {
    const s = active();
    if (i.from === 'upload') {
      const refId = i.refId;
      return {
        key: i.key,
        url: s ? engine.uploadUrl(s.id, refId) : i.url,
        name: i.name,
        local: () => localUploadUrl(refId)
      };
    }
    return {
      key: i.key,
      url: i.url,
      name: i.name,

      docId: i.refId,
      bytes: s ? () => showVault.imageBlob(i.refId, i.url, s.id, i.name) : undefined
    };
  }

  function imageGallery(): (ViewerItem & {key: string})[] {
    return sessionAttachments()
      .filter((i) => i.kind === 'image')
      .map(shownImageItem);
  }

  function openAlbumAt(key: string, fallback: ViewerItem) {
    let albumDoc: string | null = null;
    const album = {
      onShow: (item: ViewerItem) => {
        albumDoc = item.docId ?? null;
        markShownDoc(albumDoc);
      },

      onClose: () => {
        if (albumDoc) clearShownDoc(albumDoc);
      }
    };
    const items = imageGallery();
    const at = items.findIndex((x) => x.key === key);
    if (at < 0) {
      openImageViewer([fallback], 0, album);
      return;
    }
    openImageViewer(items, at, album);
  }

  function textDocKind(name: string, mime?: string): 'markdown' | 'diff' | 'text' | null {
    const dot = name.lastIndexOf('.');
    const ext = (dot >= 0 ? name.slice(dot + 1) : '').toLowerCase();
    if (ext === 'md' || ext === 'markdown' || mime === 'text/markdownFormat') return 'markdown';
    if (ext === 'diff' || ext === 'patch') return 'diff';
    const textExt = [
      'txt',
      'text',
      'json',
      'log',
      'csv',
      'xml',
      'yml',
      'yaml',
      'html',
      'htm',
      'css',
      'js',
      'ts',
      'sh',
      'py',
      'ini',
      'conf',
      'toml'
    ];
    if (
      (mime && (mime.startsWith('text/') || mime === 'application/json')) ||
      textExt.includes(ext)
    )
      return 'text';
    return null;
  }

  function openDocAttachment(name: string, url: string, mime?: string) {
    const kind = textDocKind(name, mime);
    if (!kind) {
      const tab = window.open('', '_blank');
      void engineObjectUrl(url).then(
        (u) => {
          if (tab && !tab.closed) tab.location.href = u;
          else window.open(u, '_blank');
        },
        () => {
          tab?.close();
          toast('Could not fetch ' + name);
        }
      );
      return;
    }

    const file: CycFileRef = {docId: url, name, fileKind: kind, size: 0};
    openFileViewer(file, undefined, active()?.id ?? '', undefined, async () => {
      const res = await engineCapFetch(url, {signal: AbortSignal.timeout(10_000)});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return {name, fileKind: kind, content: await res.text()};
    });
  }

  function openProfileAttachments(item: CycMediaItem) {
    const s = active();
    if (!s) return;
    if (item.kind === 'image') {
      openAlbumAt(item.key, shownImageItem(item));
      return;
    }
    if (item.from === 'shown') {
      const m = s.messages.find((x) => x.file?.docId === item.refId);
      if (m) onOpenFileCard(m);
      return;
    }

    openDocAttachment(item.name, item.url);
  }

  const markShownDoc = (docId: string | null) => {
    sessionState.shownDoc = docId;

    deps.onShownDocNav();
  };
  const clearShownDoc = (docId: string) => {
    if (sessionState.shownDoc !== docId) return;
    markShownDoc(null);
  };

  function shownPageOptions(owner: string | null, docId: string): HtmlViewerOptions {
    return {
      sessionId: owner ?? '',
      onClose: () => clearShownDoc(docId),
      onSubmit: ({label, body, page, json}) => {
        const s = active();
        if (dataState.mode !== 'live' || !s) {
          return {
            ok: false,
            message: 'there is no live conversation behind this page, so ' + 'nothing was attached'
          };
        }
        if (owner && s.id !== owner) {
          return {
            ok: false,
            message:
              'the open conversation changed while this page was ' + 'open, so nothing was attached'
          };
        }

        const slug = label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        const name = `${slug.slice(0, 40) || 'answer'}.${json ? 'json' : 'txt'}`;
        deps.attachToComposer(
          new File([body], name, {type: json ? 'application/json' : 'text/plain'}),
          {label, page}
        );
        return {ok: true, message: `attached to the conversation as ${name}`};
      }
    };
  }

  if (new URLSearchParams(location.search).get('testhooks')) {
    (window as any).__cycOpenHtmlViewer = (file: CycFileRef, url?: string) =>
      openShownDoc(file, url, active()?.id ?? null);
    (window as any).__cycOpenShownDoc = (file: CycFileRef, url?: string) =>
      openShownDoc(file, url, active()?.id ?? null);

    (window as any).__cycOpenPluginPanel = (pluginId: string, sessionId?: string) =>
      openPluginPanelById(pluginId, sessionId ?? active()?.id ?? null, (ref) =>
        deps
          .goToMessage(active()?.id ?? '', ref)
          .then((ok) => ({ok, message: ok ? '' : 'That message is not loaded here yet'}))
      );

    (window as any).__cycOpenUploadDoc = (name: string, url: string, mime?: string) =>
      openDocAttachment(name, url, mime);

    (window as any).__cycDownloadShownBinary = (name: string, url: string) =>
      downloadShownBinary(name, url);
  }

  function onOpenFileCard(m: CycMessage) {
    if (!m.file) return;
    const s = active();

    if (m.file.fileKind === 'binary') {
      const raw = dataState.mode === 'live' && s ? engine.docUrl(s.id, m.file.docId) + '/raw' : '';
      void downloadShownBinary(m.file.name, raw);
      return;
    }

    if (m.file.fileKind === 'image') {
      if (dataState.mode === 'live' && s) {
        const docId = m.file.docId;
        const raw = engine.docUrl(s.id, docId) + '/raw';
        const name = m.file.name;

        openAlbumAt(shownKey(docId), {
          url: raw,
          name,
          docId,
          bytes: () => showVault.imageBlob(docId, raw, s.id, name)
        });
      }
      return;
    }
    const url = dataState.mode === 'live' && s ? engine.docUrl(s.id, m.file.docId) : undefined;
    openShownDoc(m.file, url, s?.id ?? null);
  }

  async function downloadShownBinary(name: string, url: string) {
    if (!url) {
      toast('No engine to download from');
      return;
    }
    try {
      const res = await engineCapFetch(url, {signal: AbortSignal.timeout(30_000)});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      saveBlob(name, await res.blob());
    } catch {
      toast('Download failed');
    }
  }

  function openShownDoc(file: CycFileRef, url: string | undefined, owner: string | null) {
    if (file.fileKind === 'html') {
      openHtmlViewer(file, url, shownPageOptions(owner, file.docId));
    } else {
      openFileViewer(file, url, owner ?? '', () => clearShownDoc(file.docId));
    }
    markShownDoc(file.docId);
  }

  void (async () => {
    const docId = bootUrlNav.doc;
    if (!docId) return;

    const openWith = (m: CycMessage, owner: string) => {
      if (!m.file) return;
      if (m.file.fileKind === 'image') {
        onOpenFileCard(m);
        return;
      }
      let url: string | undefined;

      try {
        url = engine.docUrl(owner, docId);
      } catch {
        url = undefined;
      }
      openShownDoc(m.file, url, owner);
    };

    const fromVault = await showVault.get(docId);
    if (fromVault && fromVault.fileKind !== 'image') {
      cyclog('nav.doc.restored', {
        doc: docId,
        from: 'vault',
        why: 'the URL said a shown page was open and this device still had it'
      });
      let url: string | undefined;
      try {
        url = fromVault.sessionId ? engine.docUrl(fromVault.sessionId, docId) : undefined;
      } catch {
        url = undefined;
      }
      openShownDoc(
        {
          docId,
          name: fromVault.name || 'Document',
          size: fromVault.bytes,
          fileKind: (fromVault.fileKind || 'text') as CycFileRef['fileKind']
        },
        url,
        fromVault.sessionId || null
      );
      return;
    }

    for (let tries = 0; tries < 40; tries++) {
      for (const s of allSessions()) {
        const m = s.messages.find((x) => x.file?.docId === docId);
        if (!m?.file) continue;

        if (m.file.fileKind === 'image' && s.id !== sessionState.activeId) continue;
        cyclog('nav.doc.restored', {
          doc: docId,
          from: 'conversation',
          kind: m.file.fileKind,
          why: 'the URL said something shown was open and its card is still in the transcript'
        });
        openWith(m, s.id);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    deps.restored('doc');
    cyclog('nav.doc.gone', {
      doc: docId,
      why:
        'the URL named a shown document this device no longer has and no open ' +
        'conversation carries, so the chat is what is on screen'
    });
  })();

  if (bootUrlNav.profile) {
    setTimeout(() => {
      const until = Date.now() + deps.restoreGraceMs() + 1000;
      const tryProfile = () => {
        if (sessionState.activeId) {
          if (!bootUrlNav.list) deps.setView('profile');
          deps.restored('profile');
          return;
        }
        if (Date.now() < until) {
          setTimeout(tryProfile, 200);
          return;
        }
        deps.restored('profile');
        cyclog('nav.profile.nochat', {
          why:
            'the URL said the profile pane was open and no conversation came back to ' +
            'put it over, so the list is what is on screen'
        });
      };
      tryProfile();
    }, 0);
  }

  return {
    sessionAttachments,
    openAlbumAt,
    openDocAttachment,
    openProfileAttachments,
    onOpenFileCard,
    openShownDoc
  };
}
