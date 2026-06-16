module.exports = async (req, res) => {
  // 1. 處理 CORS 跨域標頭
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 2. 精準解析 Cline 發過來的純路徑 (移除 vercel.json 產生的 path 參數雜訊)
  let incomingPath = req.url || '';
  const parsedUrl = new URL(incomingPath, 'http://localhost');
  let cleanPath = parsedUrl.pathname;

  cleanPath = cleanPath.replace(/^\/api/, '').replace(/^\/v1beta/, '');
  if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;

  let targetUrl = `https://generativelanguage.googleapis.com${cleanPath}`;
  let isChatCompletion = parsedUrl.pathname.includes('chat/completions');

  // 3. 準備轉發給 Google 的 Headers (主動宣告不接受 Gzip 壓縮，確保拿到純文字流)
  const headers = {
    'host': 'generativelanguage.googleapis.com',
    'content-type': 'application/json',
    'accept-encoding': 'identity'
  };

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
    targetUrl += `?key=${apiKey}`;
  }

  // 4. 核心轉譯邏輯：將 OpenAI 格式轉為 Gemini 格式
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

      // 強制走 Google 官方的 Streaming 路由
      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`;
      if (apiKey) {
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

    // 關鍵：如果是 Chat 且成功連線，強制設定 Response 為標準 SSE (text/event-stream) 串流格式
    if (isChatCompletion && fetchResponse.status === 200) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
    } else {
      res.status(fetchResponse.status);
    }

    fetchResponse.headers.forEach((value, key) => {
      if (!key.toLowerCase().startsWith('access-control-') && key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-type') {
        res.setHeader(key, value);
      }
    });

    // 6. 處理 Google 的回傳：完美實時 Streaming 直通
    if (fetchResponse.body) {
      const reader = fetchResponse.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!isChatCompletion) {
          // 非對話請求直接原汁原味寫入
          res.write(value);
        } else {
          // 關鍵：將 Google 的 streamGenerateContent 數據片段，即時提取並翻譯給 Cline
          buffer += decoder.decode(value, { stream: true });
          
          // 利用正則表達式，只要在緩衝區看到 "text": "..."，就立刻把它撈出來發送
          const match = buffer.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
          if (match) {
            for (const m of match) {
              try {
                const textValue = JSON.parse(`{${m}}`).text;
                if (textValue) {
                  // 包裝成標準 OpenAI SSE 格式片段
                  const sseChunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: 'gemini-2.5-flash',
                    choices: [{
                      index: 0,
                      delta: { content: textValue },
                      finish_reason: null
                    }]
                  };
                  // 一字一字即時吐回給 VS Code Cline
                  res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
                }
              } catch (parseErr) {
                // 單個片段解析失敗則跳過，防止不完整的轉義字元崩潰
              }
            }
            buffer = ''; // 成功處理完這一批，清空緩衝區
          }
        }
      }

      // 當所有數據傳輸完畢，發送標準 OpenAI 結束訊號給 Cline 關閉連接
      if (isChatCompletion) {
        const sseEnd = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'gemini-2.5-flash',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        res.write(`data: ${JSON.stringify(sseEnd)}\n\n`);
        res.write('data: [DONE]\n\n');
      }
    }
    res.end();

  } catch (error) {
    console.error('Proxy Error:', error);
    res.status(500).json({ error: 'Proxy failed', message: error.message });
  }
};
