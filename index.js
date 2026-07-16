/**
 * UzForum Telegram Bot — professional versiya
 * -----------------------------------------------------------------------
 * Sayt bilan bitta Supabase bazasini ishlatadi (kv_store jadvali).
 * Kerakli environment o'zgaruvchilar (Render -> Environment):
 *   BOT_TOKEN            - BotFather'dan olingan token
 *   SUPABASE_URL          - https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  - Supabase "secret key" (Settings -> API Keys -> Secret keys)
 *                            DIQQAT: bu maxfiy kalit, hech qayerga (GitHub'ga ham) qo'ymang!
 *   ADMIN_CHAT_ID          - sizning shaxsiy Telegram ID raqamingiz (bot @userinfobot orqali olinadi)
 *   RENDER_EXTERNAL_URL    - Render avtomatik beradi (webhook uchun), qo'lda kerak emas
 *   PORT                   - Render avtomatik beradi
 * -----------------------------------------------------------------------
 */
const express = require('express');
const { Telegraf, Markup, session } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT = process.env.PORT || 3000;
const MIN_TOPUP = 5000;
const MAX_TOPUP = 50000000;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY environment o\'zgaruvchilari kerak!');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const bot = new Telegraf(BOT_TOKEN);
bot.use(session({ defaultSession: () => ({}) }));

/* ========================= kv_store helper funksiyalari ========================= */
async function kvGet(key) {
  const { data, error } = await sb.from('kv_store').select('value').eq('key', key).maybeSingle();
  if (error) { console.error('kvGet error', key, error.message); return null; }
  return data ? data.value : null;
}
async function kvSet(key, value) {
  const { error } = await sb.from('kv_store').upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) console.error('kvSet error', key, error.message);
}
async function kvDelete(key) {
  const { error } = await sb.from('kv_store').delete().eq('key', key);
  if (error) console.error('kvDelete error', key, error.message);
}
async function kvList(prefix) {
  let q = sb.from('kv_store').select('key');
  if (prefix) q = q.like('key', prefix + '%');
  const { data, error } = await q;
  if (error) { console.error('kvList error', prefix, error.message); return []; }
  return (data || []).map(r => r.key);
}

/* ========================= foydalanuvchi yordamchilari ========================= */
async function getUserByUsername(username) {
  const raw = await kvGet('user:' + username.toLowerCase());
  return raw ? JSON.parse(raw) : null;
}
async function saveUser(user) {
  await kvSet('user:' + user.username.toLowerCase(), JSON.stringify(user));
}
async function getUsernameByTelegramId(telegramId) {
  return await kvGet('tguser:' + telegramId);
}
async function getUserByTelegramId(telegramId) {
  const username = await getUsernameByTelegramId(telegramId);
  if (!username) return null;
  return await getUserByUsername(username);
}
async function requireLinkedUser(ctx) {
  const user = await getUserByTelegramId(String(ctx.from.id));
  if (!user) {
    await ctx.replyWithHTML(
      "❌ <b>Hisobingiz ulanmagan.</b>\n\nAvval saytda ro'yxatdan o'ting, so'ng kabinet ichidan " +
      "<b>\"📲 Telegram bot\"</b> bo'limiga kirib, ulash havolasini oling."
    );
    return null;
  }
  return user;
}

