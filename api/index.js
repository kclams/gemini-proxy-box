module.exports = async (req, res) => {
  // 1. 處理 CORS 跨域標頭
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 2. 解析並重寫目標路徑 (抹除 /api)
  let targetPath = req.url.replace(/^\/api/, '');
  
  if (targetPath.includes('gemini-3.5-flash')) {
    targetPath = targetPath.replace('gemini-3.5-flash', 'gemini-2.5-flash');
  }

  const targetUrl = `https://generativelanguage.googleapis.com${targetPath}`;

  // 3. 準備轉發的 Headers
  const headers = { ...req.headers };
  delete headers.host; 
  headers['host'] = 'generativelanguage.googleapis.com';

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
  }

  try {
    // 4. 使用 Node.js 原生 fetch 進行串流傳輸 (Streaming)
    const fetchResponse = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      duplex: 'half'
    });

    res.status(fetchResponse.status);

    fetchResponse.headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('access-control-')) {
        res.setHeader(key, value);
      }
    });

    if (fetchResponse.body) {
      const reader = fetchResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();

  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(500).json({ error: 'Proxy failed', message: error.message });
  }
};
