/* THE PUSH LIBRARY'S SURFACE, DECLARED RATHER THAN INFERRED AS `any`.
 *
 * `web-push` is plain JavaScript and ships no types; there is no @types package
 * installed here and nothing in this repo may run an install. Left alone, the
 * import is an implicit `any` under `strict` (TS7016), which means the three
 * calls below were completely unchecked -- including `sendNotification`'s
 * options bag, where a mistyped `TTL` or `urgency` is a push Apple refuses and
 * a phone that stays quiet.
 *
 * Only what push.ts actually calls is declared. Anything else the library
 * exports is deliberately absent: a declaration file that guesses at a surface
 * nobody uses is a second thing to keep true.
 */
declare module "web-push" {
  export type PushSubscriptionLike = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  export type SendOptions = {
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    topic?: string;
    /** node-side socket deadline; see push.ts on why it is not enough on Bun */
    timeout?: number;
    headers?: Record<string, string>;
  };
  export type SendResult = { statusCode: number; body: string; headers: Record<string, string> };

  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export function sendNotification(
    subscription: PushSubscriptionLike,
    payload?: string | Buffer | null,
    options?: SendOptions,
  ): Promise<SendResult>;

  const _default: {
    setVapidDetails: typeof setVapidDetails;
    generateVAPIDKeys: typeof generateVAPIDKeys;
    sendNotification: typeof sendNotification;
  };
  export default _default;
}
