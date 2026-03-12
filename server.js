const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const cookieParser = require('cookie-parser');
const expressLayouts = require('express-ejs-layouts');
const bcrypt = require('bcrypt');
const multer = require('multer');
const fs = require('fs');
const Database = require('better-sqlite3');
const stripeLib = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
// nodemailer (optional)
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT||587),
    secure: (process.env.SMTP_SECURE === 'true'),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

const app = express();
const PORT = process.env.PORT || 5600;
const SESSION_COOKIE_NAME = 'connect.sid';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// prepare hero images list
// Priority for where you can drop images:
// 1) public/image  (accessible as /image/<file>)  <-- recommended by the user
// 2) public/hero   (accessible as /hero/<file>)
// 3) public/images/hero
// Fallback: a small set of hardcoded images we know exist in the repo
try {
  const candidates = [
    { dir: path.join(__dirname, 'public', 'image'), urlPrefix: '/image/' },
    { dir: path.join(__dirname, 'public', 'hero'), urlPrefix: '/hero/' },
    { dir: path.join(__dirname, 'public', 'images', 'hero'), urlPrefix: '/images/hero/' }
  ];
  let _heroImages = [];
  for (const c of candidates) {
    if (fs.existsSync(c.dir)) {
      const files = fs.readdirSync(c.dir).filter(f => /\.(jpe?g|png|webp|avif|gif|svg)$/i.test(f));
      if (files.length) {
        _heroImages = files.map(f => c.urlPrefix + f);
        break;
      }
    }
  }
  if (!_heroImages.length) {
    _heroImages = ['/images/1760790304024-1-NAU-LD9202.jpg','/images/1760811897386-aohodie.png','/images/1760787294482-quan1.jpg'];
  }
  // expose to all views
  app.use((req,res,next)=>{ res.locals.heroImages = _heroImages; next(); });
} catch(e) {
  app.use((req,res,next)=>{ res.locals.heroImages = ['/images/1760790304024-1-NAU-LD9202.jpg']; next(); });
}

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: '.' }),
  secret: 'change-me-please',
  resave: false,
  saveUninitialized: false,
  name: SESSION_COOKIE_NAME,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// init db
const dbFile = path.join(__dirname, 'data.sqlite');
const db = new Database(dbFile);

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      description TEXT,
      price INTEGER,
      image TEXT,
      category TEXT,
      stock INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      total INTEGER,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      product_id INTEGER,
        quantity INTEGER,
        price INTEGER,
        option TEXT
    );

    CREATE TABLE IF NOT EXISTS discount_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      product_id INTEGER NOT NULL,
      discount_amount INTEGER NOT NULL,
      usage_limit INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // simple migration: add 'category' column if missing (for older DBs)
  try {
    const cols = db.prepare("PRAGMA table_info('products')").all();
    const hasCategory = cols.some(c => c.name === 'category');
    if (!hasCategory) {
      db.prepare("ALTER TABLE products ADD COLUMN category TEXT").run();
      console.log('Migration: added products.category column');
    }
    const hasImagesCol = cols.some(c => c.name === 'images');
    if (!hasImagesCol) {
      try { db.prepare("ALTER TABLE products ADD COLUMN images TEXT").run(); console.log('Migration: added products.images column'); } catch(e){}
    }
    // ensure order_items.option exists
    const oiCols = db.prepare("PRAGMA table_info('order_items')").all();
    const hasOption = oiCols.some(c=>c.name === 'option');
    if (!hasOption) {
      try { db.prepare("ALTER TABLE order_items ADD COLUMN option TEXT").run(); console.log('Migration: added order_items.option column'); } catch(e){}
    }
    // ensure orders table has address_id column to store chosen shipping address
    const orderCols = db.prepare("PRAGMA table_info('orders')").all();
    const hasAddressId = orderCols.some(c => c.name === 'address_id');
    if (!hasAddressId) {
      try { db.prepare("ALTER TABLE orders ADD COLUMN address_id INTEGER").run(); console.log('Migration: added orders.address_id column'); } catch(e){}
    }
    const hasSubtotal = orderCols.some(c => c.name === 'subtotal');
    if (!hasSubtotal) {
      try { db.prepare("ALTER TABLE orders ADD COLUMN subtotal INTEGER").run(); console.log('Migration: added orders.subtotal column'); } catch(e){}
    }
    const hasDiscountAmount = orderCols.some(c => c.name === 'discount_amount');
    if (!hasDiscountAmount) {
      try { db.prepare("ALTER TABLE orders ADD COLUMN discount_amount INTEGER DEFAULT 0").run(); console.log('Migration: added orders.discount_amount column'); } catch(e){}
    }
    const hasDiscountCode = orderCols.some(c => c.name === 'discount_code');
    if (!hasDiscountCode) {
      try { db.prepare("ALTER TABLE orders ADD COLUMN discount_code TEXT").run(); console.log('Migration: added orders.discount_code column'); } catch(e){}
    }
    const discountCols = db.prepare("PRAGMA table_info('discount_codes')").all();
    const hasUsageLimit = discountCols.some(c => c.name === 'usage_limit');
    if (!hasUsageLimit) {
      try { db.prepare("ALTER TABLE discount_codes ADD COLUMN usage_limit INTEGER DEFAULT 1").run(); console.log('Migration: added discount_codes.usage_limit column'); } catch(e){}
    }
    try { db.prepare('UPDATE orders SET subtotal = total WHERE subtotal IS NULL').run(); } catch(e){}
    try { db.prepare('UPDATE orders SET discount_amount = 0 WHERE discount_amount IS NULL').run(); } catch(e){}
    try { db.prepare('UPDATE discount_codes SET usage_limit = 1 WHERE usage_limit IS NULL OR usage_limit < 1').run(); } catch(e){}
  } catch (e) {
    console.warn('Migration check failed', e.message);
  }

  // seed admin and sample products if missing
  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@local');
  if (!admin) {
    const hash = bcrypt.hashSync('adminpass', 10);
    db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)')
      .run('Admin','admin@local',hash,'admin');
  }

  const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO products (title,description,price,image,stock,category) VALUES (?,?,?,?,?,?)');
    const sample = [
      ['Áo thun basic','Áo thun cotton comfortable',150000,'/images/shirt1.jpg',20,'Áo'],
      ['Áo len mùa đông','Áo len dày ấm',350000,'/images/cozy_sweater.jpg',8,'Áo mùa đông'],
      ['Quần jeans nam','Quần jeans xanh rách nhẹ',450000,'/images/jeans1.jpg',10,'Quần'],
      ['Quần short nam','Quần short nhẹ nhàng',220000,'/images/shorts1.jpg',12,'Quần'],
      ['Váy nữ','Váy nữ hoa nhí',350000,'/images/dress1.jpg',15,'Áo'],
      ['Mũ lưỡi trai','Mũ thời trang',120000,'/images/cap1.jpg',30,'Mũ'],
      ['Mũ len','Mũ len ấm áp',90000,'/images/beanie1.jpg',25,'Mũ'],
      ['Áo khoác mùa đông','Áo khoác dày',800000,'/images/coat1.jpg',5,'Áo mùa đông'],
      ['Áo sơ mi','Sơ mi công sở',250000,'/images/shirt2.jpg',18,'Áo'],
      ['Quần tây nữ','Quần tây nữ công sở',300000,'/images/trousers1.jpg',10,'Quần'],
      ['Áo polo nam','Áo polo thấm hút',200000,'/images/polo1.jpg',22,'Áo'],
      ['Áo hoodie','Hoodie unisex',280000,'/images/hoodie1.jpg',14,'Áo'],
      ['Quần jogger','Quần jogger thun',240000,'/images/jogger1.jpg',16,'Quần'],
      ['Mũ bucket','Mũ bucket thời trang',110000,'/images/bucket1.jpg',20,'Mũ'],
      ['Áo khoác nhẹ','Áo khoác mỏng',320000,'/images/jacket1.jpg',9,'Áo mùa đông'],
      ['Đầm maxi','Đầm maxi xòe',420000,'/images/maxi1.jpg',7,'Áo'],
      ['Quần shorts nữ','Quần shorts nữ',190000,'/images/shorts2.jpg',11,'Quần'],
      ['Mũ snapback','Mũ snapback',130000,'/images/snapback1.jpg',18,'Mũ'],
      ['Áo vest nam','Áo vest công sở',550000,'/images/vest1.jpg',6,'Áo'],
      ['Áo len cổ lọ','Áo len cổ lọ ấm',270000,'/images/turtle_knit.jpg',12,'Áo mùa đông']
    ];
    for (const p of sample) ins.run(p[0], p[1], p[2], p[3], p[4], p[5]);
  }
}

initDb();

// ensure users table has avatar and phone columns and create addresses table
try {
  const userCols = db.prepare("PRAGMA table_info('users')").all().map(c=>c.name);
  if (!userCols.includes('avatar')) db.prepare("ALTER TABLE users ADD COLUMN avatar TEXT").run();
  if (!userCols.includes('phone')) db.prepare("ALTER TABLE users ADD COLUMN phone TEXT").run();
    if (!userCols.includes('gender')) db.prepare("ALTER TABLE users ADD COLUMN gender TEXT").run();
    if (!userCols.includes('dob')) db.prepare("ALTER TABLE users ADD COLUMN dob TEXT").run();
} catch(e){ /* ignore */ }
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      recipient TEXT,
      phone TEXT,
      street TEXT,
      city TEXT,
      postcode TEXT,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch(e){ console.error('addresses table create failed', e.message); }

// carts table: persist user's cart between sessions
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS carts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE,
      items TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch(e){ console.error('carts table create failed', e.message); }

try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created ON chat_messages(user_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_unread ON chat_messages(user_id, sender, is_read)');
} catch(e){ console.error('chat_messages index create failed', e.message); }

// middleware to expose user to views
// middleware to expose user to views (refresh avatar/name from DB when logged in)
app.use((req,res,next)=>{
  res.locals.stripePublishable = process.env.STRIPE_PUBLISHABLE_KEY || null;
  res.locals.flashNotice = req.session && req.session.flashNotice ? req.session.flashNotice : null;
  res.locals.chatUnreadCount = 0;
  if (req.session && req.session.flashNotice) delete req.session.flashNotice;
  if (req.session.user && req.session.user.id) {
    try {
      const u = db.prepare('SELECT id,name,email,role,avatar FROM users WHERE id = ?').get(req.session.user.id);
      if (u) {
        // merge fields into session user and expose to views
        req.session.user.name = u.name;
        req.session.user.role = u.role;
        req.session.user.avatar = u.avatar;
        res.locals.currentUser = req.session.user;
        if (u.role === 'admin') {
          const unread = db.prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE sender = 'user' AND is_read = 0").get();
          res.locals.chatUnreadCount = unread ? (unread.c || 0) : 0;
        } else {
          const unread = db.prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE user_id = ? AND sender = 'admin' AND is_read = 0").get(u.id);
          res.locals.chatUnreadCount = unread ? (unread.c || 0) : 0;
        }
      } else {
        res.locals.currentUser = req.session.user;
      }
    } catch (e) { res.locals.currentUser = req.session.user; }
  } else {
    res.locals.currentUser = null;
  }
  next();
});

