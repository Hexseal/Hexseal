import { describe, expect, it } from 'vitest';
import {
  BaseError,
  ContractFunctionRevertedError,
  InternalRpcError,
  RpcRequestError,
} from 'viem';
import { getContractError } from 'viem/utils';
import { classifyReadFailure } from './contractReadError';
import { decideArbiterTimeout } from './arbiterTimeoutSettlement';

/**
 * ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ
 *
 * `decideArbiterTimeout` решает, что интерфейс обещает пользователю по деньгам
 * зависшего спора: полный возврат клиенту или дележ котла пополам. Ошибка здесь —
 * не косметика, а обещание не той суммы не тому человеку.
 *
 * Опасная клетка одна: «чтение `disputeFee()` не удалось» viem может показать как
 * контрактный реверт, даже когда это был сбой RPC. Тест держит именно её.
 *
 * ЧЕМ ЗАПУСКАТЬ. У фронта нет своего тест-раннера: `npm install` в `frontend/`
 * падает целиком на этой файловой системе (exFAT не умеет симлинки, которые npm
 * создаёт в `node_modules/.bin` — по той же причине скрипты в package.json зовут
 * `node node_modules/next/dist/bin/next`, а не `next`). Поэтому `npm test` в
 * `frontend/` берёт vitest у релеера по пути; нужен установленный
 * `relayer/node_modules` (`cd relayer && npm ci`).
 */

const ZERO = '0x0000000000000000000000000000000000000000';
const SOMEBODY = '0x1111111111111111111111111111111111111111';

const DISPUTE_FEE_ABI = [
  {
    inputs: [],
    name: 'disputeFee',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * Ошибка, которую viem реально отдаёт из `readContract`, когда RPC ответил
 * `-32603 Internal error`. Собирается настоящей машинерией viem, а не вручную:
 * весь смысл проверки — в том, КАК viem это классифицирует, и подделка здесь
 * доказывала бы только собственную подделку.
 */
function internalRpcErrorFromRead(): BaseError {
  const rpcError = new RpcRequestError({
    body: { method: 'eth_call', params: [] },
    error: { code: -32603, message: 'Internal error' },
    url: 'https://example-rpc.invalid/base-sepolia',
  });
  return getContractError(new InternalRpcError(rpcError), {
    abi: DISPUTE_FEE_ABI,
    address: SOMEBODY,
    functionName: 'disputeFee',
    args: [],
  }) as BaseError;
}

describe('viem принимает -32603 за контрактный реверт', () => {
  // Это НЕ наше поведение и не наш выбор — это предпосылка, на которой стоит
  // проверка ниже. `getContractError` держит код `InternalRpcError` в одном
  // списке с кодом 3 «execution reverted», и при любых данных подменяет причину
  // на `ContractFunctionRevertedError`. Если viem это когда-нибудь починит,
  // тест упадёт здесь — и это будет хорошая новость, а не поломка.
  it('заворачивает серверный сбой в ContractFunctionRevertedError', () => {
    const err = internalRpcErrorFromRead();
    expect(err.walk((e) => e instanceof ContractFunctionRevertedError)).toBeTruthy();
  });

  it('поэтому наш классификатор называет его контрактным отказом', () => {
    expect(classifyReadFailure(internalRpcErrorFromRead())).toBe('contract');
  });
});

describe('decideArbiterTimeout', () => {
  it('не знает исхода, пока не прочитано поле arbiter', () => {
    expect(
      decideArbiterTimeout({
        arbiter: undefined,
        fee: undefined,
        feeError: undefined,
        pot: undefined,
        disputeWindow: undefined,
      }).kind,
    ).toBe('unknown');
  });

  it('за спор брались — весь котёл клиенту, читать нечего', () => {
    expect(
      decideArbiterTimeout({
        arbiter: SOMEBODY,
        fee: undefined,
        feeError: internalRpcErrorFromRead(),
        pot: undefined,
        disputeWindow: undefined,
      }).kind,
    ).toBe('refund');
  });

  it('настоящий старый клон: disputeFee ревертит, но окно дочиталось → возврат', () => {
    // Измерено на живой реализации 0xf7cBecE7…: `disputeFee()` реверта нет
    // селектора, `DISPUTE_WINDOW()` отдаёт 345600 (4 дня).
    expect(
      decideArbiterTimeout({
        arbiter: ZERO,
        fee: undefined,
        feeError: internalRpcErrorFromRead(),
        pot: 200_000_000n,
        disputeWindow: 345_600n,
      }).kind,
    ).toBe('refund');
  });

  // ── Клетка, которую закрывает Задача 7c ──────────────────────────────────
  //
  // Сбой RPC валит все три чтения разом, и до правки этот случай был
  // НЕОТЛИЧИМ от старого клона: `feeError` классифицировался как контрактный,
  // и функция уверенно обещала полный возврат — новому клону, который поделит
  // котёл пополам. Признак старого клона локальный (нет одного селектора),
  // `-32603` — серверный, поэтому доверять выводу можно только когда другое
  // чтение того же контракта доехало.
  it('шторм -32603 валит все чтения → честное «не знаем», а не «возврат»', () => {
    const err = internalRpcErrorFromRead();
    expect(
      decideArbiterTimeout({
        arbiter: ZERO,
        fee: undefined,
        feeError: err,
        pot: undefined,
        disputeWindow: undefined,
      }).kind,
    ).toBe('unknown');
  });

  it('окно не дочиталось — «не знаем», даже если котёл уже известен', () => {
    expect(
      decideArbiterTimeout({
        arbiter: ZERO,
        fee: undefined,
        feeError: internalRpcErrorFromRead(),
        pot: 200_000_000n,
        disputeWindow: undefined,
      }).kind,
    ).toBe('unknown');
  });

  it('новый клон: все три чтения дошли → дележ, остаток клиенту', () => {
    const settlement = decideArbiterTimeout({
      arbiter: ZERO,
      fee: 990_000n,
      feeError: undefined,
      pot: 33n,
      disputeWindow: 345_600n,
    });
    expect(settlement).toEqual({
      kind: 'split',
      toExecutor: 16n,
      toClient: 17n,
      windowDays: 4,
    });
  });
});
