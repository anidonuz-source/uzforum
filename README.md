# UzForum Telegram Bot — o'rnatish qo'llanmasi

## 1. Bot yaratish (BotFather)
1. Telegram'da **@BotFather** ni oching
2. `/newbot` yuboring, botga nom va username bering (username `bot` bilan tugashi kerak, masalan `uzforum_shop_bot`)
3. Sizga **token** beriladi (masalan `123456789:AAExxxxx...`) — saqlab qo'ying, bu `BOT_TOKEN`
4. O'z Telegram ID raqamingizni bilish uchun **@userinfobot** ga `/start` yuboring — chiqqan ID raqami `ADMIN_CHAT_ID`

## 2. Supabase secret key olish
1. Supabase dashboard → loyihangiz → **Settings → API Keys**
2. **"Secret keys"** bo'limidan `default` kalitni oching (yoki yangisini yarating) — bu `SUPABASE_SERVICE_KEY`
3. DIQQAT: bu kalitni hech qachon frontend/sayt kodiga yoki ochiq GitHub repo'ga qo'ymang — faqat Render environment variables'ga qo'yiladi

## 3. Render'ga joylashtirish
1. [render.com](https://render.com) da **New → Web Service**
2. Ushbu papkani (yoki uni yuklagan GitHub repo'ni) tanlang
3. Sozlamalar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. **Environment** bo'limida shu o'zgaruvchilarni qo'shing:
   - `BOT_TOKEN` — BotFather tokeni
   - `SUPABASE_URL` — `https://ftndouuwpinxjzdkcgmt.supabase.co`
   - `SUPABASE_SERVICE_KEY` — Supabase secret key
   - `ADMIN_CHAT_ID` — sizning Telegram ID raqamingiz
5. **Create Web Service** ni bosing — Render avtomatik `RENDER_EXTERNAL_URL` beradi, bot shu orqali webhook o'rnatadi (kod ichida avtomatik ishlaydi, qo'shimcha sozlash shart emas)

## 4. Saytni bot username bilan yangilash
`index.html` faylida shu qatorni toping va o'z bot username'ingizga almashtiring:
```js
const TELEGRAM_BOT_USERNAME = 'YOUR_BOT_USERNAME'; // @ belgisisiz, masalan: uzforum_shop_bot
```

## 5. Supabase jadvaliga index qo'shish (tavsiya, tezlik uchun)
SQL Editor'da:
```sql
create index if not exists kv_store_key_prefix_idx on kv_store (key text_pattern_ops);
```

## Ishlash tartibi
- Foydalanuvchi saytda ro'yxatdan o'tadi → kabinet → "📲 Telegram bot" → ulash havolasini oladi
- Havolani bosib botni ochadi → hisob avtomatik ulanadi
- Bot orqali: balansni ko'radi, to'ldirish so'rovi yuboradi (admin tasdiqlaydi), mahsulot sotib oladi (tasdiqlash bosqichi bilan, agar balans yetarli bo'lsa — darhol), buyurtmalar tarixini ko'radi
- Admin balans so'rovlarini bot ichidan bitta tugma bilan tasdiqlaydi/rad etadi — foydalanuvchiga avtomatik xabar boradi

## Admin uchun qo'shimcha
- `/admin` — to'liq admin panel (tugmalar orqali):
  - 📊 Statistika — foydalanuvchilar, umumiy balans, umumiy sotuv, kutilayotgan so'rovlar
  - ⏳ Kutilayotgan so'rovlar — barcha balans to'ldirish so'rovlari, har biriga ✅/❌ tugma bilan
  - 👥 Foydalanuvchilar — ro'yxat, balans va bot ulanganlik holati bilan
  - 📦 Mahsulotlar — narxlari bilan ro'yxat
  - 📢 Hammaga xabar yuborish — botga ulangan barcha foydalanuvchilarga xabar (oldindan ko'rish + tasdiqlash bilan)
- Har bir balans to'ldirish so'rovi admin'ga ✅/❌ tugmalari bilan avtomatik keladi
- Xatoliklar avtomatik ushlanadi — bot yiqilib qolmaydi, foydalanuvchiga tushunarli xabar chiqadi
