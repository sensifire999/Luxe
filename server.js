const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bodyParser = require('body-parser');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');

// --- 1. DATABASE SETUP ---
if (!fs.existsSync('./sessions')) fs.mkdirSync('./sessions');
const adapter = new FileSync('db.json');
const db = low(adapter);

db.defaults({ 
    products: [], 
    orders: [], 
    verified_users: [] 
}).write();

// --- 2. CONFIGURATION ---
const BOT_TOKEN = '8340786802:AAEu64f_fw5KVQf8TZLmkkB5zjPuNl5sysQ';
const ADMIN_TELEGRAM_ID = 8084057668; 
const ADMIN_PHONE = "9041572652"; 

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
    store: new FileStore({ path: './sessions' }),
    secret: 'luxe-ultimate-2026',
    resave: true, 
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

// --- 3. MIDDLEWARES ---
app.use((req, res, next) => {
    res.locals.user = req.session.phone || null;
    res.locals.cart = req.session.cart || [];
    res.locals.cartCount = (req.session.cart || []).length;
    next();
});

const isAuth = (req, res, next) => {
    if (req.session.verified) return next();
    res.redirect('/user-login');
};

const isAdmin = (req, res, next) => {
    if (req.session.verified && req.session.phone === ADMIN_PHONE) return next();
    res.status(403).send("Unauthorized: Only Admin can access this page.");
};

// --- 4. AUTH & TELEGRAM OTP ---
app.get('/user-login', (req, res) => res.render('user-login'));

app.post('/initiate-verify', (req, res) => {
    let phone = (req.body.phone || '').replace(/\D/g, '').slice(-10);
    req.session.tempPhone = phone;
    req.session.save(() => res.redirect('/telegram-verify'));
});

app.get('/telegram-verify', (req, res) => res.render('telegram-verify', { error: null }));

bot.on('contact', (msg) => {
    const phone = msg.contact.phone_number.replace(/\D/g, '').slice(-10);
    const otp = Math.floor(1000 + Math.random() * 9000);
    db.get('verified_users').remove({ phone }).write();
    db.get('verified_users').push({ phone, otp }).write();
    bot.sendMessage(msg.chat.id, `🔐 LuxeStore OTP: ${otp}`);
});

app.post('/verify-otp', (req, res) => {
    const { otp } = req.body;
    const phone = req.session.tempPhone;
    const record = db.get('verified_users').find({ phone, otp: parseInt(otp) }).value();
    if (record) {
        req.session.verified = true;
        req.session.phone = phone;
        req.session.save(() => res.redirect('/'));
    } else {
        res.render('telegram-verify', { error: "Wrong OTP!" });
    }
});

// --- 5. SHOP & SEARCH ---
app.get('/', isAuth, (req, res) => {
    res.render('index', { products: db.get('products').value() });
});

app.get('/search', isAuth, (req, res) => {
    const query = (req.query.q || '').toLowerCase();
    const products = db.get('products').filter(p => p.name.toLowerCase().includes(query)).value();
    res.render('index', { products });
});

app.get('/product/:id', isAuth, (req, res) => {
    const product = db.get('products').find({ id: req.params.id }).value();
    if (product) res.render('product-detail', { product });
    else res.redirect('/');
});

// --- 6. CART SYSTEM ---
app.post('/add-to-cart', (req, res) => {
    const product = db.get('products').find({ id: req.body.productId }).value();
    if (product) {
        req.session.cart = req.session.cart || [];
        req.session.cart.push(product);
        req.session.save(() => res.json({ success: true, cartCount: req.session.cart.length }));
    } else res.json({ success: false });
});

app.get('/cart', isAuth, (req, res) => res.render('cart', { items: req.session.cart || [] }));

app.post('/remove-item', (req, res) => {
    const index = parseInt(req.body.index);
    if (req.session.cart && req.session.cart[index]) {
        req.session.cart.splice(index, 1);
        req.session.save(() => res.json({ success: true }));
    } else res.json({ success: false });
});

