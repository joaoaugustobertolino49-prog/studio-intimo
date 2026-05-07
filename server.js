const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Faz upload de qualquer buffer para fal.ai storage
async function uploadBufferToFal(buffer, mimetype, filename, key) {
  const initResp = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: filename, content_type: mimetype }),
  });
  if (!initResp.ok) {
    const e = await initResp.json().catch(() => ({}));
    throw new Error(e.detail || 'Erro ao iniciar upload.');
  }
  const { upload_url, file_url } = await initResp.json();
  const put = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mimetype },
    body: buffer,
  });
  if (!put.ok) throw new Error('Erro ao enviar para storage.');
  return file_url;
}

// Upload da foto do usuário
app.post('/api/upload', upload.array('images', 5), async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });
    if (!req.files?.length) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    const urls = await Promise.all(
      req.files.map(f => uploadBufferToFal(f.buffer, f.mimetype, f.originalname, key))
    );
    console.log('[UPLOAD] Fotos enviadas:', urls.length);
    res.json({ urls });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Geração: baixa template → sobe pro fal.ai → face swap
app.post('/api/generate', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const { face_image_url, template_url } = req.body;
    if (!face_image_url || !template_url) {
      return res.status(400).json({ error: 'face_image_url e template_url são obrigatórios.' });
    }

    console.log('[GENERATE] face_image_url:', face_image_url.substring(0, 80));
    console.log('[GENERATE] template_url:', template_url.substring(0, 80));

    // Baixar o template e re-hospedar no fal.ai storage
    // (fal.ai precisa de URL própria para processar)
    let finalTemplateUrl = template_url;

    // Se for URL do GitHub raw ou base64, fazer re-upload
    if (template_url.startsWith('data:') || template_url.includes('raw.githubusercontent.com') || template_url.includes('github')) {
      console.log('[GENERATE] Re-hospedando template no fal.ai storage...');
      try {
        let imageBuffer;
        let mimeType = 'image/jpeg';

        if (template_url.startsWith('data:')) {
          // base64
          const matches = template_url.match(/^data:([^;]+);base64,(.+)$/);
          mimeType = matches[1];
          imageBuffer = Buffer.from(matches[2], 'base64');
        } else {
          // URL externa — baixar
          const fetchResp = await fetch(template_url);
          if (!fetchResp.ok) throw new Error(`Erro ao baixar template: ${fetchResp.status}`);
          const arrayBuf = await fetchResp.arrayBuffer();
          imageBuffer = Buffer.from(arrayBuf);
          mimeType = fetchResp.headers.get('content-type') || 'image/jpeg';
        }

        finalTemplateUrl = await uploadBufferToFal(imageBuffer, mimeType, 'template.jpg', key);
        console.log('[GENERATE] Template re-hospedado:', finalTemplateUrl.substring(0, 80));
      } catch (uploadErr) {
        console.warn('[GENERATE] Re-upload falhou, tentando URL direta:', uploadErr.message);
        // Continua com URL original como fallback
      }
    }

    // Chamada Easel AI face swap
    const body = {
      face_image_0:  face_image_url,
      target_image:  finalTemplateUrl,
      workflow_type: 'user_hair',
      gender_0:      'female',
      upscale:       true,
    };

    console.log('[GENERATE] Chamando easel-ai/advanced-face-swap...');

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
          msg = e.detail.map(d => `${d.loc?.slice(-1)}: ${d.msg}`).join(' | ');
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
      console.error('[FAL] Sem URL. Resposta:', JSON.stringify(data).substring(0, 300));
      return res.status(500).json({ error: 'Sem imagem na resposta: ' + JSON.stringify(data).substring(0, 150) });
    }

    console.log('[RESULT]', url.substring(0, 80));
    res.json({ url });
  } catch (err) {
    console.error('[GENERATE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verificar chave
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
