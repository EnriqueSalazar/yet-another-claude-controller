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

        // Use two methods:
        // 1. write text — for regular commands (fast, reliable)
        // 2. keystroke simulation — for short inputs like permission prompt answers
        //    (write text doesn't work for TUI dialogs)
        const isShortInput = command.length <= 5 && /^[0-9a-zA-Z\s]+$/.test(command);

        let action;
        if (isShortInput) {
            // Keystroke simulation: select the session's tab, bring to front, type keys
            action = [
                `                    select t`,
                `                    select s`,
                `                    set index of w to 1`,
                `                    tell application "iTerm2" to activate`,
                `                    delay 0.3`,
                `                    tell application "System Events"`,
                `                        keystroke "${escaped}"`,
                `                        delay 0.1`,
                `                        keystroke return`,
                `                    end tell`,
            ].join('\n');
        } else {
            action = `                    tell s to write text "${escaped}"`;
        }

        const script = [
            'tell application "iTerm2"',
            '    repeat with w in windows',
            '        repeat with t in tabs of w',
            '            repeat with s in sessions of t',
            `                if tty of s contains "${ttyName}" then`,
            action,
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

// ── Message processing ───────────────────────────────────
// Shared logic used by both gateway events and REST poller

const processedMessages = new Set(); // message IDs already handled

async function processUserMessage(message) {
    // Dedup — prevent double-processing from gateway + poller
    if (processedMessages.has(message.id)) return;
    processedMessages.add(message.id);
    // Prune old IDs (keep last 500)
    if (processedMessages.size > 500) {
        const arr = [...processedMessages];
        for (let i = 0; i < arr.length - 500; i++) processedMessages.delete(arr[i]);
    }

    const mapping = channelIndex.get(message.channel.id);
    if (!mapping) return;

    if (!mapping.tty) {
        await message.reply('No active terminal session for this channel.').catch(() => {});
        return;
    }

    if (!checkAndRecordCommand(message.channel.id)) return;

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

    try {
        await injectToTTY(commandText, mapping.tty);
        await message.react('✅').catch(() => {});
        logger.info(`Injected — ${mapping.project} (${path.basename(mapping.tty)})`);
    } catch (e) {
        logger.error('Injection failed:', e.message);
        await message.react('❌').catch(() => {});
    }
}

// ── Gateway message handler ──────────────────────────────

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;
        if (!message.guild || message.guild.id !== config.guildId) return;
        if (!isAuthorizedUser(message.author.id)) return;
        await processUserMessage(message);
    } catch (e) {
        logger.error('Gateway handler error:', e.message);
    }
});

// ── REST message poller (backup) ─────────────────────────
// Polls session channels via REST API to catch messages the gateway missed

const lastPolledMessage = new Map(); // channelId → last message ID

async function pollChannelMessages() {
    for (const [project, info] of Object.entries(channelMap)) {
        if (!info.channelId || !info.tty) continue;
        try {
            // Fetch channel — may not be in cache after reconnect
            let channel = client.channels.cache.get(info.channelId);
            if (!channel) {
                try { channel = await client.channels.fetch(info.channelId); } catch (_) { continue; }
            }
            if (!channel) continue;

            // If we haven't polled this channel before, initialize to latest message
            if (!lastPolledMessage.has(info.channelId)) {
                const latest = await channel.messages.fetch({ limit: 1 }).catch(() => null);
                if (latest && latest.size > 0) {
                    lastPolledMessage.set(info.channelId, latest.first().id);
                }
                continue; // Skip this cycle — don't replay history
            }

            const after = lastPolledMessage.get(info.channelId);
            const messages = await channel.messages.fetch({ limit: 10, after }).catch(() => null);
            if (!messages || messages.size === 0) continue;

            // Update last polled to newest
            const newest = messages.first();
            lastPolledMessage.set(info.channelId, newest.id);

            // Process unhandled messages (oldest first)
            const sorted = [...messages.values()].reverse();
            for (const msg of sorted) {
                if (msg.author.bot) continue;
                if (!isAuthorizedUser(msg.author.id)) continue;
                if (processedMessages.has(msg.id)) continue;
                logger.info(`Poller caught missed message in #${channel.name}: ${(msg.content || '').substring(0, 50)}`);
                await processUserMessage(msg);
            }
        } catch (e) {
            logger.debug(`Poll error for ${project}: ${e.message}`);
        }
    }
}

