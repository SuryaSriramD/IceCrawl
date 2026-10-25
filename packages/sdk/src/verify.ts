import { replayMarkdown } from '@icecrawl/scraper/replay';
import { verifyReceipt, type VerifyReport } from '@icecrawl/trust';
import type { IceCrawl } from './client';

export type { VerifyReport };

/** Fetches a receipt with its snapshot and the server's public keys, then verifies it locally (signature, hashes, converter and scanner replay). */
export async function verifyReceiptRemote(client: IceCrawl, receiptId: string): Promise<VerifyReport> {
  const [signed, publicKeys, html, screenshot] = await Promise.all([
    client.getReceipt(receiptId),
    client.getPublicKeys(),
    client.getSnapshot(receiptId),
    client.getScreenshot(receiptId),
  ]);
  return verifyReceipt({
    signed,
    publicKeys,
    html,
    screenshot,
    replay: (bytes) => replayMarkdown(signed.receipt, bytes),
  });
}
