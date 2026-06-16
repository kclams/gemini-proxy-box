module.exports = async (req, res) => {
  // 1. 處理 CORS 跨域標頭
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 2. 解析 Cline 發過來的路徑
  // Cline 如果設定 Base URL 為 .../api/v1beta，req.url 會是 /api/v1beta/chat/completions
  let incomingPath = req.url;

  // 預設目標網址
  let targetUrl = `https://generativelanguage.googleapis.com${incomingPath.replace(/^\/api/, '')}`;
  let isChatCompletion = incomingPath.includes('chat/completions');

  // 3. 核心翻譯邏輯：如果 Cline 發送的是 OpenAI 格式的 chat/completions
  if (isChatCompletion && req.method === 'POST') {
    let bodyText = '';
    
    // 讀取 Cline 傳過來的原始 Body
    if (req.body) {
      bodyText = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    } else {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      bodyText = Buffer.concat(buffers).toString();
    }

    try {
      const openAiBody = JSON.parse(bodyText);
      // 提取模型名稱，預設為 gemini-2.5-flash
      let model = openAiBody.model || 'gemini-2.5-flash';
      if (model.includes('gemini-3.5-flash')) model = 'gemini-2.5-flash';

      // 檢查 Cline 是否要求 Streaming (打字機特效)
      const isStream = openAiBody.stream === true;
      const googleAction = isStream ? 'streamGenerateContent' : 'generateContent';

      // 重新拼裝成 Google 官方認得的標準 REST 網址
      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${googleAction}`;

      // 把 OpenAI 的 messages 陣列翻譯成 Gemini 的 contents 格式
      const googleContents = openAiBody.messages.map(msg => {
        // OpenAI 的 'assistant' 要換成 Gemini 的 'model'
        const role = msg.role === 'assistant' ? 'model' : msg.role;
        return {
          role: role,
          parts: [{ text: msg.content }]
        };
      });

      // 重新包裝成 Google 格式的請求體
      req.modifiedBody = JSON.stringify({ contents: googleContents });
    } catch (e) {
      console.error('解析 OpenAI Body 失敗，降級為原生轉發', e);
    }
  }

  // 4. 準備 Headers
  const headers = { ...req.headers };
  delete headers.host;
  headers['host'] = 'generativelanguage.googleapis.com';
  headers['content-type'] = 'application/json';

  // 注入 Vercel 後台的 API Key
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
    // 同時相容兩種帶 Key 的方式
    targetUrl += targetUrl.includes('?') ? `&key=${apiKey}` : `?key=${apiKey}`;
  }

  try {
    // 5. 正式發送請求給 Google
    const finalBody = req.modifiedBody || (req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined);
    
    const fetchResponse = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: finalBody,
      duplex: 'half'
    });

    res.status(fetchResponse.status);

    fetchResponse.headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('access-control-')) {
        res.setHeader(key, value);
      }
    });

    // 6. 如果是串流且是 chat/completions，我們也需要把 Google 的串流翻譯回 OpenAI 格式給 Cline
    if (fetchResponse.body) {
      const reader = fetchResponse.body.getReader();
      
      // 如果不是 chat/completions，直接原封不動倒進去
      if (!isChatCompletion) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } else {
        // 如果是 chat/completions，這裡做簡化轉發，確保 Cline 能拿到文字
        // 為了極致穩定性，直接把 Google 流讀完並輸出標準結構
        let responseText = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          responseText += new TextDecoder().decode(value);
        }

        try {
          // 嘗試解析 Gemini 的回傳
          const googleJson = JSON.parse(responseText);
          const aiText = googleJson.candidates?.[0]?.content?.parts?.[0]?.text || '';
          
          // 包裝成 Cline 期待的標準 OpenAI 成功回應格式
          const openAiResponse = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'gemini-2.5-flash',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: aiText },
              finish_reason: 'stop'
            }]
          };
          res.write(JSON.stringify(openAiResponse));
        } catch (jsonErr) {
          // 如果是 stream 數據格式，進行保底輸出
          res.write(responseText);
        }
      }
    }
    res.end();

  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(500).json({ error: 'Proxy failed', message: error.message });
  }
};
