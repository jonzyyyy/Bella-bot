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

module.exports = { diagnoseRevoke };
