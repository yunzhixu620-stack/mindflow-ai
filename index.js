// ==========================================
// MindFlow API Proxy - Alibaba Cloud FC Web Function
// 支持两种功能：
// 1. HTTP POST: AI 文本生成代理
// 2. WebSocket Upgrade: ASR 语音识别代理
// ==========================================

const http = require('http');
const https = require('https');
const url = require('url');

// ==================== 安全配置 ====================
// 【重要】使用环境变量存储敏感信息，不要硬编码在代码里！
// 在阿里云函数计算控制台设置：
// 1. 进入函数详情 → 环境变量
// 2. 添加 MINDFLOW_API_KEY = sk-xxxxx
const MY_API_KEY = process.env.MINDFLOW_API_KEY;

if (!MY_API_KEY) {
  console.error('❌ 错误：未找到 MINDFLOW_API_KEY 环境变量！');
  console.error('请在阿里云函数计算控制台设置环境变量。');
  process.exit(1);
}

const AI_TARGET = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const ASR_TARGET = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const PORT = parseInt(process.env.FC_SERVER_PORT || process.env.PORT || '9000', 10);

// ==================== HTTP POST: AI 文本生成 ====================
function handleHTTP(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  var chunks = [];
  req.on('data', function(chunk) { chunks.push(chunk); });
  req.on('end', function() {
    try {
      var body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      
      if (!body.messages || !Array.isArray(body.messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing or invalid messages' }));
      }

      var postData = JSON.stringify({
        model: body.model || 'qwen-plus', // 默认改为 qwen-plus
        messages: body.messages,
        temperature: body.temperature || 0.7,
      });

      var options = {
        hostname: 'dashscope.aliyuncs.com',
        path: '/compatible-mode/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + MY_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      var req2 = https.request(options, function(res2) {
        var data = '';
        res2.on('data', function(chunk) { data += chunk; });
        res2.on('end', function() {
          // 透传阿里云的响应
          res.writeHead(res2.statusCode, { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(data);
        });
      });

      req2.on('error', function(error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backend request failed: ' + error.message }));
      });

      req2.write(postData);
      req2.end();

    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request body', detail: err.message }));
    }
  });
}

// ==================== WebSocket: ASR 语音识别 ====================
function handleWebSocket(req, socket, head) {
  var headers = req.headers;

  // 构造阿里云 WebSocket URL
  var targetUrl = url.parse(ASR_TARGET);

  // 连接到阿里云 WebSocket
  var options = {
    host: targetUrl.hostname,
    port: 443,
    path: targetUrl.path,
    method: 'GET',
    headers: {
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Key': headers['sec-websocket-key'],
      'Sec-WebSocket-Version': headers['sec-websocket-version'],
      'Sec-WebSocket-Protocol': 'chat',
      'Authorization': 'Bearer ' + MY_API_KEY,
    },
  };

  var req2 = https.request(options);

  req2.on('upgrade', function(res2, socket2, head2) {
    if (res2.statusCode !== 101) {
      socket.write('HTTP/1.1 ' + res2.statusCode + ' Connection Upgrade\r\n\r\n');
      socket.end();
      return;
    }

    // 发送升级响应给客户端
    var upgradeHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + res2.headers['sec-websocket-accept'],
      '\r\n'
    ].join('\r\n');
    socket.write(upgradeHeaders);

    // 双向转发
    socket.pipe(socket2).pipe(socket);

    socket.on('error', function(err) {
      console.error('Client socket error:', err.message);
      socket2.destroy();
    });

    socket2.on('error', function(err) {
      console.error('Target socket error:', err.message);
      socket.destroy();
    });

    socket.on('close', function() {
      socket2.end();
    });

    socket2.on('close', function() {
      socket.end();
    });
  });

  req2.on('error', function(err) {
    console.error('Connection error:', err.message);
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.end();
  });

  req2.end();
}

// ==================== 主服务器 ====================
const server = http.createServer(function(req, res) {
  var pathname = url.parse(req.url).pathname;

  if (pathname === '/asr') {
    // WebSocket 升级请求由 upgrade 事件处理
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Use WebSocket protocol' }));
    return;
  }

  handleHTTP(req, res);
});

server.on('upgrade', function(req, socket, head) {
  var pathname = url.parse(req.url).pathname;

  if (pathname === '/asr') {
    handleWebSocket(req, socket, head);
  } else {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.end();
  }
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('✅ MindFlow proxy is running on port ' + PORT);
  console.log('📍 API Key configured: ' + (MY_API_KEY ? 'Yes ***' + MY_API_KEY.slice(-4) : 'No ❌'));
});
