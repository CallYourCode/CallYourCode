import {describe, expect, test} from 'vitest';
import {constantTimeEqual} from '@shared/e2e';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('constantTimeEqual auth-tag comparison', () => {
  test('equal-length buffers with identical contents match', () => {
    expect(constantTimeEqual(bytes(1, 2, 3, 4), bytes(1, 2, 3, 4))).toBe(true);
  });

  test('empty buffers are equal', () => {
    expect(constantTimeEqual(bytes(), bytes())).toBe(true);
  });

  test('a single differing byte fails, wherever it sits', () => {
    expect(constantTimeEqual(bytes(9, 2, 3, 4), bytes(1, 2, 3, 4))).toBe(false);
    expect(constantTimeEqual(bytes(1, 2, 9, 4), bytes(1, 2, 3, 4))).toBe(false);
  });

  test('a difference confined to the final byte still fails', () => {
    expect(constantTimeEqual(bytes(1, 2, 3, 4), bytes(1, 2, 3, 5))).toBe(false);
  });

  test('length mismatch fails without treating a prefix as equal', () => {
    expect(constantTimeEqual(bytes(1, 2, 3), bytes(1, 2, 3, 4))).toBe(false);
    expect(constantTimeEqual(bytes(1, 2, 3, 4), bytes(1, 2, 3))).toBe(false);
    expect(constantTimeEqual(bytes(), bytes(0))).toBe(false);
  });
});
