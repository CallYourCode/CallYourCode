export type FsFail = {ok: false; error: string};

export function failed<T extends {ok: boolean}>(r: T | FsFail): r is FsFail {
  return r.ok === false;
}
