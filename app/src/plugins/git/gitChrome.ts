// Git chrome layout as Tailwind literals.
const MONO = "[font-family:'JetBrains_Mono',monospace]";

// change-viewer (.cyc-cx-*)
export const CX_WHAT = `${MONO} text-[0.8125rem]`;
export const CX_FPATH =
  `flex-[1_1_auto] min-w-0 overflow-hidden ${MONO} text-[0.75rem] text-ellipsis whitespace-nowrap ` +
  '[direction:rtl] text-left';
export const CX_TALLY = 'flex flex-[0_0_auto] gap-[0.3125rem] text-[0.75rem] tabular-nums';
export const CX_CAP =
  'my-0 mx-[0.75rem] py-[0.375rem] px-[0.625rem] rounded-[0.375rem] text-[0.75rem] leading-[1.35]';
export const CX_SKIP = 'flex-[0_0_auto] w-[0.75rem] text-center opacity-60';
export const CX_STEP = 'flex flex-[0_0_auto] items-center gap-[0.125rem]';
export const CX_STEPBTN =
  'flex items-center justify-center w-[1.5rem] h-[1.5rem] p-0 border-none rounded-[0.25rem] ' +
  'bg-transparent text-[1rem] leading-none cursor-pointer';
export const CX_STEPAT = 'min-w-[2.5rem] text-[0.6875rem] tabular-nums text-center';
export const CX_DOC = 'flex flex-col min-w-full w-max';
export const CX_FILE =
  'flex flex-[0_0_auto] flex-col self-stretch min-w-full border-t border-solid border-t-transparent';
export const CX_FHEAD =
  'sticky top-0 left-0 z-[2] flex flex-[0_0_auto] items-center gap-[0.375rem] min-h-[28px] ' +
  'max-w-[100vw] py-[0.25rem] px-[0.625rem] border-b border-solid border-b-transparent';
export const CX_NODIFF =
  'max-w-[min(100vw,42rem)] py-[0.625rem] px-[0.75rem] text-[0.8125rem] leading-[1.4]';

// the sum card's column-gap override (was .cyc-cx-sum over .cyc-gt-branch)
export const CX_SUM_GAP = 'gap-x-[0.625rem] gap-y-[0.375rem]';

// git-viewer (.cyc-gt-*)
export const GT_ROOT = 'will-change-transform';
export const GT_REFRESH = 'flex-[0_0_auto] ms-auto text-[1.25rem]';
export const GT_LIST_SCROLL = 'overflow-x-hidden';
export const GT_LIST = 'pb-[0.5rem]';
export const GT_BRANCH =
  'flex flex-wrap items-center my-[0.5rem] mx-[0.75rem] py-[0.5rem] px-[0.625rem] rounded-[0.375rem]';
export const GT_BRANCH_GAP = 'gap-x-[0.5rem] gap-y-[0.375rem]';
export const GT_BRANCH_NAME = 'font-semibold';
export const GT_TRACK = 'text-[0.8125rem]';
export const GT_AB = 'py-0 px-[0.375rem] rounded-[0.625rem] text-[0.75rem] tabular-nums';
export const GT_BRANCH_PICK =
  'w-[calc(100%-1.5rem)] border-none text-start [font:inherit] text-inherit cursor-pointer';
export const GT_CARET = 'ms-auto text-[0.75rem]';
export const GT_VIEWTAG =
  'py-0 px-[0.375rem] rounded-[0.625rem] text-[0.625rem] font-semibold tracking-[0.03em] uppercase';
export const GT_COMPARES = 'flex gap-[0.5rem] mt-[-0.125rem] mx-[0.75rem] mb-[0.25rem]';
export const GT_CMP =
  'flex-[1_1_0] min-w-0 py-[0.3125rem] px-[0.5rem] rounded-[0.375rem] bg-transparent ' +
  'text-[0.75rem] font-medium whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer';
export const GT_BRANCHES =
  'mt-[-0.125rem] mx-[0.75rem] mb-[0.375rem] rounded-[0.375rem] overflow-hidden';
export const GT_BROW =
  'flex items-center gap-[0.5rem] w-full py-[0.4375rem] px-[0.625rem] border-none ' +
  'bg-transparent [font:inherit] text-start cursor-pointer';
export const GT_BROW_NAME = 'font-medium whitespace-nowrap overflow-hidden text-ellipsis';
export const GT_BROW_UP = 'ms-auto text-[0.75rem] whitespace-nowrap';
export const GT_BCUR =
  'py-0 px-[0.375rem] rounded-[0.625rem] text-[0.5625rem] font-semibold tracking-[0.03em] uppercase';
export const GT_SEC =
  'flex items-center justify-between gap-[0.5rem] pt-[0.625rem] px-[0.75rem] pb-[0.25rem] ' +
  'text-[0.6875rem] font-semibold tracking-[0.04em] uppercase';
export const GT_SEC_RIGHT = 'ms-auto tabular-nums';
export const GT_REVIEW =
  'flex-[0_0_auto] py-[0.0625rem] px-[0.5rem] rounded-[0.625rem] bg-transparent text-[0.625rem] ' +
  'font-semibold tracking-[0.03em] uppercase cursor-pointer';
export const GT_REVIEW_B =
  'flex-[0_0_auto] py-[0.1875rem] px-[0.625rem] rounded-[0.625rem] bg-transparent text-[0.75rem] ' +
  'font-semibold cursor-pointer';
export const GT_NONE = 'pt-[0.25rem] px-[0.75rem] pb-[0.5rem] text-[0.8125rem]';
export const GT_ROW =
  'flex items-center gap-[0.375rem] min-h-[26px] pt-0 pr-[0.5rem] pb-0 pl-[0.75rem] ' +
  'cursor-pointer select-none';
export const GT_LABEL = 'flex flex-[1_1_auto] items-baseline gap-[0.375rem] min-w-0';
export const GT_NAME = 'flex-[0_1_auto] overflow-hidden text-ellipsis whitespace-nowrap';
export const GT_DIR =
  'flex-[1_1_auto] min-w-0 overflow-hidden text-[0.75rem] text-ellipsis whitespace-nowrap ' +
  '[direction:rtl] text-left';
export const GT_FROM = 'flex-[0_0_auto] text-[0.75rem]';
export const GT_ACT =
  'flex flex-[0_0_auto] items-center justify-center w-[1.5rem] h-[1.5rem] rounded-[0.25rem] ' +
  'text-[1rem] leading-none';
export const GT_REFS =
  'flex-[0_0_auto] max-w-[40%] overflow-hidden py-0 px-[0.3125rem] rounded-[0.625rem] ' +
  'text-[0.6875rem] text-ellipsis whitespace-nowrap';
export const GT_WHEN = 'flex-[0_0_auto] text-[0.75rem] tabular-nums';
export const GT_SHA = `flex-[0_0_auto] ${MONO} text-[0.75rem]`;
