/**
 * One-shot diagnostic for message deletion.
 *
 * Message.delete(true) silently downgrades to a delete-for-me when WhatsApp
 * says a message can't be revoked, so a failed delete looks identical to a
 * successful one from the outside. This asks WhatsApp the same questions
 * delete() asks and prints the answers, so we can see *why* a revoke is being
 * refused rather than guessing.
 *
 * Enable with BELLA_DEBUG_REVOKE=1 and read the [revoke-debug] lines after a
 * restart. Purely diagnostic — it never modifies or deletes anything.
 */
async function diagnoseRevoke(client, messageIds) {
  if (messageIds.length === 0) {
    console.log('[revoke-debug] No tracked messages to probe.');
    return;
  }

  for (const messageId of messageIds) {
    try {
      const info = await client.pupPage.evaluate(async (msgId) => {
        const out = { wwebVersion: window.Debug?.VERSION };
        const Collections = window.require('WAWebCollections');

        out.inMemory = !!Collections.Msg.get(msgId);
        const msg =
          Collections.Msg.get(msgId) ||
          (await Collections.Msg.getMessagesById([msgId]))?.messages?.[0];
        if (!msg) return { ...out, found: false };

        out.found = true;
        out.type = msg.type;
        out.subtype = msg.subtype;
        out.ack = msg.ack;
        out.fromMe = !!msg.id?.fromMe;
        out.participant = String(msg.author ?? msg.from ?? '');

        // The exact pair of checks Message.delete() gates the revoke on.
        try {
          const Cap = window.require('WAWebMsgActionCapability');
          out.canSenderRevoke = Cap.canSenderRevokeMsg(msg);
          out.canAdminRevoke = Cap.canAdminRevokeMsg(msg);
        } catch (err) {
          out.capabilityError = err.message;
        }

        return out;
      }, messageId);

      console.log(`[revoke-debug] ${messageId} → ${JSON.stringify(info)}`);
    } catch (err) {
      console.error(`[revoke-debug] ${messageId} → probe failed: ${err.message}`);
    }
  }
}

/**
 * Tries each Cmd.sendRevokeMsgs call signature against one real message and
 * reports which (if either) actually revokes it.
 *
 * Message.delete() picks a signature from the reported web version, and the
 * probe shows WhatsApp permits the revoke yet the message survives — so the
 * suspicion is that the chosen signature silently no-ops on this build. This
 * settles it by measurement.
 *
 * Destructive by design: it revokes the bot's own leftover status lists, which
 * is the outcome we want anyway. Enable with BELLA_DEBUG_REVOKE=2.
 */
async function tryRevokeSignatures(client, messageIds) {
  for (const messageId of messageIds) {
    const result = await revokeSignatureRun(client, messageId);
    console.log(`[revoke-debug] signature test on ${messageId} → ${JSON.stringify(result)}`);
    // Messages WhatsApp no longer holds tell us nothing — move to the next.
    if (result.found) return result;
  }
  console.log('[revoke-debug] No tracked message was still present to test against.');
  return null;
}

async function revokeSignatureRun(client, messageId) {
  return client.pupPage.evaluate(async (msgId) => {
    const log = [];
    const Collections = window.require('WAWebCollections');
    const { Cmd } = window.require('WAWebCmd');

    const load = async () =>
      Collections.Msg.get(msgId) ||
      (await Collections.Msg.getMessagesById([msgId]))?.messages?.[0];

    let msg = await load();
    if (!msg) return { found: false };

    const chat =
      Collections.Chat.get(msg.id.remote) ||
      (await Collections.Chat.find(msg.id.remote));
    log.push(`chat resolved: ${!!chat}`);

    const settle = () => new Promise((r) => setTimeout(r, 4000));
    const typeNow = async () => (await load())?.type ?? 'gone';

    // New-style signature — what Message.delete() uses on this version.
    try {
      const ret = await Cmd.sendRevokeMsgs(chat, { list: [msg], type: 'message' }, { clearMedia: true });
      log.push(`new-style returned: ${JSON.stringify(ret) ?? 'undefined'}`);
    } catch (err) {
      log.push(`new-style threw: ${err.message}`);
    }
    await settle();
    let type = await typeNow();
    log.push(`type after new-style: ${type}`);
    if (type === 'revoked' || type === 'gone') return { found: true, worked: 'new-style', log };

    // Old-style signature — the pre-2.3000 branch.
    try {
      msg = await load();
      const ret = await Cmd.sendRevokeMsgs(chat, [msg], { clearMedia: true, type: msg.id.fromMe ? 'Sender' : 'Admin' });
      log.push(`old-style returned: ${JSON.stringify(ret) ?? 'undefined'}`);
    } catch (err) {
      log.push(`old-style threw: ${err.message}`);
    }
    await settle();
    type = await typeNow();
    log.push(`type after old-style: ${type}`);
    if (type === 'revoked' || type === 'gone') return { found: true, worked: 'old-style', log };

    return { found: true, worked: null, log };
  }, messageId);
}

module.exports = { diagnoseRevoke, tryRevokeSignatures };