// provide categories and cart summary to all views
app.use((req,res,next)=>{
  try {
    res.locals.categories = db.prepare('SELECT DISTINCT category FROM products WHERE category IS NOT NULL').all().map(r=>r.category).filter(Boolean);
  } catch(e){ res.locals.categories = []; }
  const cart = req.session.cart || {};
  res.locals.cartCount = Object.values(cart).reduce((s,q)=>s + (parseInt(q)||0),0);
  next();
});

// middleware: categories list and cart count for header
app.use((req,res,next)=>{
  try {
    const cats = db.prepare('SELECT DISTINCT category FROM products').all().map(r=>r.category).filter(Boolean);
    res.locals.categories = cats;
  } catch(e){ res.locals.categories = []; }
  try {
    const cart = req.session.cart || {};
    let count = 0; for (const k in cart) count += parseInt(cart[k])||0;
    res.locals.cartCount = count;
  } catch(e){ res.locals.cartCount = 0; }
  next();
});

// consolidated search route (case-insensitive search on title + description)
app.get('/search', (req,res)=>{
  const q = (req.query.q||'').trim();
  let products = [];
  try {
    if (q) {
      // fetch candidates then filter in JS using diacritics-insensitive comparison
      const candidates = db.prepare('SELECT * FROM products LIMIT 500').all();
      const nq = removeDiacritics(q);
      products = candidates.filter(p=>{
        const t = removeDiacritics((p.title||'') + ' ' + (p.description||''));
        // match whole words (avoid matching 'mu' inside 'mua') by checking each token
        const tokens = String(nq).split(/\s+/).filter(Boolean);
        if (tokens.length === 0) return false;
        return tokens.every(token => {
          const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp('\\b' + esc + '\\b', 'u');
          return re.test(t);
        });
      }).slice(0,100);
    } else {
      products = db.prepare('SELECT * FROM products LIMIT 100').all();
    }
  } catch(e){ products = []; }
  products = products.map(p => Object.assign({}, p, { safeImage: isValidImagePath(p.image) ? p.image : choosePlaceholder(p.title) }));
  // hide hero & top search when showing search results
  res.render('shop/index',{ products, categories: res.locals.categories, activeCategory: null, title: 'Tìm kiếm: '+q, q, hideHero: true, error: req.query.error || null });
});

// upload setup for product images (initialize early so routes can use `upload`)
const uploadDir = path.join(__dirname, 'public', 'images');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadDir); },
  filename: function (req, file, cb) {
    const name = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9\.\-]/g,'');
    cb(null, name);
  }
});
const upload = multer({ storage });

function choosePlaceholder(name) {
  // pick a placeholder based on hash of name
  const n = String(name || '').split('').reduce((s,c)=>s + c.charCodeAt(0),0);
  const arr = ['/images/placeholder-blue.svg','/images/placeholder-green.svg','/images/placeholder-gray.svg'];
  return arr[n % arr.length];
}

function isValidImagePath(relPath) {
  try {
    if (!relPath) return false;
    const p = require('path').join(__dirname, 'public', relPath.replace(/^\//, ''));
    if (!fs.existsSync(p)) return false;
    const st = fs.statSync(p);
    // require at least 1KB to consider valid image (avoid empty placeholders)
    return st.isFile() && st.size > 1024;
  } catch (e) { return false; }
}

function removeDiacritics(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// Cart persistence helpers: save/load cart JSON for a user
function loadCartForUser(userId){
  try {
    const r = db.prepare('SELECT items FROM carts WHERE user_id = ?').get(userId);
    if (!r || !r.items) return {};
    return JSON.parse(r.items);
  } catch(e){ console.error('loadCartForUser error', e && e.message); return {}; }
}

function saveCartForUser(userId, cartObj){
  try {
    const str = JSON.stringify(cartObj || {});
    // upsert: try update first
    const info = db.prepare('SELECT id FROM carts WHERE user_id = ?').get(userId);
    if (info) {
      db.prepare('UPDATE carts SET items = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(str, userId);
    } else {
      db.prepare('INSERT INTO carts (user_id, items) VALUES (?,?)').run(userId, str);
    }
  } catch(e){ console.error('saveCartForUser error', e && e.message); }
}

function parseCartKey(key) {
  const parts = String(key || '').split('::');
  return { productId: parts[0], option: parts[1] || null };
}

function getInventoryMessage(adjustments) {
  if (!adjustments || !adjustments.length) return null;
  const first = adjustments[0];
  if (first.reason === 'missing') return `Sản phẩm ${first.title || ''} không còn tồn tại và đã được xóa khỏi giỏ.`.trim();
  if (first.allowed === 0) return `${first.title} đã hết hàng.`;
  return `${first.title} chỉ còn ${first.allowed} sản phẩm trong kho.`;
}

function normalizeCartWithInventory(cartObj) {
  const sourceCart = cartObj || {};
  const normalized = {};
  const adjustments = [];
  const remainingByProduct = new Map();
  const productCache = new Map();

  for (const key of Object.keys(sourceCart)) {
    const requestedQty = parseInt(sourceCart[key], 10) || 0;
    if (requestedQty <= 0) continue;

    const { productId } = parseCartKey(key);
    if (!productId) continue;

    let product = productCache.get(productId);
    if (!product) {
      product = db.prepare('SELECT id, title, stock FROM products WHERE id = ?').get(productId) || null;
      productCache.set(productId, product);
    }

    if (!product) {
      adjustments.push({ key, reason: 'missing', title: 'Sản phẩm' });
      continue;
    }

    const productStock = Math.max(0, parseInt(product.stock, 10) || 0);
    const remaining = remainingByProduct.has(productId) ? remainingByProduct.get(productId) : productStock;
    if (remaining <= 0) {
      adjustments.push({ key, reason: 'clamped', title: product.title, requested: requestedQty, allowed: 0 });
      continue;
    }

    const allowedQty = Math.min(requestedQty, remaining);
    normalized[key] = allowedQty;
    remainingByProduct.set(productId, remaining - allowedQty);

    if (allowedQty < requestedQty) {
      adjustments.push({ key, reason: 'clamped', title: product.title, requested: requestedQty, allowed: allowedQty });
    }
  }

  return { cart: normalized, adjustments };
}

function syncCartToSession(req, cartObj) {
  req.session.cart = cartObj || {};
  try {
    if (req.session.user && req.session.user.id) saveCartForUser(req.session.user.id, req.session.cart);
  } catch (e) {
    console.error('cart sync error', e && e.message);
  }
}

function loadCartItems(cartObj) {
  const cart = cartObj || {};
  const items = [];
  let total = 0;

  for (const key of Object.keys(cart)) {
    const quantity = parseInt(cart[key], 10) || 0;
    if (quantity <= 0) continue;

    const { productId, option } = parseCartKey(key);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!product) continue;

    product.safeImage = isValidImagePath(product.image) ? product.image : choosePlaceholder(product.title);
    items.push({ key, product, quantity, option });
    total += product.price * quantity;
  }

  return { items, total };
}

function getItemUnitPrice(item) {
  if (!item) return 0;
  if (typeof item.price === 'number') return item.price;
  if (item.product && typeof item.product.price === 'number') return item.product.price;
  return parseInt(item.price || (item.product && item.product.price) || 0, 10) || 0;
}

function normalizeDiscountCode(rawCode) {
  return typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
}

function getDiscountCodeRecord(rawCode) {
  const code = normalizeDiscountCode(rawCode);
  if (!code) return null;

  return db.prepare(`
    SELECT dc.*, p.title AS product_title
    FROM discount_codes dc
    LEFT JOIN products p ON p.id = dc.product_id
    WHERE upper(dc.code) = ? AND dc.is_active = 1
  `).get(code);
}

function getDiscountCodeUsageStats(rawCode, userId) {
  const code = normalizeDiscountCode(rawCode);
  if (!code) return { totalUsed: 0, userHasUsed: false };

  const totalRow = db.prepare('SELECT COUNT(DISTINCT user_id) AS totalUsed FROM orders WHERE upper(discount_code) = ?').get(code);
  const userRow = userId
    ? db.prepare('SELECT 1 AS used FROM orders WHERE upper(discount_code) = ? AND user_id = ? LIMIT 1').get(code, userId)
    : null;

  return {
    totalUsed: parseInt(totalRow && totalRow.totalUsed, 10) || 0,
    userHasUsed: !!(userRow && userRow.used)
  };
}

function buildOrderPricing(items, rawDiscountCode, userId) {
  const subtotal = (items || []).reduce((sum, item) => sum + (getItemUnitPrice(item) * (item.quantity || 0)), 0);
  const inputCode = normalizeDiscountCode(rawDiscountCode);
  const pricing = {
    inputCode,
    subtotal,
    discountAmount: 0,
    total: subtotal,
    appliedDiscount: null,
    error: null
  };

  if (!inputCode) return pricing;

  const discount = getDiscountCodeRecord(inputCode);
  if (!discount) {
    pricing.error = 'Mã giảm giá không hợp lệ hoặc đã bị tắt.';
    return pricing;
  }

  const usageLimit = Math.max(1, parseInt(discount.usage_limit, 10) || 1);
  const usageStats = getDiscountCodeUsageStats(inputCode, userId);
  pricing.totalUsed = usageStats.totalUsed;
  pricing.remainingUses = Math.max(0, usageLimit - usageStats.totalUsed);

  if (usageStats.userHasUsed) {
    pricing.error = 'Mỗi tài khoản chỉ được sử dụng mã giảm giá này 1 lần.';
    return pricing;
  }

  if (usageStats.totalUsed >= usageLimit) {
    pricing.error = 'Mã giảm giá này đã hết lượt sử dụng.';
    return pricing;
  }

  const eligibleItems = (items || []).filter(item => String(item.product.id) === String(discount.product_id));
  if (!eligibleItems.length) {
    pricing.error = `Mã ${inputCode} chỉ áp dụng cho sản phẩm ${discount.product_title || 'đã chọn'}.`;
    return pricing;
  }

  const eligibleSubtotal = eligibleItems.reduce((sum, item) => sum + (getItemUnitPrice(item) * (item.quantity || 0)), 0);
  const discountAmount = Math.max(0, Math.min(parseInt(discount.discount_amount, 10) || 0, eligibleSubtotal, subtotal));
  if (!discountAmount) {
    pricing.error = 'Mã giảm giá không thể áp dụng cho đơn hàng này.';
    return pricing;
  }

  pricing.discountAmount = discountAmount;
  pricing.total = subtotal - discountAmount;
  pricing.appliedDiscount = Object.assign({}, discount, {
    usage_limit: usageLimit,
    total_used: usageStats.totalUsed,
    remaining_uses: Math.max(0, usageLimit - usageStats.totalUsed)
  });
  return pricing;
}

function buildUpdatedOrderPricing(order, items) {
  const subtotal = (items || []).reduce((sum, item) => sum + (getItemUnitPrice(item) * (item.quantity || 0)), 0);
  let discountAmount = 0;
  let discountCode = null;

  if (order && order.discount_amount > 0 && order.discount_code) {
    const currentDiscount = getDiscountCodeRecord(order.discount_code);
    if (currentDiscount) {
      const eligibleSubtotal = (items || [])
        .filter(item => String(item.product.id) === String(currentDiscount.product_id))
        .reduce((sum, item) => sum + (getItemUnitPrice(item) * (item.quantity || 0)), 0);
      discountAmount = Math.min(order.discount_amount, eligibleSubtotal, subtotal);
    } else {
      discountAmount = Math.min(order.discount_amount, subtotal);
    }

    if (discountAmount > 0) discountCode = order.discount_code;
  }

  return {
    subtotal,
    discountAmount,
    total: subtotal - discountAmount,
    discountCode
  };
}

function buildCheckoutFormValues(defaultAddress, source) {
  const input = source || {};
  return {
    recipient: input.recipient || (defaultAddress && defaultAddress.recipient) || '',
    phone: input.phone || (defaultAddress && defaultAddress.phone) || '',
    street: input.street || (defaultAddress && defaultAddress.street) || '',
    city: input.city || (defaultAddress && defaultAddress.city) || '',
    postcode: input.postcode || (defaultAddress && defaultAddress.postcode) || ''
  };
}

function clearCheckoutCart(req) {
  try { delete req.session.checkoutCart; } catch (e) {}
  try { delete req.session.checkoutDiscountCode; } catch (e) {}
}

function getCheckoutCartState(req) {
  const rawCheckoutCart = req.session.checkoutCart || null;
  if (rawCheckoutCart && typeof rawCheckoutCart === 'object' && Object.keys(rawCheckoutCart).length > 0) {
    return {
      source: 'buy-now',
      normalizedCart: normalizeCartWithInventory(rawCheckoutCart)
    };
  }

  const normalizedCart = normalizeCartWithInventory(req.session.cart || {});
  syncCartToSession(req, normalizedCart.cart);
  return {
    source: 'cart',
    normalizedCart
  };
}

function getCheckoutViewModel(req, options = {}) {
  const checkoutState = getCheckoutCartState(req);
  const normalizedCart = checkoutState.normalizedCart;
  const { items } = loadCartItems(normalizedCart.cart);
  const defaultAddress = db.prepare('SELECT * FROM addresses WHERE user_id = ? AND is_default = 1').get(req.session.user.id);
  const discountCodeInput = Object.prototype.hasOwnProperty.call(options, 'discountCodeInput') ? options.discountCodeInput : req.query.discountCode;
  const pricing = buildOrderPricing(items, discountCodeInput, req.session.user.id);
  const inventoryMessage = getInventoryMessage(normalizedCart.adjustments);
  const formValues = buildCheckoutFormValues(defaultAddress, options.formValues);

  return {
    items,
    total: pricing.total,
    subtotal: pricing.subtotal,
    defaultAddress,
    discountSummary: pricing,
    discountCodeInput: pricing.inputCode,
    formValues,
    checkoutSource: checkoutState.source,
    stripePublishable: process.env.STRIPE_PUBLISHABLE || null,
    error: options.error || req.query.error || pricing.error || inventoryMessage
  };
}

function renderCheckoutPage(req, res, options = {}) {
  const viewModel = getCheckoutViewModel(req, options);
  if (!viewModel.items.length) return res.redirect('/cart');
  return res.render('shop/checkout', viewModel);
}

function buildOrderConfirmationHtml(orderId, pricing) {
  const rows = [`<p>Đơn hàng #${orderId}</p>`, `<p>Tạm tính: ${pricing.subtotal.toLocaleString()} VND</p>`];
  if (pricing.discountAmount > 0 && pricing.appliedDiscount) {
    rows.push(`<p>Mã giảm giá: ${pricing.appliedDiscount.code} (-${pricing.discountAmount.toLocaleString()} VND)</p>`);
  }
  rows.push(`<p>Tổng thanh toán: ${pricing.total.toLocaleString()} VND</p>`);
  return rows.join('');
}

function convertVndToStripeUnitAmount(amountVnd) {
  return Math.max(100, Math.round((Math.max(0, amountVnd) / 1000)) * 100);
}

function buildStripeLineItems(orderItems, pricing) {
  let remainingDiscount = pricing && pricing.appliedDiscount ? pricing.discountAmount : 0;

  return (orderItems || []).map(item => {
    let lineTotal = (item.product.price || 0) * (item.quantity || 0);

    if (remainingDiscount > 0 && pricing.appliedDiscount && String(item.product.id) === String(pricing.appliedDiscount.product_id)) {
      const lineDiscount = Math.min(remainingDiscount, lineTotal);
      lineTotal -= lineDiscount;
      remainingDiscount -= lineDiscount;
    }

    const averageUnitPrice = Math.max(1, Math.round(lineTotal / Math.max(1, item.quantity || 1)));
    return {
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.product.title + (item.option ? ` (${item.option})` : ''),
          description: item.product.description
        },
        unit_amount: convertVndToStripeUnitAmount(averageUnitPrice)
      },
      quantity: item.quantity
    };
  });
}

function reserveStockForItems(items) {
  const tx = db.transaction((orderItems) => {
    for (const item of orderItems) {
      const current = db.prepare('SELECT stock FROM products WHERE id = ?').get(item.product.id);
      const availableStock = Math.max(0, parseInt(current && current.stock, 10) || 0);
      if (availableStock < item.quantity) {
        const err = new Error(`${item.product.title} chỉ còn ${availableStock} sản phẩm trong kho.`);
        err.code = 'INSUFFICIENT_STOCK';
        throw err;
      }
    }

    for (const item of orderItems) {
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(item.quantity, item.product.id);
    }
  });

  tx(items);
}

function restoreStockForOrder(orderId) {
  const tx = db.transaction((targetOrderId) => {
    const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(targetOrderId);
    for (const item of items) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.product_id);
    }
  });

  tx(orderId);
}

