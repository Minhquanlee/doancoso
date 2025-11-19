# Demo Shop (Phiên bản tiếng Việt)

Trang demo bán quần áo đơn giản sử dụng Express + EJS + SQLite (better-sqlite3).

## Tóm tắt
- Ứng dụng thương mại điện tử render phía server, viết bằng Node.js + Express, dùng EJS cho template.
- Cơ sở dữ liệu: SQLite (`data.sqlite`) qua thư viện `better-sqlite3`.
- Bao gồm giao diện admin, lưu giỏ hàng, quản lý đơn hàng, địa chỉ và hệ thống tin nhắn nhỏ.

## Công nghệ chính
- Node.js: môi trường chạy JavaScript phía server.
- Express: framework HTTP và routing.
- EJS: template engine (các view nằm trong `views/`).
- better-sqlite3: client SQLite đồng bộ nhanh.
- connect-sqlite3: lưu session bằng SQLite.
- bcrypt: mã hóa password.
- multer: xử lý upload file (ảnh sản phẩm).
- stripe: tích hợp thanh toán (tùy chọn).
- nodemailer: gửi email (tùy chọn).
- Docker / Docker Compose: đóng gói container (project có `Dockerfile` và `docker-compose.yml`).

Tiện ích front-end
- CSS tĩnh ở `public/styles.css`, JS ở `public/js/`.
- `qrcode.min.js` có sẵn cho việc tạo QR client-side.

Công cụ phát triển
- nodemon (dev) để reload tự động khi phát triển.

## Yêu cầu
- Node.js 16+ (khuyến nghị 18+)
- npm
- (Tùy chọn) Docker Desktop nếu muốn chạy bằng Docker

## Cài & chạy nhanh (chạy local bằng Node)
Mở PowerShell trong thư mục project:

```powershell
cd C:\Users\minhq\OneDrive\Desktop\doancosoweb
npm install
# phát triển (tự reload)
npm run dev
```

Hoặc chạy trực tiếp:

```powershell
node .\server.js
```

Thay đổi port cho lần chạy hiện tại:

```powershell
$env:PORT=5000; npm run dev
```

## Chạy bằng Docker (tùy chọn)
Build và chạy image cục bộ:

```powershell
docker build -t doancosoweb:latest .
docker run -p 3000:3000 -e PORT=3000 -v %cd%/public/images:/app/public/images doancosoweb:latest
```

Hoặc dùng docker-compose (khuyến nghị mount `data.sqlite` và `public/images` để giữ dữ liệu):

```powershell
docker compose up --build -d
```

Lưu ý: đảm bảo `docker-compose.yml` mount `./data.sqlite:/app/data.sqlite` (hoặc mount cả thư mục) để tránh mất dữ liệu khi container bị xoá.

## Tài khoản admin (mặc định)
- email: `admin@local`
- mật khẩu: `adminpass`

## Biến môi trường quan trọng
- `PORT` — port server lắng nghe (mặc định nếu không set)
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` — bật Stripe
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — bật gửi email

## Cơ sở dữ liệu (SQLite)
- File DB chính: `data.sqlite` nằm ở thư mục gốc project. Tất cả các bảng (users, products, orders, addresses, carts, messages, order_items) nằm trong file này.
- File session (nếu dùng): `sessions.sqlite`.

Các lệnh hữu ích (PowerShell):

```powershell
# liệt kê bảng
sqlite3 .\data.sqlite ".tables"

# hiển thị schema cho mọi bảng
sqlite3 .\data.sqlite "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"

# kiểm tra tính toàn vẹn DB
sqlite3 .\data.sqlite "PRAGMA integrity_check;"

# xem 10 dòng đầu bảng users
sqlite3 -header -csv .\data.sqlite "SELECT * FROM users LIMIT 10;"

# xuất users ra CSV
sqlite3 -header -csv .\data.sqlite "SELECT * FROM users;" > .\exports\users.csv
```

Mình có thêm script `scripts/inspect_db.js` để in danh sách bảng, schema và tối đa 5 dòng mẫu; chạy bằng:

```powershell
node .\scripts\inspect_db.js
```

## Sao lưu / export
- Sao lưu DB: copy file `data.sqlite` khi ứng dụng tắt (hoặc đảm bảo không có ghi khi copy).

```powershell
Copy-Item .\data.sqlite .\backups\data-$(Get-Date -Format yyyyMMddHHmmss).sqlite
```

## Ghi chú & cảnh báo
- SQLite là file-based, phù hợp cho dev và môi trường nhỏ. Nếu cần scale hoặc chạy nhiều replica, hãy chuyển sang Postgres hoặc MySQL.
- Khi chạy Docker, mount `data.sqlite` và `public/images` để giữ upload và thay đổi DB.
- Không commit secrets (Stripe keys, SMTP) vào source — dùng biến môi trường.

## Khắc phục sự cố
- `EADDRINUSE`: port đang bị chiếm — dừng process đó hoặc đổi `PORT`.
- Thiếu package: chạy `npm install`.
- Lỗi Docker: đảm bảo Docker Desktop đang chạy và backend WSL2 (nếu dùng Windows) được bật.