// Initialize poller with current latest messages so it doesn't replay history
async function initPoller() {
    for (const [project, info] of Object.entries(channelMap)) {
        if (!info.channelId) continue;
        try {
            const channel = client.channels.cache.get(info.channelId);
            if (!channel) continue;
            const messages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
            if (messages && messages.size > 0) {
                lastPolledMessage.set(info.channelId, messages.first().id);
            }
        } catch (_) {}
    }
    logger.info(`Poller initialized for ${lastPolledMessage.size} channels`);
}

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

// ── Permission prompt screen poller ──────────────────────
// Polls iTerm2 sessions for "Do you want to proceed?" prompts
// that the Notification hook missed.

const lastPromptHash = new Map(); // channelId → hash of last prompt sent

async function pollForPermissionPrompts() {
    const { execFileSync } = require('child_process');

    for (const [project, info] of Object.entries(channelMap)) {
        if (!info.channelId || !info.tty) continue;
        const ttyName = path.basename(info.tty);
        if (!TTY_PATTERN.test(ttyName)) continue;

        try {
            // Read last ~40 lines from iTerm2 session
            const script = [
                'tell application "iTerm2"',
                '    repeat with w in windows',
                '        repeat with t in tabs of w',
                '            repeat with s in sessions of t',
                `                if tty of s contains "${ttyName}" then`,
                '                    return text of s',
                '                end if',
                '            end repeat',
                '        end repeat',
                '    end repeat',
                '    return ""',
                'end tell'
            ].join('\n');

            const output = execFileSync('osascript', ['-e', script], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000
            }).trim();

            if (!output) continue;

            // Check last 40 lines for a permission prompt
            const lines = output.split('\n');
            const searchStart = Math.max(0, lines.length - 40);
            let hasPrompt = false;
            for (let i = lines.length - 1; i >= searchStart; i--) {
                if (lines[i].includes('Do you want to proceed?')) {
                    hasPrompt = true;
                    break;
                }
            }

            if (!hasPrompt) {
                // No prompt — clear last hash so we can detect it again later
                lastPromptHash.delete(info.channelId);
                continue;
            }

            // Extract the prompt block
            let promptText = '';
            for (let i = lines.length - 1; i >= searchStart; i--) {
                if (lines[i].includes('Do you want to proceed?')) {
                    let blockStart = i;
                    for (let j = i - 1; j >= Math.max(searchStart, i - 15); j--) {
                        const line = lines[j].trim();
                        if (line.match(/^(Bash|Read|Edit|Write|Glob|Grep|Web|Delete|Notebook)/i)) {
                            blockStart = j;
                            break;
                        }
                        if (line.match(/^[─━═]{3,}/)) {
                            blockStart = j + 1;
                            break;
                        }
                    }
                    promptText = lines.slice(blockStart).filter(l => {
                        const t = l.trim();
                        if (!t) return false;
                        if (t.match(/^(Esc to cancel|Tab to amend|ctrl\+|shift\+tab|bypass permissions|accept edits|^\d+ shell)/i)) return false;
                        if (t.match(/^[─━═│┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬\-\+\|]+$/)) return false;
                        if (t === '›' || t === '❯' || t === '>') return false;
                        return true;
                    }).join('\n');
                    break;
                }
            }

            if (!promptText) continue;

            // Dedup: hash the prompt to avoid sending the same one twice
            const promptHash = promptText.substring(0, 200);
            if (lastPromptHash.get(info.channelId) === promptHash) continue;
            lastPromptHash.set(info.channelId, promptHash);

            // Also check against notification dedup
            const notifHash = hashMessage(promptText);
            const lastNotif = lastNotification.get(info.channelId);
            if (lastNotif && lastNotif.hash === notifHash && Date.now() - lastNotif.time < 30000) continue;
            lastNotification.set(info.channelId, { hash: notifHash, time: Date.now() });

            // Send to Discord
            const channel = client.channels.cache.get(info.channelId);
            if (!channel) continue;

            const embed = new EmbedBuilder()
                .setTitle('⏳ Waiting for Input')
                .setDescription(promptText.substring(0, 4000))
                .setColor(0xf39c12);

            await channel.send({ embeds: [embed] });
            logger.info(`Screen poller: permission prompt in #${channel.name}`);
        } catch (_) {}
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
    await initPoller();
    setInterval(cleanExpiredSessions, 60 * 60 * 1000);
    setInterval(cleanOldImages, 60 * 60 * 1000);
    setInterval(pruneRateLimits, 60 * 1000);
    setInterval(processNotifications, 2000);
    setInterval(pollChannelMessages, 5000); // REST backup every 5s
    setInterval(pollForPermissionPrompts, 5000); // Screen backup every 5s
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
