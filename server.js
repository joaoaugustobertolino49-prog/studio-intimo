const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function uploadBufferToFal(buffer, mimetype, filename, key) {
  const initResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: filename, content_type: mimetype }),
  });
  if (!initResp.ok) {
    const e = await initResp.json().catch(() => ({}));
    throw new Error('Upload initiate falhou: ' + (e.detail || initResp.status));
  }
  const { upload_url, file_url } = await initResp.json();
  const put = await fetch(upload_url, {
    method: 'PUT', headers: { 'Content-Type': mimetype }, body: buffer,
  });
  if (!put.ok) throw new Error('PUT falhou: ' + put.status);
  return file_url;
}

app.post('/api/upload', upload.array('images', 5), async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });
    if (!req.files?.length) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    const urls = await Promise.all(
      req.files.map(f => uploadBufferToFal(f.buffer, f.mimetype, f.originalname, key))
    );
    console.log('[UPLOAD OK]', urls.length, 'foto(s)');
    res.json({ urls });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const { face_image_url, template_url } = req.body;
    if (!face_image_url || !template_url) {
      return res.status(400).json({ error: 'Parâmetros ausentes.' });
    }

    console.log('[STEP 1] Baixando template:', template_url.substring(0, 100));

    // Baixar template
    let imageBuffer, mimeType;
    if (template_url.startsWith('data:')) {
      const m = template_url.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error('base64 inválido');
      mimeType = m[1];
      imageBuffer = Buffer.from(m[2], 'base64');
      console.log('[STEP 1] Template base64 decodificado, size:', imageBuffer.length);
    } else {
      const fetchResp = await fetch(template_url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      console.log('[STEP 1] Fetch status:', fetchResp.status);
      if (!fetchResp.ok) throw new Error('Erro ao baixar template: HTTP ' + fetchResp.status);
      const arrayBuf = await fetchResp.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuf);
      mimeType = fetchResp.headers.get('content-type') || 'image/jpeg';
      console.log('[STEP 1] Template baixado, size:', imageBuffer.length, 'mime:', mimeType);
    }

    console.log('[STEP 2] Fazendo upload do template para fal.ai...');
    const templateFalUrl = await uploadBufferToFal(imageBuffer, 'image/jpeg', 'template.jpg', key);
    console.log('[STEP 2] Template URL fal.ai:', templateFalUrl.substring(0, 80));

    console.log('[STEP 3] Chamando face swap...');
    console.log('[STEP 3] face_image_0:', face_image_url.substring(0, 80));
    console.log('[STEP 3] target_image:', templateFalUrl.substring(0, 80));

    const body = {
      face_image_0:  face_image_url,
      target_image:  templateFalUrl,
      workflow_type: 'user_hair',
      gender_0:      'female',
      upscale:       true,
    };

    const resp = await fetch('https://fal.run/easel-ai/advanced-face-swap', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const raw = await resp.text();
    console.log('[STEP 3] FAL status:', resp.status);
    console.log('[STEP 3] FAL body:', raw.substring(0, 500));

    if (!resp.ok) {
      let msg = `Erro fal.ai ${resp.status}`;
      try {
        const e = JSON.parse(raw);
        if (Array.isArray(e.detail)) {
          msg = e.detail.map(d => `${JSON.stringify(d.loc)}: ${d.msg}`).join(' | ');
        } else {
          msg = e.detail || e.message || e.error || msg;
        }
      } catch(_) { msg = raw.substring(0, 300) || msg; }
      if (resp.status === 401) return res.status(401).json({ error: 'Chave inválida ou sem créditos.' });
      return res.status(resp.status).json({ error: msg });
    }

    const data = JSON.parse(raw);
    const url = data?.image?.url || data?.images?.[0]?.url;
    if (!url) {
      console.error('[STEP 3] Sem URL. Resposta completa:', JSON.stringify(data));
      return res.status(500).json({ error: 'Sem imagem na resposta.' });
    }

    console.log('[RESULT]', url.substring(0, 80));
    res.json({ url });

  } catch (err) {
    console.error('[GENERATE EXCEPTION]', err.message);
    console.error('[GENERATE STACK]', err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/credits', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave não fornecida.' });
    const r = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'test.txt', content_type: 'text/plain' }),
    });
    res.json({ valid: r.status !== 401 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Studio rodando na porta ${PORT}`));