function createPaidOrder(userId, items, pricingOrTotal, addressId) {
  const pricing = typeof pricingOrTotal === 'object'
    ? pricingOrTotal
    : { subtotal: pricingOrTotal, discountAmount: 0, total: pricingOrTotal, appliedDiscount: null };

  const tx = db.transaction((targetUserId, orderItems, orderPricing, targetAddressId) => {
    const discountCode = normalizeDiscountCode(orderPricing.inputCode || (orderPricing.appliedDiscount && orderPricing.appliedDiscount.code) || '');
    const finalPricing = buildOrderPricing(orderItems, discountCode, targetUserId);
    if (finalPricing.error) {
      const err = new Error(finalPricing.error);
      err.code = 'DISCOUNT_INVALID';
      throw err;
    }

    reserveStockForItems(orderItems);
    const info = db.prepare('INSERT INTO orders (user_id,total,status,address_id,subtotal,discount_amount,discount_code) VALUES (?,?,?,?,?,?,?)')
      .run(
        targetUserId,
        finalPricing.total,
        'paid',
        targetAddressId || null,
        finalPricing.subtotal || finalPricing.total,
        finalPricing.discountAmount || 0,
        finalPricing.appliedDiscount ? finalPricing.appliedDiscount.code : null
      );
    const orderId = info.lastInsertRowid;
    const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,quantity,price,option) VALUES (?,?,?,?,?)');
    for (const item of orderItems) {
      insertItem.run(orderId, item.product.id, item.quantity, item.product.price, item.option || null);
    }
    return orderId;
  });

  return tx(userId, items, pricing, addressId);
}

function normalizeProductOption(rawOption) {
  const allowedOptions = new Set(['S', 'M', 'L', 'XL']);
  const normalized = typeof rawOption === 'string' ? rawOption.trim().toUpperCase() : '';
  return allowedOptions.has(normalized) ? normalized : null;
}

// routes
app.get('/', (req,res)=>{
  const category = req.query.category;
  const categories = db.prepare('SELECT DISTINCT category FROM products').all().map(r=>r.category).filter(Boolean);
  let products;
  if (category) products = db.prepare('SELECT * FROM products WHERE category = ?').all(category);
  else products = db.prepare('SELECT * FROM products').all();
  // attach safe image path for each product
  products = products.map(p => {
    const valid = isValidImagePath(p.image);
    return Object.assign({}, p, { safeImage: valid ? p.image : choosePlaceholder(p.title) });
  });
  // if a category query is present, hide the hero and top search (handled in the layout/index)
  res.render('shop/index', { products, categories, activeCategory: category || null, hideHero: !!category, error: req.query.error || null });
});

