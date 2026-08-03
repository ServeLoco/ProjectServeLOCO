const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const config = require('./config/env');
const db = require('./db');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const imageRoutes = require('./routes/imageRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const cartRoutes = require('./routes/cartRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const offerRoutes = require('./routes/offerRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const realtimeRoutes = require('./routes/realtimeRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const shopRoutes = require('./routes/shopRoutes');
const riderRoutes = require('./routes/riderRoutes');
const storeModeRoutes = require('./routes/storeModeRoutes');
const deliveryZonesRoutes = require('./routes/deliveryZonesRoutes');
const bootstrapRoutes = require('./routes/bootstrapRoutes');

const app = express();

// Trust the first proxy hop (nginx, Cloudflare, App Runner, Lightsail) so
// req.ip reflects the real client IP, not the proxy's. Required for correct
// audit logs, geo-restriction, and per-IP rate limiting once deployed.
app.set('trust proxy', 1);

// Request logging — dev uses concise format, production uses combined for audit
app.use(morgan(config.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Compress all JSON/text responses. Browsers/Expo auto-decompress.
// Threshold 1KB skips tiny payloads (overhead > savings).
app.use(compression({ threshold: 1024 }));

// Middleware
app.use(helmet());
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" })); // Allow image loading across origins

const allowedOrigins = config.CORS_ORIGIN ? config.CORS_ORIGIN.split(',') : [];
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handling preflight OPTIONS requests for all routes

// Request body JSON parsing with safe size limits
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));

// Static file serving for images — only needed when images live on local disk.
// In S3 mode, images are served directly from the bucket/CDN, so this is skipped.
if (config.STORAGE_DRIVER !== 's3') {
  app.use(config.STATIC_UPLOAD_PATH, (req, res, next) => {
    const ext = path.extname(req.path).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'];
    if (!imageExts.includes(ext)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Only image files are allowed' });
    }
    next();
  }, express.static(path.join(__dirname, '../', config.UPLOAD_DIR), {
    maxAge: '30d',
    immutable: true,
  }));
}

// Public policy pages (privacy policy + terms of service) — required for Google Play listing.
// Mounted before /api routes so a request to /policies/* resolves to a static HTML file.
// index() is overridden so /policies (no trailing file) renders index.html.
app.use('/policies', express.static(path.join(__dirname, '..', 'public', 'policies'), {
  index: 'index.html',
  // extensions: ['html'] makes /policies/privacy resolve to /policies/privacy.html
  // and /policies/terms resolve to /policies/terms.html. Without this,
  // express.static looks for a file literally named privacy (no extension)
  // and 404s. Same for /policies/terms.
  extensions: ['html'],
  fallthrough: false,
}));

// Cheap liveness + health — registered BEFORE the /api rate limiter so they
// never 429 (load balancers / mobile reachability must always work).
app.get('/ping', (req, res) => res.status(200).json({ ok: true }));

app.get('/health', async (req, res) => {
  const dbHealth = await db.checkHealth();
  const isHealthy = dbHealth.mysql === 'ok' && dbHealth.mongodb === 'ok';

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'error',
    databases: {
      mysql: dbHealth.mysql,
      mongodb: dbHealth.mongodb
    }
  });
});

// General API rate limiter (abuse cost cap). Route-specific limiters stay.
// trust proxy is set above so per-IP keys work behind nginx.
// Admin web is chatty (dispatch, orders realtime refresh) and often shares one
// NAT IP with mobile clients — use a higher ceiling so a burst does not lock
// out /admin/login. Customer-facing traffic stays at the lower cap.
const isProd = config.NODE_ENV === 'production';
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => {
    const path = req.path || '';
    const url = req.originalUrl || '';
    const isAdmin = path.startsWith('/admin') || url.startsWith('/api/admin');
    if (isAdmin) return isProd ? 1200 : 5000;
    return isProd ? 300 : 2000;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Wait a minute and try again.' },
});
app.use('/api', apiLimiter);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/images', imageRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/realtime', realtimeRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/rider', riderRoutes);
app.use('/api/store-modes', storeModeRoutes);
app.use('/api/delivery-zones', deliveryZonesRoutes);
app.use('/api/bootstrap', bootstrapRoutes);
app.use('/api/admin/images', imageRoutes); // alias for admin panel

// Local/mobile clients may be configured with either the server root or /api.
// Redirect legacy root paths to /api/...
const legacyPaths = [
  '/auth', '/admin', '/images', '/categories', '/products', 
  '/orders', '/cart', '/settings', '/offers', '/dashboard', 
  '/admin/images'
];
legacyPaths.forEach(legacyPath => {
  app.use(legacyPath, (req, res) => {
    res.redirect(308, `/api${req.originalUrl}`);
  });
});

// Not Found Handler
app.use(notFoundHandler);

// Global Error Handler
app.use(errorHandler);

module.exports = app;
