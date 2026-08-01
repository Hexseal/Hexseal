import { describe, it, expect } from 'vitest';
import { classifyAttachmentFailure, ATTACHMENT_TTL_MS } from './attachmentFailure';

const NOW = 1_800_000_000_000;

describe('classifyAttachmentFailure', () => {
  it('404 от файлового сервера — файла нет, срок вышел', () => {
    expect(classifyAttachmentFailure(new Error('Failed to fetch file: 404'), { now: NOW }))
      .toBe('expired');
  });

  it('410 — то же самое', () => {
    expect(classifyAttachmentFailure(new Error('Download failed: 410'), { now: NOW }))
      .toBe('expired');
  });

  it('сообщение старше срока хранения — файла нет, чем бы ни кончился запрос', () => {
    // До сервера можно вообще не доехать (офлайн, релеер лежит), но правда о
    // файле от этого не меняется: через семь дней его уже вычистили.
    expect(classifyAttachmentFailure(new Error('NetworkError'), {
      now: NOW, sentAt: NOW - ATTACHMENT_TTL_MS - 1,
    })).toBe('expired');
  });

  it('свежее сообщение и настоящий сбой — это ошибка расшифровки', () => {
    expect(classifyAttachmentFailure(new Error('OperationError'), {
      now: NOW, sentAt: NOW - 60_000,
    })).toBe('decrypt_failed');
  });

  it('403 не выдаём за истёкший срок', () => {
    // «Нельзя» и «удалено» — разные вещи, и списывать запрет на срок хранения
    // значит соврать ровно так же, как раньше врал общий текст на оба случая.
    expect(classifyAttachmentFailure(new Error('Failed to fetch file: 403'), {
      now: NOW, sentAt: NOW - 60_000,
    })).toBe('decrypt_failed');
  });

  it('время сообщения неизвестно — не гадаем, показываем ошибку', () => {
    expect(classifyAttachmentFailure(new Error('boom'), { now: NOW })).toBe('decrypt_failed');
    expect(classifyAttachmentFailure(new Error('boom'), { now: NOW, sentAt: 0 })).toBe('decrypt_failed');
  });

  it('не-Error тоже разбирается', () => {
    expect(classifyAttachmentFailure('Failed to fetch file: 404', { now: NOW })).toBe('expired');
    expect(classifyAttachmentFailure(undefined, { now: NOW })).toBe('decrypt_failed');
  });

  it('срок хранения совпадает с релеером — семь дней', () => {
    // relayer/app.js: FILE_TTL_MS. Расхождение уже случалось: интерфейс
    // обещал 18 дней при реальных семи.
    expect(ATTACHMENT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