app.get('/search', (req,res)=>{
  const q = (req.query.q||'').trim();
  let products = [];
  try {
    if (q) products = db.prepare('SELECT * FROM products WHERE lower(title) LIKE ?').all('%'+q.toLowerCase()+'%');
    else products = db.prepare('SELECT * FROM products').all();
  } catch(e){ products = []; }
  products = products.map(p => Object.assign({}, p, { safeImage: (p.image && require('fs').existsSync(require('path').join(__dirname, 'public', p.image.replace(/^\//, '')))) ? p.image : choosePlaceholder(p.title) }));
  // hide hero & top search for explicit search pages
  res.render('shop/index', { products, categories: res.locals.categories, activeCategory: null, q, hideHero: true, error: req.query.error || null });
});

app.get('/product/:id', (req,res)=>{
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!product) return res.status(404).send('Not found');
  // prepare images array (support new `images` JSON column or legacy `image` field)
  try {
    if (product.images && typeof product.images === 'string' && product.images.trim()) {
      product.images = JSON.parse(product.images);
    } else if (product.image) {
      product.images = [product.image];
    } else {
      product.images = [];
    }
  } catch (e) { product.images = product.image ? [product.image] : []; }
  product.images = (product.images || []).map(img => isValidImagePath(img) ? img : choosePlaceholder(product.title));
  product.safeImage = product.images.length ? product.images[0] : choosePlaceholder(product.title);
  // find related products (same category) to allow left/right nav to go between related items
  // Order by units sold (descending) then id as fallback
  let relatedProductsData = [];
  try {
    if (product.category) {
      const sql = `SELECT p.id, p.title, p.image, p.images,
        COALESCE(oi.qty_sum,0) as sold
        FROM products p
        LEFT JOIN (
          SELECT product_id, SUM(qty) as qty_sum FROM order_items GROUP BY product_id
        ) oi ON oi.product_id = p.id
        WHERE p.category = ? AND p.id != ?
        ORDER BY sold DESC, p.id LIMIT 50`;
      const rows = db.prepare(sql).all(product.category, product.id);
      relatedProductsData = rows.map(r => {
        let imgs = [];
        try { if (r.images && typeof r.images === 'string' && r.images.trim()) imgs = JSON.parse(r.images); }
        catch(e) { if (r.image) imgs = [r.image]; }
        if (!imgs.length && r.image) imgs = [r.image];
        const safe = (imgs[0] && isValidImagePath(imgs[0])) ? imgs[0] : (isValidImagePath(r.image) ? r.image : choosePlaceholder(r.title));
        return { id: r.id, title: r.title, image: safe };
      });
    }
  } catch(e){ relatedProductsData = []; }
  // include current product as first element for cyclic navigation convenience
  const relatedProducts = [ { id: product.id, title: product.title, image: product.safeImage } ].concat(relatedProductsData);
  res.render('shop/product', { product, relatedProducts, error: req.query.error || null });
});

// JSON endpoint for product details (used by AJAX on listing page)
app.get('/product-json/:id', (req,res)=>{
  try {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Not found' });
    // prepare images array
    try {
      if (product.images && typeof product.images === 'string' && product.images.trim()) product.images = JSON.parse(product.images);
      else if (product.image) product.images = [product.image]; else product.images = [];
    } catch(e) { product.images = product.image ? [product.image] : []; }
    product.images = (product.images || []).map(img => isValidImagePath(img) ? img : choosePlaceholder(product.title));
    product.safeImage = product.images.length ? product.images[0] : choosePlaceholder(product.title);
    res.json({ product });
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// auth
app.get('/register',(req,res)=>res.render('auth/register'));
app.post('/register',(req,res)=>{
  const { name,email,password } = req.body;
  if (!email || !password) return res.render('auth/register', { error: 'Vui lòng điền email và mật khẩu.' });
  const normalizedEmail = (email || '').toLowerCase().trim();
  if (!normalizedEmail.includes('@')) return res.render('auth/register', { error: 'Email không hợp lệ (thiếu @).' });
  // Password policy: at least 8 chars, one uppercase, one special char (@ ! ?)
  if (password.length < 8) return res.render('auth/register', { error: 'Mật khẩu phải có ít nhất 8 ký tự, chứa ít nhất 1 chữ hoa và 1 ký tự đặc biệt như @ ! ?' });
  if (!/[A-Z]/.test(password)) return res.render('auth/register', { error: 'Mật khẩu phải có ít nhất 8 ký tự, chứa ít nhất 1 chữ hoa và 1 ký tự đặc biệt như @ ! ?' });
  if (!/[@!?]/.test(password)) return res.render('auth/register', { error: 'Mật khẩu phải có ít nhất 8 ký tự, chứa ít nhất 1 chữ hoa và 1 ký tự đặc biệt như @ ! ?' });
  const hash = bcrypt.hashSync(password,10);
  try {
    db.prepare('INSERT INTO users (name,email,password) VALUES (?,?,?)').run(name,normalizedEmail,hash);
    res.redirect('/login');
  } catch(e) {
    console.error(e.message);
    // likely unique constraint on email
    return res.render('auth/register', { error: 'Email đã được sử dụng.' });
  }
});

app.get('/login',(req,res)=>res.render('auth/login', {
  notice: req.query.notice || null,
  next: sanitizeNextPath(req.query.next)
}));
app.post('/login',(req,res)=>{
  const { email,password } = req.body;
  const nextPath = sanitizeNextPath(req.body.next);
  const loginViewData = { notice: req.body.notice || null, next: nextPath };
  if (!email || !password) return res.render('auth/login', { ...loginViewData, error: 'Vui lòng nhập email và mật khẩu.' });
  const normalizedEmail = (email || '').toLowerCase().trim();
  if (!normalizedEmail.includes('@')) return res.render('auth/login', { ...loginViewData, error: 'Email không hợp lệ (thiếu @).' });
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(normalizedEmail);
  if (!user) return res.render('auth/login', { ...loginViewData, error: 'Email chưa được đăng ký.' });
  if (!bcrypt.compareSync(password, user.password)) return res.render('auth/login', { ...loginViewData, error: 'Mật khẩu không đúng.' });
  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
  // ensure session is saved before redirecting (avoids race on some setups)
  req.session.save(err=>{
    if (err) console.error('Session save error', err);
    if (user.role === 'admin') {
      console.log('Admin logged in:', user.email);
      return res.redirect('/admin');
    }
    // For normal users: merge session cart with persisted cart (so cart survives logout/login)
    try {
      const persisted = loadCartForUser(user.id) || {};
      const sessionCart = req.session.cart || {};
      const merged = Object.assign({}, persisted);
      for (const k of Object.keys(sessionCart)) {
        const qty = parseInt(sessionCart[k]) || 0;
        if (!qty) continue;
        merged[k] = (parseInt(merged[k]) || 0) + qty;
      }
      const normalizedMerge = normalizeCartWithInventory(merged).cart;
      // save merged cart and attach to session
      saveCartForUser(user.id, normalizedMerge);
      req.session.cart = normalizedMerge;
    } catch(e){ console.error('cart merge error', e && e.message); }
    res.redirect(nextPath || '/');
  });
});

function handleLogout(req, res) {
  try {
    if (req.session && req.session.user && req.session.user.id) {
      // persist current session cart for this user
      try { saveCartForUser(req.session.user.id, req.session.cart || {}); } catch(e) { console.error('save cart on logout error', e && e.message); }
    }
  } catch(e){ /* ignore */ }

  if (!req.session) {
    res.clearCookie(SESSION_COOKIE_NAME);
    return res.redirect('/login');
  }

  req.session.destroy((error) => {
    if (error) {
      console.error('Logout session destroy error', error);
      req.session.user = null;
      delete req.session.user;
      req.session.cart = {};
      return req.session.save(() => {
        res.clearCookie(SESSION_COOKIE_NAME);
        res.redirect('/login');
      });
    }

    res.clearCookie(SESSION_COOKIE_NAME);
    res.redirect('/login');
  });
}

app.get('/logout', handleLogout);
app.post('/logout', handleLogout);

// account password change
app.get('/account/password', requireLogin, (req,res)=>{
  // only allow non-admin users to change their password via this route
  if (req.session.user && req.session.user.role === 'admin') return res.redirect('/admin');
  const success = req.query.success ? true : false;
  const error = req.query.error || null;
  res.render('auth/change-password', { success, error });
});

app.post('/account/password', requireLogin, (req,res)=>{
  // prevent admin from using this user change-password endpoint
  if (req.session.user && req.session.user.role === 'admin') return res.redirect('/admin');
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword || !confirmPassword) return res.redirect('/account/password?error=' + encodeURIComponent('Vui lòng điền đầy đủ.'));
  if (newPassword !== confirmPassword) return res.redirect('/account/password?error=' + encodeURIComponent('Mật khẩu mới không khớp.'));
  if (newPassword.length < 6) return res.redirect('/account/password?error=' + encodeURIComponent('Mật khẩu phải có ít nhất 6 ký tự.'));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user) return res.redirect('/login');
  if (!bcrypt.compareSync(currentPassword, user.password)) return res.redirect('/account/password?error=' + encodeURIComponent('Mật khẩu hiện tại không đúng.'));
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, user.id);
  res.redirect('/account/password?success=1');
});

// account profile
app.get('/account', requireLogin, (req,res)=>{
  // do not show admin here
  if (req.session.user && req.session.user.role === 'admin') return res.redirect('/admin');
  // include gender and dob so the form can reflect saved values
  const user = db.prepare('SELECT id,name,email,avatar,phone,gender,dob FROM users WHERE id = ?').get(req.session.user.id);
  const addresses = db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  const error = req.query.error || null;
  const success = req.query.success ? true : false;
  res.render('account/profile', { user, addresses, error, success });
});

app.post('/account', requireLogin, (req,res)=>{
  if (req.session.user && req.session.user.role === 'admin') return res.redirect('/admin');
  const { name, phone, gender, dob } = req.body;
  const trimmedName = (name || '').trim();
  const cleanedPhone = phone ? String(phone).replace(/\s+/g,'') : '';
  // basic phone validation: must be digits only, length 10, starts with 0
  if (phone) {
    if (!/^0\d{9}$/.test(cleanedPhone)) {
      return res.redirect('/account?error=' + encodeURIComponent('Số điện thoại phải bắt đầu bằng 0 và gồm 10 chữ số.'));
    }
  }
  db.prepare('UPDATE users SET name = ?, phone = ?, gender = ?, dob = ? WHERE id = ?')
    .run(trimmedName || null, cleanedPhone || null, gender || null, dob || null, req.session.user.id);

  const primaryAddress = db.prepare('SELECT id, recipient, phone FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC LIMIT 1').get(req.session.user.id);
  if (primaryAddress) {
    const nextRecipient = trimmedName || primaryAddress.recipient;
    const nextPhone = cleanedPhone || primaryAddress.phone;
    db.prepare('UPDATE addresses SET recipient = ?, phone = ? WHERE id = ? AND user_id = ?')
      .run(nextRecipient, nextPhone, primaryAddress.id, req.session.user.id);
  }

  // refresh session fields
  req.session.user.name = trimmedName || req.session.user.name;
  req.session.user.phone = cleanedPhone || req.session.user.phone;
  req.session.user.gender = gender || req.session.user.gender;
  req.session.user.dob = dob || req.session.user.dob;
  res.redirect('/account?success=1');
});

app.post('/account/avatar', requireLogin, upload.single('avatar'), (req,res)=>{
  if (req.session.user && req.session.user.role === 'admin') return res.redirect('/admin');
  if (req.file) {
    const rel = '/images/' + req.file.filename;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(rel, req.session.user.id);
    return res.redirect('/account');
  }
  res.redirect('/account');
});

app.post('/account/addresses', requireLogin, (req,res)=>{
  const { recipient, phone, street, city, postcode } = req.body;
  // validate required fields
  if (!recipient || !phone || !street || !city) {
    return res.redirect('/account?error=' + encodeURIComponent('Vui lòng điền đầy đủ thông tin địa chỉ.'));
  }
  // phone: must be digits only, length 10, start with 0
  const cleaned = String(phone || '').replace(/\s+/g,'');
  if (!/^0\d{9}$/.test(cleaned)) {
    return res.redirect('/account?error=' + encodeURIComponent('Số điện thoại không hợp lệ. Vui lòng nhập 10 chữ số và bắt đầu bằng 0.'));
  }
  db.prepare('INSERT INTO addresses (user_id,recipient,phone,street,city,postcode,is_default) VALUES (?,?,?,?,?,? ,?)')
    .run(req.session.user.id, recipient, cleaned, street, city, postcode || null, 0);
  res.redirect('/account');
});

app.post('/account/addresses/:id/delete', requireLogin, (req,res)=>{
  const id = req.params.id;
  db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').run(id, req.session.user.id);
  res.redirect('/account');
});

app.post('/account/addresses/:id/set-default', requireLogin, (req,res)=>{
  const id = req.params.id;
  const t = db.transaction(()=>{
    db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(req.session.user.id);
    db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?').run(id, req.session.user.id);
  });
  try { t(); } catch(e){}
  res.redirect('/account');
});

// cart in session
app.post('/cart/add', (req,res)=>{
  if (!req.session.user) return res.redirect(buildLoginRedirect(req));
  const { productId, qty, option } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return res.status(400).send('Invalid product');
  const normalizedOption = normalizeProductOption(option);
  if (!normalizedOption) return res.redirect(buildBackUrlWithError(req, 'Vui lòng chọn size trước khi thêm vào giỏ hàng.'));
  req.session.cart = req.session.cart || {};
  // store as compound key when option provided: "<productId>::<option>"
  const key = `${productId}::${normalizedOption}`;
  const requestedQty = Math.max(1, parseInt(qty, 10) || 1);
  const currentCart = req.session.cart || {};
  const otherQty = Object.keys(currentCart).reduce((sum, cartKey) => {
    const parsed = parseCartKey(cartKey);
    if (parsed.productId !== String(productId) || cartKey === key) return sum;
    return sum + (parseInt(currentCart[cartKey], 10) || 0);
  }, 0);
  const currentKeyQty = parseInt(currentCart[key], 10) || 0;
  const availableForKey = Math.max(0, (parseInt(product.stock, 10) || 0) - otherQty);
  const nextQty = Math.min(currentKeyQty + requestedQty, availableForKey);
  if (nextQty <= 0) return res.redirect('/cart?error=' + encodeURIComponent(`${product.title} đã hết hàng.`));
  req.session.cart[key] = nextQty;
  syncCartToSession(req, req.session.cart);
  if (nextQty < currentKeyQty + requestedQty) {
    return res.redirect('/cart?error=' + encodeURIComponent(`${product.title} chỉ còn ${availableForKey} sản phẩm trong kho.`));
  }
  res.redirect('/cart');
});

app.get('/cart', (req,res)=>{
  const normalizedCart = normalizeCartWithInventory(req.session.cart || {});
  syncCartToSession(req, normalizedCart.cart);
  const { items, total } = loadCartItems(normalizedCart.cart);
  // also fetch recent orders for logged-in user to show status updates
  let recentOrders = [];
  try {
    if (req.session.user) {
      const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').all(req.session.user.id);
      recentOrders = orders.map(o=>{
        const items = db.prepare('SELECT oi.*, p.title FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(o.id);
        return { order: o, items };
      });
    }
  } catch(e){ recentOrders = []; }
  res.render('shop/cart',{ items, total, recentOrders, error: req.query.error || null, warning: getInventoryMessage(normalizedCart.adjustments) });
});

app.post('/cart/update', (req,res)=>{
  req.session.cart = req.session.cart || {};
  // support updating multiple items: when the form posts arrays
  const productId = req.body.productId;
  const qty = req.body.qty;
  const optionArr = req.body.option || null;
  if (Array.isArray(productId) && Array.isArray(qty)) {
    // rebuild cart from posted arrays to avoid key collisions
    const newCart = {};
    for (let i = 0; i < productId.length; i++) {
      const pid = productId[i];
      const q = parseInt(qty[i]) || 0;
      const opt = Array.isArray(optionArr) ? optionArr[i] : null;
      if (q <= 0) continue;
      const key = opt ? `${pid}::${opt}` : `${pid}`;
      newCart[key] = (newCart[key] || 0) + q;
    }
    const normalized = normalizeCartWithInventory(newCart);
    syncCartToSession(req, normalized.cart);
    const message = getInventoryMessage(normalized.adjustments);
    return res.redirect('/cart' + (message ? ('?error=' + encodeURIComponent(message)) : ''));
  }
  // single update
  if (!productId) return res.redirect('/cart');
  const q = parseInt(qty)||0;
  if (q <= 0) delete req.session.cart[productId]; else req.session.cart[productId] = q;
  const normalized = normalizeCartWithInventory(req.session.cart);
  syncCartToSession(req, normalized.cart);
  const message = getInventoryMessage(normalized.adjustments);
  res.redirect('/cart' + (message ? ('?error=' + encodeURIComponent(message)) : ''));
});

// buy-now: create a single order immediately for this product (with option)
app.post('/buy-now', (req,res)=>{
  if (!req.session.user) return res.redirect(buildLoginRedirect(req));
  const { productId, qty, option } = req.body;
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) return res.redirect('/');
  const normalizedOption = normalizeProductOption(option);
  if (!normalizedOption) return res.redirect(buildBackUrlWithError(req, 'Vui lòng chọn size trước khi mua hàng.'));
  const q = parseInt(qty)||1;
  const total = p.price * q;
  const availableStock = Math.max(0, parseInt(p.stock, 10) || 0);
  if (q > availableStock) {
    return res.redirect('/product/' + p.id + '?error=' + encodeURIComponent(`${p.title} chỉ còn ${availableStock} sản phẩm trong kho.`));
  }
  const key = `${productId}::${normalizedOption}`;
  req.session.checkoutCart = { [key]: q };
  const normalized = normalizeCartWithInventory(req.session.checkoutCart);
  req.session.checkoutCart = normalized.cart;
  const message = getInventoryMessage(normalized.adjustments);
  return res.redirect('/checkout?source=buy-now' + (message ? ('&error=' + encodeURIComponent(message)) : ''));
});

app.post('/cart/remove', (req,res)=>{
  const { productId } = req.body;
  req.session.cart = req.session.cart || {};
  // support removing by product id (possibly with option keys)
  if (req.session.cart[productId]) delete req.session.cart[productId];
  else {
    // try to delete any key that starts with productId::
    for (const k of Object.keys(req.session.cart)) {
      if (k.split('::')[0] === String(productId)) delete req.session.cart[k];
    }
  }
  syncCartToSession(req, req.session.cart);
  res.redirect('/cart');
});

app.get('/checkout', (req,res)=>{
  if (!req.session.user) return res.redirect('/login');
  if (req.query.source === 'cart') clearCheckoutCart(req);
  return renderCheckoutPage(req, res);
});

app.get('/orders', (req,res)=>{
  if (!req.session.user) return res.redirect('/login');
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  const ordersWithItems = orders.map(o=>{
    const items = db.prepare('SELECT oi.*, p.title FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(o.id);
    return { order: o, items };
  });
  res.render('shop/orders',{ orders: ordersWithItems });
});

app.get('/chat', requireLogin, (req,res)=>{
  if (req.session.user && req.session.user.role === 'admin') return res.redirect('/admin/chats');
  db.prepare("UPDATE chat_messages SET is_read = 1 WHERE user_id = ? AND sender = 'admin' AND is_read = 0").run(req.session.user.id);
  const messages = db.prepare('SELECT id, user_id, sender, content, is_read, created_at FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC, id ASC').all(req.session.user.id);
  res.render('shop/chat', { messages, error: req.query.error || null });
});

app.post('/chat', requireLogin, (req,res)=>{
  if (req.session.user && req.session.user.role === 'admin') return res.redirect('/admin/chats');
  const content = typeof (req.body && req.body.message) === 'string' ? req.body.message.replace(/\r\n/g, '\n').trim().slice(0, 2000) : '';
  if (!content) return res.redirect('/chat?error=' + encodeURIComponent('Vui lòng nhập nội dung tin nhắn.'));
  db.prepare('INSERT INTO chat_messages (user_id, sender, content, is_read) VALUES (?,?,?,0)').run(req.session.user.id, 'user', content);
  res.redirect('/chat');
});

// user-visible order status page (separate from cart)
app.get('/order-status', (req,res)=>{
  if (!req.session.user) return res.redirect('/login');
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  const ordersWithItems = orders.map(o=>{
    const items = db.prepare('SELECT oi.*, p.title FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(o.id);
    return { order: o, items };
  });
  res.render('shop/order-status', { orders: ordersWithItems });
});

// user: view single order
app.get('/order/:id', requireLogin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!order) return res.status(404).send('Not found');
  const items = db.prepare('SELECT oi.*, p.title FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(id);
  // load address attached to order or user's default
  let orderAddress = null;
  if (order.address_id) orderAddress = db.prepare('SELECT * FROM addresses WHERE id = ?').get(order.address_id);
  const defaultAddress = db.prepare('SELECT * FROM addresses WHERE user_id = ? AND is_default = 1').get(req.session.user.id);
  res.render('shop/order-detail', { order, items, orderAddress, defaultAddress, notice: res.locals.flashNotice || req.query.notice || null });
});

// user: edit order (GET form)
app.get('/order/:id/edit', requireLogin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!order) return res.status(404).send('Not found');
  if (order.status === 'shipped' || order.status === 'cancelled') return res.status(400).send('Không thể chỉnh sửa đơn này');
  const activeDiscount = order.discount_code ? getDiscountCodeRecord(order.discount_code) : null;
  const items = db.prepare('SELECT oi.*, p.title, p.stock FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(id)
    .map(item => Object.assign({}, item, {
      editableStock: (parseInt(item.stock, 10) || 0) + (parseInt(item.quantity, 10) || 0)
    }));
  let orderAddress = null;
  if (order.address_id) orderAddress = db.prepare('SELECT * FROM addresses WHERE id = ?').get(order.address_id);
  const user = db.prepare('SELECT id,name,email,phone FROM users WHERE id = ?').get(req.session.user.id);
  res.render('shop/order-edit', { order, items, orderAddress, user, error: req.query.error || null, activeDiscount });
});

// user: update order address/info and editable line items
app.post('/order/:id/update', requireLogin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!order) return res.status(404).send('Not found');
  if (order.status === 'shipped' || order.status === 'cancelled') return res.status(400).send('Không thể chỉnh sửa đơn này');
  const { recipient, phone, street, city, postcode } = req.body;
  const itemIds = Array.isArray(req.body.itemId) ? req.body.itemId : [req.body.itemId];
  const quantities = Array.isArray(req.body.qty) ? req.body.qty : [req.body.qty];
  const options = Array.isArray(req.body.option) ? req.body.option : [req.body.option];
  const editUrl = '/order/' + id + '/edit';

  if (!recipient || !phone || !street || !city) {
    return res.redirect(editUrl + '?error=' + encodeURIComponent('Vui lòng điền đầy đủ thông tin giao hàng.'));
  }

  const cleanedPhone = String(phone || '').replace(/\s+/g, '');
  if (!/^0\d{9}$/.test(cleanedPhone)) {
    return res.redirect(editUrl + '?error=' + encodeURIComponent('Số điện thoại không hợp lệ.'));
  }

  const existingItems = db.prepare('SELECT oi.*, p.title, p.stock FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(id);
  if (!existingItems.length) return res.redirect(editUrl + '?error=' + encodeURIComponent('Đơn hàng không có sản phẩm để chỉnh sửa.'));

  const existingById = new Map(existingItems.map(item => [String(item.id), item]));
  const updatedItems = [];

  for (let index = 0; index < itemIds.length; index += 1) {
    const itemId = String(itemIds[index] || '');
    const existingItem = existingById.get(itemId);
    if (!existingItem) return res.redirect(editUrl + '?error=' + encodeURIComponent('Có sản phẩm trong đơn không hợp lệ.'));

    const nextQuantity = parseInt(quantities[index], 10);
    if (!Number.isInteger(nextQuantity) || nextQuantity < 1) {
      return res.redirect(editUrl + '?error=' + encodeURIComponent('Số lượng mỗi sản phẩm phải từ 1 trở lên.'));
    }

    const rawOption = options[index];
    const normalizedOption = rawOption ? normalizeProductOption(rawOption) : null;
    if (rawOption && !normalizedOption) {
      return res.redirect(editUrl + '?error=' + encodeURIComponent('Size sản phẩm không hợp lệ.'));
    }

    updatedItems.push({
      id: existingItem.id,
      productId: existingItem.product_id,
      title: existingItem.title,
      quantity: nextQuantity,
      oldQuantity: parseInt(existingItem.quantity, 10) || 0,
      price: parseInt(existingItem.price, 10) || 0,
      option: normalizedOption,
      currentStock: parseInt(existingItem.stock, 10) || 0
    });
  }

  const requestedByProduct = new Map();
  updatedItems.forEach(item => {
    const key = String(item.productId);
    requestedByProduct.set(key, (requestedByProduct.get(key) || 0) + item.quantity);
  });

  let addrId = order.address_id || null;
  const previousTotal = parseInt(order.total, 10) || 0;
  let updatedPricing = null;

  try {
    const tx = db.transaction(() => {
      const info = db.prepare('INSERT INTO addresses (user_id,recipient,phone,street,city,postcode,is_default) VALUES (?,?,?,?,?,?,?)')
        .run(req.session.user.id, recipient, cleanedPhone, street, city, postcode || null, 0);
      addrId = info.lastInsertRowid;

      for (const existingItem of existingItems) {
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(existingItem.quantity, existingItem.product_id);
      }

      for (const [productId, requestedQty] of requestedByProduct.entries()) {
        const product = db.prepare('SELECT stock, title FROM products WHERE id = ?').get(productId);
        const availableStock = Math.max(0, parseInt(product && product.stock, 10) || 0);
        if (requestedQty > availableStock) {
          const err = new Error(`${product && product.title ? product.title : 'Sản phẩm'} chỉ còn ${availableStock} sản phẩm trong kho.`);
          err.code = 'INSUFFICIENT_STOCK';
          throw err;
        }
      }

      for (const [productId, requestedQty] of requestedByProduct.entries()) {
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(requestedQty, productId);
      }

      const updateItem = db.prepare('UPDATE order_items SET quantity = ?, option = ? WHERE id = ? AND order_id = ?');
      for (const item of updatedItems) {
        updateItem.run(item.quantity, item.option || null, item.id, id);
      }

      const repricedItems = updatedItems.map(item => ({
        product: { id: item.productId, price: item.price },
        quantity: item.quantity,
        price: item.price
      }));
      const pricing = buildUpdatedOrderPricing(order, repricedItems);
      updatedPricing = pricing;
      db.prepare('UPDATE orders SET address_id = ?, subtotal = ?, discount_amount = ?, discount_code = ?, total = ? WHERE id = ?')
        .run(addrId, pricing.subtotal, pricing.discountAmount, pricing.discountCode, pricing.total, id);
    });

    tx();
  } catch (error) {
    if (error && error.code === 'INSUFFICIENT_STOCK') {
      return res.redirect(editUrl + '?error=' + encodeURIComponent(error.message));
    }
    console.error('Order update error', error && error.message);
    return res.redirect(editUrl + '?error=' + encodeURIComponent('Không thể cập nhật đơn hàng lúc này.'));
  }

  const nextTotal = updatedPricing ? updatedPricing.total : previousTotal;
  const diff = nextTotal - previousTotal;
  let notice = 'Đơn hàng đã được cập nhật thành công.';
  if (diff > 0) {
    notice = `Số lượng hàng đã tăng. Bạn cần thanh toán thêm ${diff.toLocaleString()} VND.`;
  } else if (diff < 0) {
    notice = `Số lượng hàng đã giảm. Bạn sẽ được hoàn ${Math.abs(diff).toLocaleString()} VND về tài khoản.`;
  }

  req.session.flashNotice = notice;
  req.session.save(() => {
    res.redirect('/order/' + id);
  });
});

// user: cancel order
app.post('/order/:id/cancel', requireLogin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!order) return res.status(404).send('Not found');
  if (order.status === 'shipped' || order.status === 'cancelled') return res.redirect('/order-status');
  const tx = db.transaction((orderId) => {
    restoreStockForOrder(orderId);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', orderId);
  });
  tx(id);
  res.redirect('/order-status');
});

// checkout (mock)
app.post('/checkout',(req,res)=>{
  if (!req.session.user) return res.redirect('/login');
  const checkoutView = getCheckoutViewModel(req, { discountCodeInput: req.body && req.body.discountCode, formValues: req.body || {} });
  const { items, discountSummary } = checkoutView;
  if (!items.length) return res.redirect('/cart?error=' + encodeURIComponent('Gio hang trong.'));
  if (discountSummary.error) return res.status(400).render('shop/checkout', checkoutView);
  // capture shipping info from the form and save as an address, then attach to order
  const { recipient, phone, street, city, postcode } = req.body || {};
  let addrId = null;
  try {
    if (recipient && phone && street && city) {
      // make this address the user's default: clear previous default then insert as default
      try { db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(req.session.user.id); } catch(e) { /* ignore */ }
      const ainfo = db.prepare('INSERT INTO addresses (user_id,recipient,phone,street,city,postcode,is_default) VALUES (?,?,?,?,?,?,?)')
        .run(req.session.user.id, recipient, phone, street, city, postcode || null, 1);
      addrId = ainfo.lastInsertRowid;
    }
  } catch(e) { console.error('Address insert error', e.message); }

  let orderId;
  try {
    orderId = createPaidOrder(req.session.user.id, items, discountSummary, addrId);
  } catch (e) {
    if (e && e.code === 'INSUFFICIENT_STOCK') {
      return res.status(400).render('shop/checkout', getCheckoutViewModel(req, {
        error: e.message,
        discountCodeInput: req.body && req.body.discountCode,
        formValues: req.body || {}
      }));
    }
    if (e && e.code === 'DISCOUNT_INVALID') {
      return res.status(400).render('shop/checkout', getCheckoutViewModel(req, {
        error: e.message,
        discountCodeInput: req.body && req.body.discountCode,
        formValues: req.body || {}
      }));
    }
    throw e;
  }
  if (checkoutView.checkoutSource === 'buy-now') clearCheckoutCart(req);
  else syncCartToSession(req, {});
  // send email to user if possible
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const orderHtml = buildOrderConfirmationHtml(orderId, discountSummary);
  if (mailer && user && user.email) {
    mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: user.email, subject: 'Xác nhận đơn hàng', html: orderHtml }).catch(e=>console.error('Mail send error', e.message));
  } else {
    console.log('Order created', orderId, 'user email', user && user.email);
  }
  res.render('shop/checkout-success', { orderId, total: discountSummary.total, discountSummary });
});

// Stripe integration: create a checkout session from the current cart
app.post('/create-stripe-session', async (req,res)=>{
  if (!stripeLib) return res.status(400).json({ error: 'Stripe not configured' });
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  // allow client to POST shipping info here so we can attach it to the order after Stripe success
  try {
    const { recipient, phone, street, city, postcode } = req.body || {};
    if (recipient && phone && street && city) {
      req.session.checkoutAddress = { recipient, phone, street, city, postcode: postcode || null };
    }
  } catch(e) { /* ignore */ }
  const checkoutView = getCheckoutViewModel(req, { discountCodeInput: req.body && req.body.discountCode });
  if (!checkoutView.items.length) return res.status(400).json({ error: 'Giỏ hàng trống.' });
  if (checkoutView.discountSummary.error) return res.status(400).json({ error: checkoutView.discountSummary.error });
  req.session.checkoutDiscountCode = checkoutView.discountSummary.inputCode || null;
  const line_items = buildStripeLineItems(checkoutView.items, checkoutView.discountSummary);
  const origin = req.protocol + '://' + req.get('host');
  try {
    const session = await stripeLib.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      success_url: origin + '/stripe-success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/checkout'
    });
    res.json({ id: session.id });
  } catch (e) {
    console.error('Stripe create session error', e.message);
    res.status(500).json({ error: e.message });
  }
});

