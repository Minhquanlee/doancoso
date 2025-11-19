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

// middleware to expose user to views
// middleware to expose user to views (refresh avatar/name from DB when logged in)
app.use((req,res,next)=>{
  res.locals.stripePublishable = process.env.STRIPE_PUBLISHABLE_KEY || null;
  if (req.session.user && req.session.user.id) {
    try {
      const u = db.prepare('SELECT id,name,email,role,avatar FROM users WHERE id = ?').get(req.session.user.id);
      if (u) {
        // merge fields into session user and expose to views
        req.session.user.name = u.name;
        req.session.user.role = u.role;
        req.session.user.avatar = u.avatar;
        res.locals.currentUser = req.session.user;
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
  res.render('shop/index',{ products, categories: res.locals.categories, activeCategory: null, title: 'Tìm kiếm: '+q, q, hideHero: true });
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
  res.render('shop/index', { products, categories, activeCategory: category || null, hideHero: !!category });
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
  res.render('shop/index', { products, categories: res.locals.categories, activeCategory: null, q, hideHero: true });
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
  res.render('shop/product', { product, relatedProducts });
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

app.get('/login',(req,res)=>res.render('auth/login'));
app.post('/login',(req,res)=>{
  const { email,password } = req.body;
  if (!email || !password) return res.render('auth/login', { error: 'Vui lòng nhập email và mật khẩu.' });
  const normalizedEmail = (email || '').toLowerCase().trim();
  if (!normalizedEmail.includes('@')) return res.render('auth/login', { error: 'Email không hợp lệ (thiếu @).' });
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(normalizedEmail);
  if (!user) return res.render('auth/login', { error: 'Email chưa được đăng ký.' });
  if (!bcrypt.compareSync(password, user.password)) return res.render('auth/login', { error: 'Mật khẩu không đúng.' });
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
      // save merged cart and attach to session
      saveCartForUser(user.id, merged);
      req.session.cart = merged;
    } catch(e){ console.error('cart merge error', e && e.message); }
    res.redirect('/');
  });
});

app.post('/logout',(req,res)=>{
  try {
    if (req.session && req.session.user && req.session.user.id) {
      // persist current session cart for this user
      try { saveCartForUser(req.session.user.id, req.session.cart || {}); } catch(e) { console.error('save cart on logout error', e && e.message); }
    }
  } catch(e){ /* ignore */ }
  req.session.destroy(()=>res.redirect('/'));
});

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
  res.render('account/profile', { user, addresses, error });
});

app.post('/account', requireLogin, (req,res)=>{
  if (req.session.user && req.session.user.role === 'admin') return res.redirect('/admin');
  const { name, phone, gender, dob } = req.body;
  // basic phone validation: must be digits only, length 10, starts with 0
  if (phone) {
    const cleaned = String(phone).replace(/\s+/g,'');
    if (!/^0\d{9}$/.test(cleaned)) {
      return res.redirect('/account?error=' + encodeURIComponent('Số điện thoại phải bắt đầu bằng 0 và gồm 10 chữ số.'));
    }
  }
  db.prepare('UPDATE users SET name = ?, phone = ?, gender = ?, dob = ? WHERE id = ?')
    .run(name || null, phone || null, gender || null, dob || null, req.session.user.id);
  // refresh session fields
  req.session.user.name = name || req.session.user.name;
  req.session.user.gender = gender || req.session.user.gender;
  req.session.user.dob = dob || req.session.user.dob;
  // after saving profile info, go back to homepage as requested
  res.redirect('/');
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
  const { productId, qty, option } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return res.status(400).send('Invalid product');
  req.session.cart = req.session.cart || {};
  // store as compound key when option provided: "<productId>::<option>"
  const key = option ? `${productId}::${option}` : `${productId}`;
  req.session.cart[key] = (req.session.cart[key] || 0) + (parseInt(qty)||1);
  res.redirect('/cart');
});

app.get('/cart', (req,res)=>{
  const cart = req.session.cart || {};
  const items = [];
  let total = 0;
  for (const pid in cart) {
    // support compound keys: id::option
    const parts = pid.split('::');
    const realId = parts[0];
    const option = parts[1] || null;
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(realId);
    if (!p) continue;
    const q = cart[pid];
    p.safeImage = isValidImagePath(p.image) ? p.image : choosePlaceholder(p.title);
    items.push({ product: p, quantity: q, option });
    total += p.price * q;
  }
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
  res.render('shop/cart',{ items, total, recentOrders });
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
    req.session.cart = newCart;
    return res.redirect('/cart');
  }
  // single update
  if (!productId) return res.redirect('/cart');
  const q = parseInt(qty)||0;
  if (q <= 0) delete req.session.cart[productId]; else req.session.cart[productId] = q;
  res.redirect('/cart');
});

