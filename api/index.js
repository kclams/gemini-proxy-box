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

  // 3. 準備轉發給 Google 的 Headers (主動宣告不接受 Gzip 壓縮)
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

  // 4. 核心轉譯邏輯：如果 Cline 發送的是 OpenAI 格式的 chat/completions
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

      // 既然 Cline 一定會用 Streaming，我們就強制走 Google 官方的 Streaming 路由
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

    // 如果是 Chat 且成功連線，強制設定 Response 為 SSE 串流格式，配合 Cline 讀取
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

    // 6. 處理 Google 的回傳：完美無損 Streaming 直通
    if (fetchResponse.body) {
      const reader = fetchResponse.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!isChatCompletion) {
          // 非 chat/completions 請求直接原汁原味寫入
          res.write(value);
        } else {
          // 關鍵：將 Google 的 streamGenerateContent 格式，動態翻譯成 OpenAI 的 stream 格式
          buffer += decoder.decode(value, { stream: true });
          
          // Google 串流回應通常是一個 JSON 陣列或獨立的對象塊
          // 這裡我們直接把文字提取出來，包裝成標準 OpenAI SSE 格式發送
          try {
            // 清理可能干擾的逗號或陣列括號，嘗試尋找 text 欄位
            const match = buffer.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
            if (match) {
              for (const m of match) {
                const textValue = JSON.parse(`{${m}}`).text;
                if (textValue) {
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
                  res.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
                }
              }
              buffer = ''; // 清空已處理的緩衝
            }
          } catch (e) {
            // 解析失敗時不中斷，等待更多緩衝數據進來
          }
        }
      }

      // 串流結束，發送結束訊號給 Cline
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