/* ========================= mahsulot / buyurtma yordamchilari ========================= */
async function listProducts() {
  const keys = await kvList('product:');
  const items = await Promise.all(keys.map(async k => {
    const raw = await kvGet(k);
    return raw ? JSON.parse(raw) : null;
  }));
  return items.filter(Boolean);
}
async function getProduct(id) {
  const raw = await kvGet('product:' + id);
  return raw ? JSON.parse(raw) : null;
}
async function saveOrder(order) {
  await kvSet('order:' + order.id, JSON.stringify(order));
}
async function getOrder(id) {
  const raw = await kvGet('order:' + id);
  return raw ? JSON.parse(raw) : null;
}
async function listOrdersByUsername(username) {
  const keys = await kvList('order:');
  const items = await Promise.all(keys.map(async k => {
    const raw = await kvGet(k);
    return raw ? JSON.parse(raw) : null;
  }));
  return items.filter(o => o && o.buyer && o.buyer.toLowerCase() === username.toLowerCase())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
async function getPaymentCard() {
  const raw = await kvGet('uzforum_payment_card');
  return raw ? JSON.parse(raw) : { number: '', holder: '', bank: '' };
}

function money(n) {
  return (n || 0).toLocaleString('uz-UZ') + " so'm";
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function isAdmin(ctx) {
  return ADMIN_CHAT_ID && String(ctx.from.id) === String(ADMIN_CHAT_ID);
}

/* ========================= menyular ========================= */
function mainMenu() {
  return Markup.keyboard([
    ['👤 Hisobim', '💰 Balans to\'ldirish'],
    ['📦 Mahsulot sotib olish', '🧾 Buyurtmalarim'],
    ['🆘 Yordam']
  ]).resize();
}
function cancelKeyboard() {
  return Markup.inlineKeyboard([Markup.button.callback('✖️ Bekor qilish', 'cancel_flow')]);
}

/* ========================= xatoliklarni global tutish ========================= */
bot.catch((err, ctx) => {
  console.error(`Xatolik [${ctx.updateType}]`, err);
  ctx.reply('⚠️ Kutilmagan xatolik yuz berdi. Birozdan so\'ng qayta urinib ko\'ring.').catch(() => {});
});

/* ========================= /start (ulash) ========================= */
bot.start(async (ctx) => {
  const payload = ctx.startPayload;
  const telegramId = String(ctx.from.id);

  if (payload) {
    const raw = await kvGet('linkcode:' + payload);
    if (!raw) {
      return ctx.replyWithHTML("❌ Havola muddati o'tgan yoki noto'g'ri.\nSaytdan qaytadan havola oling.");
    }
    const { username, createdAt } = JSON.parse(raw);
    if (Date.now() - createdAt > 10 * 60 * 1000) {
      await kvDelete('linkcode:' + payload);
      return ctx.replyWithHTML("❌ Havola muddati o'tgan <i>(10 daqiqa)</i>.\nSaytdan qaytadan havola oling.");
    }
    const user = await getUserByUsername(username);
    if (!user) return ctx.reply('❌ Hisob topilmadi.');

    user.telegramId = telegramId;
    await saveUser(user);
    await kvSet('tguser:' + telegramId, user.username);
    await kvDelete('linkcode:' + payload);

    return ctx.replyWithHTML(`✅ <b>Hisobingiz muvaffaqiyatli ulandi!</b>\n\n👋 Xush kelibsiz, <b>${esc(user.username)}</b>!`, mainMenu());
  }

  const existing = await getUserByTelegramId(telegramId);
  if (existing) {
    return ctx.replyWithHTML(`👋 Xush kelibsiz qaytganingizdan xursandmiz, <b>${esc(existing.username)}</b>!`, mainMenu());
  }
  return ctx.replyWithHTML(
    "👋 <b>Assalomu alaykum! UzForum botiga xush kelibsiz.</b>\n\n" +
    "Bu bot orqali balansingizni to'ldirishingiz, mahsulot sotib olishingiz va buyurtmalaringizni kuzatishingiz mumkin.\n\n" +
    "🔗 Hisobingizni ulash uchun:\n" +
    "1️⃣ Saytda ro'yxatdan o'ting\n" +
    "2️⃣ Kabinet → <b>\"📲 Telegram bot\"</b>\n" +
    "3️⃣ Ulash havolasini bosing"
  );
});

bot.command('menu', (ctx) => ctx.reply('📋 Asosiy menyu:', mainMenu()));
bot.command('help', (ctx) => ctx.replyWithHTML(
  "🆘 <b>Yordam</b>\n\n" +
  "/menu — asosiy menyuni ko'rsatish\n" +
  "👤 Hisobim — profil va balansni ko'rish\n" +
  "💰 Balans to'ldirish — balans to'ldirish so'rovi yuborish\n" +
  "📦 Mahsulot sotib olish — katalogdan xarid qilish\n" +
  "🧾 Buyurtmalarim — buyurtmalar tarixi\n\n" +
  "Savol bo'lsa shu botga yozing, admin tez orada javob beradi."
));

/* ========================= 👤 Hisobim ========================= */
bot.hears('👤 Hisobim', async (ctx) => {
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  const joined = user.joined ? new Date(user.joined) : null;
  const now = new Date();
  await ctx.replyWithHTML(
    `👤 <b>Hisob ma'lumotlari</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🪪 Ism: <b>${esc(user.username)}</b>\n` +
    `🆔 Telegram ID: <code>${ctx.from.id}</code>\n` +
    `💰 Balans: <b>${money(user.balance || 0)}</b>\n` +
    `🕝 Ro'yxatdan o'tgan: ${joined ? joined.toLocaleDateString('uz-UZ') : '—'}\n` +
    `🕔 Hozirgi vaqt: ${now.toLocaleDateString('uz-UZ')} | ${now.toLocaleTimeString('uz-UZ')}`
  );
});

/* ========================= 💰 Balans to'ldirish ========================= */
bot.hears("💰 Balans to'ldirish", async (ctx) => {
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  const card = await getPaymentCard();
  ctx.session.flow = 'topup_amount';
  const cardInfo = card.number
    ? `💳 Karta: <code>${esc(card.number)}</code>\n👤 Egasi: ${esc(card.holder || '—')}\n🏦 Bank: ${esc(card.bank || '—')}\n\n`
    : '';
  await ctx.replyWithHTML(
    `${cardInfo}✍️ To'ldirmoqchi bo'lgan summani (so'mda) yuboring.\nMasalan: <code>100000</code>\n\n` +
    `<i>Min: ${money(MIN_TOPUP)} · Max: ${money(MAX_TOPUP)}</i>`,
    cancelKeyboard()
  );
});

bot.action('cancel_flow', async (ctx) => {
  ctx.session.flow = null;
  ctx.session.pendingProductId = null;
  ctx.session.broadcastText = null;
  await ctx.answerCbQuery('Bekor qilindi');
  await ctx.editMessageText('✖️ Bekor qilindi.');
});

/* ========================= 📦 Mahsulot sotib olish ========================= */
bot.hears('📦 Mahsulot sotib olish', async (ctx) => {
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  await ctx.sendChatAction('typing');
  const products = (await listProducts()).filter(p => p.isPremium !== false && p.price > 0);
  if (products.length === 0) return ctx.reply("🙁 Hozircha sotuvda mahsulot yo'q.");

  const buttons = products.slice(0, 30).map(p => [
    Markup.button.callback(`${p.icon || '📦'} ${p.name} — ${money(p.price)}`, `buy:${p.id}`)
  ]);
  await ctx.replyWithHTML(`🛒 <b>Mahsulotlar</b>\n💰 Joriy balans: <b>${money(user.balance || 0)}</b>\n\nBirini tanlang:`, Markup.inlineKeyboard(buttons));
});

bot.action(/^buy:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const user = await getUserByTelegramId(String(ctx.from.id));
  if (!user) return ctx.answerCbQuery('Hisob ulanmagan');
  const product = await getProduct(productId);
  if (!product) return ctx.answerCbQuery('Mahsulot topilmadi', { show_alert: true });

  if ((user.balance || 0) < product.price) {
    await ctx.answerCbQuery();
    return ctx.replyWithHTML(
      `❌ <b>Balansingiz yetarli emas.</b>\nKerak: ${money(product.price)}\nMavjud: ${money(user.balance || 0)}\n\n"💰 Balans to'ldirish" orqali to'ldiring.`
    );
  }

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🧾 Xaridni tasdiqlaysizmi?\n\n${product.icon || '📦'} ${product.name}\n💵 ${money(product.price)}\n\nBalansdan darhol yechib olinadi.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Ha, sotib olaman', `confirm_buy:${product.id}`)],
      [Markup.button.callback('✖️ Bekor qilish', 'cancel_flow')]
    ])
  );
});

