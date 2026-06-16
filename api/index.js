module.exports = async (req, res) => {
  // 1. 處理 CORS 跨域標頭
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 2. 解析 Cline 發過來的路徑
  let incomingPath = req.url || '';
  let cleanPath = incomingPath.replace(/^\/api/, '').replace(/^\/v1beta/, '');
  if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;

  let targetUrl = `https://generativelanguage.googleapis.com${cleanPath}`;
  let isChatCompletion = incomingPath.includes('chat/completions');

  // 3. 準備轉發給 Google 的 Headers (只保留最核心的)
  const headers = {
    'host': 'generativelanguage.googleapis.com',
    'content-type': 'application/json'
  };

  // 注入 Vercel 後台的 API Key
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
    if (!targetUrl.includes('key=')) {
      targetUrl += targetUrl.includes('?') ? `&key=${apiKey}` : `?key=${apiKey}`;
    }
  }

  // 4. 核心翻譯邏輯：如果 Cline 發送的是 OpenAI 格式的 chat/completions
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

      // 重新拼裝成 Google 官方 REST 網址
      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${googleAction}`;
      if (apiKey && !targetUrl.includes('key=')) {
        targetUrl += `?key=${apiKey}`;
      }

      // 翻譯 messages
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
    // 非 chat/completions 的常規 POST 請求轉發
    const buffers = [];
    for await (const chunk of req) {
      buffers.push(chunk);
    }
    finalBody = Buffer.concat(buffers);
  }

  try {
    // 5. 正式發送請求給 Google (移除 duplex，使用最基礎的 fetch 結構防止崩潰)
    const fetchResponse = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: finalBody
    });

    res.status(fetchResponse.status);

    fetchResponse.headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('access-control-')) {
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
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          responseText += new TextDecoder().decode(value);
        }

        try {
          const googleJson = JSON.parse(responseText);
          // 如果 Google 回報錯誤，直接把錯誤吐回去幫忙除錯
          if (googleJson.error) {
            res.write(JSON.stringify(googleJson));
          } else {
            const aiText = googleJson.candidates?.[0]?.content?.parts?.[0]?.text || 
                           googleJson[0]?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
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