// --- 7. CHECKOUT & ORDERS (FIXED SECTION) ---
app.get('/checkout', isAuth, (req, res) => {
    const cartItems = req.session.cart || [];
    if (cartItems.length === 0) return res.redirect('/cart');
    // Yahan humne 'items' pass kiya hai taaki ejs mein error na aaye
    res.render('checkout', { items: cartItems }); 
});

app.post('/process-checkout', isAuth, (req, res) => {
    const { fullname, address, paymentMethod } = req.body;
    const cart = req.session.cart || [];
    if (cart.length === 0) return res.redirect('/cart');

    const total = cart.reduce((a, b) => a + parseInt(b.price), 0);
    const advance = (paymentMethod === 'Online' ? total * 0.95 : total * 0.20).toFixed(2);
    
    req.session.tempOrder = { fullname, address, total, advance, items: cart, paymentMethod };
    req.session.save(() => res.redirect('/payment-gateway'));
});

app.get('/payment-gateway', isAuth, (req, res) => {
    if (!req.session.tempOrder) return res.redirect('/cart');
    res.render('payment-gateway', { orderData: req.session.tempOrder });
});

app.post('/place-order', isAuth, (req, res) => {
    const { utr } = req.body;
    const temp = req.session.tempOrder;
    if (!utr || !temp) return res.redirect('/cart');

    const orderId = Math.floor(100000 + Math.random() * 900000);
    const order = { 
        id: orderId, 
        phone: req.session.phone, 
        ...temp, 
        utr, 
        status: "🕒 Pending", 
        date: new Date().toLocaleDateString('en-IN') 
    };

    db.get('orders').push(order).write();
    
    // Admin ko notification
    bot.sendMessage(ADMIN_TELEGRAM_ID, `📦 NEW ORDER #${orderId}\n👤 ${temp.fullname}\n💰 Adv: ₹${temp.advance}\n🔑 UTR: ${utr}\n📞 Call: ${req.session.phone}`);
    
    req.session.cart = []; 
    req.session.tempOrder = null;
    req.session.save(() => res.render('order-success', { orderId }));
});

// --- 8. ADMIN DASHBOARD ---
app.get('/admin', isAuth, isAdmin, (req, res) => {
    const products = db.get('products').value();
    const orders = db.get('orders').value();
    const stats = {
        sales: orders.reduce((s, o) => s + parseFloat(o.total), 0).toFixed(2),
        advance: orders.reduce((s, o) => s + parseFloat(o.advance), 0).toFixed(2),
        ordersCount: orders.length,
        users: db.get('verified_users').size().value()
    };
    res.render('admin', { products, orders: orders.reverse(), stats });
});

app.post('/admin/add-product', isAuth, isAdmin, (req, res) => {
    const { name, price, images, desc } = req.body;
    const imageArray = images.split(',').map(url => url.trim());
    db.get('products').push({ id: "P"+Date.now(), name, price: parseInt(price), images: imageArray, desc }).write();
    res.redirect('/admin');
});

app.post('/admin/update-status', isAuth, isAdmin, (req, res) => {
    const { orderId, status } = req.body;
    db.get('orders').find({ id: parseInt(orderId) }).assign({ status }).write();
    res.json({ success: true });
});

app.post('/admin/delete-product', isAuth, isAdmin, (req, res) => {
    db.get('products').remove({ id: req.body.id }).write();
    res.json({ success: true });
});

// --- 9. TRACKING & PROFILE ---
app.get('/my-orders', isAuth, (req, res) => {
    const orders = db.get('orders').filter({ phone: req.session.phone }).value();
    res.render('my-orders', { orders: orders.reverse() });
});

app.get('/order-track/:id', isAuth, (req, res) => {
    const order = db.get('orders').find({ id: parseInt(req.params.id) }).value();
    if (order) res.render('order-track', { order });
    else res.redirect('/my-orders');
});

app.get('/profile', isAuth, (req, res) => res.render('profile', { phone: req.session.phone }));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/user-login')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 LUXESTORE IS LIVE AT PORT ${PORT}`);
});