// After Stripe Checkout success, create order from session cart (fallback to session)
app.get('/stripe-success', async (req,res)=>{
  if (!req.session.user) return res.redirect('/login');
  if (!stripeLib) return res.redirect('/checkout');
  const sessionId = req.query.session_id;
  try {
    const stripeSession = sessionId ? await stripeLib.checkout.sessions.retrieve(sessionId) : null;
    // if payment succeeded, create order from cart
    const checkoutView = getCheckoutViewModel(req, { discountCodeInput: req.session.checkoutDiscountCode || '' });
    const { items, discountSummary } = checkoutView;
    if (!items.length) return res.redirect('/cart');
    if (discountSummary.error) return renderCheckoutPage(req, res, { error: discountSummary.error, discountCodeInput: req.session.checkoutDiscountCode || '' });
    // if we saved a checkoutAddress in session (from the checkout form), persist it and attach to order
    let addrId = null;
    try {
      const sa = req.session.checkoutAddress;
      if (sa && sa.recipient && sa.phone && sa.street && sa.city) {
        // clear previous default for user
        try { db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(req.session.user.id); } catch(e) { /* ignore */ }
        const ainfo = db.prepare('INSERT INTO addresses (user_id,recipient,phone,street,city,postcode,is_default) VALUES (?,?,?,?,?,?,?)')
          .run(req.session.user.id, sa.recipient, sa.phone, sa.street, sa.city, sa.postcode || null, 1);
        addrId = ainfo.lastInsertRowid;
        // clear session saved checkout address after persisting
        try { delete req.session.checkoutAddress; } catch(e){}
      }
    } catch(e) { console.error('Stripe address save error', e.message); }

    let orderId;
    try {
      orderId = createPaidOrder(req.session.user.id, items, discountSummary, addrId);
    } catch (error) {
      if (error && (error.code === 'DISCOUNT_INVALID' || error.code === 'INSUFFICIENT_STOCK')) {
        return renderCheckoutPage(req, res, {
          error: error.message,
          discountCodeInput: req.session.checkoutDiscountCode || ''
        });
      }
      throw error;
    }
    if (checkoutView.checkoutSource === 'buy-now') clearCheckoutCart(req);
    else syncCartToSession(req, {});
    try { delete req.session.checkoutDiscountCode; } catch(e){}
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    const orderHtml = buildOrderConfirmationHtml(orderId, discountSummary);
    if (mailer && user && user.email) {
      mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: user.email, subject: 'Xác nhận đơn hàng', html: orderHtml }).catch(e=>console.error('Mail send error', e.message));
    } else {
      console.log('Order created (stripe)', orderId, 'user', user && user.email);
    }
    res.render('shop/checkout-success', { orderId, total: discountSummary.total, discountSummary });
  } catch (e) {
    console.error('Stripe success handling error', e.message);
    res.redirect('/checkout');
  }
});

