// api/index.js - Vercel 專用完美無損轉發
const { createProxyMiddleware } = require('http-proxy-middleware');

// 處理 Cline 必須的 CORS 跨域標頭
const corsLabels = (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-goog-api-key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
};

const proxy = createProxyMiddleware({
    target: 'https://generativelanguage.googleapis.com',
    changeOrigin: true,
    pathRewrite: (path) => path.replace(/^\/api/, ''), // 把 Vercel 預設的 /api 路徑抹除，對齊 Google
    onProxyReq: (proxyReq, req, res) => {
        // 修正 Cline 偶爾會帶錯的模型名稱
        if (req.url.includes('gemini-3.5-flash')) {
            proxyReq.path = proxyReq.path.replace('gemini-3.5-flash', 'gemini-2.5-flash');
        }
        // 注入你在 Vercel 後台設定的 Google 官方 Key
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
            proxyReq.setHeader('x-goog-api-key', apiKey);
        }
        proxyReq.setHeader('host', 'generativelanguage.googleapis.com');
    },
    onProxyRes: (proxyRes, req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
});

module.exports = (req, res) => {
    corsLabels(req, res, () => {
        proxy(req, res);
    });
};
