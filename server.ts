import 'dotenv/config';
import http from 'http';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './server/api.ts';
import { getPersistenceMode } from './src/db/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  const distPath = path.resolve(__dirname, 'dist');
  const hasDist = fs.existsSync(path.join(distPath, 'index.html'));
  const isProd = process.env.NODE_ENV === 'production' && hasDist;

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Basic Healthcheck for Cloud Run probes (no eager DB startup probe)
  app.get(['/healthz', '/api/health'], (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'MoviLog',
      persistenceMode: getPersistenceMode(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  // API Routes
  app.use('/api', apiRouter);

  // Vite integration in dev, or static files if production build exists
  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`MoviLog iniciado na porta ${PORT} (persistência: ${getPersistenceMode()})`);
  });

  const gracefulShutdown = async () => {
    httpServer.close(async () => {
      if (global._movilogPostgresPool) {
        try {
          await global._movilogPostgresPool.end();
        } catch {
          // ignore shutdown pool close errors
        }
      }
      process.exit(0);
    });
  };

  process.once('SIGTERM', gracefulShutdown);
  process.once('SIGINT', gracefulShutdown);
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

