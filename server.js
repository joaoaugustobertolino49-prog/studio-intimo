const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function uploadToFal(buffer, mimetype, filename, key) {
  const initResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: filename || 'photo.jpg', content_type: mimetype }),
  });
  if (!initResp.ok) {
    const e = await initResp.json().catch(() => ({}));
    throw new Error(e.detail || 'Erro ao iniciar upload.');
  }
  const { upload_url, file_url } = await initResp.json();
  const put = await fetch(upload_url, {
    method: 'PUT', headers: { 'Content-Type': mimetype }, body: buffer,
  });
  if (!put.ok) throw new Error('Erro ao enviar imagem.');
  return file_url;
}

app.post('/api/upload', upload.array('images', 5), async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });
    if (!req.files?.length) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    const urls = await Promise.all(req.files.map(f => uploadToFal(f.buffer, f.mimetype, f.originalname, key)));
    console.log(`[UPLOAD] ${urls.length} foto(s):`, urls.map(u => u.substring(0,60)));
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
      return res.status(400).json({ error: 'face_image_url e template_url são obrigatórios.' });
    }

    // Parâmetros corretos conforme documentação do Easel AI
    const body = {
      face_image_0:  face_image_url,  // foto da pessoa (origem)
      target_image:  template_url,    // template do ensaio (destino)
      workflow_type: 'user_hair',     // preserva cabelo da pessoa
      gender_0:      'female',
      upscale:       true,
    };

    console.log('[GENERATE] Chamando easel-ai/advanced-face-swap');
    console.log('[GENERATE] face_image_0:', face_image_url.substring(0,80));
    console.log('[GENERATE] target_image:', template_url.substring(0,80));

    const resp = await fetch('https://fal.run/easel-ai/advanced-face-swap', {
      method:  'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const raw = await resp.text();
    console.log('[FAL STATUS]', resp.status);
    console.log('[FAL BODY]', raw.substring(0, 400));

    if (!resp.ok) {
      let msg = `Erro fal.ai ${resp.status}`;
      try {
        const e = JSON.parse(raw);
        if (Array.isArray(e.detail)) {
          msg = e.detail.map(d => `${d.loc?.join('.')}: ${d.msg}`).join(' | ');
        } else {
          msg = e.detail || e.message || e.error || msg;
        }
      } catch(_) { msg = raw.substring(0, 200) || msg; }
      if (resp.status === 401) return res.status(401).json({ error: 'Chave inválida ou sem créditos.' });
      return res.status(resp.status).json({ error: msg });
    }

    let data;
    try { data = JSON.parse(raw); }
    catch(_) { return res.status(500).json({ error: 'Resposta inválida do fal.ai.' }); }

    const url = data?.image?.url || data?.images?.[0]?.url;
    if (!url) {
      console.error('[FAL] Sem URL. Dados:', JSON.stringify(data).substring(0,300));
      return res.status(500).json({ error: 'Sem imagem na resposta: ' + JSON.stringify(data).substring(0,100) });
    }

    console.log('[RESULT]', url.substring(0,80));
    res.json({ url });
  } catch (err) {
    console.error('[GENERATE ERROR]', err.message);
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
