export const config = {
  runtime: 'edge'
};

export default async function handler(req) {
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

  const url = new URL(req.url);
  let cleanPath = url.pathname.replace(/^\/api/, '').replace(/^\/v1beta/, '');
  if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;

  let targetUrl = `https://generativelanguage.googleapis.com${cleanPath}`;
  const isChatCompletion = url.pathname.includes('chat/completions');

  const headers = new Headers();
  headers.set('host', 'generativelanguage.googleapis.com');
  headers.set('content-type', 'application/json');
  headers.set('accept-encoding', 'identity');

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey && !isChatCompletion) {
    targetUrl += `?key=${apiKey}`;
  }

  let finalBody = null;

  if (isChatCompletion && req.method === 'POST') {
    try {
      const openAiBody = await req.json();
      let model = openAiBody.model || 'gemini-2.5-flash';
      if (model.includes('gemini-3.5-flash')) model = 'gemini-2.5-flash';

      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
      if (apiKey) targetUrl += `&key=${apiKey}`;

      // 🚀 升級版：完美支援 Cline 的字串、陣列以及圖片傳輸
      const googleContents = openAiBody.messages.map(msg => {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        let parts = [];

        // 如果是單純的文字
        if (typeof msg.content === 'string') {
          parts = [{ text: msg.content }];
        } 
        // 如果是 Cline 傳來的多模態陣列 (包含圖片或複雜結構)
        else if (Array.isArray(msg.content)) {
          parts = msg.content.map(part => {
            if (part.type === 'text') {
              return { text: part.text };
            } else if (part.type === 'image_url' && part.image_url?.url) {
              // 擷取 Base64 圖片並轉換為 Gemini 格式
              const match = part.image_url.url.match(/^data:(.*?);base64,(.*)$/);
              if (match) {
                return {
                  inlineData: {
                    mimeType: match[1],
                    data: match[2]
                  }
                };
              }
              return { text: `[Image link: ${part.image_url.url}]` };
            }
            return { text: JSON.stringify(part) };
          });
        }

        return { role: role, parts: parts };
      });

      finalBody = JSON.stringify({ contents: googleContents });
    } catch (e) {
      console.error('解析 OpenAI Body 失敗', e);
    }
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    finalBody = await req.text();
  }

  try {
    const fetchResponse = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: finalBody
    });

    const responseHeaders = new Headers();
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');

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

    responseHeaders.set('Content-Type', 'text/event-stream');
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');

    const { writable, readable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = fetchResponse.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();
    
    (async () => {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.trim() === '') continue;
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;
              
              try {
                const googleJson = JSON.parse(dataStr);
                const textValue = googleJson.candidates?.[0]?.content?.parts?.[0]?.text;
                
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
                  await writer.write(encoder.encode(`data: ${JSON.stringify(sseChunk)}\n\n`));
                }
              } catch (parseErr) {}
            }
          }
        }

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
        console.error('Stream error:', err);
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: responseHeaders
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: 'Proxy failed', message: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
