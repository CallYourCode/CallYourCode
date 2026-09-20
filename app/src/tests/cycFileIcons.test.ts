import {describe, expect, test} from 'vitest';
import {fileIcon, prismLanguage, SETI} from '../features/media/icons';

describe('file icons', () => {
  test('maps supported source, media, and repository files case-insensitively', () => {
    expect(fileIcon('APP.TSX', true)).toEqual(fileIcon('app.tsx', true));
    expect(fileIcon('photo.webp', false)).not.toEqual(fileIcon('archive.zip', false));
    expect(fileIcon('Dockerfile', true)).not.toEqual(fileIcon('unknown.data', true));
  });

  test('maps dotfiles and unknown files safely', () => {
    expect(fileIcon('.gitignore', true)).not.toEqual(fileIcon('unknown', true));
    expect(fileIcon('unknown', false)).toEqual({char: SETI.fallback[0], color: SETI.fallback[2]});
  });
});

describe('file languages', () => {
  test('keeps supported repository languages and plain unknown fallback', () => {
    expect(prismLanguage('component.tsx')).toBe('tsx');
    expect(prismLanguage('config.json5')).toBe('json');
    expect(prismLanguage('patch.diff')).toBe('diff');
    expect(prismLanguage('unknown.xyz')).toBe('');
  });
});
