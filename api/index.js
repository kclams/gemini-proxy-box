module.exports = async (req, res) => {
  // 1. 處理 CORS 跨域標頭
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 2. 精準解析 Cline 發過來的純路徑
  let incomingPath = req.url || '';
  const parsedUrl = new URL(incomingPath, 'http://localhost');
  let cleanPath = parsedUrl.pathname;

  cleanPath = cleanPath.replace(/^\/api/, '').replace(/^\/v1beta/, '');
  if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;

  let targetUrl = `https://generativelanguage.googleapis.com${cleanPath}`;
  let isChatCompletion = parsedUrl.pathname.includes('chat/completions');

  // 3. 準備轉發給 Google 的 Headers (主動宣告不接受 Gzip，防止 Z_DATA_ERROR)
  const headers = {
    'host': 'generativelanguage.googleapis.com',
    'content-type': 'application/json',
    'accept-encoding': 'identity' // 關鍵：強制要求 Google 吐出未壓縮的原始文字流
  };

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
    targetUrl += `?key=${apiKey}`;
  }

  // 4. 核心翻譯邏輯
  let finalBody = undefined;
  if (isChatCompletion && req.method === 'POST') {
    let bodyText = '';
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
      let model = openAiBody.model || 'gemini-2.5-flash';
      if (model.includes('gemini-3.5-flash')) model = 'gemini-2.5-flash';

      const isStream = openAiBody.stream === true;
      const googleAction = isStream ? 'streamGenerateContent' : 'generateContent';

      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${googleAction}`;
      if (apiKey) {
        targetUrl += `?key=${apiKey}`;
      }

      const googleContents = openAiBody.messages.map(msg => {
        const role = msg.role === 'assistant' ? 'model' : msg.role;
        return {
          role: role,
          parts: [{ text: msg.content }]
        };
      });

      finalBody = JSON.stringify({ contents: googleContents });
    } catch (e) {
      console.error('解析 OpenAI Body 失敗', e);
    }
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buffers = [];
    for await (const chunk of req) {
      buffers.push(chunk);
    }
    finalBody = Buffer.concat(buffers);
  }

  try {
    // 5. 正式發送請求給 Google
    const fetchResponse = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: finalBody
    });

    res.status(fetchResponse.status);

    fetchResponse.headers.forEach((value, key) => {
      // 抹除 Google 的 content-encoding 標頭，防止客戶端重複解壓縮崩潰
      if (!key.toLowerCase().startsWith('access-control-') && key.toLowerCase() !== 'content-encoding') {
        res.setHeader(key, value);
      }
    });

    // 6. 處理 Google 的回傳
    if (fetchResponse.body) {
      const reader = fetchResponse.body.getReader();
      
      if (!isChatCompletion) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } else {
        let responseText = '';
        const decoder = new TextDecoder('utf-8');
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          responseText += decoder.decode(value, { stream: true });
        }

        try {
          const googleJson = JSON.parse(responseText);
          if (googleJson.error) {
            res.write(JSON.stringify(googleJson));
          } else {
            const targetObj = Array.isArray(googleJson) ? googleJson[0] : googleJson;
            const aiText = targetObj.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
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
          }
        } catch (jsonErr) {
          // 如果解析 JSON 失敗，保底直接把原始文字吐回去
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