// buy-now: create a single order immediately for this product (with option)
app.post('/buy-now', (req,res)=>{
  if (!req.session.user) return res.redirect('/login');
  const { productId, qty, option } = req.body;
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) return res.redirect('/');
  const q = parseInt(qty)||1;
  const total = p.price * q;
  const info = db.prepare('INSERT INTO orders (user_id,total,status) VALUES (?,?,?)').run(req.session.user.id,total,'paid');
  const orderId = info.lastInsertRowid;
  db.prepare('INSERT INTO order_items (order_id,product_id,quantity,price,option) VALUES (?,?,?,?,?)').run(orderId,p.id,q,p.price, option||null);
  // clear session cart and persisted cart for this user
  req.session.cart = {};
  try { if (req.session.user && req.session.user.id) saveCartForUser(req.session.user.id, {}); } catch(e){}
  res.render('shop/checkout-success', { orderId, total });
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
  res.redirect('/cart');
});

app.get('/checkout', (req,res)=>{
  if (!req.session.user) return res.redirect('/login');
  const cart = req.session.cart || {};
  const items = [];
  let total = 0;
  for (const pid in cart) {
    // support compound keys like '123::M'
    const parts = pid.split('::');
    const realId = parts[0];
    const option = parts[1] || null;
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(realId);
    if (!p) continue;
    const q = cart[pid];
    p.safeImage = (p.image && require('fs').existsSync(require('path').join(__dirname, 'public', p.image.replace(/^\//, '')))) ? p.image : '/images/default.svg';
    items.push({ product: p, quantity: q, option });
    total += p.price * q;
  }
  if (items.length === 0) return res.redirect('/cart');
  // try to fetch user's default address (if any) to prefill/skip form
  const defaultAddress = db.prepare('SELECT * FROM addresses WHERE user_id = ? AND is_default = 1').get(req.session.user.id);
  res.render('shop/checkout',{ items, total, defaultAddress, stripePublishable: process.env.STRIPE_PUBLISHABLE || null });
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
  res.render('shop/order-detail', { order, items, orderAddress, defaultAddress });
});

// user: edit order (GET form)
app.get('/order/:id/edit', requireLogin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!order) return res.status(404).send('Not found');
  if (order.status === 'shipped' || order.status === 'cancelled') return res.status(400).send('Không thể chỉnh sửa đơn này');
  const items = db.prepare('SELECT oi.*, p.title FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?').all(id);
  let orderAddress = null;
  if (order.address_id) orderAddress = db.prepare('SELECT * FROM addresses WHERE id = ?').get(order.address_id);
  const user = db.prepare('SELECT id,name,email,phone FROM users WHERE id = ?').get(req.session.user.id);
  res.render('shop/order-edit', { order, items, orderAddress, user });
});

// user: update order address/info
app.post('/order/:id/update', requireLogin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!order) return res.status(404).send('Not found');
  if (order.status === 'shipped' || order.status === 'cancelled') return res.status(400).send('Không thể chỉnh sửa đơn này');
  const { recipient, phone, street, city, postcode } = req.body;
  // insert new address and attach to order
  const info = db.prepare('INSERT INTO addresses (user_id,recipient,phone,street,city,postcode,is_default) VALUES (?,?,?,?,?,?,?)')
    .run(req.session.user.id, recipient, phone, street, city, postcode || null, 0);
  const addrId = info.lastInsertRowid;
  db.prepare('UPDATE orders SET address_id = ? WHERE id = ?').run(addrId, id);
  res.redirect('/order-status');
});

// user: cancel order
app.post('/order/:id/cancel', requireLogin, (req,res)=>{
  const id = req.params.id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(id, req.session.user.id);
  if (!order) return res.status(404).send('Not found');
  if (order.status === 'shipped' || order.status === 'cancelled') return res.redirect('/order-status');
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('cancelled', id);
  res.redirect('/order-status');
});

