import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';
import { app } from '../app.js';
import { mockContract } from './mocks/ethersRegistry.js';

const FORWARDER = process.env.TRUSTED_FORWARDER;
const VALID_BODY = {
  from: '0x1111111111111111111111111111111111111111',
  to:   '0x2222222222222222222222222222222222222222',
  gas:  '100000',
  data: '0xabcdef',
  signature: '0x' + '11'.repeat(65),
};

// Same event fragment app.js's FORWARDER_ABI declares — used to build realistic
// Executed(...) logs for the post-mine re-verification tests below.
const EXECUTED_IFACE = new ethers.Interface([
  'event Executed(address indexed from, address indexed to, bool success)',
]);

function executedLog(from, to, success) {
  const { topics, data } = EXECUTED_IFACE.encodeEventLog(
    EXECUTED_IFACE.getEvent('Executed'),
    [from, to, success],
  );
  return { address: FORWARDER, topics, data };
}

// Real ethers.Contract methods carry a `.staticCall` sub-function automatically;
// the FakeContract test mock does not — it just returns whatever function a test
// hands it as `execute`. This attaches one so app.js's pre-send simulation has
// something to call.
function executeMock({ simResult, sendResult }) {
  const fn = async () => sendResult;
  fn.staticCall = async () => simResult;
  return fn;
}

describe('POST /relay', () => {
  it('rejects a request missing required fields', async () => {
    const res = await request(app).post('/relay').send({ from: VALID_BODY.from });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid "to" address', async () => {
    const res = await request(app).post('/relay').send({ ...VALID_BODY, to: 'not-an-address' });
    expect(res.status).toBe(400);
  });

  it('rejects a gas value over the hard cap', async () => {
    const res = await request(app).post('/relay').send({ ...VALID_BODY, gas: '9000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gas exceeds maximum/);
  });

  it('rejects when the forwarder reports the signature invalid', async () => {
    mockContract(FORWARDER, { getNonce: 0n, verify: false });
    const res = await request(app).post('/relay').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid signature/);
  });

  it('relays successfully when simulation, mining, and the Executed log all agree', async () => {
    mockContract(FORWARDER, {
      getNonce: 0n,
      verify: true,
      execute: executeMock({
        simResult: [true, '0x'],
        sendResult: {
          wait: async () => ({
            status: 1,
            hash: '0xdeadbeef',
            blockNumber: 42,
            logs: [executedLog(VALID_BODY.from, VALID_BODY.to, true)],
          }),
        },
      }),
    });
    const res = await request(app).post('/relay').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.txHash).toBe('0xdeadbeef');
  });

  it('reports a 400 when the relayed transaction reverts on-chain (outer revert)', async () => {
    mockContract(FORWARDER, {
      getNonce: 0n,
      verify: true,
      execute: executeMock({
        simResult: [true, '0x'],
        sendResult: { wait: async () => ({ status: 0 }) },
      }),
    });
    const res = await request(app).post('/relay').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reverted/);
  });

  it('rejects without broadcasting when the simulation predicts the inner call fails', async () => {
    let sent = false;
    const fn = async () => {
      sent = true;
      return { wait: async () => ({ status: 1, logs: [] }) };
    };
    // AlreadyFunded selector, from the CUSTOM_ERRORS table shared with route.ts.
    fn.staticCall = async () => [false, '0x5adf6387'];
    mockContract(FORWARDER, { getNonce: 0n, verify: true, execute: fn });

    const res = await request(app).post('/relay').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/AlreadyFunded/);
    expect(sent).toBe(false); // never broadcasts a doomed tx
  });

  it('returns a 400 when the simulation call itself throws', async () => {
    const fn = async () => ({ wait: async () => ({ status: 1, logs: [] }) });
    fn.staticCall = async () => { throw new Error('network hiccup'); };
    mockContract(FORWARDER, { getNonce: 0n, verify: true, execute: fn });

    const res = await request(app).post('/relay').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Simulation failed/);
  });

  it("rejects when the simulation passes but the mined receipt's Executed log reports failure", async () => {
    // Models the race the simulation alone can't catch: state changes between the
    // staticCall and the real broadcast, so the mined tx's own event is what counts.
    mockContract(FORWARDER, {
      getNonce: 0n,
      verify: true,
      execute: executeMock({
        simResult: [true, '0x'],
        sendResult: {
          wait: async () => ({
            status: 1,
            hash: '0xdeadbeef',
            blockNumber: 42,
            logs: [executedLog(VALID_BODY.from, VALID_BODY.to, false)],
          }),
        },
      }),
    });
    const res = await request(app).post('/relay').send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inner call failed/i);
  });
});
