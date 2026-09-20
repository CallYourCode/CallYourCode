import {describe, expect, test} from 'vitest';
import {
  arbitrate,
  isEchoOfPlayback,
  normText,
  BACKCHANNEL,
  STOCK_SILENCE,
  ECHO_DENSITY_DB,
  type Verdict
} from '../audio/arbiter';
const QUIET = -65;
const LOUD = -35;
function verdict(o: Partial<Parameters<typeof arbitrate>[0]>): Verdict {
  return arbitrate({
    text: '',
    wasPlaying: false,
    fromPress: false,
    medianDb: LOUD,
    playingText: '',
    ...o
  });
}
describe('no-words: the decoders read nothing', () => {
  test('an empty transcript is no-words, never stock-silence', () => {
    expect(verdict({text: ''})).toBe('no-words');
  });
  test('punctuation-only normalizes to nothing and is no-words', () => {
    expect(verdict({text: ' ... !! '})).toBe('no-words');
  });
  test('NOT gated on the press: a pressed capture with no words is still no-words', () => {
    expect(verdict({text: '', fromPress: true})).toBe('no-words');
    expect(verdict({text: '', fromPress: true, wasPlaying: true, medianDb: QUIET})).toBe(
      'no-words'
    );
  });
});
describe('THE PRESS RULE: a press is judged on one question, were there words', () => {
  test('a quiet stock phrase said into a held button is kept', () => {
    expect(verdict({text: 'Thanks.', fromPress: true, medianDb: QUIET})).toBe('');
  });
  test('a backchannel said into a held button while a reply plays is kept', () => {
    expect(verdict({text: 'okay', fromPress: true, wasPlaying: true})).toBe('');
    expect(verdict({text: 'right', fromPress: true, wasPlaying: true})).toBe('');
    expect(verdict({text: 'sure', fromPress: true, wasPlaying: true})).toBe('');
  });
  test('a quiet pressed capture during playback is NOT ruled echo', () => {
    expect(
      verdict({
        text: 'Do not do it yet, this is also a task',
        fromPress: true,
        wasPlaying: true,
        medianDb: -74
      })
    ).toBe('');
  });
  test('pressed words that all appear in the reply are still kept', () => {
    expect(
      verdict({
        text: 'delete the file',
        fromPress: true,
        wasPlaying: true,
        playingText: 'I will delete the file now'
      })
    ).toBe('');
  });
});
describe('stock-silence: whisper hallucinations over near-silence, detector only', () => {
  test('every stock phrase, quiet, on a detector take, is dropped', () => {
    for (const phrase of STOCK_SILENCE) {
      if (!phrase) continue;
      expect(verdict({text: phrase, medianDb: QUIET}), phrase).toBe('stock-silence');
    }
  });
  test('the drop survives capitalization and punctuation ("Thank you.")', () => {
    expect(verdict({text: 'Thank you.', medianDb: QUIET})).toBe('stock-silence');
    expect(verdict({text: 'Thanks for watching!', medianDb: QUIET})).toBe('stock-silence');
  });
  test('ONLY over quiet audio: a loud "Thanks." said hands-free is kept', () => {
    expect(verdict({text: 'Thanks.', medianDb: LOUD})).toBe('');
  });
  test('exactly at the echo floor is not "below" it: kept', () => {
    expect(verdict({text: 'Thanks.', medianDb: ECHO_DENSITY_DB})).toBe('');
  });
});
describe('nothing was playing: terse answers commit', () => {
  test('a backchannel with no playback is a real answer', () => {
    expect(verdict({text: 'yeah', wasPlaying: false})).toBe('');
    expect(verdict({text: 'okay', wasPlaying: false})).toBe('');
  });
  test('quiet real words with no playback are kept (echo-density is a playback rule)', () => {
    expect(verdict({text: 'hello hello hello hello', medianDb: -75.2})).toBe('');
  });
});
describe('backchannel-over-playback: listening noises while a reply plays', () => {
  test('every backchannel over playback resumes instead of interrupting', () => {
    for (const word of BACKCHANNEL) {
      expect(verdict({text: word, wasPlaying: true}), word).toBe('backchannel-over-playback');
    }
  });
  test('checked before echo-density: a quiet "okay" over playback is named backchannel', () => {
    expect(verdict({text: 'okay', wasPlaying: true, medianDb: QUIET})).toBe(
      'backchannel-over-playback'
    );
  });
  test('multi-word backchannels normalize and match ("Uh huh.")', () => {
    expect(verdict({text: 'Uh huh.', wasPlaying: true})).toBe('backchannel-over-playback');
    expect(verdict({text: 'Oh, okay!', wasPlaying: true})).toBe('backchannel-over-playback');
  });
});
describe('echo-density: mostly-silent capture while a reply was playing', () => {
  test('quiet real words over playback are ruled leaked echo on a detector take', () => {
    expect(verdict({text: 'some real sentence', wasPlaying: true, medianDb: QUIET})).toBe(
      'echo-density'
    );
  });
  test('loud words over playback pass this rule', () => {
    expect(verdict({text: 'stop that is wrong', wasPlaying: true, medianDb: LOUD})).toBe('');
  });
});
describe('bargeStopped: the cut-in that won the floor is never dropped as echo', () => {
  test('quiet cut-in that stopped playback and got a real final is kept', () => {
    expect(
      verdict({
        text: 'wait stop doing that first',
        wasPlaying: true,
        medianDb: QUIET,
        bargeStopped: true
      })
    ).toBe('');
  });
  test('low-energy blip during playback with no barge still drops as echo', () => {
    expect(
      verdict({text: 'some real sentence', wasPlaying: true, medianDb: QUIET, bargeStopped: false})
    ).toBe('echo-density');

    expect(verdict({text: 'some real sentence', wasPlaying: true, medianDb: QUIET})).toBe(
      'echo-density'
    );
  });
  test('no-playback utterances are unchanged either way', () => {
    expect(verdict({text: 'hello hello hello hello', medianDb: -75.2, bargeStopped: true})).toBe(
      ''
    );
    expect(verdict({text: 'hello hello hello hello', medianDb: -75.2, bargeStopped: false})).toBe(
      ''
    );
  });
  test('only the energy veto lifts: the other playback rules still drop', () => {
    expect(
      verdict({
        text: 'delete the file',
        wasPlaying: true,
        bargeStopped: true,
        playingText: 'I will delete the file now'
      })
    ).toBe('echo-of-playback');

    expect(verdict({text: 'okay', wasPlaying: true, medianDb: QUIET, bargeStopped: true})).toBe(
      'backchannel-over-playback'
    );

    expect(
      verdict({text: 'Thank you.', wasPlaying: true, medianDb: QUIET, bargeStopped: true})
    ).toBe('stock-silence');
  });
});
describe('echo-of-playback: our own sentence bouncing back', () => {
  test('up to four words all present in the playing text are echo', () => {
    expect(
      verdict({
        text: 'delete the file',
        wasPlaying: true,
        playingText: 'I will delete the file now'
      })
    ).toBe('echo-of-playback');
    expect(
      verdict({
        text: 'I will delete the',
        wasPlaying: true,
        playingText: 'I will delete the file now'
      })
    ).toBe('echo-of-playback');
  });
  test('five words are a real sentence even if every one was played', () => {
    expect(
      verdict({
        text: 'I will delete the file',
        wasPlaying: true,
        playingText: 'I will delete the file now'
      })
    ).toBe('');
  });
  test("one word of the user's own passes", () => {
    expect(
      verdict({
        text: 'delete the wrong file',
        wasPlaying: true,
        playingText: 'I will delete the file now'
      })
    ).toBe('');
  });
  test('an empty playing text can never claim an echo', () => {
    expect(isEchoOfPlayback('delete the file', '')).toBe(false);
  });
  test('matching is on normalized words: case and punctuation do not hide an echo', () => {
    expect(isEchoOfPlayback('Delete, the FILE!', 'i will delete the file now')).toBe(true);
  });
});
describe('normText: the normalization every rule reads through', () => {
  test('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normText('Thank you.')).toBe('thank you');
    expect(normText('  Uh-huh...  ')).toBe('uhhuh');
    expect(normText('a  b   c')).toBe('a b c');
  });
  test('keeps letters and digits in any script', () => {
    expect(normText('café 42')).toBe('café 42');
  });
  test('null-ish input is the empty string', () => {
    expect(normText(undefined as unknown as string)).toBe('');
  });
});
