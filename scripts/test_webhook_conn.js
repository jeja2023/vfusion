const http = require('http');

const payload = JSON.stringify({ event: 'EVENT_INGESTED', timestamp: new Date().toISOString(), data: { test: true } });

const req = http.request('http://localhost:44375/Shared/Handlers/VFusion/VFusionPhotoWebhook.ashx', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-VFusion-Signature': 'test_signature'
  },
  timeout: 5000
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('HTTP Status:', res.statusCode);
    console.log('Headers:', JSON.stringify(res.headers, null, 2));
    console.log('Body:', body.substring(0, 500));
  });
});

req.on('error', (err) => {
  console.log('Connection Error:', err.message);
});

req.on('timeout', () => {
  console.log('Timeout!');
  req.destroy();
});

req.write(payload);
req.end();
