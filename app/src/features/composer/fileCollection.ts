import {installFileDrop, type FileDrop} from './fileDropZone';
import {prefersMotion} from '@/shared/capabilities';
import {paintPresentation, type Presentation} from '@/components/presentation';

type WebkitEntry = {
  isFile: boolean;
  isDirectory: boolean;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (entries: WebkitEntry[]) => void, err: (e: unknown) => void) => void;
  };
};

function readEntryFile(entry: WebkitEntry): Promise<File | null> {
  if (!entry.file) return Promise.resolve(null);
  return new Promise((resolve) =>
    entry.file!(
      (f) => resolve(f),
      () => resolve(null)
    )
  );
}

// Drain a directory reader. `readEntries` hands back at most a browser-defined
// batch (~100) per call and signals completion with an empty batch, so it must be
// pumped in a loop until it runs dry.
async function readAllEntries(reader: {
  readEntries: (ok: (entries: WebkitEntry[]) => void, err: (e: unknown) => void) => void;
}): Promise<WebkitEntry[]> {
  const all: WebkitEntry[] = [];
  for (;;) {
    const batch = await new Promise<WebkitEntry[]>((resolve) =>
      reader.readEntries(
        (entries) => resolve(entries),
        () => resolve([])
      )
    );
    if (!batch.length) return all;
    all.push(...batch);
  }
}

async function collectEntry(root: WebkitEntry, out: File[]): Promise<void> {
  const stack: WebkitEntry[] = [root];
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.isDirectory && entry.createReader) {
      stack.push(...(await readAllEntries(entry.createReader())));
    } else if (entry.isFile) {
      const file = await readEntryFile(entry);
      if (file) out.push(file);
    }
  }
}

function transferOf(e: ClipboardEvent | DragEvent): DataTransfer | null {
  return e instanceof DragEvent ? e.dataTransfer : e.clipboardData;
}

// Extract every File carried by a drag-drop (or clipboard) transfer, walking
// dropped directory trees. The extracted Files are handed to the composer's
// shared `stage` intake, which is where the HEIC-to-JPEG conversion happens, so
// a dropped iPhone .heic is normalized exactly like a picked or pasted one.
export async function filesFromEvent(e: ClipboardEvent | DragEvent): Promise<File[]> {
  const transfer = transferOf(e);
  if (!transfer) return [];

  const items = transfer.items;
  if (!items) return transfer.files ? Array.from(transfer.files) : [];

  const out: File[] = [];
  const walks: Promise<void>[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.() as WebkitEntry | null;
    if (entry) {
      walks.push(collectEntry(entry, out));
    } else {
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  await Promise.all(walks);
  return out;
}

function dragHasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;

  return Array.from(types).includes('Files');
}

export function installComposerDropZone(opts: {
  pane: HTMLElement;

  onFiles: (files: File[]) => void;

  canDrop: () => boolean;
}): () => void {
  const {pane, onFiles, canDrop} = opts;

  // The layer is the message area: from the chat's pad-top line (header, pane
  // gap, agents bar) down to its pad-bottom line (composer, pane gap, floor),
  // plus whatever the composer has grown by (a chip row). The drop target
  // fills it inside `--cyc-drop-pad`.
  const dropLayer = document.createElement('div');
  dropLayer.classList.add(
    'cyc-drop-layer',
    ...(
      'absolute! z-[5] inset-x-0 top-[var(--cyc-chat-pad-top)] ' +
      'bottom-[calc(var(--cyc-chat-pad-bottom)+var(--cyc-composer-overshoot,0px))] ' +
      'p-[var(--cyc-drop-pad,20px)] ' +
      'flex flex-col justify-center items-center gap-3 ' +
      'opacity-0 [transition:opacity_0.2s_ease] ' +
      '[&:not(.cyc-drop-mounted)]:hidden [&.cyc-drop-shown]:opacity-100'
    ).split(' ')
  );
  pane.append(dropLayer);

  // Drop padding (the inset between the message area and the target): 10px on
  // phone, 20px otherwise.
  const paintDropPad = (p: Presentation) => {
    dropLayer.style.setProperty('--cyc-drop-pad', p.width === 'phone' ? '10px' : '20px');
  };
  const unpaintDropTop = paintPresentation(dropLayer, paintDropPad);

  let drop: FileDrop | undefined;
  let mounted = false;
  let cancelFade: (() => void) | undefined;

  // Reveal puts the layer in flow (`.cyc-drop-mounted`) then transitions its opacity up
  // via `.cyc-drop-shown`; the hide drops `.cyc-drop-shown` so opacity glides back
  // to 0 and strips `.cyc-drop-mounted` (display:none) once the transition ends. A new
  // toggle drops the pending listener before re-arming.
  const fade = (mount: boolean, onFadeEnd?: () => void) => {
    cancelFade?.();
    const finish = () => {
      dropLayer.removeEventListener('transitionend', finish);
      cancelFade = undefined;
      if (!mount) dropLayer.classList.remove('cyc-drop-mounted', 'cyc-drop-shown');
      onFadeEnd?.();
    };
    cancelFade = () => {
      dropLayer.removeEventListener('transitionend', finish);
      cancelFade = undefined;
    };
    if (mount) {
      dropLayer.classList.add('cyc-drop-mounted');
      // Force layout so the opacity transition runs from the just-revealed 0.
      void dropLayer.offsetWidth;
      dropLayer.classList.add('cyc-drop-shown');
    } else {
      dropLayer.classList.remove('cyc-drop-shown');
    }
    if (!prefersMotion()) return finish();
    dropLayer.addEventListener('transitionend', finish);
  };

  const toggle = (mount: boolean) => {
    if (mount === mounted) return;
    mounted = mount;

    if (mount && !drop) {
      drop = installFileDrop(dropLayer, {
        icon: 'document',
        title: 'Drop files to attach them',
        onDrop: () => toggle(false)
      });
    }

    fade(mount, () => {
      // Tear the target down once the hide has settled, unless a re-show raced in.
      if (!mounted && drop) {
        drop.destroy();
        drop = undefined;
      }
    });
  };

  // Show while a file drag hovers the pane. `dragenter`/`dragover` both arm it
  // (enter for the first cross-in, over for the steady state); both must keep
  // calling preventDefault so the pane stays a valid drop surface.
  const show = (e: DragEvent) => {
    if (!dragHasFiles(e) || !canDrop()) return;
    e.preventDefault();
    e.stopPropagation();
    toggle(true);
  };

  // relatedTarget containment replaces the depth counter: a leave into a descendant
  // keeps the overlay, a leave to a node outside the pane (or null, i.e. off the
  // window) tears it down.
  const onDragLeave = (e: DragEvent) => {
    const to = e.relatedTarget as Node | null;
    if (!to || !pane.contains(to)) toggle(false);
  };

  const onDrop = async (e: DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    toggle(false);
    if (!canDrop()) return;
    const files: File[] = await filesFromEvent(e);
    if (!files.length) return;
    onFiles(files);
  };

  const onWindowDrop = () => toggle(false);

  pane.addEventListener('dragenter', show);
  pane.addEventListener('dragover', show);
  pane.addEventListener('dragleave', onDragLeave);
  pane.addEventListener('drop', onDrop);
  window.addEventListener('drop', onWindowDrop);

  return () => {
    pane.removeEventListener('dragenter', show);
    pane.removeEventListener('dragover', show);
    pane.removeEventListener('dragleave', onDragLeave);
    pane.removeEventListener('drop', onDrop);
    window.removeEventListener('drop', onWindowDrop);
    unpaintDropTop();
    drop?.destroy();
    dropLayer.remove();
  };
}