// Admin: orders management
app.get('/admin/orders', requireAdmin, (req,res)=>{
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const enriched = orders.map(o=>{
    const items = db.prepare('SELECT oi.*, p.title FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(o.id);
    return { order: o, items };
  });
  res.render('admin/orders', { orders: enriched, activeAdmin: 'orders' });
});

app.post('/admin/orders/:id/status', requireAdmin, (req,res)=>{
  const { status } = req.body;
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  // If the order was cancelled by the user, admins should not change it
  if (order && order.status === 'cancelled') {
    return res.redirect('/admin/orders');
  }
  if (order && status === 'cancelled') {
    const tx = db.transaction((orderId) => {
      restoreStockForOrder(orderId);
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
    });
    tx(id);
    return res.redirect('/admin/orders');
  }
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
  res.redirect('/admin/orders');
});

// Admin: view order details
app.get('/admin/orders/:id', requireAdmin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).send('Not found');
  const items = db.prepare('SELECT oi.*, p.title FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(id);
  const user = db.prepare('SELECT id,name,email,phone FROM users WHERE id = ?').get(order.user_id);
  // try to find order's saved address (orders.address_id) or user's default address
  let orderAddress = null;
  if (order.address_id) orderAddress = db.prepare('SELECT * FROM addresses WHERE id = ?').get(order.address_id);
  const defaultAddress = db.prepare('SELECT * FROM addresses WHERE user_id = ? AND is_default = 1').get(order.user_id);
  res.render('admin/order-detail', { order, items, user, orderAddress, defaultAddress });
});

