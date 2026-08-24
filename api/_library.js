const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const config = {
  project: process.env.GOOGLE_CLOUD_PROJECT || '',
  bucket: process.env.GCS_ASSET_BUCKET || 'aerial-jigsaw-498805-c0-ai-commerce-assets',
  identityKey: process.env.IDENTITY_PLATFORM_API_KEY || '',
};
let account;
let cachedToken = { value: '', expires: 0 };

function localCredentialPath() {
  const env = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(env)) return '';
  const entry = fs.readFileSync(env, 'utf8').match(/^VERTEX_SERVICE_ACCOUNT_FILE=(.+)$/m);
  return entry ? entry[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

function serviceAccount() {
  if (account) return account;
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (encoded) account = JSON.parse(encoded);
  else {
    const credential = localCredentialPath();
    if (!credential || !fs.existsSync(credential)) throw new Error('未配置 Google 服务账号。');
    account = JSON.parse(fs.readFileSync(credential, 'utf8'));
  }
  for (const field of ['client_email', 'private_key', 'token_uri', 'project_id']) if (!account[field]) throw new Error('Google 服务账号字段不完整。');
  if (!config.project) config.project = account.project_id;
  return account;
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }

async function cloudToken() {
  if (cachedToken.value && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: sa.token_uri, iat: now, exp: now + 3600 }))}`;
  const signer = crypto.createSign('RSA-SHA256'); signer.update(unsigned); signer.end();
  const assertion = `${unsigned}.${signer.sign(sa.private_key).toString('base64url')}`;
  const response = await fetch(sa.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Google 服务账号授权失败：${data.error_description || data.error || response.status}`);
  cachedToken = { value: data.access_token, expires: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; let size = 0;
  for await (const chunk of req) { chunks.push(chunk); size += chunk.length; if (size > 512 * 1024) throw new Error('请求数据过大。'); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res, status, value) {
  if (typeof res.status === 'function') return res.status(status).json(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}

function errorMessage(data, fallback) { return data?.error?.message || data?.error?.errors?.[0]?.message || fallback; }

async function identity(endpoint, body) {
  if (!config.identityKey) throw new Error('认证服务尚未配置。');
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${encodeURIComponent(config.identityKey)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(data, '认证失败。'));
  return data;
}

async function verifyUser(req) {
  const value = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!value) throw new Error('请先登录后再访问素材库。');
  const data = await identity('accounts:lookup', { idToken: value[1] });
  const user = data.users?.[0];
  if (!user?.localId) throw new Error('登录状态已失效，请重新登录。');
  return { uid: user.localId, email: user.email || '' };
}

function objectName(uid, name) { return `users/${uid}/assets/${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${String(name || 'asset').replace(/[^a-zA-Z0-9._-]/g, '_')}`; }
function signedUrl(method, object, mimeType = '', expires = 900) {
  const sa = serviceAccount();
  const now = new Date(); const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); const day = stamp.slice(0, 8);
  const uri = `/${config.bucket}/${object.split('/').map(encodeURIComponent).join('/')}`;
  const signedHeaders = method === 'PUT' ? 'content-type;host' : 'host';
  const credential = `${sa.client_email}/${day}/auto/storage/goog4_request`;
  const query = new URLSearchParams({ 'X-Goog-Algorithm': 'GOOG4-RSA-SHA256', 'X-Goog-Credential': credential, 'X-Goog-Date': stamp, 'X-Goog-Expires': String(expires), 'X-Goog-SignedHeaders': signedHeaders }).toString().replace(/%2F/g, '%2F');
  const headers = method === 'PUT' ? `content-type:${mimeType}\nhost:storage.googleapis.com\n` : 'host:storage.googleapis.com\n';
  const canonical = `${method}\n${uri}\n${query}\n${headers}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const toSign = `GOOG4-RSA-SHA256\n${stamp}\n${day}/auto/storage/goog4_request\n${crypto.createHash('sha256').update(canonical).digest('hex')}`;
  const signer = crypto.createSign('RSA-SHA256'); signer.update(toSign); signer.end();
  return `https://storage.googleapis.com${uri}?${query}&X-Goog-Signature=${signer.sign(sa.private_key).toString('hex')}`;
}

