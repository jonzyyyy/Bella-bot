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

/**
 * Runs the real production path — Message.delete(true) — against one surviving
 * message, and reports the version gate that picks the revoke signature.
 *
 * A direct Cmd.sendRevokeMsgs call revokes these messages instantly, while
 * delete(true) leaves them untouched. Either the version gate is choosing the
 * wrong signature, or the revoke works and our verification just checks before
 * WhatsApp has updated the local model. This distinguishes the two.
 *
 * Enable with BELLA_DEBUG_REVOKE=3.
 */
async function testLibraryDeletePath(client, messageIds) {
  const gate = await client.pupPage.evaluate(() => ({
    version: window.Debug?.VERSION,
    comparesNewer: window.WWebJS?.compareWwebVersions?.(window.Debug?.VERSION, '>=', '2.3000.0'),
  }));
  console.log(`[revoke-debug] version gate → ${JSON.stringify(gate)}`);

  for (const messageId of messageIds) {
    const msg = await client.getMessageById(messageId).catch(() => null);
    if (!msg || msg.type === 'revoked') continue;

    let threw = null;
    try {
      await msg.delete(true);
    } catch (err) {
      threw = err.message;
    }

    const immediate = await client.getMessageById(messageId).catch(() => null);
    await new Promise((r) => setTimeout(r, 5000));
    const settled = await client.getMessageById(messageId).catch(() => null);

    console.log(`[revoke-debug] library delete on ${messageId} → ${JSON.stringify({
      threw,
      typeImmediately: immediate ? immediate.type : 'gone',
      typeAfter5s: settled ? settled.type : 'gone',
    })}`);
    return;
  }
  console.log('[revoke-debug] No surviving message to test the library path against.');
}

/**
 * Measures how long a revoke actually takes to land.
 *
 * Deletes each message and polls until WhatsApp stops holding it, reporting the
 * elapsed time. The fixed settle in postStatus was guessed from a single
 * measurement on an hours-old message; production lists are still present after
 * it, so the real distribution matters. Logs the message body so we can also
 * confirm we're deleting the message we think we are.
 *
 * Skips the newest tracked message so the group keeps a current list.
 * Enable with BELLA_DEBUG_REVOKE=4.
 */
async function measureRevokeLatency(client, messageIds, maxMs = 240000) {
  const targets = messageIds.slice(0, -1); // keep the newest list in the group
  if (targets.length === 0) {
    console.log('[revoke-debug] Only one tracked status — nothing safe to measure against.');
    return;
  }

  for (const messageId of targets) {
    const msg = await client.getMessageById(messageId).catch(() => null);
    if (!msg || msg.type === 'revoked') {
      console.log(`[revoke-debug] ${messageId} already gone before delete`);
      continue;
    }
    console.log(`[revoke-debug] deleting ${messageId} — body: ${JSON.stringify(String(msg.body).slice(0, 45))}`);

    const started = Date.now();
    try {
      await msg.delete(true);
    } catch (err) {
      console.error(`[revoke-debug] delete threw: ${err.message}`);
    }

    let elapsed = null;
    while (Date.now() - started < maxMs) {
      await new Promise((r) => setTimeout(r, 2000));
      const cur = await client.getMessageById(messageId).catch(() => null);
      if (!cur || cur.type === 'revoked') {
        elapsed = Date.now() - started;
        break;
      }
    }
    console.log(
      `[revoke-debug] ${messageId} → ${elapsed === null ? `STILL PRESENT after ${maxMs}ms` : `gone after ${elapsed}ms`}`
    );
  }
}

/**
 * Isolates the one structural difference between the delete that works and the
 * delete that doesn't.
 *
 * The same message revokes in ~2.3s when deleted from the startup probe, but
 * survives a 5s wait when deleted by postStatus. The only thing postStatus does
 * differently is call chat.fetchMessages() immediately beforehand. This posts a
 * throwaway message, deletes it each way, and times the result.
 *
 * Posts two temporary messages to the group, which delete themselves if the
 * revoke works. Enable with BELLA_DEBUG_REVOKE=5.
 */
