import { requireSession, getSupabaseConfig } from './_supabase.js';

function sanitizeName(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120);
}

function decodeDataUrl(dataUrl) {
  const raw = String(dataUrl || '');
  const m = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return {
    contentType: m[1],
    buffer: Buffer.from(m[2], 'base64'),
  };
}

function encodePath(path) {
  return String(path)
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');
}

export default async function handler(req, res) {
  try {
    const session = await requireSession(req, res);
    if (!session) return;

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const dataUrl = String(payload.data_url || '').trim();
    const fileName = sanitizeName(payload.file_name || 'file.bin');
    const kind = String(payload.kind || 'file').trim().toLowerCase();

    if (!dataUrl) return res.status(400).json({ error: 'data_url is required' });

    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) return res.status(400).json({ error: 'Invalid data_url format' });

    const bucket = process.env.SUPABASE_ATTACHMENTS_BUCKET || 'nim-attachments';
    const stamp = Date.now();
    const objectPath = `${session.user_id}/${kind}/${stamp}-${fileName}`;

    const { url, key } = getSupabaseConfig();

    const upRes = await fetch(`${url}/storage/v1/object/${bucket}/${encodePath(objectPath)}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': decoded.contentType || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: decoded.buffer,
    });

    const upRaw = await upRes.text();
    if (!upRes.ok) {
      let upData = null;
      try {
        upData = upRaw ? JSON.parse(upRaw) : null;
      } catch {
        upData = { raw: upRaw };
      }
      const err = new Error((upData && (upData.error || upData.message)) || `Storage upload failed ${upRes.status}`);
      err.status = upRes.status;
      err.data = upData;
      throw err;
    }

    let accessUrl = `${url}/storage/v1/object/public/${bucket}/${encodePath(objectPath)}`;

    try {
      const signRes = await fetch(`${url}/storage/v1/object/sign/${bucket}/${encodePath(objectPath)}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 30 }),
      });
      const signRaw = await signRes.text();
      const signData = signRaw ? JSON.parse(signRaw) : {};
      if (signRes.ok && signData && signData.signedURL) {
        accessUrl = `${url}/storage/v1${signData.signedURL}`;
      }
    } catch {
      // keep public URL fallback
    }

    return res.status(200).json({
      ok: true,
      bucket,
      path: objectPath,
      url: accessUrl,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Attachment upload error',
      detail: err.data || null,
    });
  }
}