// Admin: delete order
app.post('/admin/orders/:id/delete', requireAdmin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  // do not allow deleting orders that are cancelled (preserve user intent)
  if (order && order.status === 'cancelled') {
    return res.redirect('/admin/orders');
  }
  if (order) restoreStockForOrder(id);
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  res.redirect('/admin/orders');
});

// Admin: edit order (status and attach address)
app.get('/admin/orders/:id/edit', requireAdmin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).send('Not found');
  // If the order was cancelled (by the user), disallow admin from opening the edit form
  if (order.status === 'cancelled') return res.redirect('/admin/orders');
  const items = db.prepare('SELECT oi.*, p.title FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(id);
  const user = db.prepare('SELECT id,name,email,phone FROM users WHERE id = ?').get(order.user_id);
  const addresses = db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY created_at DESC').all(order.user_id);
  res.render('admin/order-edit', { order, items, user, addresses });
});

app.post('/admin/orders/:id/update', requireAdmin, (req,res)=>{
  const id = req.params.id;
  const { status, address_id } = req.body;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (order && order.status === 'cancelled') {
    // do not allow updating a cancelled order
    return res.redirect('/admin/orders');
  }
  if (order && status === 'cancelled') {
    const tx = db.transaction((orderId) => {
      restoreStockForOrder(orderId);
      db.prepare('UPDATE orders SET status = ?, address_id = ? WHERE id = ?').run(status || 'pending', address_id || null, orderId);
    });
    tx(id);
    return res.redirect('/admin/orders');
  }
  db.prepare('UPDATE orders SET status = ?, address_id = ? WHERE id = ?').run(status || 'pending', address_id || null, id);
  res.redirect('/admin/orders');
});



// admin product CRUD (very simple)
function requireAdmin(req,res,next){
  if (!req.session.user) return res.status(403).send('Forbidden');
  try {
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.user.id);
    if (!user || user.role !== 'admin') return res.status(403).send('Forbidden');
    // refresh session user role in case it was changed
    req.session.user.role = user.role;
    next();
  } catch (e) {
    console.error('requireAdmin check error', e.message);
    return res.status(500).send('Server error');
  }
}

// require logged-in user
function requireLogin(req,res,next){
  if (!req.session.user) return res.redirect('/login');
  next();
}

function sanitizeNextPath(rawPath){
  if (typeof rawPath !== 'string') return '/';
  if (!rawPath.startsWith('/') || rawPath.startsWith('//')) return '/';
  return rawPath;
}

function buildLoginRedirect(req){
  const fallbackPath = '/';
  let nextPath = fallbackPath;
  const referer = req.get('referer');

  if (referer) {
    try {
      const refererUrl = new URL(referer);
      nextPath = sanitizeNextPath((refererUrl.pathname || '/') + (refererUrl.search || '') + (refererUrl.hash || ''));
    } catch (error) {
      nextPath = fallbackPath;
    }
  }

  return '/login?notice=' + encodeURIComponent('Bạn cần đăng nhập để mua hàng.') + '&next=' + encodeURIComponent(nextPath);
}

function buildBackUrlWithError(req, message){
  const fallbackPath = '/';
  const referer = req.get('referer');

  if (!referer) {
    return fallbackPath + '?error=' + encodeURIComponent(message);
  }

  try {
    const refererUrl = new URL(referer);
    const pathname = sanitizeNextPath((refererUrl.pathname || '/') + (refererUrl.search || ''));
    const base = new URL(pathname, 'http://local.test');
    base.searchParams.set('error', message);
    return base.pathname + base.search;
  } catch (error) {
    return fallbackPath + '?error=' + encodeURIComponent(message);
  }
}

function getAdminChatInbox() {
  const rows = db.prepare(`
    SELECT
      u.id AS user_id,
      u.name,
      u.email,
      u.avatar,
      last_message.content AS last_content,
      last_message.created_at AS last_created_at,
      last_message.sender AS last_sender,
      COALESCE(unread.unread_count, 0) AS unread_count
    FROM users u
    JOIN (
      SELECT user_id, MAX(id) AS last_message_id
      FROM chat_messages
      GROUP BY user_id
    ) latest ON latest.user_id = u.id
    JOIN chat_messages last_message ON last_message.id = latest.last_message_id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS unread_count
      FROM chat_messages
      WHERE sender = 'user' AND is_read = 0
      GROUP BY user_id
    ) unread ON unread.user_id = u.id
    WHERE u.role IS NULL OR u.role != 'admin'
    ORDER BY last_message.id DESC
  `).all();

  return rows.map(row => ({
    user: {
      id: row.user_id,
      name: row.name || 'Khách hàng',
      email: row.email || '',
      avatar: row.avatar || null
    },
    last: {
      content: row.last_content,
      created_at: row.last_created_at,
      sender: row.last_sender
    },
    unreadCount: parseInt(row.unread_count, 10) || 0
  }));
}

app.get('/admin', requireAdmin, (req,res)=>{
  const products = db.prepare('SELECT * FROM products').all();
  res.render('admin/index',{ products, activeAdmin: 'products' });
});

app.get('/admin/discounts', requireAdmin, (req,res)=>{
  const products = db.prepare('SELECT id, title FROM products ORDER BY title COLLATE NOCASE ASC').all();
  const discounts = db.prepare(`
    SELECT dc.*, p.title AS product_title,
      COUNT(DISTINCT o.user_id) AS total_used
    FROM discount_codes dc
    LEFT JOIN products p ON p.id = dc.product_id
    LEFT JOIN orders o ON upper(o.discount_code) = upper(dc.code)
    GROUP BY dc.id, dc.code, dc.product_id, dc.discount_amount, dc.usage_limit, dc.is_active, dc.created_at, p.title
    ORDER BY dc.created_at DESC, dc.id DESC
  `).all();
  res.render('admin/discounts', {
    products,
    discounts,
    activeAdmin: 'discounts',
    error: req.query.error || null,
    success: req.query.success || null
  });
});

app.post('/admin/discounts', requireAdmin, (req,res)=>{
  const code = normalizeDiscountCode(req.body.code);
  const productId = parseInt(req.body.product_id, 10);
  const discountAmount = parseInt(req.body.discount_amount, 10) || 0;
  const usageLimit = parseInt(req.body.usage_limit, 10) || 0;

  if (!code || !productId || discountAmount <= 0 || usageLimit < 1) {
    return res.redirect('/admin/discounts?error=' + encodeURIComponent('Vui lòng nhập mã, chọn sản phẩm, số tiền giảm và số lượng sử dụng hợp lệ.'));
  }

  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) {
    return res.redirect('/admin/discounts?error=' + encodeURIComponent('Sản phẩm áp dụng không tồn tại.'));
  }

  try {
    db.prepare('INSERT INTO discount_codes (code, product_id, discount_amount, usage_limit, is_active) VALUES (?,?,?,?,1)').run(code, productId, discountAmount, usageLimit);
    return res.redirect('/admin/discounts?success=' + encodeURIComponent('Đã tạo mã giảm giá thành công.'));
  } catch (e) {
    const message = e && /unique/i.test(e.message || '')
      ? 'Mã giảm giá này đã tồn tại.'
      : 'Không thể tạo mã giảm giá.';
    return res.redirect('/admin/discounts?error=' + encodeURIComponent(message));
  }
});

app.post('/admin/discounts/:id/delete', requireAdmin, (req,res)=>{
  db.prepare('DELETE FROM discount_codes WHERE id = ?').run(req.params.id);
  res.redirect('/admin/discounts?success=' + encodeURIComponent('Đã xóa mã giảm giá.'));
});

app.get('/admin/chats', requireAdmin, (req,res)=>{
  const chats = getAdminChatInbox();
  res.render('admin/chats', { chats, activeAdmin: 'chats' });
});

app.get('/admin/chat/:userId', requireAdmin, (req,res)=>{
  const userId = parseInt(req.params.userId, 10);
  if (!userId) return res.status(404).send('Not found');
  const user = db.prepare('SELECT id, name, email, avatar FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).send('Not found');
  db.prepare("UPDATE chat_messages SET is_read = 1 WHERE user_id = ? AND sender = 'user' AND is_read = 0").run(userId);
  const messages = db.prepare('SELECT id, user_id, sender, content, is_read, created_at FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC, id ASC').all(userId);
  res.render('admin/chat-thread', { user, messages, activeAdmin: 'chats', error: req.query.error || null });
});

app.post('/admin/chat/:userId', requireAdmin, (req,res)=>{
  const userId = parseInt(req.params.userId, 10);
  if (!userId) return res.status(404).send('Not found');
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).send('Not found');
  const content = typeof (req.body && req.body.message) === 'string' ? req.body.message.replace(/\r\n/g, '\n').trim().slice(0, 2000) : '';
  if (!content) return res.redirect('/admin/chat/' + userId + '?error=' + encodeURIComponent('Vui lòng nhập nội dung phản hồi.'));
  db.prepare('INSERT INTO chat_messages (user_id, sender, content, is_read) VALUES (?,?,?,0)').run(userId, 'admin', content);
  res.redirect('/admin/chat/' + userId);
});

