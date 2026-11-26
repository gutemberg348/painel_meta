import { z } from 'zod';

export function createInboxChannels(flw, config) {
  let request;
  let expires = 0;
  return async function inboxChannels(account) {
    if (account?.role === 'agent' && !account.channelId) return [];
    if (!request || Date.now() >= expires) {
      expires = Infinity;
      request = flw.channels().then(channels => {
        expires = Date.now() + 60000;
        return channels.filter(channel => z.uuid().safeParse(channel.id).success);
      }).catch(error => {
        request = undefined;
        throw error;
      });
    }
    const channels = await request;
    let allowed = channels;
    if (config.inboxChannelId) {
      allowed = channels.filter(item => item.id.toLowerCase() === config.inboxChannelId);
      if (!allowed.length) throw Object.assign(new Error('O canal configurado em FLW_INBOX_CHANNEL_ID não aparece entre os canais WhatsApp desse token.'), { status: 409 });
    }
    if (account?.role === 'agent') return allowed.filter(c => c.id.toLowerCase() === account.channelId && c.active !== false);
    return allowed;
  };
}
