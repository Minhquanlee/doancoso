const https = require('https');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data.sqlite'));
const imagesDir = path.join(__dirname, '..', 'public', 'images');
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

function keywordForCategory(cat) {
  if (!cat) return 'clothing';
  const c = cat.toString().toLowerCase();
  if (c.includes('áo') || c.includes('ao') || c.includes('shirt') || c.includes('polo') || c.includes('hoodie')) return 'shirt';
  if (c.includes('quần') || c.includes('quan') || c.includes('jeans') || c.includes('trousers') || c.includes('short')) return 'pants';
  if (c.includes('váy') || c.includes('dam') || c.includes('dress')) return 'dress';
  if (c.includes('mũ') || c.includes('mu') || c.includes('cap') || c.includes('beanie') || c.includes('bucket')) return 'hat';
  if (c.includes('áo khoác') || c.includes('khoác') || c.includes('coat') || c.includes('jacket')) return 'jacket';
  if (c.includes('polo')) return 'polo shirt';
  return 'clothing';
}

function download(url, dest, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirect
        const location = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(download(location, dest, maxRedirects - 1));
      }
      if (res.statusCode !== 200) return reject(new Error('Failed to fetch ' + url + ' status ' + res.statusCode));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', (err) => { try { fs.unlinkSync(dest); } catch(e){}; reject(err); });
    }).on('error', reject);
  });
}

function isPlaceholderImage(imgPath) {
  if (!imgPath) return true;
  const lower = imgPath.toLowerCase();
  if (lower.includes('placeholder') || lower.includes('default.svg') || lower.endsWith('.svg')) return true;
  // check file exists
  const abs = path.join(__dirname, '..', 'public', imgPath.replace(/^\//, ''));
  try {
    const st = fs.statSync(abs);
    return st.size < 1024; // treat tiny files as placeholder
  } catch(e) { return true; }
}

(async ()=>{
  try {
    const products = db.prepare('SELECT * FROM products').all();
    let added = 0;
    for (const p of products) {
      if (!isPlaceholderImage(p.image)) continue; // skip if has a good image
      const keyword = keywordForCategory(p.category || p.title);
      const url = `https://source.unsplash.com/800x800/?${encodeURIComponent(keyword)}`;
      const filename = `${Date.now()}-${p.id}.jpg`;
      const dest = path.join(imagesDir, filename);
      try {
        console.log('Fetching for product', p.id, p.title, 'keyword=', keyword);
        try {
          await download(url, dest);
        } catch (e) {
          console.warn('Unsplash failed, falling back to picsum for', p.id, e.message);
          // fallback to picsum seeded by product id and keyword
          const seed = encodeURIComponent((keyword + '-' + p.id).slice(0,80));
          const picsum = `https://picsum.photos/seed/${seed}/800/800`;
          await download(picsum, dest);
        }
        const rel = '/images/' + filename;
        db.prepare('UPDATE products SET image = ? WHERE id = ?').run(rel, p.id);
        console.log('Saved', rel);
        added++;
      } catch(e) {
        console.error('Failed to download for', p.id, e.message);
      }
      // small delay to be polite
      await new Promise(r=>setTimeout(r, 300));
    }
    console.log('Done. Images added:', added);
    process.exit(0);
  } catch(e){
    console.error('Script error', e);
    process.exit(1);
  }
})();