bot.action(/^confirm_buy:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const user = await getUserByTelegramId(String(ctx.from.id));
  if (!user) return ctx.answerCbQuery('Hisob ulanmagan');
  const product = await getProduct(productId);
  if (!product) return ctx.answerCbQuery('Mahsulot topilmadi', { show_alert: true });

  if ((user.balance || 0) < product.price) {
    await ctx.answerCbQuery();
    return ctx.editMessageText('❌ Balansingiz yetarli emas.');
  }

  user.balance = (user.balance || 0) - product.price;
  const order = {
    id: 'o' + Date.now(),
    type: 'purchase',
    buyer: user.username,
    items: [{ name: product.name, cat: product.cat, qty: 1, total: product.price, free: false }],
    subtotal: product.price,
    discount: 0,
    promoCode: null,
    total: product.price,
    receiptImage: null,
    paidWithBalance: true,
    status: 'approved',
    createdAt: new Date().toISOString(),
    source: 'telegram'
  };
  user.purchases = user.purchases || [];
  user.purchases.unshift({ date: order.createdAt, items: order.items, orderId: order.id });

  await saveUser(user);
  await saveOrder(order);

  await ctx.answerCbQuery('Xarid amalga oshirildi ✅');
  await ctx.editMessageText(
    `✅ <b>"${esc(product.name)}"</b> sotib olindi!\n💰 Yangi balans: <b>${money(user.balance)}</b>\n\nAdmin tez orada siz bilan bog'lanib, mahsulotni yetkazib beradi.`,
    { parse_mode: 'HTML' }
  );

  if (ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(ADMIN_CHAT_ID,
      `🛒 <b>Yangi buyurtma (Telegram)</b>\n👤 ${esc(user.username)}\n📦 ${esc(product.name)}\n💵 ${money(product.price)}\n🆔 <code>${order.id}</code>\n\nMijozga mahsulotni qo'lda yetkazib bering.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
});

/* ========================= 🧾 Buyurtmalarim ========================= */
bot.hears('🧾 Buyurtmalarim', async (ctx) => {
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  await ctx.sendChatAction('typing');
  const orders = await listOrdersByUsername(user.username);
  if (orders.length === 0) return ctx.reply("🙁 Hali buyurtma yo'q.");
  const statusLabel = { pending: '⏳ Kutilmoqda', approved: '✅ Tasdiqlangan', rejected: '❌ Rad etilgan' };
  const lines = orders.slice(0, 15).map(o => {
    const title = o.type === 'topup' ? `Balans to'ldirish (${money(o.amount)})` : (o.items || []).map(i => i.name).join(', ');
    return `${statusLabel[o.status] || o.status} — ${esc(title)} — <i>${new Date(o.createdAt).toLocaleDateString('uz-UZ')}</i>`;
  });
  await ctx.replyWithHTML('🧾 <b>So\'nggi buyurtmalaringiz</b>\n━━━━━━━━━━━━━━━\n' + lines.join('\n'));
});

