import express, { Request, Response, NextFunction } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { env, prisma } from './config/index.js';
import routes, {
  initializeIntegrations,
  initializeEnhancedSync,
  startEnhancedSyncProcessors,
  stopEnhancedSyncProcessors,
  startSyncScheduler,
  stopSyncScheduler
} from './routes/index.js';
import { initializeSocket } from './services/socket.js';

const app = express();

// CORS configuration - Allow multiple origins
const allowedOrigins = env.frontendUrl.split(',').map(url => url.trim());
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
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600 // Cache preflight for 10 minutes
};
app.use(helmet());
app.use(cors(corsOptions));

// Debug logging for CORS
app.use((req, res, next) => {
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

// Initialize background job queue
import { initializeQueue, shutdownQueue } from './services/queue/sync-queue.service.js';
import { initializeQueueWorkers } from './services/queue/queue-worker.service.js';
let queueInitialized = false;

// Queue will be initialized after server starts
const initQueue = async () => {
  try {
    if (!env.databaseUrl) {
      console.warn('⚠️ DATABASE_URL not configured - queue will not start');
      return;
    }
    await initializeQueue(env.databaseUrl, prisma);
    console.log('✅ Background job queue initialized');

    // Initialize queue workers to process jobs
    await initializeQueueWorkers(prisma);
    console.log('✅ Queue workers initialized and ready to process jobs');

    queueInitialized = true;
  } catch (error) {
    console.error('❌ Failed to initialize queue:', error);
  }
};

// Routes
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

// Create HTTP server
const httpServer = createServer(app);

// Initialize Socket.IO
const io = initializeSocket(httpServer);
console.log('✅ Socket.IO initialized');

// Start server
const PORT = Number(env.port);
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

httpServer.listen(PORT, HOST, async () => {
  console.log(`\n🚀 Server running on ${HOST}:${PORT} in ${env.nodeEnv} mode`);
  console.log(`📍 FRONTEND_URL: ${env.frontendUrl}`);
  console.log(`💾 DATABASE_URL configured: ${env.databaseUrl ? 'YES' : 'NO'}`);
  console.log(`🔌 Socket.IO ready for connections`);

  // Initialize background job queue
  await initQueue();

  // Start enhanced sync background processors
  startEnhancedSyncProcessors();
  console.log('🔄 Enhanced sync processors started:');
  console.log('   - Sync Queue Processor (batch size: 10, interval: 5s)');
  console.log('   - JTL Polling Service (interval: 2min)');
  if (queueInitialized) {
    console.log('   - Background Job Queue (PostgreSQL-based)');
  }

  // Start cron-based fallback polling scheduler
  await startSyncScheduler();
  console.log('   - Sync Scheduler (incremental every 5min, full every 24h)');

  console.log('\n✨ All systems operational!\n');
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\n🛑 Shutting down gracefully...');

  // Stop background job queue
  if (queueInitialized) {
    await shutdownQueue();
    console.log('✅ Background queue stopped');
  }

  // Stop sync scheduler
  stopSyncScheduler();
  console.log('✅ Sync scheduler stopped');

  // Stop sync processors
  stopEnhancedSyncProcessors();
  console.log('✅ Sync processors stopped');

  // Close database connection
  await prisma.$disconnect();
  console.log('✅ Database connection closed');

  // Close HTTP server
  httpServer.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
