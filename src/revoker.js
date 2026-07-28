/**
 * Serialises "delete for everyone" across the whole bot.
 *
 * WhatsApp silently drops a revoke issued while another one is still in
 * flight — it resolves normally and the message simply stays. Measured over a
 * day of logs: every revoke issued on its own succeeded, and every revoke
 * issued in the same moment as another failed. Reactions showed it most because
 * reacting happens on a reminder, so the reminder's revoke and the status
 * list's revoke were fired microseconds apart.
 *
 * So revokes are queued globally: one at a time, each confirmed gone (or timed
 * out) before the next is issued, with a short gap between them.
 */

const POLL_MS = 500;
const CONFIRM_TIMEOUT_MS = 15000;
const GAP_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chain = Promise.resolve();

/** True once WhatsApp no longer holds the message as a normal chat message. */
async function isGone(client, messageId) {
  const msg = await client.getMessageById(messageId).catch(() => null);
  return !msg || msg.type === 'revoked';
}

async function performRevoke(client, messageId) {
  if (await isGone(client, messageId)) return true;

  const msg = await client.getMessageById(messageId).catch(() => null);
  if (!msg) return true;
  await msg.delete(true);

  // A revoke lands in about a second; poll rather than guess, so the next one
  // is never issued while this is still settling.
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (await isGone(client, messageId)) {
      await sleep(GAP_MS);
      return true;
    }
  }
  await sleep(GAP_MS);
  return false;
}

/**
 * Queues a revoke behind any already in progress.
 * @returns {Promise<boolean>} true once the message is gone from the chat
 */
function revoke(client, messageId) {
  const run = chain.then(() => performRevoke(client, messageId));
  chain = run.catch(() => {}); // a failure must not break the queue
  return run;
}

module.exports = { revoke, isGone };
