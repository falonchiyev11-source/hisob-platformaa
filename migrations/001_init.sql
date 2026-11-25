-- Savdo va ombor boshqaruv platformasi: boshlang'ich sxema.
-- Barcha pul qiymatlari NUMERIC(15,2) — float ishlatilmaydi.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin', 'seller')),
  active        boolean NOT NULL DEFAULT true,
  script        text NOT NULL DEFAULT 'latn' CHECK (script IN ('latn', 'cyrl')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id             uuid PRIMARY KEY,
  name           text NOT NULL,
  category_id    uuid REFERENCES categories(id) ON DELETE SET NULL,
  code           text,
  cost_price     numeric(15,2) NOT NULL CHECK (cost_price >= 0),
  price          numeric(15,2) NOT NULL CHECK (price >= 0),
  discount_price numeric(15,2) CHECK (discount_price >= 0),
  stock          integer NOT NULL DEFAULT 0,       -- inventory_movements yig'indisi bilan bir tranzaksiyada yangilanadi
  note           text,
  image          text,                             -- kichraytirilgan rasm (data URL)
  image_version  integer NOT NULL DEFAULT 0,
  version        integer NOT NULL DEFAULT 1,       -- offline nizolarni aniqlash uchun
  archived       boolean NOT NULL DEFAULT false,
  created_by     uuid REFERENCES users(id),
  updated_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_code_uq ON products (lower(code)) WHERE code IS NOT NULL AND NOT archived;
CREATE INDEX products_name_idx ON products (lower(name));

CREATE TABLE inventory_movements (
  id         uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id),
  delta      integer NOT NULL CHECK (delta <> 0),
  type       text NOT NULL CHECK (type IN ('initial', 'receipt', 'sale', 'return', 'adjustment')),
  ref_id     uuid,
  note       text,
  user_id    uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inv_mov_product_idx ON inventory_movements (product_id, created_at);

CREATE TABLE customers (
  id         uuid PRIMARY KEY,
  name       text NOT NULL,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales (
  id          uuid PRIMARY KEY,                         -- qurilmada yaratiladi (idempotentlik kaliti)
  number      bigserial UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id),
  customer_id uuid REFERENCES customers(id),
  subtotal    numeric(15,2) NOT NULL,                   -- oddiy narx bo'yicha
  total       numeric(15,2) NOT NULL,                   -- haqiqiy sotilgan narx bo'yicha
  cost_total  numeric(15,2) NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_created_idx ON sales (created_at);

CREATE TABLE sale_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id      uuid NOT NULL REFERENCES sales(id),
  line_no      integer NOT NULL,
  product_id   uuid NOT NULL REFERENCES products(id),
  product_name text NOT NULL,
  qty          integer NOT NULL CHECK (qty > 0),
  base_price   numeric(15,2) NOT NULL,                  -- savdo paytidagi oddiy narx
  unit_price   numeric(15,2) NOT NULL CHECK (unit_price >= 0), -- haqiqiy sotilgan narx
  cost_price   numeric(15,2) NOT NULL                   -- savdo paytidagi tannarx
);
CREATE INDEX sale_items_sale_idx ON sale_items (sale_id);

CREATE TABLE sale_payments (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id),
  method  text NOT NULL CHECK (method IN ('cash', 'card', 'click', 'debt')),
  amount  numeric(15,2) NOT NULL CHECK (amount > 0),
  UNIQUE (sale_id, method)
);

CREATE TABLE debts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id     uuid NOT NULL UNIQUE REFERENCES sales(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  amount      numeric(15,2) NOT NULL CHECK (amount > 0),
  note        text,
  created_at  timestamptz NOT NULL
);

CREATE TABLE debt_payments (
  id         uuid PRIMARY KEY,
  debt_id    uuid NOT NULL REFERENCES debts(id),
  amount     numeric(15,2) NOT NULL CHECK (amount > 0),
  method     text NOT NULL CHECK (method IN ('cash', 'card', 'click')),
  note       text,
  user_id    uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL
);
CREATE INDEX debt_payments_debt_idx ON debt_payments (debt_id);