function firestoreUrl(uid, assetId = '') { return `https://firestore.googleapis.com/v1/projects/${config.project}/databases/(default)/documents/users/${encodeURIComponent(uid)}/assets${assetId ? `/${encodeURIComponent(assetId)}` : ''}`; }
async function firestore(method, url, body) {
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${await cloudToken()}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(data, '素材库请求失败。'));
  return data;
}
function assetFromDocument(document) {
  const field = document.fields || {}; const value = (name) => field[name]?.stringValue || '';
  return { id: document.name?.split('/').pop(), name: value('name'), type: value('type'), contentType: value('contentType'), object: value('object'), createdAt: value('createdAt') };
}
function fields(asset) { return { fields: Object.fromEntries(Object.entries(asset).map(([key, value]) => [key, { stringValue: String(value || '') }])) }; }

async function auth(input) {
  const email = String(input.email || '').trim().toLowerCase(); const password = String(input.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('请输入有效邮箱。');
  if (password.length < 8) throw new Error('密码至少需要 8 位。');
  const endpoint = input.action === 'register' ? 'accounts:signUp' : 'accounts:signInWithPassword';
  const data = await identity(endpoint, { email, password, returnSecureToken: true });
  return { idToken: data.idToken, refreshToken: data.refreshToken, expiresIn: Number(data.expiresIn || 3600), email: data.email, uid: data.localId };
}

async function library(req, input) {
  const user = await verifyUser(req);
  if (input.action === 'list') {
    const data = await firestore('GET', `${firestoreUrl(user.uid)}?pageSize=100&orderBy=createdAt%20desc`);
    return { assets: (data.documents || []).map(assetFromDocument) };
  }
  if (input.action === 'upload-url') {
    const mimeType = String(input.mimeType || ''); if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('仅支持 JPG、PNG 或 WEBP 图片。');
    if (!Number(input.size) || Number(input.size) > 20 * 1024 * 1024) throw new Error('单张图片请小于 20MB。');
    const type = ['product', 'character', 'location'].includes(input.type) ? input.type : 'product'; const object = objectName(user.uid, input.name);
    return { object, type, uploadUrl: signedUrl('PUT', object, mimeType) };
  }
  if (input.action === 'save') {
    const object = String(input.object || ''); if (!object.startsWith(`users/${user.uid}/assets/`)) throw new Error('无效的素材存储地址。');
    const assetId = crypto.randomUUID(); const asset = { name: String(input.name || '未命名素材').slice(0, 160), type: ['product', 'character', 'location'].includes(input.type) ? input.type : 'product', contentType: String(input.contentType || 'image/jpeg'), object, createdAt: new Date().toISOString() };
    await firestore('PATCH', firestoreUrl(user.uid, assetId), fields(asset)); return { asset: { id: assetId, ...asset } };
  }
  const assetId = String(input.assetId || ''); if (!assetId) throw new Error('缺少素材编号。');
  const document = await firestore('GET', firestoreUrl(user.uid, assetId)); const asset = assetFromDocument(document);
  if (!asset.object.startsWith(`users/${user.uid}/assets/`)) throw new Error('无效的云端素材。');
  if (input.action === 'preview-url') return { asset, previewUrl: signedUrl('GET', asset.object, '', 86400) };
  if (input.action === 'delete') {
    const encoded = encodeURIComponent(asset.object); const response = await fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(config.bucket)}/o/${encoded}`, { method: 'DELETE', headers: { authorization: `Bearer ${await cloudToken()}` } });
    if (!response.ok && response.status !== 404) throw new Error('云端素材删除失败。');
    await firestore('DELETE', firestoreUrl(user.uid, assetId)); return { deleted: true };
  }
  throw new Error('未知的素材库操作。');
}

async function handler(req, res, type) {
  try {
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const input = await readBody(req);
    if (type === 'auth') return send(res, 200, await auth(input));
    return send(res, 200, await library(req, input));
  } catch (error) { return send(res, 500, { error: error.message || '服务发生错误。' }); }
}

module.exports = { handler };
