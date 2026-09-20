import {clampNumber} from '@/shared/numbers';

export type PopupAnchor = {
  x: number;
  y: number;
};

const EDGE_INSET = 7;

export function placeMenu(anchor: PopupAnchor, panel: HTMLElement, edgeInset: number = EDGE_INSET) {
  const panelW = panel.offsetWidth;
  const panelH = panel.offsetHeight;
  const frameW = window.innerWidth;
  const frameH = window.innerHeight;

  const leftFloor = edgeInset;
  const leftCeil = frameW - panelW - edgeInset;
  const topFloor = edgeInset;
  const topCeil = frameH - panelH - edgeInset;

  const roomAfter = anchor.x + panelW + edgeInset <= frameW;
  const x = roomAfter ? anchor.x : anchor.x - panelW;
  const anchorEdge = roomAfter ? 'left' : 'right';

  const y = anchor.y;

  panel.style.left = clampNumber(x, leftFloor, Math.max(leftFloor, leftCeil)) + 'px';
  panel.style.top = clampNumber(y, topFloor, Math.max(topFloor, topCeil)) + 'px';
  panel.style.transformOrigin = `${anchorEdge} top`;
}