/* ========================= 🆘 Yordam ========================= */
bot.hears('🆘 Yordam', async (ctx) => {
  await ctx.reply("🆘 Savolingiz bormi? Shu yerga yozing — admin tez orada javob beradi.");
  if (ADMIN_CHAT_ID) {
    bot.telegram.sendMessage(ADMIN_CHAT_ID, `🆘 Yordam so'rovi: @${ctx.from.username || '—'} (ID: ${ctx.from.id})`).catch(() => {});
  }
});

/* ========================= admin panel ========================= */
async function getAllUsers() {
  const keys = await kvList('user:');
  const list = (await Promise.all(keys.map(k => kvGet(k)))).filter(Boolean).map(v => JSON.parse(v));
  return list;
}
async function getAllOrders() {
  const keys = await kvList('order:');
  const list = (await Promise.all(keys.map(k => kvGet(k)))).filter(Boolean).map(v => JSON.parse(v));
  return list;
}

function adminMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 Statistika', 'admin_stats')],
    [Markup.button.callback('⏳ Kutilayotgan so\'rovlar', 'admin_pending')],
    [Markup.button.callback('👥 Foydalanuvchilar', 'admin_users')],
    [Markup.button.callback('📦 Mahsulotlar', 'admin_products')],
    [Markup.button.callback('📢 Hammaga xabar yuborish', 'admin_broadcast')]
  ]);
}

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await ctx.replyWithHTML('⚙️ <b>Admin panel</b>\n\nKerakli bo\'limni tanlang:', adminMenuKeyboard());
});

bot.action('admin_menu', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ Admin panel\n\nKerakli bo\'limni tanlang:', adminMenuKeyboard());
});

bot.action('admin_stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.sendChatAction('typing');
  const users = await getAllUsers();
  const orders = await getAllOrders();

  const totalBalance = users.reduce((s, u) => s + (u.balance || 0), 0);
  const linkedCount = users.filter(u => u.telegramId).length;
  const pendingTopups = orders.filter(o => o.type === 'topup' && o.status === 'pending');
  const totalSales = orders.filter(o => o.type === 'purchase' && o.status === 'approved').reduce((s, o) => s + (o.total || 0), 0);

  await ctx.editMessageText(
    `📊 <b>Statistika</b>\n━━━━━━━━━━━━━━━\n` +
    `👥 Foydalanuvchilar: <b>${users.length}</b> (${linkedCount} ta bot ulangan)\n` +
    `💰 Umumiy balans (barcha userlar): <b>${money(totalBalance)}</b>\n` +
    `🛒 Umumiy sotuv: <b>${money(totalSales)}</b>\n` +
    `⏳ Kutilayotgan to'ldirish so'rovlari: <b>${pendingTopups.length}</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]) }
  );
});

bot.action('admin_pending', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.sendChatAction('typing');
  const orders = await getAllOrders();
  const pending = orders.filter(o => o.type === 'topup' && o.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (pending.length === 0) {
    return ctx.editMessageText('✅ Kutilayotgan so\'rovlar yo\'q.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]));
  }

  await ctx.editMessageText(`⏳ <b>Kutilayotgan so'rovlar (${pending.length} ta)</b>`, { parse_mode: 'HTML' });
  for (const o of pending.slice(0, 15)) {
    await ctx.replyWithHTML(
      `👤 ${esc(o.buyer)}\n💵 ${money(o.amount)}\n🕐 ${new Date(o.createdAt).toLocaleString('uz-UZ')}\n🆔 <code>${o.id}</code>`,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Tasdiqlash', `topup_ok:${o.id}`),
        Markup.button.callback('❌ Rad etish', `topup_no:${o.id}`)
      ])
    );
  }
});

