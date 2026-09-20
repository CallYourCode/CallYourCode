import {engineCapFetch, httpBaseOf} from '../contract';

type EngineFetchInit = RequestInit & {
  timeoutMs?: number;
};

export function engineFetch(
  engineKey: string,
  path: string,
  init: EngineFetchInit = {}
): Promise<Response> {
  const {timeoutMs, ...rest} = init;
  if (timeoutMs !== undefined && rest.signal === undefined) {
    rest.signal = AbortSignal.timeout(timeoutMs);
  }
  return engineCapFetch(httpBaseOf(engineKey) + path, rest);
}
