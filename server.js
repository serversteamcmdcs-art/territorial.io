const express = require('express');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');

// 1. Настройка веб-сервера для игры
const app = express();
app.use(express.static(path.join(__dirname, '/')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сайт игры запущен на порту ${PORT}`));

// 2. Настройка бота
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', () => {
    console.log(`Бот ${client.user.tag} готов!`);
});

client.on('messageCreate', async (message) => {
    if (message.content === '!play') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Играть в Discord')
                .setStyle(ButtonStyle.Link)
                .setURL(`https://discord.com/app-assets/${client.user.id}/index.html`) // Ссылка для Activity
        );

        await message.reply({ content: 'Нажми кнопку ниже, чтобы запустить игру!', components: [row] });
    }
});

// Вместо 'TOKEN' вставь свой токен из Discord Portal (или добавь в Environment Variables на Render)
client.login(process.env.DISCORD_TOKEN);
