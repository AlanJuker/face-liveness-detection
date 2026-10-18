const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1); // Railway termina TLS en su proxy: req.secure refleja HTTPS
app.use(express.json({ limit: '15mb' }));

/**
 * Sesión de administrador para la galería. La cookie lleva su vencimiento
 * firmado con HMAC usando GALLERY_PASSWORD como clave: cambiar la contraseña
 * invalida todas las sesiones. Sin GALLERY_PASSWORD la galería queda cerrada.
 */
const SESSION_COOKIE = 'gallery_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const sign = (value) =>
  crypto.createHmac('sha256', process.env.GALLERY_PASSWORD).update(value).digest('hex');

const safeEqual = (a, b) => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function hasSession(req) {
  if (!process.env.GALLERY_PASSWORD) return false;
  const [expires, signature] = (readCookie(req, SESSION_COOKIE) || '').split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  return safeEqual(signature, sign(expires));
}

function requireSession(req, res, next) {
  if (hasSession(req)) return next();
  res.status(401).json({ error: 'Se requiere iniciar sesión' });
}

const cookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: req.secure,
  path: '/',
});

/**
 * Almacenamiento de fotografías de evidencia.
 * - Con DATABASE_URL (Railway PostgreSQL): tabla `photos`.
 * - Sin DATABASE_URL (desarrollo local): archivos en server/data/.
 */
function createStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const internal = process.env.DATABASE_URL.includes('.railway.internal');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: internal ? false : { rejectUnauthorized: false },
    });

    const ready = pool.query(`
      CREATE TABLE IF NOT EXISTS photos (
        id SERIAL PRIMARY KEY,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    return {
      kind: 'postgres',
      async list() {
        await ready;
        const { rows } = await pool.query(
          'SELECT id, octet_length(data) AS bytes, created_at FROM photos ORDER BY id DESC',
        );
        return rows.map((r) => ({
          id: r.id,
          bytes: Number(r.bytes),
          createdAt: r.created_at.toISOString(),
        }));
      },
      async save(buffer) {
        await ready;
        const { rows } = await pool.query('INSERT INTO photos (data) VALUES ($1) RETURNING id', [
          buffer,
        ]);
        return rows[0].id;
      },
      async get(id) {
        await ready;
        const { rows } = await pool.query('SELECT data FROM photos WHERE id = $1', [id]);
        return rows[0]?.data ?? null;
      },
      async remove(id) {
        await ready;
        await pool.query('DELETE FROM photos WHERE id = $1', [id]);
      },
      async clear() {
        await ready;
        await pool.query('DELETE FROM photos');
      },
    };
  }

  // Desarrollo local sin base de datos: archivos JPEG en server/data/
  const dir = path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (id) => path.join(dir, `${Number(id)}.jpg`);

  return {
    kind: 'filesystem',
    async list() {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jpg'))
        .map((f) => {
          const stat = fs.statSync(path.join(dir, f));
          return {
            id: Number(f.replace('.jpg', '')),
            bytes: stat.size,
            createdAt: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => b.id - a.id);
    },
    async save(buffer) {
      const id = Date.now();
      fs.writeFileSync(fileOf(id), buffer);
      return id;
    },
    async get(id) {
      const file = fileOf(id);
      return fs.existsSync(file) ? fs.readFileSync(file) : null;
    },
    async remove(id) {
      const file = fileOf(id);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    },
    async clear() {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.jpg')) fs.unlinkSync(path.join(dir, f));
      }
    },
  };
}

const store = createStore();
console.log(`Photo store: ${store.kind}`);

// ---- API ----

app.post('/api/session', (req, res) => {
  const password = req.body?.password;
  if (
    !process.env.GALLERY_PASSWORD ||
    typeof password !== 'string' ||
    !safeEqual(sign(password), sign(process.env.GALLERY_PASSWORD))
  ) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const expires = String(Date.now() + SESSION_TTL_MS);
  res.cookie(SESSION_COOKIE, `${expires}.${sign(expires)}`, {
    ...cookieOptions(req),
    maxAge: SESSION_TTL_MS,
  });
  res.status(204).end();
});

app.delete('/api/session', (req, res) => {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
  res.status(204).end();
});

app.get('/api/photos', requireSession, async (_req, res) => {
  try {
    const photos = await store.list();
    const totalBytes = photos.reduce((sum, p) => sum + p.bytes, 0);
    res.json({ photos, totalBytes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudieron listar las fotografías' });
  }
});

app.post('/api/photos', async (req, res) => {
  try {
    const dataUrl = req.body?.dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,')) {
      return res.status(400).json({ error: 'Se espera un data URL JPEG' });
    }
    const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
    const id = await store.save(buffer);
    res.status(201).json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'No se pudo guardar la fotografía' });
  }
});

app.get('/api/photos/:id', requireSession, async (req, res) => {
  try {
    const data = await store.get(req.params.id);
    if (!data) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    if (req.query.download !== undefined) {
      res.setHeader('Content-Disposition', `attachment; filename="verificacion-rostro-${req.params.id}.jpg"`);
    }
    res.send(data);
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.delete('/api/photos/:id', requireSession, async (req, res) => {
  try {
    await store.remove(req.params.id);
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

app.delete('/api/photos', requireSession, async (_req, res) => {
  try {
    await store.clear();
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
});

// ---- estáticos de la SPA (build de Angular) ----

const publicDir = path.join(__dirname, '..', 'public');
if (fs.existsSync(publicDir)) {
  app.use(
    express.static(publicDir, {
      setHeaders(res, filePath) {
        if (/\.(js|css|bin)$/.test(filePath) || filePath.includes(`${path.sep}models${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

module.exports = app;
