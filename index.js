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
const SITE_API_KEY = process.env.SITE_API_KEY;
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
async function saveProductRecord(product) {
  await kvSet('product:' + product.id, JSON.stringify(product));
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

const CATEGORIES = ['Sborkalar', 'Plaginlar', 'Klientlar', 'Modlar', 'Resurspacklar'];
const PROMO_LIST_KEY = 'uzforum_promo_codes';

async function getPromoCodes() {
  const raw = await kvGet(PROMO_LIST_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function savePromoCodes(list) {
  await kvSet(PROMO_LIST_KEY, JSON.stringify(list));
}
function findPromo(list, code) {
  return list.find(p => p.code.toLowerCase() === String(code || '').toLowerCase());
}
function promoLabel(p) {
  return p.type === 'percent' ? `${p.value}%` : money(p.value);
}
function applyPromoDiscount(price, promo) {
  if (!promo) return 0;
  const raw = promo.type === 'percent' ? Math.round(price * promo.value / 100) : promo.value;
  return Math.min(raw, price);
}

function money(n) {
  return (n || 0).toLocaleString('uz-UZ') + " so'm";
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const EXTRA_ADMINS_KEY = 'uzforum_extra_admins';
async function getExtraAdminIds() {
  const raw = await kvGet(EXTRA_ADMINS_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function saveExtraAdminIds(list) {
  await kvSet(EXTRA_ADMINS_KEY, JSON.stringify(list));
}
async function getAllAdminIds() {
  const extra = await getExtraAdminIds();
  const ids = extra.map(a => String(a.id));
  if (ADMIN_CHAT_ID) ids.unshift(String(ADMIN_CHAT_ID));
  return [...new Set(ids)];
}
async function isAdmin(ctx) {
  const id = String(ctx.from.id);
  if (ADMIN_CHAT_ID && id === String(ADMIN_CHAT_ID)) return true;
  const extra = await getExtraAdminIds();
  return extra.some(a => String(a.id) === id);
}
function isMainAdmin(ctx) {
  return !!ADMIN_CHAT_ID && String(ctx.from.id) === String(ADMIN_CHAT_ID);
}
async function notifyAdmins(text, extra) {
  const ids = await getAllAdminIds();
  return Promise.all(ids.map(id => bot.telegram.sendMessage(id, text, extra).catch(() => {})));
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
  "📦 Mahsulot sotib olish — kategoriya bo'yicha katalogdan xarid, promo-kod bilan chegirma olish mumkin\n" +
  "🧾 Buyurtmalarim — buyurtmalar tarixi\n" +
  "🆘 Yordam — adminga to'g'ridan-to'g'ri yozing, u shu yerda javob beradi\n"
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
  ctx.session.attachProductId = null;
  ctx.session.buyPromo = null;
  ctx.session.newProduct = null;
  ctx.session.newPromo = null;
  ctx.session.adjustUsername = null;
  ctx.session.adjustMode = null;
  await ctx.answerCbQuery('Bekor qilindi');
  await ctx.editMessageText('✖️ Bekor qilindi.');
});

/* ========================= 📦 Mahsulot sotib olish (kategoriya bo'yicha) ========================= */
bot.hears('📦 Mahsulot sotib olish', async (ctx) => {
  const user = await requireLinkedUser(ctx);
  if (!user) return;
  const buttons = CATEGORIES.map(c => [Markup.button.callback(`📂 ${c}`, `browse_cat:${c}`)]);
  buttons.push([Markup.button.callback('🔎 Barcha mahsulotlar', 'browse_cat:all')]);
  await ctx.replyWithHTML(`🛒 <b>Kategoriya tanlang</b>\n💰 Joriy balans: <b>${money(user.balance || 0)}</b>`, Markup.inlineKeyboard(buttons));
});

bot.action(/^browse_cat:(.+)$/, async (ctx) => {
  const user = await getUserByTelegramId(String(ctx.from.id));
  if (!user) return ctx.answerCbQuery('Hisob ulanmagan');
  const cat = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.sendChatAction('typing');
  let products = (await listProducts()).filter(p => p.isPremium !== false && p.price > 0);
  if (cat !== 'all') products = products.filter(p => p.cat === cat);
  if (products.length === 0) {
    return ctx.editMessageText('🙁 Bu bo\'limda hozircha mahsulot yo\'q.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'back_to_cats')]]));
  }
  const buttons = products.slice(0, 30).map(p => [
    Markup.button.callback(`${p.icon || '📦'} ${p.name} — ${money(p.price)}`, `buy:${p.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Orqaga', 'back_to_cats')]);
  await ctx.editMessageText(`${cat === 'all' ? '🔎 Barcha mahsulotlar' : '📂 ' + cat}\n\nBirini tanlang:`, Markup.inlineKeyboard(buttons));
});

bot.action('back_to_cats', async (ctx) => {
  const user = await getUserByTelegramId(String(ctx.from.id));
  if (!user) return ctx.answerCbQuery('Hisob ulanmagan');
  await ctx.answerCbQuery();
  const buttons = CATEGORIES.map(c => [Markup.button.callback(`📂 ${c}`, `browse_cat:${c}`)]);
  buttons.push([Markup.button.callback('🔎 Barcha mahsulotlar', 'browse_cat:all')]);
  await ctx.editMessageText(`🛒 <b>Kategoriya tanlang</b>\n💰 Joriy balans: <b>${money(user.balance || 0)}</b>`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^buy:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const user = await getUserByTelegramId(String(ctx.from.id));
  if (!user) return ctx.answerCbQuery('Hisob ulanmagan');
  const product = await getProduct(productId);
  if (!product) return ctx.answerCbQuery('Mahsulot topilmadi', { show_alert: true });

  ctx.session.pendingProductId = productId;
  ctx.session.buyPromo = null;

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
      [Markup.button.callback('🎟 Promo-kod kiritish', `buy_promo:${product.id}`)],
      [Markup.button.callback('✖️ Bekor qilish', 'cancel_flow')]
    ])
  );
});

bot.action(/^buy_promo:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  ctx.session.flow = 'buy_promo_wait';
  ctx.session.pendingProductId = productId;
  await ctx.answerCbQuery();
  await ctx.editMessageText('🎟 Promo-kodni yozing:', cancelKeyboard());
});

bot.action(/^confirm_buy:(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const user = await getUserByTelegramId(String(ctx.from.id));
  if (!user) return ctx.answerCbQuery('Hisob ulanmagan');
  const product = await getProduct(productId);
  if (!product) return ctx.answerCbQuery('Mahsulot topilmadi', { show_alert: true });

  const promo = ctx.session.buyPromo || null;
  const discount = promo ? applyPromoDiscount(product.price, promo) : 0;
  const finalPrice = Math.max(0, product.price - discount);

  if ((user.balance || 0) < finalPrice) {
    await ctx.answerCbQuery();
    return ctx.editMessageText('❌ Balansingiz yetarli emas.');
  }

  user.balance = (user.balance || 0) - finalPrice;
  const order = {
    id: 'o' + Date.now(),
    type: 'purchase',
    buyer: user.username,
    items: [{ name: product.name, cat: product.cat, qty: 1, total: finalPrice, free: false }],
    subtotal: product.price,
    discount,
    promoCode: promo ? promo.code : null,
    total: finalPrice,
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
  ctx.session.pendingProductId = null;
  ctx.session.buyPromo = null;

  await ctx.answerCbQuery('Xarid amalga oshirildi ✅');

  const discountLine = discount > 0 ? `🎟 Chegirma (${esc(promo.code)}): -${money(discount)}\n` : '';

  if (product.fileId) {
    await ctx.replyWithHTML(
      `✅ <b>"${esc(product.name)}"</b> sotib olindi!\n${discountLine}💰 Yangi balans: <b>${money(user.balance)}</b>\n\n📁 Faylingiz quyida — yuklab oling:`
    );
    await ctx.replyWithDocument(product.fileId, { caption: `📦 ${product.name}` }).catch(async () => {
      await ctx.reply('⚠️ Faylni yuborishda xatolik. Admin siz bilan qo\'lda bog\'lanadi.');
      notifyAdmins(
        `⚠️ <b>Fayl avtomatik yuborilmadi</b>\n👤 ${esc(user.username)}\n📦 ${esc(product.name)}\n🆔 <code>${order.id}</code>\nIltimos faylni qo'lda yuboring.`,
        { parse_mode: 'HTML' }
      );
    });
  } else {
    await ctx.editMessageText(
      `✅ <b>"${esc(product.name)}"</b> sotib olindi!\n${discountLine}💰 Yangi balans: <b>${money(user.balance)}</b>\n\nAdmin tez orada siz bilan bog'lanib, mahsulotni yetkazib beradi.`,
      { parse_mode: 'HTML' }
    );
  }

  notifyAdmins(
    `🛒 <b>Yangi buyurtma (Telegram)</b>\n👤 ${esc(user.username)}\n📦 ${esc(product.name)}\n💵 ${money(finalPrice)}${discount > 0 ? ` (chegirma: -${money(discount)})` : ''}\n🆔 <code>${order.id}</code>\n\n${product.fileId ? '📁 Fayl avtomatik yuborildi.' : "Mijozga mahsulotni qo'lda yetkazib bering."}`,
    { parse_mode: 'HTML' }
  );
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

/* ========================= 🆘 Yordam (ikki tomonlama chat) ========================= */
bot.hears('🆘 Yordam', async (ctx) => {
  ctx.session.flow = 'support_wait';
  await ctx.replyWithHTML('🆘 Savolingizni yozing — admin shu yerga javob yozadi.', cancelKeyboard());
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

function adminMenuKeyboard(mainAdmin) {
  const rows = [
    [Markup.button.callback('📊 Statistika', 'admin_stats')],
    [Markup.button.callback('⏳ Kutilayotgan so\'rovlar', 'admin_pending')],
    [Markup.button.callback('👥 Foydalanuvchilar', 'admin_users')],
    [Markup.button.callback('🔍 Foydalanuvchi qidirish', 'admin_search_user')],
    [Markup.button.callback('📦 Mahsulotlar', 'admin_products')],
    [Markup.button.callback('➕ Mahsulot qo\'shish', 'admin_add_product')],
    [Markup.button.callback('🗑 Mahsulotni o\'chirish', 'admin_delete_product')],
    [Markup.button.callback('📁 Mahsulotga fayl biriktirish', 'admin_attach_file')],
    [Markup.button.callback('🎟 Promo-kodlar', 'admin_promo')],
    [Markup.button.callback('📢 Hammaga xabar yuborish', 'admin_broadcast')]
  ];
  if (mainAdmin) rows.push([Markup.button.callback('🛡 Adminlar boshqaruvi', 'admin_manage_admins')]);
  return Markup.inlineKeyboard(rows);
}

bot.command('admin', async (ctx) => {
  if (!(await isAdmin(ctx))) return;
  await ctx.replyWithHTML('⚙️ <b>Admin panel</b>\n\nKerakli bo\'limni tanlang:', adminMenuKeyboard(isMainAdmin(ctx)));
});

bot.action('admin_menu', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.editMessageText('⚙️ Admin panel\n\nKerakli bo\'limni tanlang:', adminMenuKeyboard(isMainAdmin(ctx)));
});

/* ========================= 🛡 adminlar boshqaruvi (faqat bosh admin) ========================= */
async function renderAdminManagement() {
  const extra = await getExtraAdminIds();
  const lines = extra.length
    ? extra.map(a => `👤 <code>${esc(a.id)}</code>${a.username ? ' (@' + esc(a.username) + ')' : ''}`).join('\n')
    : "Hozircha qo'shimcha admin yo'q.";
  const buttons = [[Markup.button.callback('➕ Yangi admin qo\'shish', 'admin_add_admin')]];
  extra.forEach(a => buttons.push([Markup.button.callback(`🗑 ${a.username ? '@' + a.username : a.id} ni o'chirish`, `admin_remove_admin:${a.id}`)]));
  buttons.push([Markup.button.callback('◀️ Orqaga', 'admin_menu')]);
  return {
    text: `🛡 <b>Adminlar boshqaruvi</b>\n━━━━━━━━━━━━━━━\n👑 Bosh admin: <code>${esc(ADMIN_CHAT_ID || '—')}</code>\n\n<b>Qo'shimcha adminlar:</b>\n${lines}`,
    buttons
  };
}

bot.action('admin_manage_admins', async (ctx) => {
  if (!isMainAdmin(ctx)) return ctx.answerCbQuery('Faqat bosh admin uchun', { show_alert: true });
  await ctx.answerCbQuery();
  const { text, buttons } = await renderAdminManagement();
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action('admin_add_admin', async (ctx) => {
  if (!isMainAdmin(ctx)) return ctx.answerCbQuery('Faqat bosh admin uchun', { show_alert: true });
  await ctx.answerCbQuery();
  ctx.session.flow = 'add_admin_wait';
  await ctx.editMessageText(
    "➕ Yangi adminni qo'shish uchun do'stingizning Telegram xabarini shu yerga <b>forward</b> qiling, yoki uning raqamli Telegram ID'sini yozing.\n\n" +
    "<i>ID bilmasa, do'stingiz botga /start yozib, keyin sizga shu yerdan biror xabarini forward qilsin.</i>",
    { parse_mode: 'HTML', ...cancelKeyboard() }
  );
});

bot.action(/^admin_remove_admin:(.+)$/, async (ctx) => {
  if (!isMainAdmin(ctx)) return ctx.answerCbQuery('Faqat bosh admin uchun', { show_alert: true });
  const id = ctx.match[1];
  const extra = await getExtraAdminIds();
  const next = extra.filter(a => String(a.id) !== String(id));
  await saveExtraAdminIds(next);
  await ctx.answerCbQuery('Admin o\'chirildi');
  const { text, buttons } = await renderAdminManagement();
  await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action('admin_stats', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
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
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
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
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
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
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.sendChatAction('typing');
  const products = await listProducts();
  if (products.length === 0) {
    return ctx.editMessageText('Mahsulotlar yo\'q.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]));
  }
  const lines = products.map(p =>
    `${p.icon || '📦'} <b>${esc(p.name)}</b> — ${p.isPremium === false ? 'Bepul' : money(p.price)} ${p.fileId ? '📁' : '⚠️ faylsiz'}`
  );
  await ctx.editMessageText(
    `📦 <b>Mahsulotlar (${products.length} ta)</b>\n📁 = fayl biriktirilgan, ⚠️ = fayl yo'q (qo'lda yuboriladi)\n━━━━━━━━━━━━━━━\n` + lines.join('\n'),
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]) }
  );
});

/* ========================= 📁 mahsulotga fayl biriktirish ========================= */
bot.action('admin_attach_file', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  await ctx.sendChatAction('typing');
  const products = await listProducts();
  if (products.length === 0) {
    return ctx.editMessageText('Mahsulotlar yo\'q.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]));
  }
  const buttons = products.slice(0, 40).map(p => [
    Markup.button.callback(`${p.fileId ? '📁' : '⚠️'} ${p.icon || '📦'} ${p.name}`, `attach_pick:${p.id}`)
  ]);
  buttons.push([Markup.button.callback('◀️ Orqaga', 'admin_menu')]);
  await ctx.editMessageText(
    '📁 <b>Qaysi mahsulotga fayl biriktiramiz?</b>\n\nTanlang, so\'ng faylni yuborasiz — u shu mahsulot sotib olinganda xaridorga avtomatik yuboriladi.',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
});

bot.action(/^attach_pick:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  const productId = ctx.match[1];
  const product = await getProduct(productId);
  if (!product) return ctx.answerCbQuery('Topilmadi', { show_alert: true });
  ctx.session.flow = 'attach_file_wait';
  ctx.session.attachProductId = productId;
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `📁 <b>"${esc(product.name)}"</b> uchun endi faylni yuboring.\n\n<i>Faylni oddiy "Document" (📎) ko'rinishida yuboring, rasm sifatida emas — aks holda sifat pasayishi mumkin.</i>`,
    { parse_mode: 'HTML', ...cancelKeyboard() }
  );
});

bot.on('document', async (ctx) => {
  if (!((await isAdmin(ctx)) && ctx.session.flow === 'attach_file_wait' && ctx.session.attachProductId)) return;
  const productId = ctx.session.attachProductId;
  const product = await getProduct(productId);
  if (!product) {
    ctx.session.flow = null;
    ctx.session.attachProductId = null;
    return ctx.reply('❌ Mahsulot topilmadi.');
  }
  product.fileId = ctx.message.document.file_id;
  product.fileName = ctx.message.document.file_name || product.name;
  await saveProductRecord(product);

  ctx.session.flow = null;
  ctx.session.attachProductId = null;

  await ctx.replyWithHTML(
    `✅ Fayl <b>"${esc(product.name)}"</b> ga biriktirildi!\n📄 ${esc(product.fileName)}\n\nEndi bu mahsulot sotib olinganda fayl avtomatik yuboriladi.`,
    mainMenu()
  );
});

/* ========================= 🔍 foydalanuvchi qidirish + balansni sozlash ========================= */
bot.action('admin_search_user', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  ctx.session.flow = 'search_user_wait';
  await ctx.editMessageText('🔍 Qidirilayotgan foydalanuvchi username\'ini yozing:', cancelKeyboard());
});

bot.action(/^adj_balance:(add|sub):(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  const [, mode, username] = ctx.match;
  ctx.session.flow = 'adjust_balance_wait';
  ctx.session.adjustUsername = username;
  ctx.session.adjustMode = mode;
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `💰 <b>${esc(username)}</b> balansiga ${mode === 'add' ? "qo'shiladigan" : 'ayiriladigan'} summani yozing (so'm):`,
    { parse_mode: 'HTML', ...cancelKeyboard() }
  );
});

/* ========================= ➕ mahsulot qo'shish ========================= */
bot.action('admin_add_product', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  ctx.session.newProduct = {};
  const buttons = CATEGORIES.map(c => [Markup.button.callback(c, `newprod_cat:${c}`)]);
  buttons.push([Markup.button.callback('✖️ Bekor qilish', 'cancel_flow')]);
  await ctx.editMessageText('➕ <b>Yangi mahsulot — kategoriyani tanlang:</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^newprod_cat:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  ctx.session.newProduct = { cat: ctx.match[1] };
  ctx.session.flow = 'newprod_name';
  await ctx.answerCbQuery();
  await ctx.editMessageText(`📂 Kategoriya: <b>${esc(ctx.match[1])}</b>\n\n✍️ Mahsulot nomini yozing:`, { parse_mode: 'HTML', ...cancelKeyboard() });
});

/* ========================= 🗑 mahsulotni o'chirish ========================= */
bot.action('admin_delete_product', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const products = await listProducts();
  if (products.length === 0) {
    return ctx.editMessageText('Mahsulotlar yo\'q.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Orqaga', 'admin_menu')]]));
  }
  const buttons = products.slice(0, 40).map(p => [Markup.button.callback(`🗑 ${p.icon || '📦'} ${p.name}`, `delprod_pick:${p.id}`)]);
  buttons.push([Markup.button.callback('◀️ Orqaga', 'admin_menu')]);
  await ctx.editMessageText('🗑 <b>Qaysi mahsulotni o\'chiramiz?</b>', { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^delprod_pick:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  const product = await getProduct(ctx.match[1]);
  if (!product) return ctx.answerCbQuery('Topilmadi', { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `⚠️ <b>"${esc(product.name)}"</b> ni butunlay o'chirishga ishonchingiz komilmi? Bu amalni ortga qaytarib bo'lmaydi.`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Ha, o\'chirish', `delprod_confirm:${product.id}`)],
      [Markup.button.callback('✖️ Bekor qilish', 'cancel_flow')]
    ]) }
  );
});

