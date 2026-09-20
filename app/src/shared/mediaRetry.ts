// The ONE image-load retry policy, shared by the picture resolver
// (features/media/resolveImage.ts) and the avatar painter
// (components/avatarView.ts). It lives in shared/ because a component must not
// import from features/, so the avatar view can no longer keep its own inlined
// copy that silently drifts from the resolver's.
//
// Shape: once a load starts, keep retrying with a fixed backoff between
// attempts until this window elapses, then give up. A 404 gives up at once
// (see each caller); the window/backoff here govern the transient case.
export const MEDIA_RETRY_WINDOW_MS = 12_000;
export const MEDIA_RETRY_BACKOFF_MS = 500;
