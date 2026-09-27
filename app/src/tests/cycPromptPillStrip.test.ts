import {describe, expect, test} from 'vitest';
import {
  stripAppendedPromptBits,
  DEFAULT_REPLY_TEXT,
  type ReplyStringOverrides
} from '../config/replyStrings';

// FIX 7: grey "prompt" session pills showed the reply-dial wordings the app/
// engine append to the owner's message. stripAppendedPromptBits removes those
// known appended wordings (several may be concatenated) and a leading "TEXT: "
// for DISPLAY only, never touching arbitrary text the owner typed. Samples below
// are real prompt-record tails from the stored chat logs.

describe('stripAppendedPromptBits: real log samples', () => {
  test('a reply wording concatenated with a complexity wording, both stripped', () => {
    const owner = '> SCHEDULED (nudge): pick the lane. datasets with scrapers already are prefered.';
    const appended =
      owner +
      ' (Reply with the chat tool, complete and structured. Then ALSO call the speak' +
      ' tool with a short spoken summary of that reply: two or three sentences, the' +
      ' answer and nothing else.) (Keep this short and simple: the answer, the one' +
      ' reason it is the answer, and stop there.)';
    // The trailing dial wordings go; the owner's own "(nudge)" mid-line stays.
    expect(stripAppendedPromptBits(appended)).toBe(owner);
  });

  test('the current default reply wording is stripped', () => {
    const owner = 'what does attachFrontier do here?';
    expect(stripAppendedPromptBits(owner + DEFAULT_REPLY_TEXT[2])).toBe(owner);
  });

  test('a legacy reply wording that no longer ships is still stripped', () => {
    const owner = 'summarise the plan';
    const legacy =
      ' (Reply with the chat tool, the way you would message someone: complete but not' +
      ' exhaustive, structured where structure helps, a few short paragraphs at most. Do' +
      ' not use the speak tool.)';
    expect(stripAppendedPromptBits(owner + legacy)).toBe(owner);
  });

  test('the multiline (indented) wording shipped with newlines is recognised', () => {
    const owner = 'give me the tradeoffs';
    const multiline =
      ' (Reply with the chat tool AND the speak tool. Send a short spoken summary\n' +
      '    of the reply via speak tool and a full text message via chat tool.)';
    expect(stripAppendedPromptBits(owner + multiline)).toBe(owner);
  });

  test('a leading "TEXT: " prefix is stripped', () => {
    expect(stripAppendedPromptBits('TEXT: hello there')).toBe('hello there');
  });

  test('the "> " quote marker and mid-text parens the owner typed are preserved', () => {
    const owner = '> is it benzene_url (the citation key) or the live url?';
    expect(stripAppendedPromptBits(owner + DEFAULT_REPLY_TEXT[4])).toBe(owner);
  });

  test('arbitrary owner-typed trailing parens are NOT stripped', () => {
    const owner = 'ship the fix (not the individual bugs)';
    expect(stripAppendedPromptBits(owner)).toBe(owner);
  });

  test('a text with no appended wording is returned unchanged', () => {
    expect(stripAppendedPromptBits('> /compact')).toBe('> /compact');
    expect(stripAppendedPromptBits('plain question with no dial')).toBe(
      'plain question with no dial'
    );
  });
});

describe('stripAppendedPromptBits: owner overrides and bits', () => {
  test("the owner's overridden reply wording is stripped", () => {
    const ov: ReplyStringOverrides = {
      reply: {2: {text: ' (Custom: keep it terse and to the point.)'}}
    };
    const owner = 'status?';
    expect(stripAppendedPromptBits(owner + ' (Custom: keep it terse and to the point.)', ov)).toBe(
      owner
    );
  });

  test('a shipped prompt bit appended at the end is stripped', () => {
    const owner = 'is this right?';
    // "short answer" is a default prompt bit; appended plainly at the end.
    expect(stripAppendedPromptBits(owner + ' short answer')).toBe(owner);
  });

  test('several concatenated wordings are all peeled', () => {
    const owner = 'plan the migration';
    const s =
      owner +
      DEFAULT_REPLY_TEXT[4] +
      ' (Keep this short and simple: the answer, the one reason it is the answer, and' +
      ' stop there.)';
    expect(stripAppendedPromptBits(s)).toBe(owner);
  });
});