bot.action(/^delprod_confirm:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  await kvDelete('product:' + ctx.match[1]);
  await ctx.answerCbQuery('O\'chirildi');
  await ctx.editMessageText('✅ Mahsulot o\'chirildi.', Markup.inlineKeyboard([[Markup.button.callback('◀️ Admin panel', 'admin_menu')]]));
});

/* ========================= 🎟 promo-kodlar ========================= */
bot.action('admin_promo', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const promos = await getPromoCodes();
  const lines = promos.length
    ? promos.map(p => `<code>${esc(p.code)}</code> — ${promoLabel(p)} ${p.active ? '✅' : '⛔️'}`).join('\n')
    : "Hozircha promo-kod yo'q.";
  const buttons = [[Markup.button.callback('➕ Yangi promo-kod', 'promo_add')]];
  promos.forEach(p => buttons.push([
    Markup.button.callback(`${p.active ? '⛔️ O\'chirish' : '✅ Faollashtirish'} ${p.code}`, `promo_toggle:${p.code}`),
    Markup.button.callback('🗑', `promo_delete:${p.code}`)
  ]));
  buttons.push([Markup.button.callback('◀️ Orqaga', 'admin_menu')]);
  await ctx.editMessageText(`🎟 <b>Promo-kodlar</b>\n━━━━━━━━━━━━━━━\n${lines}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action('promo_add', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  ctx.session.newPromo = {};
  ctx.session.flow = 'promo_code_wait';
  await ctx.answerCbQuery();
  await ctx.editMessageText('🎟 Yangi promo-kod matnini yozing (masalan: YOZ2026):', cancelKeyboard());
});

bot.action(/^promo_toggle:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  const promos = await getPromoCodes();
  const p = findPromo(promos, ctx.match[1]);
  if (!p) return ctx.answerCbQuery('Topilmadi', { show_alert: true });
  p.active = !p.active;
  await savePromoCodes(promos);
  await ctx.answerCbQuery(p.active ? 'Faollashtirildi' : 'O\'chirildi');
  const lines = promos.map(x => `<code>${esc(x.code)}</code> — ${promoLabel(x)} ${x.active ? '✅' : '⛔️'}`).join('\n');
  const buttons = [[Markup.button.callback('➕ Yangi promo-kod', 'promo_add')]];
  promos.forEach(x => buttons.push([
    Markup.button.callback(`${x.active ? '⛔️ O\'chirish' : '✅ Faollashtirish'} ${x.code}`, `promo_toggle:${x.code}`),
    Markup.button.callback('🗑', `promo_delete:${x.code}`)
  ]));
  buttons.push([Markup.button.callback('◀️ Orqaga', 'admin_menu')]);
  await ctx.editMessageText(`🎟 <b>Promo-kodlar</b>\n━━━━━━━━━━━━━━━\n${lines}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^promo_delete:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  const promos = await getPromoCodes();
  const idx = promos.findIndex(p => p.code.toLowerCase() === ctx.match[1].toLowerCase());
  if (idx !== -1) promos.splice(idx, 1);
  await savePromoCodes(promos);
  await ctx.answerCbQuery('O\'chirildi');
  const lines = promos.length
    ? promos.map(p => `<code>${esc(p.code)}</code> — ${promoLabel(p)} ${p.active ? '✅' : '⛔️'}`).join('\n')
    : "Hozircha promo-kod yo'q.";
  const buttons = [[Markup.button.callback('➕ Yangi promo-kod', 'promo_add')]];
  promos.forEach(p => buttons.push([
    Markup.button.callback(`${p.active ? '⛔️ O\'chirish' : '✅ Faollashtirish'} ${p.code}`, `promo_toggle:${p.code}`),
    Markup.button.callback('🗑', `promo_delete:${p.code}`)
  ]));
  buttons.push([Markup.button.callback('◀️ Orqaga', 'admin_menu')]);
  await ctx.editMessageText(`🎟 <b>Promo-kodlar</b>\n━━━━━━━━━━━━━━━\n${lines}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
});

bot.action('admin_broadcast', async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  ctx.session.flow = 'broadcast_wait';
  await ctx.editMessageText(
    "📢 Hammaga yuboriladigan xabar matnini yozing.\n(Faqat botga ulangan foydalanuvchilarga boradi)",
    cancelKeyboard()
  );
});

bot.action(/^broadcast_confirm$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
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
  /* ---- admin support javobi (forward qilingan xabarga reply) ---- */
  if ((await isAdmin(ctx)) && ctx.message.reply_to_message) {
    const mapRaw = await kvGet('supportmap:' + ctx.chat.id + ':' + ctx.message.reply_to_message.message_id);
    if (mapRaw) {
      const targetId = mapRaw;
      await bot.telegram.sendMessage(targetId, `💬 <b>Admin javobi:</b>\n\n${esc(ctx.message.text)}`, { parse_mode: 'HTML' }).catch(() => {});
      return ctx.reply('✅ Javob yuborildi.');
    }
  }

  if (ctx.session.flow === 'support_wait') {
    ctx.session.flow = null;
    await ctx.reply('✅ Xabaringiz adminga yuborildi. Tez orada javob berishadi.', mainMenu());
    const adminIds = await getAllAdminIds();
    for (const adminId of adminIds) {
      const sent = await bot.telegram.sendMessage(
        adminId,
        `🆘 <b>Yordam so'rovi</b>\n👤 @${esc(ctx.from.username || '—')} (<code>${ctx.from.id}</code>)\n\n${esc(ctx.message.text)}\n\n<i>Javob berish uchun shu xabarga "Reply" qiling.</i>`,
        { parse_mode: 'HTML' }
      ).catch(() => null);
      if (sent) await kvSet('supportmap:' + adminId + ':' + sent.message_id, String(ctx.from.id));
    }
    return;
  }

  if (ctx.session.flow === 'broadcast_wait' && (await isAdmin(ctx))) {
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

  if (ctx.session.flow === 'buy_promo_wait') {
    const code = ctx.message.text.trim();
    const productId = ctx.session.pendingProductId;
    const product = productId ? await getProduct(productId) : null;
    if (!product) { ctx.session.flow = null; return ctx.reply('❌ Mahsulot topilmadi, qaytadan urinib ko\'ring.', mainMenu()); }
    const promos = await getPromoCodes();
    const promo = findPromo(promos, code);
    if (!promo || !promo.active) {
      return ctx.replyWithHTML(`❌ Bunday faol promo-kod topilmadi. Qaytadan yozing yoki bekor qiling.`, cancelKeyboard());
    }
    ctx.session.flow = null;
    ctx.session.buyPromo = promo;
    const discount = applyPromoDiscount(product.price, promo);
    const finalPrice = Math.max(0, product.price - discount);
    return ctx.replyWithHTML(
      `🎟 Promo-kod qabul qilindi: <b>${esc(promo.code)}</b> (-${promoLabel(promo)})\n\n${product.icon || '📦'} ${product.name}\n💵 <s>${money(product.price)}</s> → <b>${money(finalPrice)}</b>\n\nXaridni tasdiqlaysizmi?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ha, sotib olaman', `confirm_buy:${product.id}`)],
        [Markup.button.callback('✖️ Bekor qilish', 'cancel_flow')]
      ])
    );
  }

  /* ---- bosh admin: yangi admin qo'shish ---- */
  if (ctx.session.flow === 'add_admin_wait' && isMainAdmin(ctx)) {
    ctx.session.flow = null;
    let newId = null, newUsername = null;
    if (ctx.message.forward_from) {
      newId = String(ctx.message.forward_from.id);
      newUsername = ctx.message.forward_from.username || null;
    } else {
      const digits = (ctx.message.text || '').replace(/\D/g, '');
      if (digits) newId = digits;
    }
    if (!newId) {
      return ctx.replyWithHTML(
        "⚠️ ID aniqlanmadi. Do'stingizning xabarini forward qiling yoki uning raqamli Telegram ID'sini yozing.",
        cancelKeyboard()
      );
    }
    if (String(newId) === String(ADMIN_CHAT_ID)) {
      return ctx.replyWithHTML('⚠️ Bu allaqachon bosh admin.', mainMenu());
    }
    const extra = await getExtraAdminIds();
    if (extra.some(a => String(a.id) === String(newId))) {
      return ctx.replyWithHTML('⚠️ Bu foydalanuvchi allaqachon admin.', mainMenu());
    }
    extra.push({ id: newId, username: newUsername });
    await saveExtraAdminIds(extra);
    await ctx.replyWithHTML(
      `✅ Yangi admin qo'shildi: <code>${esc(newId)}</code>${newUsername ? ' (@' + esc(newUsername) + ')' : ''}`,
      mainMenu()
    );
    bot.telegram.setMyCommands(
      [
        { command: 'start', description: 'Botni ishga tushirish' },
        { command: 'menu', description: 'Asosiy menyu' },
        { command: 'help', description: 'Yordam' },
        { command: 'admin', description: 'Admin panel' }
      ],
      { scope: { type: 'chat', chat_id: Number(newId) } }
    ).catch(() => {});
    bot.telegram.sendMessage(
      newId,
      "🛡 <b>Tabriklaymiz!</b> Siz UzForum botida admin etib tayinlandingiz.\n/admin buyrug'i orqali panelni oching.",
      { parse_mode: 'HTML' }
    ).catch(() => {});
    return;
  }

  /* ---- admin: foydalanuvchi qidirish ---- */
  if (ctx.session.flow === 'search_user_wait' && (await isAdmin(ctx))) {
    ctx.session.flow = null;
    const uname = ctx.message.text.trim();
    const user = await getUserByUsername(uname);
    if (!user) return ctx.reply('❌ Bunday foydalanuvchi topilmadi.', mainMenu());
    const orders = await listOrdersByUsername(user.username);
    await ctx.replyWithHTML(
      `👤 <b>${esc(user.username)}</b>\n` +
      `💰 Balans: <b>${money(user.balance || 0)}</b>\n` +
      `📲 Bot: ${user.telegramId ? `ulangan (<code>${user.telegramId}</code>)` : 'ulanmagan'}\n` +
      `🧾 Buyurtmalar soni: ${orders.length}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Balans qo\'shish', `adj_balance:add:${user.username}`), Markup.button.callback('➖ Balans ayirish', `adj_balance:sub:${user.username}`)],
        [Markup.button.callback('◀️ Admin panel', 'admin_menu')]
      ])
    );
    return;
  }

  if (ctx.session.flow === 'adjust_balance_wait' && (await isAdmin(ctx))) {
    const amount = parseInt((ctx.message.text || '').replace(/\D/g, ''), 10);
    if (!amount || amount <= 0) {
      return ctx.replyWithHTML('⚠️ Musbat son yuboring. Masalan: <code>50000</code>', cancelKeyboard());
    }
    const username = ctx.session.adjustUsername;
    const mode = ctx.session.adjustMode;
    ctx.session.flow = null; ctx.session.adjustUsername = null; ctx.session.adjustMode = null;

    const user = await getUserByUsername(username);
    if (!user) return ctx.reply('❌ Foydalanuvchi topilmadi.', mainMenu());
    user.balance = Math.max(0, (user.balance || 0) + (mode === 'add' ? amount : -amount));
    await saveUser(user);
    await ctx.replyWithHTML(`✅ <b>${esc(user.username)}</b> balansi yangilandi: <b>${money(user.balance)}</b>`, mainMenu());
    if (user.telegramId) {
      bot.telegram.sendMessage(user.telegramId,
        `💰 Admin balansingizni ${mode === 'add' ? "to'ldirdi" : 'kamaytirdi'}: ${mode === 'add' ? '+' : '-'}${money(amount)}\nYangi balans: <b>${money(user.balance)}</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return;
  }

  /* ---- admin: yangi mahsulot qo'shish (bosqichma-bosqich) ---- */
  if (ctx.session.flow === 'newprod_name' && (await isAdmin(ctx))) {
    ctx.session.newProduct.name = ctx.message.text.trim();
    ctx.session.flow = 'newprod_price';
    return ctx.replyWithHTML('💵 Narxini yozing (so\'m). Bepul bo\'lsa <code>0</code> yozing:', cancelKeyboard());
  }
  if (ctx.session.flow === 'newprod_price' && (await isAdmin(ctx))) {
    const price = parseInt((ctx.message.text || '').replace(/\D/g, ''), 10) || 0;
    ctx.session.newProduct.price = price;
    ctx.session.flow = 'newprod_desc';
    return ctx.replyWithHTML('📝 Qisqacha tavsif yozing:', cancelKeyboard());
  }
  if (ctx.session.flow === 'newprod_desc' && (await isAdmin(ctx))) {
    ctx.session.newProduct.desc = ctx.message.text.trim();
    ctx.session.flow = 'newprod_icon';
    return ctx.replyWithHTML('🗺️ Emoji ikonka yuboring (masalan 🗺️), yoki <code>-</code> deb yozing:', cancelKeyboard());
  }
  if (ctx.session.flow === 'newprod_icon' && (await isAdmin(ctx))) {
    const iconText = ctx.message.text.trim();
    const p = ctx.session.newProduct;
    const product = {
      id: 'p' + Date.now(),
      cat: p.cat,
      name: p.name,
      ver: '1.16–1.21',
      price: p.price,
      icon: iconText === '-' ? '📦' : iconText.slice(0, 4),
      imageData: null,
      desc: p.desc || "Tavsif kiritilmagan.",
      isPremium: p.price > 0,
      features: [],
      fileId: null,
      fileName: null
    };
    await saveProductRecord(product);
    ctx.session.flow = null;
    ctx.session.newProduct = null;
    await ctx.replyWithHTML(
      `✅ <b>"${esc(product.name)}"</b> qo'shildi!\n📂 ${esc(product.cat)} · 💵 ${product.price > 0 ? money(product.price) : 'Bepul'}\n\n📁 Faylni "Mahsulotga fayl biriktirish" orqali qo'shishni unutmang.`,
      mainMenu()
    );
    return;
  }

  /* ---- admin: promo-kod yaratish ---- */
  if (ctx.session.flow === 'promo_code_wait' && (await isAdmin(ctx))) {
    const code = ctx.message.text.trim().toUpperCase();
    const promos = await getPromoCodes();
    if (findPromo(promos, code)) {
      return ctx.replyWithHTML('⚠️ Bu kod allaqachon mavjud. Boshqa kod yozing:', cancelKeyboard());
    }
    ctx.session.newPromo = { code };
    ctx.session.flow = null;
    return ctx.replyWithHTML(
      `🎟 Kod: <b>${esc(code)}</b>\n\nChegirma turini tanlang:`,
      Markup.inlineKeyboard([
        [Markup.button.callback('% Foizli chegirma', 'promo_type:percent')],
        [Markup.button.callback('so\'m Belgilangan summa', 'promo_type:fixed')],
        [Markup.button.callback('✖️ Bekor qilish', 'cancel_flow')]
      ])
    );
  }
  if (ctx.session.flow === 'promo_value_wait' && (await isAdmin(ctx))) {
    const value = parseInt((ctx.message.text || '').replace(/\D/g, ''), 10);
    if (!value || value <= 0) {
      return ctx.replyWithHTML('⚠️ Musbat son yuboring:', cancelKeyboard());
    }
    const promo = ctx.session.newPromo;
    promo.value = value;
    promo.active = true;
    const promos = await getPromoCodes();
    promos.push(promo);
    await savePromoCodes(promos);
    ctx.session.flow = null;
    ctx.session.newPromo = null;
    await ctx.replyWithHTML(`✅ Promo-kod <b>${esc(promo.code)}</b> yaratildi: -${promoLabel(promo)}`, mainMenu());
    return;
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

    notifyAdmins(
      `💰 <b>Balans to'ldirish so'rovi</b>\n👤 ${esc(user.username)}\n💵 ${money(amount)}\n🆔 <code>${order.id}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          Markup.button.callback('✅ Tasdiqlash', `topup_ok:${order.id}`),
          Markup.button.callback('❌ Rad etish', `topup_no:${order.id}`)
        ])
      }
    );
  }
});

bot.action(/^promo_type:(percent|fixed)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery();
  if (!ctx.session.newPromo) return ctx.answerCbQuery('Sessiya tugagan, qaytadan boshlang', { show_alert: true });
  ctx.session.newPromo.type = ctx.match[1];
  ctx.session.flow = 'promo_value_wait';
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    ctx.match[1] === 'percent' ? '📉 Necha foiz chegirma? (masalan 10):' : '💵 Necha so\'m chegirma?',
    cancelKeyboard()
  );
});

/* ========================= admin: topup tasdiqlash / rad etish ========================= */
bot.action(/^topup_ok:(.+)$/, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery('Ruxsat yo\'q');
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
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery('Ruxsat yo\'q');
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

(async () => {
  const adminIds = await getAllAdminIds();
  for (const id of adminIds) {
    bot.telegram.setMyCommands(
      [
        { command: 'start', description: 'Botni ishga tushirish' },
        { command: 'menu', description: 'Asosiy menyu' },
        { command: 'help', description: 'Yordam' },
        { command: 'admin', description: 'Admin panel' }
      ],
      { scope: { type: 'chat', chat_id: Number(id) } }
    ).catch(() => {});
  }
})();

/* ========================= server (webhook) ========================= */
const app = express();
app.use(express.json({ limit: '2mb' }));

/* saytdan (boshqa domendan) so'rov qabul qilish uchun CORS */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ========================= sayt -> bot: mahsulotni avtomatik yetkazish ========================= *
 * Sayt "Bepul olish" / balansdan xarid qilinganda shu endpointga murojaat qiladi.
 * Agar xaridor bot bilan ulangan bo'lsa va mahsulotga fayl biriktirilgan bo'lsa,
 * fayl xaridorning Telegramiga darhol avtomatik yuboriladi.
 */
app.post('/api/deliver-product', async (req, res) => {
  try {
    if (!SITE_API_KEY || req.headers['x-api-key'] !== SITE_API_KEY) {
      return res.status(401).json({ delivered: false, reason: 'unauthorized' });
    }
    const { username, productId } = req.body || {};
    if (!username || !productId) {
      return res.status(400).json({ delivered: false, reason: 'bad_request' });
    }
    const user = await getUserByUsername(username);
    if (!user || !user.telegramId) {
      notifyAdmins(
        `⚠️ <b>Saytdan so'rov — foydalanuvchi botga ulanmagan</b>\n👤 ${esc(username)}\n🆔 <code>${esc(productId)}</code>\nMahsulotni qo'lda yetkazib berish kerak bo'lishi mumkin.`,
        { parse_mode: 'HTML' }
      );
      return res.json({ delivered: false, reason: 'not_linked' });
    }
    const product = await getProduct(productId);
    if (!product) {
      notifyAdmins(
        `⚠️ <b>Saytdan so'rov — mahsulot topilmadi</b>\n👤 ${esc(user.username)}\n🆔 <code>${esc(productId)}</code>`,
        { parse_mode: 'HTML' }
      );
      return res.json({ delivered: false, reason: 'not_found' });
    }
    if (!product.fileId) {
      notifyAdmins(
        `⚠️ <b>Saytdan so'rov — fayl biriktirilmagan</b>\n👤 ${esc(user.username)}\n📦 ${esc(product.name)}\nIltimos, foydalanuvchiga faylni qo'lda yuboring.`,
        { parse_mode: 'HTML' }
      );
      return res.json({ delivered: false, reason: 'no_file' });
    }
    await bot.telegram.sendMessage(
      user.telegramId,
      `🎁 <b>"${esc(product.name)}"</b> saytdan olindi — faylingiz quyida:`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    await bot.telegram.sendDocument(user.telegramId, product.fileId, { caption: `📦 ${product.name}` });
    notifyAdmins(
      `🎁 <b>Saytdan mahsulot olindi</b>\n👤 ${esc(user.username)}\n📦 ${esc(product.name)}\n📁 Fayl avtomatik yuborildi.`,
      { parse_mode: 'HTML' }
    );
    return res.json({ delivered: true });
  } catch (e) {
    console.error('deliver-product xatosi', e);
    notifyAdmins(
      `⚠️ <b>Saytdan so'rovda server xatoligi</b>\n🆔 <code>${esc(productId || '—')}</code>\n${esc(e && e.message ? e.message : String(e))}`,
      { parse_mode: 'HTML' }
    );
    return res.status(500).json({ delivered: false, reason: 'server_error' });
  }
});

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