bot.action('admin_users', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.sendChatAction('typing');
  const users = (await getAllUsers()).sort((a, b) => new Date(b.joined || 0) - new Date(a.joined || 0));
  if (users.length === 0) {
    return ctx.editMessageText('Foydalanuvchilar yo\'q.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]));
  }
  const lines = users.slice(0, 25).map(u =>
    `${u.telegramId ? '📲' : '🌐'} <b>${esc(u.username)}</b> — ${money(u.balance || 0)}`
  );
  await ctx.editMessageText(
    `👥 <b>Foydalanuvchilar (${users.length} ta, so'nggi 25 tasi)</b>\n📲 = bot ulangan, 🌐 = faqat sayt\n━━━━━━━━━━━━━━━\n` + lines.join('\n'),
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]) }
  );
});

bot.action('admin_products', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.sendChatAction('typing');
  const products = await listProducts();
  if (products.length === 0) {
    return ctx.editMessageText('Mahsulotlar yo\'q.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]));
  }
  const lines = products.map(p => `${p.icon || '📦'} <b>${esc(p.name)}</b> — ${p.isPremium === false ? 'Bepul' : money(p.price)}`);
  await ctx.editMessageText(
    `📦 <b>Mahsulotlar (${products.length} ta)</b>\n━━━━━━━━━━━━━━━\n` + lines.join('\n'),
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]) }
  );
});

bot.action('admin_broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  ctx.session.flow = 'broadcast_wait';
  await ctx.editMessageText(
    "📢 Hammaga yuboriladigan xabar matnini yozing.\n(Faqat botga ulangan foydalanuvchilarga boradi)",
    cancelKeyboard()
  );
});

bot.action(/^broadcast_confirm$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery();
  const text = ctx.session.broadcastText;
  if (!text) return ctx.answerCbQuery('Xabar topilmadi', { show_alert: true });
  await ctx.answerCbQuery('Yuborilmoqda...');
  const users = (await getAllUsers()).filter(u => u.telegramId);
  let sent = 0;
  for (const u of users) {
    try { await bot.telegram.sendMessage(u.telegramId, `📢 ${text}`); sent++; } catch (e) { /* bloklagan bo'lishi mumkin */ }
  }
  ctx.session.flow = null;
  ctx.session.broadcastText = null;
  await ctx.editMessageText(`✅ Xabar ${sent} ta foydalanuvchiga yuborildi.`);
});


