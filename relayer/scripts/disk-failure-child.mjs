#!/usr/bin/env node
// ⚠️  ПРОВЕРОЧНЫЙ СКРИПТ, ЗАПУСКАЕТСЯ РУКАМИ (родителем — verify-disk-failure-
// real-crash.mjs). НЕ ЧАСТЬ `npm test`, НЕ ЗАПУСКАЕТСЯ CI, не запускается
// сам по себе.
//
// Дочерний процесс для verify-disk-failure-real-crash.mjs.
// Намеренно НЕ регистрирует process.on('uncaughtException') нигде — это
// точная копия того, что происходит (точнее, не происходит) в
// index.js/app.js/notifier.js релеера сегодня. Если markFetched() бросит
// без try/catch, этот процесс должен упасть НАСТОЯЩИМ образом (ненулевой
// код выхода), а не просто залогировать что-то и продолжить.
//
// Печатает "LISTENING <port>" в stdout, как только сервер поднят — родитель
// парсит эту строку, чтобы узнать порт для настоящих HTTP-запросов.

const STORAGE_DIR = process.env.STORAGE_DIR;
if (!STORAGE_DIR) throw new Error('STORAGE_DIR must be set by the parent process');

process.env.SERVER_SECRET       ||= 'child-disk-failure-secret';
process.env.RELAYER_PRIVATE_KEY ||= '0x' + '33'.repeat(32);
process.env.TRUSTED_FORWARDER   ||= '0x1111111111111111111111111111111111111111';
process.env.DIAMOND_ADDRESS     ||= '0x2222222222222222222222222222222222222222';
process.env.PUSH_SECRET         ||= 'child-disk-failure-push-secret';
process.env.RPC_URL             ||= 'http://127.0.0.1:9';
process.env.ALLOWED_ORIGINS     ||= 'http://localhost:3000';
process.env.TRUST_PROXY         ||= 'true';

const { app } = await import('../app.js');

const server = app.listen(0);
server.once('listening', () => {
  console.log(`LISTENING ${server.address().port}`);
});
