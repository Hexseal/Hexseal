export { appChainId as CHAIN_ID } from '@/config/chain';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// Agreement lifecycle windows (must match Agreement.sol)
export const ACTIVATION_WINDOW = BigInt(2 * 86400);   // 2 days
export const AUTO_APPROVE_WINDOW = BigInt(2 * 86400); // 2 days
export const DISPUTE_WINDOW = BigInt(4 * 86400);      // 4 days — arbiter must resolve
export const DEADLINE_GRACE = BigInt(1 * 86400);      // 1 day grace after deadline

// Те же окна, но в сутках — для копирайта. Копирайт про сроки обязан брать
// число ОТСЮДА и подставлять через ICU-plural, а не писать его словами в
// пятнадцати файлах переводов: ровно так фронт уже разошёлся с контрактом
// (`docs/OPEN-ITEMS.md` п. 12) — обещал исполнителю 3 дня на активацию, пока
// кнопка возврата у клиента считалась от настоящих двух, и обещал арбитру
// 7-дневное окно спора через год после того, как оно стало четырёхдневным.
//
// Дробное значение допустимо намеренно: окно в 36 часов даст 1.5, и ICU-plural
// отрендерит «1.5 days» вместо вранья про «1 day».
export const ACTIVATION_WINDOW_DAYS = Number(ACTIVATION_WINDOW) / 86400;
export const AUTO_APPROVE_WINDOW_DAYS = Number(AUTO_APPROVE_WINDOW) / 86400;
export const DISPUTE_WINDOW_DAYS = Number(DISPUTE_WINDOW) / 86400;

// Must match ArbiterRegistryFacet.sol's FINALIZE_DELAY — the window after
// submitVerdict() during which finalizeVerdict() is guaranteed to revert.
export const FINALIZE_DELAY = BigInt(24 * 3600); // 24 hours

// Input validation limits for deal/job/service forms
export const MAX_DEAL_AMOUNT = 1_000_000; // USDC (6 decimals → $1M)
export const MAX_DEADLINE_DAYS = 365;
export const MAX_TITLE_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;