// Admin: sales / revenue report
app.get('/admin/sales', requireAdmin, (req,res)=>{
  try {
    const period = (req.query.period || 'month');
    const now = new Date();
    let since = new Date(now);
    if (period === 'day') {
      since.setDate(now.getDate() - 1);
    } else if (period === 'week') {
      since.setDate(now.getDate() - 7);
    } else {
      // month
      since.setDate(now.getDate() - 30);
    }
    const sinceIso = since.toISOString();

    const rows = db.prepare(`
      SELECT oi.product_id, p.title, p.image, SUM(oi.quantity) AS total_qty, SUM(oi.quantity * oi.price) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.status != 'cancelled' AND datetime(o.created_at) >= datetime(?)
      GROUP BY oi.product_id
      ORDER BY total_qty DESC
      LIMIT 50
    `).all(sinceIso);
    const formatted = rows.map(r=>{
      const safeImage = isValidImagePath(r.image) ? r.image : choosePlaceholder(r.title);
      return Object.assign({}, r, { safeImage, revenue: r.revenue || 0, total_qty: r.total_qty || 0 });
    });

    const summary = db.prepare(`
      SELECT COUNT(*) AS total_orders, SUM(o.total) AS total_revenue, COUNT(DISTINCT o.user_id) AS total_customers
      FROM orders o
      WHERE o.status != 'cancelled' AND datetime(o.created_at) >= datetime(?)
    `).get(sinceIso) || {};

    const totalRevenue = parseInt(summary.total_revenue, 10) || 0;
    const totalOrders = parseInt(summary.total_orders, 10) || 0;
    const totalCustomers = parseInt(summary.total_customers, 10) || 0;
    const averageOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
    const totalUnitsSold = formatted.reduce((sum, row) => sum + (parseInt(row.total_qty, 10) || 0), 0);
    const topProduct = formatted.length ? formatted[0] : null;

    const dayRows = db.prepare(`
      SELECT date(o.created_at) AS day, COUNT(*) as orders_count, SUM(o.total) AS revenue
      FROM orders o
      WHERE o.status != 'cancelled' AND datetime(o.created_at) >= datetime(?)
      GROUP BY day
      ORDER BY day DESC
    `).all(sinceIso);
    const dailyHistory = (dayRows || []).map(r=>({ day: r.day, orders: r.orders_count || 0, revenue: r.revenue || 0 }));

    const chartDays = (dailyHistory || []).slice().reverse().map(d=>d.day);
    const chartRevenue = (dailyHistory || []).slice().reverse().map(d=>d.revenue || 0);
    const chartOrders = (dailyHistory || []).slice().reverse().map(d=>d.orders || 0);

    const topCustomers = db.prepare(`
      SELECT o.user_id, u.name, u.email, COUNT(o.id) AS orders_count, SUM(o.total) AS total_spent
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.status != 'cancelled' AND datetime(o.created_at) >= datetime(?)
      GROUP BY o.user_id, u.name, u.email
      ORDER BY total_spent DESC, orders_count DESC
      LIMIT 8
    `).all(sinceIso).map(row => ({
      user_id: row.user_id,
      name: row.name || 'Khách hàng',
      email: row.email || '',
      orders_count: parseInt(row.orders_count, 10) || 0,
      total_spent: parseInt(row.total_spent, 10) || 0
    }));

    const topProductChart = formatted.slice(0, 5).map(item => ({
      title: item.title,
      qty: parseInt(item.total_qty, 10) || 0,
      revenue: parseInt(item.revenue, 10) || 0
    }));

    const latestDays = dailyHistory.slice(0, 7);

    res.render('admin/sales', {
      rows: formatted,
      period,
      totalRevenue,
      totalOrders,
      totalCustomers,
      totalUnitsSold,
      averageOrderValue,
      topProduct,
      topCustomers,
      dailyHistory,
      latestDays,
      chartDays,
      chartRevenue,
      chartOrders,
      topProductChart,
      activeAdmin: 'sales'
    });
  } catch (e) {
    console.error('Sales report error', e && e.message);
    res.status(500).send('Server error generating sales report');
  }
});

// Export sales CSV for selected period (period=day|week|month)
app.get('/admin/sales/export', requireAdmin, (req,res)=>{
  try {
    const period = (req.query.period || 'month');
    const now = new Date();
    let since = new Date(now);
    if (period === 'day') since.setDate(now.getDate() - 1);
    else if (period === 'week') since.setDate(now.getDate() - 7);
    else since.setDate(now.getDate() - 30);
    const sinceIso = since.toISOString();
    // export per-day summary
    const rows = db.prepare(`
      SELECT date(o.created_at) AS day, COUNT(*) as orders_count, SUM(o.total) AS revenue
      FROM orders o
      WHERE o.status != 'cancelled' AND datetime(o.created_at) >= datetime(?)
      GROUP BY day
      ORDER BY day DESC
    `).all(sinceIso);
    const lines = ['day,orders,revenue'];
    for (const r of rows) lines.push([r.day, r.orders_count||0, r.revenue||0].join(','));
    const csv = lines.join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sales-${period}.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error('Sales export error', e && e.message);
    res.status(500).send('Export error');
  }
});

// Admin: view sales details for a single day (YYYY-MM-DD)
app.get('/admin/sales/day/:day', requireAdmin, (req,res)=>{
  try {
    const day = req.params.day; // expect format YYYY-MM-DD
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 20;
    const offset = (page - 1) * pageSize;

    const prodRows = db.prepare(`
      SELECT oi.product_id, p.title, p.image, SUM(oi.quantity) AS total_qty, SUM(oi.quantity * oi.price) AS revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.status != 'cancelled' AND date(o.created_at) = date(?)
      GROUP BY oi.product_id
      ORDER BY total_qty DESC
    `).all(day);
    const products = (prodRows || []).map(r=>({
      product_id: r.product_id,
      title: r.title,
      safeImage: isValidImagePath(r.image) ? r.image : choosePlaceholder(r.title),
      total_qty: r.total_qty || 0,
      revenue: r.revenue || 0
    }));

    const orders = db.prepare(`
      SELECT o.*, u.name AS customer_name, u.email AS customer_email
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.status != 'cancelled' AND date(o.created_at) = date(?)
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(day, pageSize, offset);
    const countRow = db.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status != 'cancelled' AND date(created_at) = date(?)").get(day);
    const totalOrders = countRow ? (countRow.cnt || 0) : 0;
    const totalPages = Math.max(1, Math.ceil(totalOrders / pageSize));

    const totalRevenue = products.reduce((s,p)=>s + (p.revenue||0), 0);
    const totalUnitsSold = products.reduce((s,p)=>s + (p.total_qty||0), 0);
    const topCustomers = db.prepare(`
      SELECT o.user_id, u.name, u.email, COUNT(o.id) AS orders_count, SUM(o.total) AS total_spent
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      WHERE o.status != 'cancelled' AND date(o.created_at) = date(?)
      GROUP BY o.user_id, u.name, u.email
      ORDER BY total_spent DESC, orders_count DESC
      LIMIT 5
    `).all(day).map(row => ({
      user_id: row.user_id,
      name: row.name || 'Khách hàng',
      email: row.email || '',
      orders_count: parseInt(row.orders_count, 10) || 0,
      total_spent: parseInt(row.total_spent, 10) || 0
    }));
    const topProduct = products.length ? products[0] : null;

    res.render('admin/sales-day', {
      day,
      products,
      orders,
      totalRevenue,
      totalOrders,
      totalUnitsSold,
      topCustomers,
      topProduct,
      page,
      pageSize,
      totalPages,
      period: req.query.period || 'day',
      activeAdmin: 'sales'
    });
  } catch (e) {
    console.error('Sales day detail error', e && e.message);
    if (e && e.stack) console.error(e.stack);
    res.status(500).send('Server error');
  }
});

// Export CSV for a single day (orders list)
app.get('/admin/sales/day/:day/export', requireAdmin, (req,res)=>{
  try {
    const day = req.params.day;
    const orders = db.prepare("SELECT * FROM orders WHERE status != 'cancelled' AND date(created_at) = date(?) ORDER BY created_at DESC").all(day);
    const lines = ['order_id,created_at,user_id,total,status,address_id'];
    for (const o of orders) lines.push([o.id, o.created_at, o.user_id || '', o.total || 0, o.status || '', o.address_id || ''].join(','));
    const csv = lines.join('\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sales-${day}.csv"`);
    return res.send(csv);
  } catch (e) {
    console.error('Sales day export error', e && e.message);
    res.status(500).send('Export error');
  }
});

app.get('/admin/edit/:id', requireAdmin, (req,res)=>{
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).send('Not found');
  res.render('admin/edit',{ product: p, activeAdmin: 'products' });
});

// allow multiple images upload (field name: images[]) and removal via removeImages[]
app.post('/admin/edit/:id', requireAdmin, upload.any(), (req,res)=>{
  const id = req.params.id;
  const { title,description,price,stock,category,removeImages } = req.body;
  const filesArr = Array.isArray(req.files) ? req.files : [];
  // fetch current images
  const cur = db.prepare('SELECT images FROM products WHERE id = ?').get(id);
  let images = [];
  try { images = cur && cur.images ? JSON.parse(cur.images) : []; } catch(e){ images = []; }
  // remove selected images (client sends filenames to removeImages[])
  if (removeImages) {
    const toRemove = Array.isArray(removeImages) ? removeImages : [removeImages];
    images = images.filter(img => !toRemove.includes(img));
    // delete files from disk
    for (const r of toRemove) {
      try { if (r && r.startsWith('/images/')) fs.unlinkSync(path.join(__dirname,'public', r.replace(/^\//,''))); } catch(e){}
    }
  }
  // add newly uploaded files
  for (const f of filesArr) images.push('/images/'+f.filename);
  // update image column too for backward compatibility (first image)
  const imageFirst = images.length ? images[0] : null;
  db.prepare('UPDATE products SET title=?,description=?,price=?,stock=?,image=?,images=?,category=? WHERE id=?')
    .run(title,description,parseInt(price)||0,parseInt(stock)||0,imageFirst, JSON.stringify(images), category || null, id);
  res.redirect('/admin');
});

app.get('/admin/new', requireAdmin, (req,res)=>res.render('admin/new', { activeAdmin: 'new' }));
app.post('/admin/new', requireAdmin, upload.any(), (req,res)=>{
  const { title,description,price,stock,category } = req.body;
  const filesArr = Array.isArray(req.files) ? req.files : [];
  const images = filesArr.map(f=> '/images/'+f.filename);
  const imageFirst = images.length ? images[0] : '/images/default.svg';
  db.prepare('INSERT INTO products (title,description,price,stock,image,images,category) VALUES (?,?,?,?,?,?,?)')
    .run(title,description,parseInt(price)||0,parseInt(stock)||0,imageFirst, JSON.stringify(images), category || null);
  res.redirect('/admin');
});

app.post('/admin/delete/:id', requireAdmin, (req,res)=>{
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

// basic error handler
let _lastError = null;
app.use((err,req,res,next)=>{
  _lastError = err;
  try { require('fs').writeFileSync(require('path').join(__dirname,'last_error.log'), (err && err.stack) ? err.stack : String(err)); } catch(e) { /* ignore */ }
  console.error(err && err.stack ? err.stack : err);
  // in non-production show stack inline for localhost requests
  if ((process.env.NODE_ENV !== 'production') && req.ip === '::1' || req.ip === '127.0.0.1') {
    res.status(500).send('<pre>Server error\n\n' + (err && err.stack ? err.stack : String(err)) + '</pre>');
    return;
  }
  res.status(500).send('Server error');
});

// debug endpoint to view last error (development only, localhost)
app.get('/__last_error', (req,res)=>{
  if (process.env.NODE_ENV === 'production') return res.status(404).send('Not found');
  if (!(req.ip === '::1' || req.ip === '127.0.0.1')) return res.status(403).send('Forbidden');
  try {
    const txt = require('fs').readFileSync(require('path').join(__dirname,'last_error.log'),'utf8');
    res.type('text').send(txt || 'No error logged');
  } catch(e){ res.type('text').send('No error logged'); }
});

// lightweight health endpoint for smoke checks
app.get('/_health', (req,res)=>{
  try {
    const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
    const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    res.json({ ok: true, productCount, userCount, pid: process.pid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} dang duoc su dung. Hay dung tien trinh cu hoac chay lai voi PORT khac.`);
    process.exit(1);
  }

  console.error('Server start error:', error);
  process.exit(1);
});
