const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data.sqlite'));

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

// detect if products table has 'category' column
const cols = db.prepare("PRAGMA table_info('products')").all();
const hasCategory = cols.some(c => c.name === 'category');
let insertWithCat = null;
let insertNoCat = null;
if (hasCategory) insertWithCat = db.prepare('INSERT INTO products (title,description,price,image,stock,category) VALUES (?,?,?,?,?,?)');
else insertNoCat = db.prepare('INSERT INTO products (title,description,price,image,stock) VALUES (?,?,?,?,?)');
const find = db.prepare('SELECT id FROM products WHERE title = ?');
let added = 0;
for (const p of sample) {
  const exists = find.get(p[0]);
  if (!exists) {
    if (hasCategory) insertWithCat.run(p[0], p[1], p[2], p[3], p[4], p[5]);
    else insertNoCat.run(p[0], p[1], p[2], p[3], p[4]);
    added++;
  }
}
console.log('Seed complete, added:', added);
process.exit(0);
