export const config = {
  runtime: 'nodejs' // 確保使用標準 Node.js 環境
};

export default async function handler(req) {
  // 1. 處理 CORS 跨域預檢 (OPTIONS)
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-goog-api-key'
      }
    });
  }

  // 2. 解析並重寫目標路徑
  const url = new URL(req.url);
  let cleanPath = url.pathname.replace(/^\/api/, '').replace(/^\/v1beta/, '');
  if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;

  let targetUrl = `https://generativelanguage.googleapis.com${cleanPath}`;
  const isChatCompletion = url.pathname.includes('chat/completions');

  // 3. 建立轉發給 Google 的 Headers
  const headers = new Headers();
  headers.set('host', 'generativelanguage.googleapis.com');
  headers.set('content-type', 'application/json');
  headers.set('accept-encoding', 'identity'); // 拒絕壓縮，防止 Z_DATA_ERROR

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    headers.set('x-goog-api-key', apiKey);
    targetUrl += `?key=${apiKey}`;
  }

  let finalBody = null;

  // 4. 翻譯邏輯：將 OpenAI 格式轉為 Gemini 格式
  if (isChatCompletion && req.method === 'POST') {
    try {
      const openAiBody = await req.json();
      let model = openAiBody.model || 'gemini-2.5-flash';
      if (model.includes('gemini-3.5-flash')) model = 'gemini-2.5-flash';

      // 強制走 Google 官方的 Streaming 路由
      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`;
      if (apiKey) targetUrl += `?key=${apiKey}`;

      // 翻譯 messages 陣列
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
    finalBody = await req.text();
  }

  try {
    // 5. 正式向 Google 發起請求
    const fetchResponse = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: finalBody
    });

    // 6. 設定要回傳給 Cline 的基底 Headers
    const responseHeaders = new Headers();
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');

    // 如果不是 chat/completions，直接原封不動把 Google 的 Response 倒回去
    if (!isChatCompletion || fetchResponse.status !== 200) {
      fetchResponse.headers.forEach((value, key) => {
        if (!key.toLowerCase().startsWith('access-control-')) {
          responseHeaders.set(key, value);
        }
      });
      return new Response(fetchResponse.body, {
        status: fetchResponse.status,
        headers: responseHeaders
      });
    }

    // 7. 如果是對話請求，建立一個「真・即時串流（TransformStream）」實時翻譯給 Cline
    responseHeaders.set('Content-Type', 'text/event-stream');
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');

    const { writable, readable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = fetchResponse.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();
    
    // 非同步執行的串流轉換器，絕不卡死連線
    (async () => {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          
          // 即時撈出 "text": "..." 欄位
          const match = buffer.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
          if (match) {
            for (const m of match) {
              try {
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
                  // 毫不延遲，發現一個字，就立刻噴回給 VS Code Cline
                  await writer.write(encoder.encode(`data: ${JSON.stringify(sseChunk)}\n\n`));
                }
              } catch (pErr) {}
            }
            buffer = '';
          }
        }

        // 結束串流訊號
        const sseEnd = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'gemini-2.5-flash',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(sseEnd)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (err) {
        console.error('串流轉換錯誤:', err);
      } finally {
        await writer.close();
      }
    })();

    // 返回這個可讀流，Vercel 網關會自動進行真實 Streaming 轉發！
    return new Response(readable, {
      status: 200,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('Proxy Error:', error);
    return new Response(JSON.stringify({ error: 'Proxy failed', message: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
