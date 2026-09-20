import type {CycAgentStatus} from '../../types';
import {effectiveActivity} from '../settings';

export function activityMark(s: {status?: CycAgentStatus}): CycAgentStatus | null {
  if (!effectiveActivity()) return null;
  return s.status === 'done' || s.status === 'blocked' || s.status === 'unknown' ? s.status : null;
}

export function wantsLook(s: {status?: CycAgentStatus}): boolean {
  const mark = activityMark(s);
  return mark === 'done' || mark === 'blocked';
}
