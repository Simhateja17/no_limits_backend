import express, { Request, Response, NextFunction } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env, prisma } from '../src/config/index.js';
import routes, {
  initializeIntegrations,
  initializeEnhancedSync
} from '../src/routes/index.js';

// Create Express app
const app = express();

// CORS configuration - Allow multiple origins
const allowedOrigins = env.frontendUrl.split(',').map((url: string) => url.trim());
const corsOptions: CorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-WC-Webhook-Source', 'X-WC-Webhook-Signature'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600 // Cache preflight for 10 minutes
};

app.use(helmet());
app.use(cors(corsOptions));

// Debug logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`${req.method} ${req.path} - Origin: ${req.headers.origin || 'no-origin'}`);
  next();
});

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Initialize integrations with prisma client
initializeIntegrations(prisma);

// Initialize enhanced sync system (bi-directional with origin tracking)
initializeEnhancedSync(prisma);
console.log('✅ Enhanced product sync system initialized');

// Routes - Mount at /api to match the webhook URLs
app.use('/api', routes);

// Root endpoint
app.get('/', (_req: Request, res: Response) => {
  res.json({
    message: 'No-Limits Platform API',
    version: '2.0',
    features: [
      'Bi-directional product sync',
      'Origin tracking',
      'Field-level ownership',
      'Async job queue',
      'JTL-FFN integration'
    ]
  });
});

// Error handling middleware
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err);
  console.error('Stack:', err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// Export for Vercel serverless function
export default app;
