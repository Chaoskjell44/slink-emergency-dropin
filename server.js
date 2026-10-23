/**
 * Slink maintenance drop-in.
 *
 * - Returns a 503 maintenance page on every route except `/image/HASH.ext`
 *   (unless SERVE_IMAGES=false).
 * - Serves image files from:
 *     - local filesystem (STORAGE_PROVIDER=local)
 *     - SMB/CIFS share  (STORAGE_PROVIDER=smb)
 *     - S3 / S3-compatible bucket (STORAGE_PROVIDER=s3)
 * - The maintenance text is rendered from content.json.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { S3Client, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const smb2 = require('@awo00/smb2');

const PORT = process.env.PORT || 3000;
const IMAGES_DIR = process.env.IMAGES_DIR || '/app/images';
const STORAGE_PROVIDER = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
const SERVE_IMAGES = process.env.SERVE_IMAGES !== 'false';

const CONTENT_JSON_PATH = process.env.CONTENT_JSON || path.join(__dirname, 'content.json');
const TEMPLATE_PATH = path.join(__dirname, 'public', 'template.html');

const ALLOWED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'
]);

const MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp'
};

// Slink image hashes are URL-safe strings. Keep the limit generous but bounded.
const HASH_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function renderTemplate(template, vars) {
  return Object.entries(vars).reduce((html, [key, value]) => {
    const safeValue = value == null ? '' : String(value);
    return html.replace(new RegExp(`{{${key}}}`, 'g'), safeValue);
  }, template);
}

const content = JSON.parse(fs.readFileSync(CONTENT_JSON_PATH, 'utf8'));
const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
const MAINTENANCE_HTML = renderTemplate(template, content);

let s3Client = null;

function createS3Client() {
  const endpoint = process.env.AMAZON_S3_ENDPOINT;
  const useCustomProvider = process.env.AMAZON_S3_USE_CUSTOM_PROVIDER === 'true' || !!endpoint;
  const forcePathStyle = process.env.AMAZON_S3_FORCE_PATH_STYLE === 'true' || (useCustomProvider && process.env.AMAZON_S3_FORCE_PATH_STYLE !== 'false');
  const region = process.env.AMAZON_S3_REGION || (useCustomProvider ? 'auto' : 'us-east-1');
  const accessKeyId = process.env.AMAZON_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AMAZON_S3_SECRET_ACCESS_KEY;

  const config = { region };

  if (endpoint) {
    config.endpoint = endpoint;
  }

  if (forcePathStyle) {
    config.forcePathStyle = true;
  }

  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  } else if (process.env.AMAZON_S3_USE_IAM_ROLE !== 'true') {
    console.warn('[S3] No explicit credentials and AMAZON_S3_USE_IAM_ROLE is not set; falling back to AWS default credential provider chain.');
  }

  return new S3Client(config);
}

if (STORAGE_PROVIDER === 's3') {
  s3Client = createS3Client();
}

function send503(res) {
  res.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Retry-After': '3600',
    'X-Robots-Tag': 'noindex, nofollow'
  });
  res.end(MAINTENANCE_HTML);
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(message);
}

function serveLocal(req, res, fileName, ext, isHead) {
  const normalized = path.normalize(fileName);

  // Defensive path-traversal check (the hash/ext regex already prevents `..`,
  // but normalize makes the intent explicit).
  if (normalized !== fileName || normalized.includes('..') || normalized.includes('/')) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  const filePath = path.join(IMAGES_DIR, normalized);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      sendError(res, 404, 'Not found');
      return;
    }

    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600'
    };

    if (stats.size != null) {
      headers['Content-Length'] = stats.size;
    }

    res.writeHead(200, headers);

    if (isHead) {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    stream.on('error', (e) => {
      console.error('Stream error:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Server error');
    });
  });
}

async function serveS3(req, res, fileName, ext, isHead) {
  const bucket = process.env.AMAZON_S3_BUCKET;
  if (!bucket) {
    sendError(res, 500, 'S3 bucket not configured');
    return;
  }

  const prefix = process.env.S3_KEY_PREFIX || '';
  const key = prefix + fileName;
  const client = s3Client; // captured from closure

  const command = isHead
    ? new HeadObjectCommand({ Bucket: bucket, Key: key })
    : new GetObjectCommand({ Bucket: bucket, Key: key });

  try {
    const data = await client.send(command);

    const headers = {
      'Content-Type': data.ContentType || MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600'
    };

    if (data.ContentLength != null) {
      headers['Content-Length'] = data.ContentLength;
    }

    res.writeHead(200, headers);

    if (isHead) {
      res.end();
      return;
    }

    const stream = data.Body;
    stream.pipe(res);

    stream.on('error', (e) => {
      console.error('S3 stream error:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Server error');
    });
  } catch (err) {
    console.error('S3 error:', err);

    if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
      sendError(res, 404, 'Not found');
    } else {
      sendError(res, 502, 'Storage unavailable');
    }
  }
}

async function serveSMB(req, res, fileName, ext, isHead) {
  const host = process.env.SMB_HOST;
  const share = process.env.SMB_SHARE;
  const username = process.env.SMB_USERNAME;
  const password = process.env.SMB_PASSWORD;
  const domain = process.env.SMB_WORKGROUP || 'WORKGROUP';
  const port = process.env.SMB_PORT ? parseInt(process.env.SMB_PORT, 10) : 445;
  const imagePath = (process.env.SMB_IMAGE_PATH || 'slink/images').replace(/\\/g, '/').replace(/\/$/, '');

  if (!host || !share || !username || !password) {
    sendError(res, 500, 'SMB credentials not configured');
    return;
  }

  const client = new smb2.Client(host, { port });

  try {
    const session = await client.authenticate({ domain, username, password });
    const tree = await session.connectTree(share);
    const remotePath = `${imagePath}/${fileName}`;

    if (isHead) {
      const exists = await tree.exists(remotePath);
      if (!exists) {
        sendError(res, 404, 'Not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600'
      });
      res.end();
      return;
    }

    const buffer = await tree.readFile(remotePath);

    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(buffer);
  } catch (err) {
    console.error('SMB error:', err);

    const errorText = String(err && err.message ? err.message : err);
    if (/not found|enoent|status_object_name_not_found/i.test(errorText)) {
      sendError(res, 404, 'Not found');
    } else {
      sendError(res, 502, 'Storage unavailable');
    }
  } finally {
    try {
      await client.close();
    } catch (closeErr) {
      // ignore close errors
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  const match = pathname.match(/^\/image\/([a-zA-Z0-9_-]+)\.([a-zA-Z0-9]+)$/);
  if (!match || !SERVE_IMAGES) {
    send503(res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }
  const isHead = req.method === 'HEAD';

  const [, imageId, rawExt] = match;
  const ext = rawExt.toLowerCase();

  if (!HASH_REGEX.test(imageId) || !ALLOWED_EXTENSIONS.has(ext)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  const fileName = `${imageId}.${ext}`;

  if (STORAGE_PROVIDER === 's3') {
    serveS3(req, res, fileName, ext, isHead).catch((e) => {
      console.error('Unexpected S3 handler error:', e);
      sendError(res, 500, 'Server error');
    });
  } else if (STORAGE_PROVIDER === 'smb') {
    serveSMB(req, res, fileName, ext, isHead).catch((e) => {
      console.error('Unexpected SMB handler error:', e);
      sendError(res, 500, 'Server error');
    });
  } else if (STORAGE_PROVIDER === 'local') {
    serveLocal(req, res, fileName, ext, isHead);
  } else {
    console.warn(`Unsupported STORAGE_PROVIDER: ${STORAGE_PROVIDER}`);
    send503(res);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Slink maintenance drop-in listening on 0.0.0.0:${PORT}`);
  console.log(`Storage provider: ${STORAGE_PROVIDER}`);

  if (!SERVE_IMAGES) {
    console.log('Image forwarding is disabled (all routes return maintenance page).');
  } else if (STORAGE_PROVIDER === 'local') {
    console.log(`Serving local images from: ${IMAGES_DIR}`);
  } else if (STORAGE_PROVIDER === 'smb') {
    console.log(`Serving SMB images from //${process.env.SMB_HOST || '<not set>'}/${process.env.SMB_SHARE || '<not set>'}`);
  } else if (STORAGE_PROVIDER === 's3') {
    console.log(`Serving S3 images from bucket: ${process.env.AMAZON_S3_BUCKET || '<not set>'}`);
  }
});
