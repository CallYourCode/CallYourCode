import {describe, expect, test} from 'vitest';
import {formatBytes} from '../features/media/mediaBox';

describe('formatBytes CYC unit policy', () => {
  test('zero and falsy sizes read as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(undefined as unknown as number)).toBe('0 B');
  });

  test('bytes band stays whole up to the KB threshold', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  test('KB band crosses at 1024 and rounds to whole KB', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1500)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(1048575)).toBe('1024 KB');
  });

  test('MB band crosses at 1048576 with one decimal and trailing-zero strip', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(1572864)).toBe('1.5 MB');
    expect(formatBytes(1073741823)).toBe('1024 MB');
  });

  test('GB band crosses at 1073741824 with two decimals, ungrouped, and caps at GB', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
    expect(formatBytes(2000000000)).toBe('1.86 GB');
    expect(formatBytes(5497558138880)).toBe('5120 GB');
  });
});
