import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import {validateWatchPurpose} from './reply-watchdog.mjs';
import {registerWechatReplyTool} from '../wechat-live-stage/wechat-mcp-reply-live.mjs';

const now = 1_700_000_000_000;
const expiresAt = now + 86_400_000;

test('进度回复缺失截止时间时返回明确的发送前错误', async () => {
  let call;
  let networkCalls = 0;
  const owner = 'fixture-owner';
  registerWechatReplyTool({registerTool(_name, _metadata, handler) {call = handler;}}, {
    z, owner, bridge: {owner, state: {phase: 'armed'}},
    send: async args => {
      validateWatchPurpose(args.replyPurpose, args.nextUpdateAt, now, expiresAt);
      networkCalls++;
      return {state: 'sent'};
    }
  });
  const result = await call({eventId: 'fixture-event', text: '正在处理',
    idempotencyKey: 'original-key', replyPurpose: 'progress'});
  const value = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true);
  assert.equal(value.state, 'not_sent');
  assert.equal(value.reason, 'invalid_progress_deadline');
  assert.equal(value.currentInvocationStartedSend, false);
  assert.equal(value.currentInvocationAttemptRecorded, false);
  assert.equal(networkCalls, 0);
  assert.ok(!Object.hasOwn(value, 'retrySafe'));
  assert.match(value.instruction, /earlier attempts independently/);
});

test('未来毫秒截止时间通过，过期与最终回复携带截止时间保留各自错误', () => {
  assert.doesNotThrow(() => validateWatchPurpose('progress', now + 120_000, now, expiresAt));
  assert.doesNotThrow(() => validateWatchPurpose('final', undefined, now, expiresAt));
  for (const deadline of [undefined, now, now - 1, expiresAt, '1700000120000']) {
    assert.throws(() => validateWatchPurpose('progress', deadline, now, expiresAt),
      error => error.code === 'invalid_progress_deadline');
  }
  assert.throws(() => validateWatchPurpose('final', now + 120_000, now, expiresAt),
    error => error.code === 'unexpected_final_deadline');
});
