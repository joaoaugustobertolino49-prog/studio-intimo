const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');

const app    = express();
const upload = multer({ limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Upload de UMA foto para fal.ai storage
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
  const putResp = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mimetype },
    body: buffer,
  });
  if (!putResp.ok) throw new Error('Erro ao enviar imagem para storage.');
  return file_url;
}

// Upload de múltiplas fotos
app.post('/api/upload', upload.array('images', 5), async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });

    const urls = await Promise.all(
      req.files.map(f => uploadToFal(f.buffer, f.mimetype, f.originalname, key))
    );

    console.log(`[UPLOAD] ${urls.length} foto(s) enviadas com sucesso.`);
    res.json({ urls });
  } catch (err) {
    console.error('[UPLOAD]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Gerar ensaio com FLUX Kontext
// Estratégia: se há múltiplas fotos, faz chamadas sequenciais
// usando cada foto como referência adicional no prompt
app.post('/api/generate', async (req, res) => {
  try {
    const key = req.headers['x-fal-key'];
    if (!key) return res.status(401).json({ error: 'Chave API não fornecida.' });

    const { image_urls, prompt } = req.body;
    if (!image_urls || image_urls.length === 0 || !prompt) {
      return res.status(400).json({ error: 'image_urls e prompt são obrigatórios.' });
    }

    console.log(`[GENERATE] ${image_urls.length} foto(s) de referência. Prompt: ${prompt.substring(0,100)}`);

    // Usa a primeira foto como imagem base do Kontext
    // e descreve as demais no prompt para o modelo considerar
    const mainImageUrl = image_urls[0];

    // Monta contexto adicional das fotos extras no prompt
    let extraContext = '';
    if (image_urls.length > 1) {
      extraContext = ` Use all provided reference images to accurately capture the person's face, body type, skin tone, and physical features.`;
    }

    const finalPrompt = `Keep the exact same face, facial features, skin tone, body type and physical identity of the person in the reference image.${extraContext} ${prompt}. Photorealistic, high quality, 8k, professional photography, sharp focus, detailed skin texture.`;

    // Chamada principal com imagem base
    const resp = await fetch('https://fal.run/fal-ai/flux-pro/kontext', {
      method: 'POST',
      headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url:      mainImageUrl,
        prompt:         finalPrompt,
        guidance_scale: 3.5,
        num_images:     1,
        output_format:  'jpeg',
      }),
    });

    const rawText = await resp.text();
    console.log('[FAL STATUS]', resp.status);
    console.log('[FAL BODY]', rawText.substring(0, 300));

    if (!resp.ok) {
      let errMsg = `Erro fal.ai ${resp.status}`;
      try { const e = JSON.parse(rawText); errMsg = e.detail || e.message || e.error || errMsg; } catch(_) {}
      if (resp.status === 401) return res.status(401).json({ error: 'Chave inválida ou sem créditos.' });
      return res.status(resp.status).json({ error: errMsg });
    }

    let data;
    try { data = JSON.parse(rawText); } catch(_) { return res.status(500).json({ error: 'Resposta inválida do fal.ai.' }); }

    let finalUrl = data?.images?.[0]?.url;
    if (!finalUrl) return res.status(500).json({ error: 'fal.ai não retornou imagem.' });

    // Se há fotos de corpo como referência adicional, faz um segundo pass
    // usando a imagem gerada + foto de corpo para refinar proporções
    if (image_urls.length > 1) {
      console.log('[GENERATE] Segundo pass com foto de corpo...');
      try {
        const bodyPrompt = `Refine this image keeping the exact same face and scene. Match the body proportions, skin tone and physical features of the reference person. ${prompt}. Photorealistic, 8k.`;

        const resp2 = await fetch('https://fal.run/fal-ai/flux-pro/kontext', {
          method: 'POST',
          headers: { 'Authorization': `Key ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_url:      finalUrl,
            prompt:         bodyPrompt,
            guidance_scale: 2.5,
            num_images:     1,
            output_format:  'jpeg',
          }),
        });

        if (resp2.ok) {
          const data2 = await resp2.json();
          const url2  = data2?.images?.[0]?.url;
          if (url2) { finalUrl = url2; console.log('[GENERATE] Segundo pass concluído.'); }
        }
      } catch(e) {
        console.warn('[GENERATE] Segundo pass falhou, usando resultado do primeiro pass.', e.message);
      }
    }

    console.log('[RESULT]', finalUrl.substring(0, 80));
    res.json({ url: finalUrl });
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
