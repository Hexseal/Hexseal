import { ethers } from 'ethers';

/** Signs an arbitrary message with a test wallet (EIP-191 personal_sign, matching
 *  every signature scheme this relayer verifies via ethers.recoverAddress/verifyMessage). */
export async function signMessage(wallet, message) {
  return wallet.signMessage(message);
}

/** Builds the exact signed-profile-update fixture PUT /files/public-put/:key expects
 *  (relayer/app.js, profile branch): message = "hexseal:profile:update:<addr>:<nonce>:<keccak256(body)>",
 *  recovered server-side via ethers.recoverAddress(ethers.hashMessage(message), sig). */
export async function signProfileUpdate(wallet, nonce, bodyStr) {
  const address  = (await wallet.getAddress()).toLowerCase();
  const bodyHash = ethers.keccak256(ethers.toUtf8Bytes(bodyStr));
  const message  = `hexseal:profile:update:${address}:${nonce}:${bodyHash}`;
  const sig      = await wallet.signMessage(message);
  return { address, sig };
}
