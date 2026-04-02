const express = require('express');
const path = require('path');
const app = express();

// ВАЖНО: Разрешаем Дискорду показывать нашу игру внутри своего окна
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "frame-ancestors https://discord.com https://*.discordapp.com");
    res.setHeader("X-Frame-Options", "ALLOW-FROM https://discord.com");
    next();
});

// Раздаем статические файлы (твой index.html)
app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
