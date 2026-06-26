/**
 * error-log.js ユニットテスト（Node 18+）
 * 実行: node test/error-log.test.js
 */

import {
  buildErrorFingerprintInput,
  ERROR_DEDUP_TTL_SEC,
  ERROR_LOG_MAX_ENTRIES,
} from '../src/error-log.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

assert(
  buildErrorFingerprintInput('ss1', 'syncBlockCalendars', 'test message')
    === 'ss1|syncBlockCalendars|test message',
  'fingerprint input'
);

assert(
  buildErrorFingerprintInput('ss1', 'fn', 'x'.repeat(300)).endsWith('x'.repeat(200)),
  'message truncated to 200 chars'
);

assert(ERROR_LOG_MAX_ENTRIES === 200, 'max entries');
assert(ERROR_DEDUP_TTL_SEC === 900, 'dedup ttl');

console.log('error-log.test.js: all passed');
