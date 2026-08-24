const crypto = require('node:crypto');

const config = {
  location: process.env.VERTEX_LOCATION || 'global',
  textModel: process.env.VERTEX_TEXT_MODEL || 'gemini-3.5-flash',
};
let account;
let cache = { token: '', expires: 0 };

function serviceAccount() {
  if (account) return account;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Vercel 尚未配置 Vertex 服务账号。');
  try { account = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); } catch { throw new Error('Vercel 中的 Vertex 服务账号格式无效。'); }
  for (const key of ['client_email', 'private_key', 'token_uri', 'project_id']) if (!account[key]) throw new Error('Vertex 服务账号字段不完整。');
  return account;
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }

async function accessToken() {
  if (cache.token && cache.expires > Date.now() + 60_000) return cache.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: sa.token_uri, iat: now, exp: now + 3600 }))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned); signer.end();
  const assertion = `${unsigned}.${signer.sign(sa.private_key).toString('base64url')}`;
  const response = await fetch(sa.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const data = await response.json();
  if (!response.ok) throw new Error(`Vertex 授权失败：${data.error_description || data.error || response.status}`);
  cache = { token: data.access_token, expires: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return cache.token;
}

async function generate(body) {
  const sa = serviceAccount();
  const host = config.location === 'global' ? 'aiplatform.googleapis.com' : `${config.location}-aiplatform.googleapis.com`;
  const response = await fetch(`https://${host}/v1/projects/${sa.project_id}/locations/${config.location}/publishers/google/models/${encodeURIComponent(config.textModel)}:generateContent`, { method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Vertex 请求失败（${response.status}）`);
  return data;
}

function imageParts(images) {
  return (images || []).slice(0, 3).map((image) => {
    const match = String(image).match(/^data:([^;]+);base64,(.+)$/);
    return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
  }).filter(Boolean);
}

function parseJson(value) {
  const clean = value.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(clean); } catch {
    const object = clean.match(/\{[\s\S]*\}/);
    if (!object) throw new Error('模型未返回可用的视频策划结果。');
    return JSON.parse(object[0]);
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    chunks.push(chunk); size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('图片过大：部署版单次请求请控制在 4MB 内。');
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function durations(value, fallback) {
  const allowed = new Set([4, 6, 8, 10]);
  const supplied = Array.isArray(value) ? value.map(Number).filter((second) => allowed.has(second)).slice(0, 12) : [];
  return supplied.length ? supplied : [Math.max(4, Math.min(10, Number(fallback) || 10))];
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const input = await readBody(req);
    const segmentDurations = durations(input.segmentDurations, input.duration);
    const china = input.market === 'cn';
    const brief = String(input.creativeBrief || '').trim().slice(0, 2000);
    const referenceAnalysis = input.videoAnalysis ? JSON.stringify(input.videoAnalysis).slice(0, 18_000) : 'No reference video was supplied.';
    const prompt = `You are the video-planning agent and performance-focused e-commerce prompt writer for Flow Omni Flash. Create exactly ${segmentDurations.length} connected but independently renderable vertical social-commerce clips. Their required durations, in order, are: ${segmentDurations.join(', ')} seconds. This is a conversion campaign, not a generic showcase.

HARD VISUAL SOURCE LOCK — NON-NEGOTIABLE: The three attached reference sheets are the only visual source of truth, in this exact order: Product, Character, Location. In every generated video frame, use the exact product silhouette, colourways, materials, texture, construction and visible packaging details from the Product sheet; the exact real adult model identity, face, skin tone, hair, body proportions, outfit and accessories from the Character sheet; and the exact room/scene architecture, layout, furniture, recurring props, placement, scale, colour palette and lighting from the Location sheet. Do not introduce, remove, replace, restyle, approximate, swap, or alter any referenced visual element. Do not borrow the reference video's people, product, location, objects, wardrobe, logo, styling or art direction. The reference video may guide only shot order, pacing, camera motion, transition rhythm and conversion structure.

SCRIPT AND VOICEOVER PLANNER: Inspect USER CREATIVE BRIEF. If it contains dialogue, a spoken script, talking points, or a requested message, treat it as source copy. Preserve its meaning, divide it naturally across the required clip durations, and pair each spoken beat with a corresponding visible proof or action. Never cut a sentence in an unnatural place. If it does not contain a script, write concise experience-led voiceover that follows the conversion arc. ${china ? 'Voiceover must be natural Mandarin Chinese.' : 'Voiceover must be natural US English.'}

USER CREATIVE BRIEF PRIORITY: ${brief ? `<USER_BRIEF>${brief}</USER_BRIEF>` : 'No extra user brief was supplied. Use the recommended conversion strategy.'}

REFERENCE VIDEO STRUCTURE (timing and narrative only; never copy its visual assets or wording): <REFERENCE_VIDEO>${referenceAnalysis}</REFERENCE_VIDEO>

CONVERSION ARC: Open clip 1 with a relatable use moment or problem and reveal the product within the first two seconds. Use following clips for concrete product proof such as material, fit, texture, construction, visible use result or close-up detail. Then show believable lifestyle use and end with a natural, non-pushy purchase nudge. Product must remain visibly recognizable for at least 60% of every clip. Never use unsupported claims, fake reviews, fake discounts, urgency, invented features or generic fashion posing.

Each prompt_en is a complete English direct-paste Flow Omni Flash instruction. It must include the labels: TARGET AND DURATION; CONVERSION ROLE; REFERENCE LOCK; HOOK; SCENE; SUBJECT AND PRODUCT; PRODUCT PROOF; ACTION TIMELINE; CAMERA AND FRAMING; LIGHTING AND VISUAL STYLE; ON-SCREEN TEXT; VOICEOVER; CTA; CONTINUITY; NEGATIVE CONSTRAINTS. The only permitted non-English inside prompt_en is a literal Mandarin dialogue quotation for a Chinese-market voiceover. Require photorealistic live-action commercial UGC video: real person, natural skin, fabric, motion, lighting and camera physics. Explicitly forbid anime, manga, illustration, drawing, line art, 3D/CGI, doll-like skin, beauty-filter plasticity, unrelated people, unrelated environments and any deviation from the three locked sheets.

Return ONLY valid JSON with this exact schema: {"target_model":"Flow Omni Flash","strategy_zh":"简洁中文策略","segments":[{"index":1,"duration_seconds":10,"time":"0-10s","summary_zh":"此段中文简介，说明镜头和转化作用","prompt_en":"complete English direct-paste instruction","voiceover":"${china ? '普通话口播' : 'US English voiceover'}","voiceover_language":"${china ? 'Chinese' : 'English'}"}]}. Every summary_zh and strategy_zh must be Chinese.`;
    const data = await generate({ contents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts(input.references)] }], generationConfig: { temperature: 0.24, responseMimeType: 'application/json' } });
    return res.status(200).json({ result: parseJson(data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim() || '') });
  } catch (error) {
    return res.status(500).json({ error: error.message || '视频策划服务发生错误' });
  }
};
