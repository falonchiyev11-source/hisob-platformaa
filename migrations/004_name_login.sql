-- Kirish do'kon nomi bilan. login_key — nomning kichik harfli, apostroflari bir xillashtirilgan shakli
-- (ilova tomonida hisoblanadi, chunki bazaning "C" lokali kirill harflarini kichiklashtira olmaydi).
-- Oldingi loginlar faqat kichik lotin harflaridan iborat edi, shuning uchun ular uchun kalit = login.
ALTER TABLE users ADD COLUMN login_key text;
UPDATE users SET login_key = username;
ALTER TABLE users ALTER COLUMN login_key SET NOT NULL;
CREATE UNIQUE INDEX users_login_key_uq ON users (login_key);
