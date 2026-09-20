import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

vi.hoisted(() => {
  (globalThis as {indexedDB?: unknown}).indexedDB ??= {open: () => ({})};
});

// The heic2any WASM decoder is the fallback strategy; a spy stands in for it so
// the decode-order tests can prove native is tried first without loading WASM.
const {heic2anyDefault} = vi.hoisted(() => ({heic2anyDefault: vi.fn()}));
vi.mock('heic2any', () => ({default: heic2anyDefault}));

import {heicToJpegForUpload, isHeic} from '../features/media/heic';
import {
  createComposerBlocks,
  type ComposerBlocksDeps
} from '../features/composer/components/composerBlocks';
import {filesFromEvent} from '../features/composer/fileCollection';
import {pasteImageFile} from '../features/composer/paste';

type HeicWindow = Window & {__cycHeicDecoder?: (blob: Blob) => Promise<Blob>};

const heicWindow = window as HeicWindow;

function file(name: string, type = ''): File {
  return new File(['source'], name, {type, lastModified: 123});
}

describe('HEIC upload boundary', () => {
  beforeEach(() => {
    delete heicWindow.__cycHeicDecoder;
  });

  afterEach(() => {
    delete heicWindow.__cycHeicDecoder;
    vi.restoreAllMocks();
  });

  test('recognizes HEIC MIME variants and extension-only files, but not ordinary images', () => {
    expect(isHeic(file('camera', 'image/heic'))).toBe(true);
    expect(isHeic(file('camera', 'image/heif-sequence'))).toBe(true);
    expect(isHeic(file('camera.HEIC'))).toBe(true);
    expect(isHeic(file('camera.heif'))).toBe(true);
    expect(isHeic(file('camera.jpg', 'image/jpeg'))).toBe(false);
    expect(isHeic(file('camera.heic', 'image/jpeg'))).toBe(false);
  });

  test('does not enter the decoder boundary for a non-HEIC upload', async () => {
    const decoder = vi.fn(async (blob: Blob) => blob);
    heicWindow.__cycHeicDecoder = decoder;
    const source = file('camera.jpg', 'image/jpeg');

    await expect(heicToJpegForUpload(source)).resolves.toBe(source);
    expect(decoder).not.toHaveBeenCalled();
  });

  test('converts through the lazy decoder boundary and keeps file metadata', async () => {
    const decoder = vi.fn(async () => new Blob(['jpeg'], {type: 'image/jpeg'}));
    heicWindow.__cycHeicDecoder = decoder;
    const source = file('camera.heic', 'image/heic');

    const converted = await heicToJpegForUpload(source);

    expect(decoder).toHaveBeenCalledWith(source);
    expect(converted).toMatchObject({name: 'camera.jpg', type: 'image/jpeg', lastModified: 123});
    expect(converted.size).toBe(4);
  });

  test('surfaces the decode error instead of falling back to the raw bytes', async () => {
    heicWindow.__cycHeicDecoder = async () => {
      throw new Error('decoder unavailable');
    };
    const source = file('camera.heif', 'image/heif');

    // The old behavior quietly returned the undecodable .heic; the boundary now
    // rejects so no intake path can silently queue a raw HEIC for upload.
    await expect(heicToJpegForUpload(source)).rejects.toThrow('decoder unavailable');
  });
});