async function compareDeleteSequences(client, chatId) {
  const chat = await client.getChatById(chatId);

  const run = async (label, withPreload) => {
    const sent = await chat.sendMessage(`🐾 _bot self-test (${label}) — this message deletes itself_`);
    const id = sent.id._serialized ?? sent.id.id;
    await new Promise((r) => setTimeout(r, 3000));

    if (withPreload) {
      try {
        await chat.fetchMessages({ limit: 30 });
      } catch (err) {
        console.warn(`[revoke-debug] ${label} fetchMessages failed: ${err.message}`);
      }
    }

    const msg = await client.getMessageById(id).catch(() => null);
    if (!msg) {
      console.log(`[revoke-debug] ${label}: message vanished before delete`);
      return;
    }

    const started = Date.now();
    try {
      await msg.delete(true);
    } catch (err) {
      console.error(`[revoke-debug] ${label} delete threw: ${err.message}`);
    }

    let elapsed = null;
    while (Date.now() - started < 30000) {
      await new Promise((r) => setTimeout(r, 1000));
      const cur = await client.getMessageById(id).catch(() => null);
      if (!cur || cur.type === 'revoked') {
        elapsed = Date.now() - started;
        break;
      }
    }
    console.log(`[revoke-debug] ${label} (preload=${withPreload}) → ${elapsed === null ? 'STILL PRESENT after 30s' : `gone after ${elapsed}ms`}`);
  };

  await run('with-preload', true);
  await run('no-preload', false);
}

/**
 * Tracks whether revoking still works as the session ages.
 *
 * Every measured success happened seconds after a restart; every failure hours
 * in. Sending keeps working throughout, so the suspicion is that the revoke
 * path specifically degrades over the life of a session. This posts and deletes
 * a message in the bot's own "message yourself" chat — not the group — every
 * `intervalMs`, and logs the latency against uptime.
 *
 * Enable with BELLA_DEBUG_REVOKE=7.
 */
function watchRevokeHealth(client, intervalMs = 600000) {
  const selfId = client.info?.wid?._serialized;
  if (!selfId) {
    console.error('[revoke-health] No self id available — cannot run.');
    return;
  }
  const startedAt = Date.now();

  const tick = async () => {
    const upMin = Math.round((Date.now() - startedAt) / 60000);
    try {
      const chat = await client.getChatById(selfId);
      const sent = await chat.sendMessage(`revoke health check — ${new Date().toISOString()}`);
      const id = sent.id._serialized ?? sent.id.id;
      await new Promise((r) => setTimeout(r, 2000));

      const msg = await client.getMessageById(id).catch(() => null);
      if (!msg) {
        console.log(`[revoke-health] uptime=${upMin}min → message vanished before delete`);
        return;
      }

      const started = Date.now();
      try {
        await msg.delete(true);
      } catch (err) {
        console.error(`[revoke-health] uptime=${upMin}min → delete threw: ${err.message}`);
        return;
      }

      let elapsed = null;
      while (Date.now() - started < 20000) {
        await new Promise((r) => setTimeout(r, 1000));
        const cur = await client.getMessageById(id).catch(() => null);
        if (!cur || cur.type === 'revoked') {
          elapsed = Date.now() - started;
          break;
        }
      }
      console.log(`[revoke-health] uptime=${upMin}min → ${elapsed === null ? 'FAILED (still present after 20s)' : `ok in ${elapsed}ms`}`);
    } catch (err) {
      console.error(`[revoke-health] uptime=${upMin}min → check failed: ${err.message}`);
    }
  };

  tick();
  setInterval(tick, intervalMs).unref?.();
  console.log(`[revoke-health] Watching revoke health every ${Math.round(intervalMs / 60000)} min.`);
}

module.exports = {
  diagnoseRevoke, tryRevokeSignatures, testLibraryDeletePath, measureRevokeLatency, compareDeleteSequences,
  watchRevokeHealth,
};
