import { register } from 'node:module';

// Регистрирует крючок резолвера в том же процессе (см. forbidXmtpHooks.mjs).
register('./forbidXmtpHooks.mjs', import.meta.url);