// decode() picks a strategy in a fixed order: the injected test override, then
// the native platform decode (createImageBitmap + a canvas readback, fast on
// iOS Safari and free of the WASM), then heic2any for browsers that cannot
// decode HEIC natively. These prove that order through heicToJpegForUpload.
describe('HEIC decode strategy order', () => {
  const heicFile = () => new File([new Uint8Array(50)], 'x.heic', {type: 'image/heic'});

  beforeEach(() => {
    delete heicWindow.__cycHeicDecoder;
    heic2anyDefault.mockReset();
  });

  afterEach(() => {
    delete heicWindow.__cycHeicDecoder;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Stub the native seam: createImageBitmap plus an OffscreenCanvas whose
  // readback yields a JPEG. `decodes:false` makes the bitmap decode throw, as
  // desktop Chrome does on HEIC, so decode() must fall back.
  const stubNative = (opts: {decodes: boolean}) => {
    const drawImage = vi.fn();
    const convertToBlob = vi.fn(async () => new Blob(['native-jpeg'], {type: 'image/jpeg'}));
    class FakeOffscreen {
      constructor(
        public width: number,
        public height: number
      ) {}
      getContext() {
        return {drawImage};
      }
      convertToBlob = convertToBlob;
    }
    const createImageBitmap = vi.fn(async (_blob: Blob, _options?: unknown) => {
      if (!opts.decodes) throw new Error('native cannot decode HEIC');
      return {width: 4, height: 3, close: vi.fn()} as unknown as ImageBitmap;
    });
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    return {createImageBitmap, convertToBlob};
  };

  test('prefers the injected override over native and heic2any', async () => {
    const overridden = new Blob(['override-jpeg'], {type: 'image/jpeg'});
    const override = vi.fn(async () => overridden);
    heicWindow.__cycHeicDecoder = override;
    const native = stubNative({decodes: true});

    const out = await heicToJpegForUpload(heicFile());

    expect(override).toHaveBeenCalled();
    expect(native.createImageBitmap).not.toHaveBeenCalled();
    expect(heic2anyDefault).not.toHaveBeenCalled();
    expect(out.size).toBe(overridden.size);
  });

  test('tries the native canvas decode before heic2any when both are available', async () => {
    const native = stubNative({decodes: true});

    const out = await heicToJpegForUpload(heicFile());

    expect(native.createImageBitmap).toHaveBeenCalled();
    expect(native.convertToBlob).toHaveBeenCalled();
    expect(heic2anyDefault).not.toHaveBeenCalled();
    expect(out).toMatchObject({name: 'x.jpg', type: 'image/jpeg'});
  });

  test('asks the native decode to apply EXIF orientation from the image', async () => {
    // iPhone HEICs carry an orientation tag and the JPEG canvas export strips
    // EXIF, so the bitmap must be decoded with orientation already baked in or
    // a portrait shot lands sideways.
    const native = stubNative({decodes: true});

    await heicToJpegForUpload(heicFile());

    expect(native.createImageBitmap).toHaveBeenCalledTimes(1);
    expect(native.createImageBitmap.mock.calls[0][1]).toEqual({imageOrientation: 'from-image'});
  });

  test('falls back to the plain bitmap call when the options bag throws a TypeError', async () => {
    // Older engines reject the second argument to createImageBitmap; the decode
    // must retry without options and still succeed.
    const drawImage = vi.fn();
    const convertToBlob = vi.fn(async () => new Blob(['native-jpeg'], {type: 'image/jpeg'}));
    class FakeOffscreen {
      constructor(
        public width: number,
        public height: number
      ) {}
      getContext() {
        return {drawImage};
      }
      convertToBlob = convertToBlob;
    }
    const createImageBitmap = vi.fn(async (_blob: Blob, options?: unknown) => {
      if (options) throw new TypeError('createImageBitmap: options are not supported');
      return {width: 4, height: 3, close: vi.fn()} as unknown as ImageBitmap;
    });
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
    vi.stubGlobal('createImageBitmap', createImageBitmap);

    const out = await heicToJpegForUpload(heicFile());

    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(createImageBitmap.mock.calls[0][1]).toEqual({imageOrientation: 'from-image'});
    expect(createImageBitmap.mock.calls[1][1]).toBeUndefined();
    expect(heic2anyDefault).not.toHaveBeenCalled();
    expect(out).toMatchObject({name: 'x.jpg', type: 'image/jpeg'});
  });

  test('falls back to heic2any when the browser cannot decode HEIC natively', async () => {
    const native = stubNative({decodes: false});
    heic2anyDefault.mockResolvedValue(new Blob(['wasm-jpeg'], {type: 'image/jpeg'}));

    const out = await heicToJpegForUpload(heicFile());

    expect(native.createImageBitmap).toHaveBeenCalled();
    expect(heic2anyDefault).toHaveBeenCalledWith({
      blob: expect.anything(),
      toType: 'image/jpeg',
      quality: 0.92
    });
    expect(out).toMatchObject({name: 'x.jpg', type: 'image/jpeg'});
  });
});

// The file picker, drag-and-drop, and paste all funnel a File into the composer
// through the SAME shared `stage` intake, which routes HEIC through
// `heicToJpegForUpload`. These tests exercise that single funnel plus the two
// non-picker extraction seams (drop + paste) so a dropped/pasted HEIC is proven
// to become a JPEG File before it is queued for upload.
describe('HEIC on every composer intake path', () => {
  let createObjectUrl: PropertyDescriptor | undefined;
  let revokeObjectUrl: PropertyDescriptor | undefined;

  beforeEach(() => {
    delete heicWindow.__cycHeicDecoder;
    createObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    revokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {configurable: true, value: () => 'blob:test'});
    Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: () => {}});
  });

  afterEach(() => {
    delete heicWindow.__cycHeicDecoder;
    vi.unstubAllGlobals();
    if (createObjectUrl) Object.defineProperty(URL, 'createObjectURL', createObjectUrl);
    else delete (URL as {createObjectURL?: unknown}).createObjectURL;
    if (revokeObjectUrl) Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrl);
    else delete (URL as {revokeObjectURL?: unknown}).revokeObjectURL;
  });

  // A microtask + macrotask flush: the intake chain awaits the decoder override
  // and then constructs the JPEG File before it calls onStage.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const jpegDecoder = () => vi.fn(async () => new Blob(['jpeg-bytes'], {type: 'image/jpeg'}));

  // A typed onStage spy so the recorded call args are a [File, onProgress] tuple.
  const stageSpy = () =>
    vi.fn((_file: File, _onProgress: (ratio: number) => void): Promise<unknown> =>
      Promise.resolve()
    );

  function makeBlocks(onStage: ComposerBlocksDeps['onStage']) {
    const input = document.createElement('div');
    const composerRows = document.createElement('div');
    const btnAttach = document.createElement('button');
    const api = createComposerBlocks({
      input,
      composerRows,
      btnAttach,
      isDisabled: () => false,
      setEmpty: vi.fn(),
      applyPlaceholder: vi.fn(),
      onStage
    });
    composerRows.append(api.blocksRow, api.blocksThumb);
    return api;
  }

  test('the shared stage funnel converts a HEIC to a JPEG File before queueing it', async () => {
    heicWindow.__cycHeicDecoder = jpegDecoder();
    const onStage = stageSpy();
    const api = makeBlocks(onStage);

    api.stage(file('IMG_0001.HEIC', 'image/heic'));
    // The chip shows immediately (the converting affordance) while nothing is
    // queued yet, then the converted JPEG is what reaches onStage.
    expect(onStage).not.toHaveBeenCalled();
    await settle();

    expect(onStage).toHaveBeenCalledTimes(1);
    const queued = onStage.mock.calls[0][0] as File;
    expect(queued.type).toBe('image/jpeg');
    expect(queued.name).toBe('IMG_0001.jpg');
    expect(api.staged()[0].file).toBe(queued);
  });

  test('a non-HEIC file passes straight through the funnel unchanged', async () => {
    heicWindow.__cycHeicDecoder = jpegDecoder();
    const onStage = stageSpy();
    const api = makeBlocks(onStage);

    const png = file('shot.png', 'image/png');
    api.stage(png);
    await settle();

    expect(heicWindow.__cycHeicDecoder as ReturnType<typeof jpegDecoder>).not.toHaveBeenCalled();
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onStage.mock.calls[0][0]).toBe(png);
  });

  test('a mixed multi-file batch converts only the HEIC members', async () => {
    heicWindow.__cycHeicDecoder = jpegDecoder();
    const onStage = stageSpy();
    const api = makeBlocks(onStage);

    const png = file('a.png', 'image/png');
    for (const f of [file('b.heic', 'image/heic'), png, file('c.HEIF')]) api.stage(f);
    await settle();

    const queued = onStage.mock.calls.map((c) => c[0] as File);
    expect(queued).toHaveLength(3);
    expect(queued.filter((f) => f.type === 'image/jpeg')).toHaveLength(2);
    expect(queued).toContain(png);
  });

  test('a failed HEIC decode never queues the raw bytes and offers a retry', async () => {
    heicWindow.__cycHeicDecoder = async () => {
      throw new Error('decoder unavailable');
    };
    const onStage = stageSpy();
    const api = makeBlocks(onStage);

    api.stage(file('broken.heic', 'image/heic'));
    await settle();

    expect(onStage).not.toHaveBeenCalled();
    const st = api.staged()[0];
    expect(st.error).toBeInstanceOf(Error);
    expect(typeof st.retry).toBe('function');
    const chip = api.blocksRow.querySelector('.cyc-attach-chip');
    expect(chip?.classList.contains('cyc-attach-failed')).toBe(true);

    // Retrying with a working decoder converts and finally queues the JPEG.
    heicWindow.__cycHeicDecoder = jpegDecoder();
    st.retry?.();
    await settle();
    expect(onStage).toHaveBeenCalledTimes(1);
    expect((onStage.mock.calls[0][0] as File).type).toBe('image/jpeg');
  });

  test('the drop path extracts a HEIC that the funnel then converts', async () => {
    class FakeDragEvent {
      dataTransfer: unknown;
      constructor(init: {dataTransfer: unknown}) {
        this.dataTransfer = init.dataTransfer;
      }
    }
    vi.stubGlobal('DragEvent', FakeDragEvent);

    const heic = file('dropped.heic', 'image/heic');
    const png = file('dropped.png', 'image/png');
    const transfer = {
      items: [heic, png].map((f) => ({kind: 'file', getAsFile: () => f})),
      files: [heic, png]
    };
    const dropped = await filesFromEvent(
      new FakeDragEvent({dataTransfer: transfer}) as unknown as DragEvent
    );
    expect(dropped).toEqual([heic, png]);

    heicWindow.__cycHeicDecoder = jpegDecoder();
    const onStage = stageSpy();
    const api = makeBlocks(onStage);
    // Exactly what main.ts's onFiles handler does: attach every dropped file.
    for (const f of dropped) api.stage(f);
    await settle();

    // The non-HEIC queues synchronously while the HEIC lands after its async
    // decode, so assert membership rather than order.
    const queued = onStage.mock.calls.map((c) => c[0] as File);
    expect(queued).toHaveLength(2);
    expect(queued.map((f) => f.type).sort()).toEqual(['image/jpeg', 'image/png']);
  });

  test('the paste path selects an extension-only HEIC that the funnel converts', async () => {
    // An iPhone paste can drop the MIME type; the picker matched image/* only,
    // so the paste selector must fall back to the .heic extension.
    const heic = file('pasted.heic');
    const data = {
      items: [{kind: 'file', type: '', getAsFile: () => heic}]
    } as unknown as DataTransfer;
    const picked = pasteImageFile(data);
    expect(picked).toBe(heic);

    heicWindow.__cycHeicDecoder = jpegDecoder();
    const onStage = stageSpy();
    const api = makeBlocks(onStage);
    api.stage(picked!);
    await settle();

    expect(onStage).toHaveBeenCalledTimes(1);
    expect((onStage.mock.calls[0][0] as File).type).toBe('image/jpeg');
  });

  test('pasteImageFile ignores non-file clipboard entries', () => {
    const data = {
      items: [
        {kind: 'string', type: 'text/plain', getAsFile: (): File | null => null},
        {
          kind: 'file',
          type: 'application/pdf',
          getAsFile: (): File | null => file('doc.pdf', 'application/pdf')
        }
      ]
    } as unknown as DataTransfer;
    expect(pasteImageFile(data)).toBeNull();
  });
});

