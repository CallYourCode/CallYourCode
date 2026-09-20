type ReleaseDecodeResult<B> = {
  fromStream: string | null;

  batch: B | null;

  decoded: boolean;
};

export async function transcriptAtRelease<B>(opts: {
  streamRun: Promise<string | null>;

  decodeClip: () => Promise<B | null>;

  graceMs: number;

  onGraceExpired?: () => void;
}): Promise<ReleaseDecodeResult<B>> {
  const {streamRun, decodeClip, graceMs, onGraceExpired} = opts;

  let started: Promise<B | null> | null = null;
  const start = (): Promise<B | null> => (started ??= decodeClip());

  const grace = setTimeout(() => {
    onGraceExpired?.();

    void start().catch((): null => null);
  }, graceMs);

  let fromStream: string | null;
  try {
    fromStream = await streamRun;
  } finally {
    clearTimeout(grace);
  }

  if (fromStream) return {fromStream, batch: null, decoded: started !== null};

  let batch: B | null = null;
  try {
    batch = await start();
  } catch {
    batch = null;
  }
  return {fromStream, batch, decoded: true};
}
