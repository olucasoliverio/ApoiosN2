import 'dotenv/config';
import axios from 'axios';
import crypto from 'crypto';
import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';

const TOKEN   = process.env.DISCORD_TOKEN;
const CHANNEL = process.env.CHANNEL_ID;
const APP_URL = process.env.APPS_SCRIPT_URL;
const SECRET  = process.env.WEBHOOK_SECRET || '';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.ThreadMember]
});

const sent = new Set();

function isFromTargetChannel(msg) {
  // Mensagem no canal direto
  if (msg.channelId === CHANNEL) return true;

  // Mensagem em thread: parent é o canal monitorado?
  const ch = msg.channel;
  if (ch && (ch.type === ChannelType.PublicThread || ch.type === ChannelType.PrivateThread || ch.type === ChannelType.AnnouncementThread)) {
    return ch.parentId === CHANNEL;
  }
  return false;
}

client.once('ready', async () => {
  console.log(`[gateway] online ${client.user.tag}`);

  try {
    const parent = await client.channels.fetch(CHANNEL);
    if (!parent) {
      console.warn('[gateway] CHANNEL_ID não encontrado ou sem permissão de ver');
    } else {
      console.log('[gateway] canal OK:', parent.id, parent.type);

      // Se for Forum/News (que usam threads), entre nas threads ativas
      if (parent.type === ChannelType.GuildForum || parent.type === ChannelType.GuildNews) {
        const active = await parent.threads.fetchActive();
        active?.threads?.forEach(async (t) => {
          try { if (!t.joined) await t.join(); } catch (_) {}
        });
        console.log('[gateway] threads ativas ingressadas:', active?.threads?.size || 0);
      }
    }
  } catch (err) {
    console.warn('[gateway] não consegui buscar o canal:', err.message);
  }
});

// Se novas threads forem criadas no canal-alvo, entrar nelas
client.on('threadCreate', async (thread) => {
  try {
    if (thread.parentId === CHANNEL && !thread.joined) {
      await thread.join();
      console.log('[threads] joined nova thread', thread.id);
    }
  } catch (e) {
    console.warn('[threads] falha ao join', thread.id, e.message);
  }
});

client.on('messageCreate', async (m) => {
  try {
    // ignore só mensagens do próprio bot (evita loop)
    if (m.author?.id === client.user.id) return;

    // aceite mensagens de bots/webhooks e humanos
    if (!isFromTargetChannel(m)) return;

    const attachments = [...m.attachments.values()].map(a => ({
      id: a.id,
      name: a.name,
      url: a.url,
      contentType: a.contentType || null,
      size: a.size
    }));

    const embeds = m.embeds.map(e => ({
      title: e.title || null,
      description: e.description || null,
      url: e.url || null,
      fields: e.fields?.map(f => ({ name: f.name, value: f.value, inline: !!f.inline })) || [],
      footer: e.footer?.text || null,
      image: e.image?.url || null,
      thumbnail: e.thumbnail?.url || null,
      author: e.author?.name || null
    }));

    const authorName = m.author?.username || (m.webhookId ? 'Webhook' : 'Desconhecido');
    const content = m.content || ''; // pode vir vazio se for só embed

    const hash = crypto.createHash('sha1')
      .update(`${m.id}:${content}:${attachments.length}:${embeds.length}`)
      .digest('hex');
    if (sent.has(hash)) return;
    sent.add(hash);
    if (sent.size > 5000) { const it = sent.values().next().value; sent.delete(it); }

    const payload = {
      channelId: m.channelId,
      messageId: m.id,
      authorId: m.author?.id || (m.webhookId ? `webhook:${m.webhookId}` : 'unknown'),
      author: authorName,
      content,
      embeds,
      attachments,
      createdAt: m.createdAt.toISOString(),
      // se você tiver um conversationId nos dados, inclua aqui:
      // conversationId: '...'
      secret: SECRET
    };

    console.log('[forward] → Apps Script', {
      id: m.id,
      len: content.length,
      att: attachments.length,
      emb: embeds.length,
      thread: m.channel?.isThread?.() ? m.channel.id : null
    });

    const res = await axios.post(APP_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    });

    console.log('[forward] ←', res.status, JSON.stringify(res.data).slice(0, 300));
  } catch (e) {
    const code = e.response?.status;
    const data = e.response?.data;
    console.error('[forward][erro]', code || e.code || e.message, data ? JSON.stringify(data).slice(0, 300) : '');
  }
});

(async () => {
  try {
    const r = await axios.get('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${TOKEN}` },
      timeout: 15000
    });
    console.log('[rest] token OK → bot:', r.data.username, r.data.id);
  } catch (e) {
    console.error('[rest] token inválido/rede', e.response?.status || e.code, e.response?.data || e.message);
    process.exit(1);
  }
  await client.login(TOKEN);
})();