describe('local upload URL cache', () => {
  let createObjectUrlDescriptor: PropertyDescriptor | undefined;
  let revokeObjectUrlDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.resetModules();
    createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((file: File) => `blob:${file.name}`)
    });
    Object.defineProperty(URL, 'revokeObjectURL', {configurable: true, value: vi.fn()});
  });

  afterEach(() => {
    if (createObjectUrlDescriptor)
      Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
    else delete (URL as {createObjectURL?: unknown}).createObjectURL;
    if (revokeObjectUrlDescriptor)
      Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
    else delete (URL as {revokeObjectURL?: unknown}).revokeObjectURL;
    vi.restoreAllMocks();
  });

  test('keeps an upload URL stable and evicts the oldest URL above 64 MiB', async () => {
    const {localUploadUrl, rememberLocalUpload} =
      await import('../features/composer/localUploadUrls');
    const mib = 1024 * 1024;
    const first = {name: 'first', size: 64 * mib} as File;
    const second = {name: 'second', size: 1} as File;

    rememberLocalUpload('first', first);
    rememberLocalUpload('first', {name: 'replacement', size: 1} as File);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(localUploadUrl('first')).toBe('blob:first');

    rememberLocalUpload('second', second);
    expect(localUploadUrl('first')).toBeUndefined();
    expect(localUploadUrl('second')).toBe('blob:second');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
  });

  test('aliasing the engine uploadId to the transfer key serves the SAME object URL (no re-mint, no <img> reload)', async () => {
    const {aliasLocalUpload, localUploadUrl, rememberLocalUpload} =
      await import('../features/composer/localUploadUrls');
    rememberLocalUpload('tk-1', {name: 'pic', size: 10} as File);
    expect(aliasLocalUpload('tk-1', 'up-9')).toBe(true);
    expect(localUploadUrl('up-9')).toBe('blob:pic');
    expect(localUploadUrl('up-9')).toBe(localUploadUrl('tk-1'));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    // Idempotent once the target id resolves; false when the source is gone
    // (the caller then falls back to minting from the kept File).
    expect(aliasLocalUpload('tk-1', 'up-9')).toBe(true);
    expect(aliasLocalUpload('never-held', 'up-10')).toBe(false);
    expect(localUploadUrl('up-10')).toBeUndefined();
  });

  test('a shared URL is revoked exactly once, only when its last id is evicted', async () => {
    const {aliasLocalUpload, localUploadUrl, rememberLocalUpload} =
      await import('../features/composer/localUploadUrls');
    const mib = 1024 * 1024;
    rememberLocalUpload('tk-1', {name: 'big', size: 63 * mib} as File);
    aliasLocalUpload('tk-1', 'up-9');
    // The blob's bytes count once, so pressure walks both of its ids out of
    // the cache together; the revoke fires once, after the LAST id goes,
    // never while the other id still answers for the bubble.
    rememberLocalUpload('other', {name: 'other', size: 2 * mib} as File);
    expect(localUploadUrl('tk-1')).toBeUndefined();
    expect(localUploadUrl('up-9')).toBeUndefined();
    expect(localUploadUrl('other')).toBe('blob:other');
    const revoked = (URL.revokeObjectURL as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'blob:big'
    );
    expect(revoked).toHaveLength(1);
  });
});
