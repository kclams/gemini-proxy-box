// api/index.js - Vercel Serverless 專用完美無損 Gemini 轉發
module.exports = async (req, res) => {
  // 1. 處理 Cline 必須的 CORS 跨域標頭
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 2. 解析並重寫目標路徑 (抹除 Vercel 預設的 /api)
  let targetPath = req.url.replace(/^\/api/, '');
  
  // 修正 Cline 偶爾會帶錯的模型名稱
  if (targetPath.includes('gemini-3.5-flash')) {
    targetPath = targetPath.replace('gemini-3.5-flash', 'gemini-2.5-flash');
  }

  const targetUrl = `https://generativelanguage.googleapis.com${targetPath}`;

  // 3. 準備轉發的 Headers
  const headers = { ...req.headers };
  delete headers.host; // 讓 fetch 自動重新生成正確的 host
  headers['host'] = 'generativelanguage.googleapis.com';

  // 注入你在 Vercel 後台設定的 Google 官方 Key
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
  }

  try {
    // 4. 使用 Node.js 18+ 原生 fetch 進行流式傳輸轉發 (Streaming)
    const fetchResponse = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      duplex: 'half' // 允許串流傳輸體
    });

    // 複製回應狀態碼
    res.status(fetchResponse.status);

    // 複製回應 Headers
    fetchResponse.headers.forEach((value, key) => {
      // 避免覆蓋我們自己設定的 CORS 標頭
      if (!key.toLowerCase().startsWith('access-control-')) {
        res.setHeader(key, value);
      }
    });

    // 關鍵：將 Google 的回應流 (Stream) 直接導向 Vercel 的回應，實現完美無損轉發
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