// checkout (mock)
app.post('/checkout',(req,res)=>{
  if (!req.session.user) return res.redirect('/login');
  const cart = req.session.cart || {};
  let total = 0;
  const items = [];
  for (const key in cart) {
    const parts = String(key).split('::');
    const realId = parts[0];
    const option = parts[1] || null;
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(realId);
    if (!p) continue;
    const q = cart[key];
    total += p.price * q;
    items.push({ product: p, quantity: q, option });
  }
  // capture shipping info from the form and save as an address, then attach to order
  const { recipient, phone, street, city, postcode } = req.body || {};
  let addrId = null;
  try {
    if (recipient && phone && street && city) {
      const ainfo = db.prepare('INSERT INTO addresses (user_id,recipient,phone,street,city,postcode,is_default) VALUES (?,?,?,?,?,?,?)')
        .run(req.session.user.id, recipient, phone, street, city, postcode || null, 0);
      addrId = ainfo.lastInsertRowid;
    }
  } catch(e) { console.error('Address insert error', e.message); }

  const info = db.prepare('INSERT INTO orders (user_id,total,status,address_id) VALUES (?,?,?,?)').run(req.session.user.id,total,'paid', addrId);
  const orderId = info.lastInsertRowid;
  const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,quantity,price,option) VALUES (?,?,?,?,?)');
  for (const it of items) {
    insertItem.run(orderId, it.product.id, it.quantity, it.product.price, it.option || null);
  }
  req.session.cart = {};
  try { if (req.session.user && req.session.user.id) saveCartForUser(req.session.user.id, {}); } catch(e){}
  // send email to user if possible
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const orderHtml = `<p>Đơn hàng #${orderId} — Tổng: ${total.toLocaleString()} VND</p>`;
  if (mailer && user && user.email) {
    mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: user.email, subject: 'Xác nhận đơn hàng', html: orderHtml }).catch(e=>console.error('Mail send error', e.message));
  } else {
    console.log('Order created', orderId, 'user email', user && user.email);
  }
  res.render('shop/checkout-success', { orderId, total });
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
  const cart = req.session.cart || {};
  const line_items = [];
  for (const pid in cart) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
    if (!p) continue;
    const q = cart[pid];
    // naive currency conversion: assume VND, convert to USD cents by /1000 then *100
    const unit_amount = Math.max(100, Math.round((p.price/1000)) * 100);
    line_items.push({
      price_data: {
        currency: 'usd',
        product_data: { name: p.title, description: p.description },
        unit_amount
      },
      quantity: q
    });
  }
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
    const cart = req.session.cart || {};
    let total = 0;
    const items = [];
    for (const key in cart) {
      const parts = String(key).split('::');
      const realId = parts[0];
      const option = parts[1] || null;
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(realId);
      if (!p) continue;
      const q = cart[key];
      total += p.price * q;
      items.push({ product: p, quantity: q, option });
    }
    // if we saved a checkoutAddress in session (from the checkout form), persist it and attach to order
    let addrId = null;
    try {
      const sa = req.session.checkoutAddress;
      if (sa && sa.recipient && sa.phone && sa.street && sa.city) {
        const ainfo = db.prepare('INSERT INTO addresses (user_id,recipient,phone,street,city,postcode,is_default) VALUES (?,?,?,?,?,?,?)')
          .run(req.session.user.id, sa.recipient, sa.phone, sa.street, sa.city, sa.postcode || null, 0);
        addrId = ainfo.lastInsertRowid;
      }
    } catch(e) { console.error('Stripe address save error', e.message); }

    const info = db.prepare('INSERT INTO orders (user_id,total,status,address_id) VALUES (?,?,?,?)').run(req.session.user.id,total,'paid', addrId);
    const orderId = info.lastInsertRowid;
  const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,quantity,price,option) VALUES (?,?,?,?,?)');
  for (const it of items) insertItem.run(orderId, it.product.id, it.quantity, it.product.price, it.option || null);
    req.session.cart = {};
    try { if (req.session.user && req.session.user.id) saveCartForUser(req.session.user.id, {}); } catch(e){}
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    const orderHtml = `<p>Đơn hàng #${orderId} — Tổng: ${total.toLocaleString()} VND</p>`;
    if (mailer && user && user.email) {
      mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: user.email, subject: 'Xác nhận đơn hàng', html: orderHtml }).catch(e=>console.error('Mail send error', e.message));
    } else {
      console.log('Order created (stripe)', orderId, 'user', user && user.email);
    }
    res.render('shop/checkout-success', { orderId, total });
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

app.get('/admin', requireAdmin, (req,res)=>{
  const products = db.prepare('SELECT * FROM products').all();
  res.render('admin/index',{ products, activeAdmin: 'products' });
});

// Admin: sales / revenue report
app.get('/admin/sales', requireAdmin, (req,res)=>{
  try {
    // support period filter: day, week, month (default month)
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

    // Aggregate sold quantities and revenue per product within the window, exclude cancelled orders
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

    // compute total revenue in period (can be derived from rows or run an aggregate query)
    let totalRevenue = 0;
    if (formatted && formatted.length) totalRevenue = formatted.reduce((s,r)=>s + (r.revenue||0), 0);

    res.render('admin/sales', { rows: formatted, period, totalRevenue, activeAdmin: 'sales' });
  } catch (e) {
    console.error('Sales report error', e && e.message);
    res.status(500).send('Server error generating sales report');
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

app.listen(5600, '0.0.0.0', ()=>console.log(`Server running on http://localhost:${PORT}`));
