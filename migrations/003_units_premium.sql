-- O'lchov birliklari (dona / kg / metr), ikkinchi birlik (nisbat bilan) va premium narx.
-- Miqdorlar kasr bo'lishi mumkin (masalan 1,5 kg), shuning uchun integer → numeric(14,3).

-- Mahsulot
ALTER TABLE products ALTER COLUMN stock TYPE numeric(14,3);
ALTER TABLE products
  ADD COLUMN unit          text NOT NULL DEFAULT 'dona' CHECK (unit IN ('dona', 'kg', 'metr')),
  ADD COLUMN premium_price numeric(15,2) CHECK (premium_price >= 0),
  -- Ikkinchi birlik: masalan "qop", 1 qop = alt_factor × asosiy birlik (50 kg)
  ADD COLUMN alt_unit      text,
  ADD COLUMN alt_factor    numeric(14,3) CHECK (alt_factor > 0),
  ADD COLUMN alt_price     numeric(15,2) CHECK (alt_price >= 0),
  ADD CONSTRAINT products_alt_unit_complete CHECK (
    (alt_unit IS NULL AND alt_factor IS NULL AND alt_price IS NULL)
    OR (alt_unit IS NOT NULL AND alt_factor IS NOT NULL AND alt_price IS NOT NULL)
  );

-- Ombor harakatlari asosiy birlikda
ALTER TABLE inventory_movements ALTER COLUMN delta TYPE numeric(14,3);

-- Savdo qatori: qaysi birlikda sotilgani va shu birlikdagi nisbat (tarix o'zgarmasligi uchun)
ALTER TABLE sale_items ALTER COLUMN qty TYPE numeric(14,3);
ALTER TABLE sale_items
  ADD COLUMN unit_name   text NOT NULL DEFAULT 'dona',
  ADD COLUMN unit_factor numeric(14,3) NOT NULL DEFAULT 1 CHECK (unit_factor > 0);

ALTER TABLE return_items ALTER COLUMN qty TYPE numeric(14,3);
