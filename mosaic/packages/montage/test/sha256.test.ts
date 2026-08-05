import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256Hex } from '../src/sha256.ts';

describe('sha256Hex', () => {
  it('matches the published vectors', () => {
    assert.equal(
      sha256Hex(''),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(
      sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.equal(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto across every padding boundary', () => {
    // 55/56 and 63/64 are where the length field spills into an extra block.
    for (let len = 0; len <= 200; len++) {
      const input = 'x'.repeat(len);
      assert.equal(
        sha256Hex(input),
        createHash('sha256').update(input).digest('hex'),
        `length ${len}`,
      );
    }
  });

  it('agrees with node:crypto on multi-byte characters', () => {
    for (const input of ['Kreta 2026 ☀️', 'ë-ü-ø', '👨‍👩‍👧 vakantie', 'naïve café']) {
      assert.equal(
        sha256Hex(input),
        createHash('sha256').update(input, 'utf8').digest('hex'),
        input,
      );
    }
  });
});