/* ========================= matnli xabarlarni qayta ishlash (topup summasi) ========================= */
bot.on('text', async (ctx) => {
  if (ctx.session.flow === 'broadcast_wait' && isAdmin(ctx)) {
    const text = ctx.message.text;
    ctx.session.broadcastText = text;
    ctx.session.flow = null;
    return ctx.replyWithHTML(
      `📢 <b>Xabar oldindan ko'rish:</b>\n\n${esc(text)}\n\nYuborilsinmi?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ha, yuborish', 'broadcast_confirm')],
        [Markup.button.callback('✖️ Bekor qilish', 'cancel_flow')]
      ])
    );
  }

  if (ctx.session.flow === 'topup_amount') {
    const amount = parseInt((ctx.message.text || '').replace(/\D/g, ''), 10);
    if (!amount || amount < MIN_TOPUP || amount > MAX_TOPUP) {
      return ctx.replyWithHTML(`⚠️ Iltimos, ${money(MIN_TOPUP)} dan ${money(MAX_TOPUP)} gacha bo'lgan summa yuboring.\nMasalan: <code>100000</code>`, cancelKeyboard());
    }
    const user = await getUserByTelegramId(String(ctx.from.id));
    if (!user) return ctx.reply('❌ Hisobingiz ulanmagan.');

    const order = {
      id: 'o' + Date.now(),
      type: 'topup',
      buyer: user.username,
      amount,
      receiptImage: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      source: 'telegram'
    };
    await saveOrder(order);
    ctx.session.flow = null;

    await ctx.replyWithHTML(
      `✅ So'rov yuborildi!\nAdmin tasdiqlagach, balansingizga <b>${money(amount)}</b> qo'shiladi.\nHolatni "🧾 Buyurtmalarim" bo'limidan kuzatib borishingiz mumkin.`,
      mainMenu()
    );

    if (ADMIN_CHAT_ID) {
      bot.telegram.sendMessage(ADMIN_CHAT_ID,
        `💰 <b>Balans to'ldirish so'rovi</b>\n👤 ${esc(user.username)}\n💵 ${money(amount)}\n🆔 <code>${order.id}</code>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            Markup.button.callback('✅ Tasdiqlash', `topup_ok:${order.id}`),
            Markup.button.callback('❌ Rad etish', `topup_no:${order.id}`)
          ])
        }
      ).catch(() => {});
    }
  }
});

/* ========================= admin: topup tasdiqlash / rad etish ========================= */
bot.action(/^topup_ok:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo\'q');
  const orderId = ctx.match[1];
  const order = await getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Topilmadi', { show_alert: true });
  if (order.status !== 'pending') return ctx.answerCbQuery('Allaqachon ko\'rib chiqilgan');

  order.status = 'approved';
  await saveOrder(order);

  const user = await getUserByUsername(order.buyer);
  if (user) {
    user.balance = (user.balance || 0) + order.amount;
    await saveUser(user);
    if (user.telegramId) {
      bot.telegram.sendMessage(user.telegramId,
        `✅ <b>Balansingiz to'ldirildi:</b> +${money(order.amount)}\n💰 Yangi balans: <b>${money(user.balance)}</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }
  await ctx.answerCbQuery('Tasdiqlandi ✅');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n✅ TASDIQLANDI');
});

bot.action(/^topup_no:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Ruxsat yo\'q');
  const orderId = ctx.match[1];
  const order = await getOrder(orderId);
  if (!order) return ctx.answerCbQuery('Topilmadi', { show_alert: true });
  if (order.status !== 'pending') return ctx.answerCbQuery('Allaqachon ko\'rib chiqilgan');

  order.status = 'rejected';
  await saveOrder(order);

  const user = await getUserByUsername(order.buyer);
  if (user && user.telegramId) {
    bot.telegram.sendMessage(user.telegramId,
      `❌ Balans to'ldirish so'rovi rad etildi (${money(order.amount)}).\nSavol bo'lsa admin bilan bog'laning.`
    ).catch(() => {});
  }
  await ctx.answerCbQuery('Rad etildi');
  await ctx.editMessageText(ctx.callbackQuery.message.text + '\n\n❌ RAD ETILDI');
});

/* ========================= bot komandalar menyusi ========================= */
bot.telegram.setMyCommands([
  { command: 'start', description: 'Botni ishga tushirish' },
  { command: 'menu', description: 'Asosiy menyu' },
  { command: 'help', description: 'Yordam' }
]).catch(() => {});

if (ADMIN_CHAT_ID) {
  bot.telegram.setMyCommands(
    [
      { command: 'start', description: 'Botni ishga tushirish' },
      { command: 'menu', description: 'Asosiy menyu' },
      { command: 'help', description: 'Yordam' },
      { command: 'admin', description: 'Admin panel' }
    ],
    { scope: { type: 'chat', chat_id: Number(ADMIN_CHAT_ID) } }
  ).catch(() => {});
}

/* ========================= server (webhook) ========================= */
const app = express();
app.use(express.json());

const externalUrl = process.env.RENDER_EXTERNAL_URL;
if (externalUrl) {
  const webhookPath = '/telegraf/' + BOT_TOKEN;
  app.use(bot.webhookCallback(webhookPath));
  bot.telegram.setWebhook(`${externalUrl}${webhookPath}`).then(() => {
    console.log('Webhook o\'rnatildi:', `${externalUrl}${webhookPath}`);
  }).catch(err => console.error('Webhook xatosi:', err));
} else {
  bot.launch();
  console.log('Bot polling rejimida ishga tushdi (lokal test)');
}

app.get('/', (req, res) => res.send('UzForum bot ishlayapti ✅'));
app.listen(PORT, () => console.log('Server ishga tushdi, port:', PORT));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
