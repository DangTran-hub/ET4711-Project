require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Xin chào từ server' });
});

app.listen(3000, () => console.log('Server chạy ở cổng 3000'));