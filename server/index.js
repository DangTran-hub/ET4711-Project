const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Xin chào từ server' });
});

app.get('/api/v1/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

if (require.main === module) {
  app.listen(3000).on('listening', () => {
    console.log('Server chạy ở cổng 3000');
  });
}

module.exports = app;
