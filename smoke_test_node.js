const http = require('http');
const querystring = require('querystring');
const Database = require('better-sqlite3');

const BASE = process.env.BASE || 'http://localhost:6000';
const db = new Database('data.sqlite');

let cookieJar = '';
function mergeSetCookie(headers) {
  const sc = headers['set-cookie'];
  if (!sc) return;
  // take first cookie parts
  sc.forEach(c => {
    const pair = c.split(';')[0];
    // replace or append
    const name = pair.split('=')[0];
    const re = new RegExp('(?:^|; )' + name + '=[^;]*');
    if (cookieJar.match(re)) {
      cookieJar = cookieJar.replace(re, pair);
    } else {
      cookieJar = cookieJar ? cookieJar + '; ' + pair : pair;
    }
  });
}

function request(method, path, data, headers={}){
  return new Promise((resolve,reject)=>{
    const body = data && typeof data === 'object' && headers['Content-Type']==='application/x-www-form-urlencoded' ? querystring.stringify(data) : data || null;
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + (url.search||''),
      method,
      headers: Object.assign({}, headers)
    };
    if (cookieJar) opts.headers['Cookie'] = cookieJar;
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(opts, res => {
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>{
        const b = Buffer.concat(chunks).toString();
        mergeSetCookie(res.headers);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: b });
      });
    });
    req.on('error',err=>reject(err));
    if (body) req.write(body);
    req.end();
  });
}

async function run(){
  console.log('Starting Node smoke test against', BASE);
  try{
    const h = await request('GET','/_health');
    console.log('/_health', h.statusCode, h.body.slice(0,200));
  } catch(e){ return console.error('Health check failed:', e.message); }

  // register
  try{
    const r = await request('POST','/register',{name:'NT Tester',email:'nttester@example.local',password:'ntpass'},{'Content-Type':'application/x-www-form-urlencoded'});
    console.log('REGISTER', r.statusCode);
  } catch(e){ return console.error('Register failed', e.message); }

  // login
  try{
    const r = await request('POST','/login',{email:'nttester@example.local',password:'ntpass'},{'Content-Type':'application/x-www-form-urlencoded'});
    console.log('LOGIN', r.statusCode, 'cookies:', cookieJar);
  } catch(e){ return console.error('Login failed', e.message); }

  // get a product id
  const p = db.prepare('SELECT id,title FROM products LIMIT 1').get();
  if (!p) return console.error('No product found in DB');
  console.log('Using product', p.id, p.title);

  // add to cart
  try{
    const r = await request('POST','/cart/add',{productId:p.id, qty:1},{'Content-Type':'application/x-www-form-urlencoded'});
    console.log('CART_ADD', r.statusCode);
  } catch(e){ return console.error('Cart add failed', e.message); }

  // view cart
  try{
    const r = await request('GET','/cart');
    console.log('CART_VIEW', r.statusCode, r.body.includes(p.title) ? 'contains product' : 'no product');
  } catch(e){ return console.error('Cart view failed', e.message); }

  // checkout
  try{
    const r = await request('POST','/checkout',null);
    console.log('CHECKOUT', r.statusCode);
  } catch(e){ return console.error('Checkout failed', e.message); }

  // orders
  try{
    const r = await request('GET','/orders');
    console.log('ORDERS', r.statusCode, r.body.length>0 ? 'OK' : 'empty');
  } catch(e){ return console.error('Orders failed', e.message); }

  console.log('Smoke test finished');
}

run();