CREATE TABLE returns (
  id             uuid PRIMARY KEY,
  sale_id        uuid NOT NULL REFERENCES sales(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  reason         text NOT NULL,
  total          numeric(15,2) NOT NULL,   -- qaytarilgan mahsulotlarning sotilgan narxi bo'yicha
  base_total     numeric(15,2) NOT NULL,   -- oddiy narx bo'yicha (chegirmani qayta hisoblash uchun)
  cost_total     numeric(15,2) NOT NULL,
  refund_cash    numeric(15,2) NOT NULL DEFAULT 0 CHECK (refund_cash >= 0),
  refund_card    numeric(15,2) NOT NULL DEFAULT 0 CHECK (refund_card >= 0),
  refund_click   numeric(15,2) NOT NULL DEFAULT 0 CHECK (refund_click >= 0),
  debt_reduction numeric(15,2) NOT NULL DEFAULT 0 CHECK (debt_reduction >= 0),
  created_at     timestamptz NOT NULL
);
CREATE INDEX returns_sale_idx ON returns (sale_id);

CREATE TABLE return_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    uuid NOT NULL REFERENCES returns(id),
  sale_item_id uuid NOT NULL REFERENCES sale_items(id),
  product_id   uuid NOT NULL REFERENCES products(id),
  qty          integer NOT NULL CHECK (qty > 0),
  unit_price   numeric(15,2) NOT NULL,
  base_price   numeric(15,2) NOT NULL,
  cost_price   numeric(15,2) NOT NULL
);

CREATE TABLE recurring_expenses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  amount         numeric(15,2) NOT NULL CHECK (amount > 0),
  period         text NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  start_date     date NOT NULL,
  category       text,
  note           text,
  paid_from_cash boolean NOT NULL DEFAULT true,
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expenses (
  id             uuid PRIMARY KEY,
  name           text NOT NULL,
  amount         numeric(15,2) NOT NULL CHECK (amount > 0),
  category       text,
  expense_date   date NOT NULL,                -- foyda qaysi kunga tegishli
  note           text,
  paid_from_cash boolean NOT NULL DEFAULT true,
  recurring_id   uuid REFERENCES recurring_expenses(id),
  period_key     date,
  user_id        uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,         -- pul kassadan qachon chiqqani
  deleted_at     timestamptz,
  deleted_by     uuid REFERENCES users(id)
);
CREATE INDEX expenses_date_idx ON expenses (expense_date);

-- Doimiy xarajat davrlari: bir davr faqat bir marta tasdiqlanadi yoki o'tkazib yuboriladi.
CREATE TABLE recurring_confirmations (
  recurring_id uuid NOT NULL REFERENCES recurring_expenses(id),
  period_key   date NOT NULL,
  status       text NOT NULL CHECK (status IN ('confirmed', 'skipped')),
  expense_id   uuid REFERENCES expenses(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recurring_id, period_key)
);

CREATE TABLE daily_closings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  close_date   date NOT NULL UNIQUE,
  opening_cash numeric(15,2) NOT NULL,
  expected_cash numeric(15,2) NOT NULL,
  actual_cash  numeric(15,2) NOT NULL,
  difference   numeric(15,2) NOT NULL,
  summary      jsonb NOT NULL,
  note         text,
  closed_by    uuid NOT NULL REFERENCES users(id),
  closed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id),
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  details    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_logs (created_at DESC);

-- Offline sinxronlash: har bir amal bir marta bajariladi.
CREATE TABLE processed_ops (
  op_id      uuid PRIMARY KEY,
  op_type    text NOT NULL,
  result     jsonb,
  user_id    uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_conflicts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_id        uuid NOT NULL UNIQUE,
  op_type      text NOT NULL,
  entity_id    uuid,
  payload      jsonb NOT NULL,
  server_state jsonb,
  reason       text NOT NULL,
  user_id      uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES users(id),
  resolution   text
);
