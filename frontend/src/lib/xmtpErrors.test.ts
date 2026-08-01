import { describe, it, expect } from 'vitest';
import { classifyXmtpError, trimXmtpError, XMTP_TAB_BUSY } from './xmtpErrors';

describe('classifyXmtpError', () => {
  it('занятое другой вкладкой хранилище — отдельный класс', () => {
    // Не «таймаут»: причина известна точно, и человеку надо сказать не
    // «проверь интернет», а «закрой вторую вкладку».
    expect(classifyXmtpError(XMTP_TAB_BUSY)).toBe('tab_busy');
  });

  it('таймаут', () => {
    expect(classifyXmtpError('XMTP_TIMEOUT')).toBe('timeout');
  });

  it('незакрытый запрос в кошельке', () => {
    expect(classifyXmtpError("Request of type 'personal_sign' already pending for origin")).toBe('wallet_pending');
    expect(classifyXmtpError('Already pending for origin http://x')).toBe('wallet_pending');
  });

  it('лимит установок', () => {
    expect(classifyXmtpError('this inbox has registered 10/10 installations')).toBe('too_many_installations');
    expect(classifyXmtpError('already registered 10 installations')).toBe('too_many_installations');
  });

  it('несовпадение сети', () => {
    expect(classifyXmtpError('Wrong chain id. Initially added with 8453 but now signing from 0')).toBe('wrong_chain');
  });

  it('нет защищённого контекста', () => {
    expect(classifyXmtpError('XMTP_NO_OPFS')).toBe('insecure_context');
    expect(classifyXmtpError('Messaging requires a secure context. Open the app via https')).toBe('insecure_context');
  });

  it('незнакомый отказ остаётся неразобранным — показываем как есть', () => {
    expect(classifyXmtpError('openmls: SecretReuseError')).toBeNull();
  });
});

describe('trimXmtpError', () => {
  it('срезает многострочный дамп WASM', () => {
    expect(trimXmtpError('storage error\n=====\nstack frame 1\nstack frame 2')).toBe('storage error');
  });

  it('однострочное сообщение не портит', () => {
    expect(trimXmtpError('  boom  ')).toBe('boom');
  });
});
