#!/usr/bin/env node

/**
 * YACC — Yet Another Claude Controller
 * Discord bot — one channel per iTerm2 terminal session.
 * No public URL needed. Single-user, private server.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { Client, GatewayIntentBits, ChannelType, EmbedBuilder } = require('discord.js');
const Logger = require('./src/core/logger');
const { execFile } = require('child_process');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const logger = new Logger('YACC');

const config = {
    botToken: process.env.DISCORD_BOT_TOKEN,
    guildId: process.env.DISCORD_GUILD_ID,
    allowedUsers: process.env.DISCORD_ALLOWED_USERS
        ? process.env.DISCORD_ALLOWED_USERS.split(',').map(id => id.trim()).filter(Boolean)
        : []
};

if (!config.botToken) { logger.error('DISCORD_BOT_TOKEN not set'); process.exit(1); }
if (!config.guildId) { logger.error('DISCORD_GUILD_ID not set'); process.exit(1); }

const CATEGORY_NAME = 'Claude Sessions';
const CHANNEL_MAP_PATH = path.join(__dirname, 'src/data/channel-map.json');
const IMAGES_DIR = path.join(__dirname, 'src/data/images');
const sessionsDir = path.join(__dirname, 'src/data/sessions');
const NOTIFY_DIR = path.join(__dirname, 'src/data/notifications');
const TTY_PATTERN = /^ttys\d+$/;
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']);
const DISCORD_CDN_PATTERN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//;
const RATE_LIMIT_MS = 2000;
const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
const lastCommandTime = new Map();

for (const dir of [IMAGES_DIR, sessionsDir, path.dirname(CHANNEL_MAP_PATH), NOTIFY_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ── Authorization ────────────────────────────────────────

let serverOwnerId = null;

function isAuthorizedUser(userId) {
    if (config.allowedUsers.length > 0) return config.allowedUsers.includes(userId);
    return serverOwnerId && userId === serverOwnerId;
}

// ── Channel Map ──────────────────────────────────────────

let channelMap = {};
const channelIndex = new Map();

function loadChannelMap() {
    try { channelMap = JSON.parse(fs.readFileSync(CHANNEL_MAP_PATH, 'utf8')); } catch (_) { channelMap = {}; }
    rebuildChannelIndex();
}

function rebuildChannelIndex() {
    channelIndex.clear();
    for (const [project, info] of Object.entries(channelMap)) {
        if (info.channelId) channelIndex.set(info.channelId, { project, ...info });
    }
}

let channelMapDirty = false;
function saveChannelMap() {
    fs.writeFileSync(CHANNEL_MAP_PATH, JSON.stringify(channelMap, null, 2), { mode: 0o600 });
    channelMapDirty = false;
}
function markChannelMapDirty() {
    if (!channelMapDirty) {
        channelMapDirty = true;
        setTimeout(() => { if (channelMapDirty) saveChannelMap(); }, 1000);
    }
}

// ── Cleanup ──────────────────────────────────────────────

function cleanExpiredSessions() {
    const now = Math.floor(Date.now() / 1000);
    try {
        for (const file of fs.readdirSync(sessionsDir)) {
            if (!file.endsWith('.json')) continue;
            try {
                const fp = path.join(sessionsDir, file);
                const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (s.expiresAt && s.expiresAt < now) fs.unlinkSync(fp);
            } catch (_) {}
        }
    } catch (_) {}
}

function cleanOldImages() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    try {
        for (const file of fs.readdirSync(IMAGES_DIR)) {
            try {
                const fp = path.join(IMAGES_DIR, file);
                if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
            } catch (_) {}
        }
    } catch (_) {}
}

function checkAndRecordCommand(channelId) {
    const now = Date.now();
    const last = lastCommandTime.get(channelId) || 0;
    if (now - last < RATE_LIMIT_MS) return false;
    lastCommandTime.set(channelId, now);
    return true;
}

function pruneRateLimits() {
    const cutoff = Date.now() - RATE_LIMIT_MS * 10;
    for (const [key, time] of lastCommandTime) {
        if (time < cutoff) lastCommandTime.delete(key);
    }
    const notifCutoff = Date.now() - 60000;
    for (const [key, val] of lastNotification) {
        if (val.time < notifCutoff) lastNotification.delete(key);
    }
}

// ── iTerm2 injection ─────────────────────────────────────

function injectToTTY(command, ttyPath) {
    return new Promise((resolve, reject) => {
        const ttyName = path.basename(ttyPath);
        if (!TTY_PATTERN.test(ttyName)) { reject(new Error('Invalid TTY')); return; }

        const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        const script = [
            'tell application "iTerm2"',
            '    repeat with w in windows',
            '        repeat with t in tabs of w',
            '            repeat with s in sessions of t',
            `                if tty of s contains "${ttyName}" then`,
            `                    tell s to write text "${escaped}"`,
            '                    return "ok"',
            '                end if',
            '            end repeat',
            '        end repeat',
            '    end repeat',
            '    return "tty_not_found"',
            'end tell'
        ].join('\n');

        execFile('osascript', ['-e', script], (error, stdout) => {
            if (error) { reject(new Error('AppleScript failed')); return; }
            if (stdout.trim() === 'tty_not_found') {
                reject(new Error('Session not found in iTerm2. Run Claude in an iTerm2 tab.'));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

// ── Image download ───────────────────────────────────────

async function downloadDiscordAttachment(url, filename) {
    if (!DISCORD_CDN_PATTERN.test(url)) throw new Error('Invalid attachment URL');

    let ext = path.extname(filename).toLowerCase() || '.jpg';
    if (!ALLOWED_IMAGE_EXTS.has(ext)) ext = '.jpg';
    const localName = `discord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const localPath = path.join(IMAGES_DIR, localName);

    const res = await fetch(url, { redirect: 'error' });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const contentLength = parseInt(res.headers.get('content-length') || '0');
    if (contentLength > MAX_IMAGE_SIZE) throw new Error('File too large');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_SIZE) throw new Error('File too large');
    fs.writeFileSync(localPath, buffer, { mode: 0o600 });
    return localPath;
}

// ── Discord Bot ──────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let categoryId = null;

function sanitizeChannelName(name) {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'claude-session';
}

async function ensureCategory(guild) {
    if (categoryId) {
        const existing = guild.channels.cache.get(categoryId);
        if (existing) return existing;
    }
    let category = guild.channels.cache.find(c => c.name === CATEGORY_NAME && c.type === ChannelType.GuildCategory);
    if (!category) {
        category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory });
        logger.info(`Created category: ${CATEGORY_NAME}`);
    }
    categoryId = category.id;
    return category;
}

async function ensureChannel(guild, projectName, tty) {
    const channelName = sanitizeChannelName(projectName);
    const mapped = channelMap[projectName];
    if (mapped?.channelId) {
        const existing = guild.channels.cache.get(mapped.channelId);
        if (existing) {
            if (tty && mapped.tty !== tty) {
                channelMap[projectName].tty = tty;
                channelMap[projectName].lastSeen = Date.now();
                rebuildChannelIndex();
                markChannelMapDirty();
                await existing.setTopic(`TTY: ${tty} | ${projectName}`).catch(() => {});
            }
            return existing;
        }
    }

    const category = await ensureCategory(guild);
    let channel = guild.channels.cache.find(c => c.name === channelName && c.parentId === category.id);

    if (!channel) {
        channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: `TTY: ${tty || 'unknown'} | ${projectName}`
        });
        logger.info(`Created channel: #${channelName}`);
    }

    channelMap[projectName] = { channelId: channel.id, tty: tty || null, lastSeen: Date.now() };
    rebuildChannelIndex();
    markChannelMapDirty();
    return channel;
}

// ── Message handler ──────────────────────────────────────

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;
        if (!message.guild || message.guild.id !== config.guildId) return;
        if (!isAuthorizedUser(message.author.id)) return;

        const mapping = channelIndex.get(message.channel.id);
        if (!mapping) return;

        if (!mapping.tty) {
            await message.reply('No active terminal session for this channel.').catch(() => {});
            return;
        }

        if (!checkAndRecordCommand(message.channel.id)) {
            await message.reply('Too fast — wait a moment.').catch(() => {});
            return;
        }

        const images = message.attachments.filter(a => {
            const ext = path.extname(a.name || '').toLowerCase();
            return ALLOWED_IMAGE_EXTS.has(ext) || (a.contentType && a.contentType.startsWith('image/'));
        });

        let commandText = message.content || '';

        if (images.size > 0) {
            try {
                const paths = await Promise.all(
                    [...images.values()].map(a => downloadDiscordAttachment(a.url, a.name))
                );
                commandText = `${commandText || 'Look at these images'} ${paths.join(' ')}`.trim();
            } catch (e) {
                logger.error('Image download failed:', e.message);
                await message.reply('Failed to download image.').catch(() => {});
                return;
            }
        }

        if (!commandText) return;

        await injectToTTY(commandText, mapping.tty);
        await message.react('✅').catch(() => {});
        logger.info(`Injected — ${mapping.project} (${path.basename(mapping.tty)})`);
    } catch (e) {
        logger.error('Message handler error:', e.message);
        await message.react('❌').catch(() => {});
    }
});

// ── Notification processing ──────────────────────────────

const lastNotification = new Map();

function hashMessage(msg) {
    return (msg || '').substring(0, 100);
}

async function processNotifications() {
    let files;
    try { files = fs.readdirSync(NOTIFY_DIR).filter(f => f.endsWith('.json')); } catch (_) { return; }
    if (files.length === 0) return;

    for (const file of files) {
        const fp = path.join(NOTIFY_DIR, file);
        try {
            const stat = fs.lstatSync(fp);
            if (!stat.isFile()) { try { fs.unlinkSync(fp); } catch (_) {} continue; }

            const notification = JSON.parse(fs.readFileSync(fp, 'utf8'));
            fs.unlinkSync(fp);

            const guild = client.guilds.cache.get(config.guildId);
            if (!guild) continue;

            const channel = await ensureChannel(guild, notification.project, notification.claudeTTY);

            const hash = hashMessage(notification.message);
            const last = lastNotification.get(channel.id);
            if (last && last.hash === hash && Date.now() - last.time < 5000) continue;
            lastNotification.set(channel.id, { hash, time: Date.now() });

            const fullMessage = (notification.message || '').substring(0, 4000);
            const lines = fullMessage.split('\n');
            let userQuestion = '';
            const responseLines = [];
            for (const line of lines) {
                if (line.startsWith('> ') && !userQuestion) {
                    userQuestion = line.substring(2).trim();
                } else {
                    responseLines.push(line);
                }
            }
            const description = responseLines.join('\n').trim();

            const embed = new EmbedBuilder()
                .setColor(notification.type === 'completed' ? 0x2ecc71 : 0xf39c12);

            if (userQuestion) {
                embed.setTitle(`💬 ${userQuestion.substring(0, 250)}`);
            } else {
                const emoji = notification.type === 'completed' ? '✅' : '⏳';
                const status = notification.type === 'completed' ? 'Completed' : 'Waiting for Input';
                embed.setTitle(`${emoji} ${status}`);
            }

            if (description) embed.setDescription(description);

            await channel.send({ embeds: [embed] });
            logger.info(`Notification → #${channel.name}`);
        } catch (e) {
            logger.error('Notification failed:', e.message);
            try { fs.unlinkSync(fp); } catch (_) {}
        }
    }
}

// ── Bot ready ────────────────────────────────────────────

client.once('ready', async () => {
    logger.info(`Bot ready: ${client.user.tag}`);
    logger.info(`Guild: ${config.guildId}`);

    try {
        const guild = await client.guilds.fetch(config.guildId);
        serverOwnerId = guild.ownerId;
        logger.info(`Server owner: ${serverOwnerId}`);
        if (config.allowedUsers.length > 0) {
            logger.info(`Allowed users: ${config.allowedUsers.join(', ')}`);
        } else {
            logger.info('Auth: server owner only (set DISCORD_ALLOWED_USERS to add more)');
        }
    } catch (e) {
        logger.error('Could not fetch guild:', e.message);
    }

    loadChannelMap();
    cleanExpiredSessions();
    cleanOldImages();
    setInterval(cleanExpiredSessions, 60 * 60 * 1000);
    setInterval(cleanOldImages, 60 * 60 * 1000);
    setInterval(pruneRateLimits, 60 * 1000);
    setInterval(processNotifications, 2000);
});

// ── Connection health ────────────────────────────────────

client.on('error', (e) => logger.error('Client error:', e.message));
client.on('warn', (msg) => logger.warn('Client warning:', msg));
client.on('shardDisconnect', (e, id) => logger.warn(`Shard ${id} disconnected (code ${e.code})`));
client.on('shardReconnecting', (id) => logger.info(`Shard ${id} reconnecting...`));
client.on('shardResume', async (id) => {
    logger.info(`Shard ${id} resumed — scheduling full reconnect`);
    needsFullReconnect = true;
});
client.on('shardError', (e, id) => logger.error(`Shard ${id} error:`, e.message));

let watchdogRestarts = 0;
let needsFullReconnect = false;

async function watchdog() {
    if (client.ws.status !== 0) {
        logger.error(`WebSocket unhealthy (status: ${client.ws.status}). Force reconnect...`);
        await forceReconnect();
        return;
    }
    if (needsFullReconnect) {
        needsFullReconnect = false;
        logger.info('Executing scheduled full reconnect...');
        await forceReconnect();
    }
}

async function forceReconnect() {
    watchdogRestarts++;
    logger.info(`Watchdog restart #${watchdogRestarts}`);
    try {
        client.destroy();
        await new Promise(r => setTimeout(r, 2000));
        await client.login(config.botToken);
        watchdogRestarts = 0;
        logger.info('Reconnected successfully');
    } catch (e) {
        logger.error('Reconnect failed:', e.message);
        if (watchdogRestarts > 5) {
            logger.error('Too many failures. Exiting.');
            process.exit(1);
        }
        setTimeout(() => forceReconnect(), Math.min(watchdogRestarts * 5000, 30000));
    }
}

setInterval(watchdog, 30000);

// ── Start ────────────────────────────────────────────────

client.login(config.botToken).catch(e => {
    logger.error('Login failed:', e.message);
    process.exit(1);
});

function shutdown(signal) {
    logger.info(`Shutting down (${signal})...`);
    client.destroy();
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
