#!/usr/bin/env node

/**
 * YACC — Yet Another Claude Controller
 * Discord bot — one channel per terminal session.
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

// Ensure directories
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
// Reverse index: channelId → { project, tty, ... }
const channelIndex = new Map();

function loadChannelMap() {
    try {
        channelMap = JSON.parse(fs.readFileSync(CHANNEL_MAP_PATH, 'utf8'));
    } catch (_) {
        channelMap = {};
    }
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

// ── Session files ────────────────────────────────────────

function getAllSessions() {
    const now = Math.floor(Date.now() / 1000);
    const sessions = [];
    try {
        for (const file of fs.readdirSync(sessionsDir)) {
            if (!file.endsWith('.json')) continue;
            try {
                const s = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
                if (s.claudeTTY && typeof s.expiresAt === 'number' && s.expiresAt > now) sessions.push(s);
            } catch (e) { logger.debug(`Bad session file ${file}: ${e.message}`); }
        }
    } catch (_) {}
    const byTTY = new Map();
    for (const s of sessions) {
        const existing = byTTY.get(s.claudeTTY);
        if (!existing || s.createdAt > existing.createdAt) byTTY.set(s.claudeTTY, s);
    }
    return Array.from(byTTY.values());
}

function cleanExpiredSessions() {
    const now = Math.floor(Date.now() / 1000);
    try {
        for (const file of fs.readdirSync(sessionsDir)) {
            if (!file.endsWith('.json')) continue;
            try {
                const fp = path.join(sessionsDir, file);
                const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (s.expiresAt && s.expiresAt < now) fs.unlinkSync(fp);
            } catch (e) { logger.debug(`Cleanup error ${file}: ${e.message}`); }
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
    // Also prune notification dedup map
    const notifCutoff = Date.now() - 60000;
    for (const [key, val] of lastNotification) {
        if (val.time < notifCutoff) lastNotification.delete(key);
    }
}

// ── TTY health check ─────────────────────────────────────
// Verify a TTY is alive and find the correct one for a project if stale

function findActiveTTYForProject(projectName) {
    try {
        const { execFileSync } = require('child_process');
        const psOutput = execFileSync('ps', ['-eo', 'pid,tty,comm'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        });
        const claudeProcs = psOutput.split('\n')
            .filter(l => l.includes('claude') && l.includes('ttys'))
            .map(l => {
                const parts = l.trim().split(/\s+/);
                return { pid: parts[0], tty: '/dev/' + parts[1] };
            });

        for (const proc of claudeProcs) {
            try {
                // Use lsof with grep cwd to get the actual working directory
                const lsof = execFileSync('lsof', ['-p', proc.pid], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
                });
                const cwdLine = lsof.split('\n').find(l => l.includes(' cwd '));
                if (cwdLine) {
                    const cwd = cwdLine.trim().split(/\s+/).pop();
                    if (path.basename(cwd) === projectName) {
                        return proc.tty;
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
    return null;
}

function isTTYAlive(ttyPath) {
    try {
        const { execFileSync } = require('child_process');
        const ttyName = path.basename(ttyPath);
        const psOutput = execFileSync('ps', ['-eo', 'tty,comm'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        });
        return psOutput.includes(ttyName) && psOutput.includes('claude');
    } catch (_) {
        return false;
    }
}

function findProjectCwd(projectName) {
    try {
        const { execFileSync } = require('child_process');
        const psOutput = execFileSync('ps', ['-eo', 'pid,tty,comm'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        });
        const claudeProcs = psOutput.split('\n')
            .filter(l => l.includes('claude') && l.includes('ttys'))
            .map(l => { const p = l.trim().split(/\s+/); return { pid: p[0] }; });

        for (const proc of claudeProcs) {
            try {
                const lsof = execFileSync('lsof', ['-p', proc.pid], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
                });
                const cwdLine = lsof.split('\n').find(l => l.includes(' cwd '));
                if (cwdLine) {
                    const cwd = cwdLine.trim().split(/\s+/).pop();
                    if (path.basename(cwd) === projectName) {
                        return cwd;
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
    return null;
}

// ── iTerm2 injection ─────────────────────────────────────
// Uses iTerm2's native `write text` — no clipboard, no keystroke simulation.

function injectToTTY(command, ttyPath) {
    return new Promise((resolve, reject) => {
        const ttyName = path.basename(ttyPath);
        if (!TTY_PATTERN.test(ttyName)) { reject(new Error('Invalid TTY')); return; }

        // Escape backslashes and double quotes for AppleScript string
        const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        // Try iTerm2 native write first
        const script = [
            'tell application "iTerm2"',
            '    repeat with w in windows',
            '        repeat with t in tabs of w',
            '            repeat with s in sessions of t',
            `                if tty of s contains "${ttyName}" then`,
            `                    tell s to write text "${escaped}"`,
            '                    return "iterm2"',
            '                end if',
            '            end repeat',
            '        end repeat',
            '    end repeat',
            '    return "tty_not_found"',
            'end tell'
        ].join('\n');

        execFile('osascript', ['-e', script], (error, stdout) => {
            const result = error ? 'tty_not_found' : stdout.trim();

            if (result !== 'tty_not_found') {
                resolve(result);
                return;
            }

            // Fallback: TTY not in iTerm2 (VS Code, Terminal.app, etc.)
            // Cannot inject directly — reject so caller can use claude --resume instead
            reject(new Error('TTY not in iTerm2'));
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

        logger.debug(`Message from ${message.author.id} in #${message.channel.name}: ${(message.content || '').substring(0, 50)}`);

        if (!isAuthorizedUser(message.author.id)) {
            logger.warn(`Unauthorized: ${message.author.id}`);
            return;
        }

        const mapping = channelIndex.get(message.channel.id);
        if (!mapping) return;

        if (!mapping.tty) {
            await message.reply('No active terminal session for this channel.').catch(() => {});
            return;
        }

        // Verify TTY is alive and in iTerm2 — if not, try to find the new one
        if (!isTTYAlive(mapping.tty)) {
            logger.warn(`TTY ${mapping.tty} is dead for ${mapping.project}. Searching...`);
            const newTTY = findActiveTTYForProject(mapping.project);
            if (newTTY) {
                channelMap[mapping.project].tty = newTTY;
                mapping.tty = newTTY;
                rebuildChannelIndex();
                markChannelMapDirty();
                logger.info(`Remapped ${mapping.project} → ${newTTY}`);
            } else {
                await message.reply('Terminal session not found. It may have restarted.').catch(() => {});
                return;
            }
        }

        if (!checkAndRecordCommand(message.channel.id)) {
            await message.reply('Too fast — wait a moment.').catch(() => {});
            return;
        }

        // Handle image attachments — download concurrently
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
            // Try iTerm2 native injection first
            await injectToTTY(commandText, mapping.tty);
            await message.react('✅').catch(() => {});
            logger.info(`Injected — ${mapping.project} (${path.basename(mapping.tty)})`);
        } catch (e) {
            if (e.message === 'TTY not in iTerm2') {
                // Fallback: use claude CLI --continue for non-iTerm2 sessions (VS Code, etc.)
                await message.react('⏳').catch(() => {});
                logger.info(`Using claude --continue for ${mapping.project} (non-iTerm2)`);
                try {
                    const { execFile: execFileCb } = require('child_process');
                    // Find the project's working directory from the Claude process
                    const projectCwd = findProjectCwd(mapping.project) || process.cwd();
                    const response = await new Promise((resolve, reject) => {
                        execFileCb('claude', ['-p', commandText, '--continue', '--output-format', 'text'], {
                            cwd: projectCwd,
                            timeout: 300000, // 5 min
                            maxBuffer: 1024 * 1024
                        }, (err, stdout, stderr) => {
                            if (err) reject(err);
                            else resolve(stdout.trim());
                        });
                    });
                    // Post response directly to Discord
                    if (response) {
                        const chunks = response.match(/[\s\S]{1,4000}/g) || [];
                        for (const chunk of chunks) {
                            await message.channel.send({ embeds: [new EmbedBuilder()
                                .setDescription(chunk)
                                .setColor(0x2ecc71)
                            ]}).catch(() => {});
                        }
                    }
                    await message.react('✅').catch(() => {});
                    logger.info(`CLI response sent — ${mapping.project}`);
                } catch (cliErr) {
                    logger.error('Claude CLI failed:', cliErr.message);
                    await message.react('❌').catch(() => {});
                }
            } else {
                throw e;
            }
        }
    } catch (e) {
        logger.error('Message handler error:', e.message);
        await message.react('❌').catch(() => {});
    }
});

// ── Notification processing ──────────────────────────────

// Dedup: track last notification per channel to avoid duplicate "Completed" spam
const lastNotification = new Map(); // channelId → { message hash, timestamp }

function hashMessage(msg) {
    // Simple hash: first 100 chars. Same content within 5s = duplicate
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

            // Dedup: skip if same content sent to same channel within 5s
            const hash = hashMessage(notification.message);
            const last = lastNotification.get(channel.id);
            if (last && last.hash === hash && Date.now() - last.time < 5000) {
                logger.debug(`Deduped notification for #${channel.name}`);
                continue;
            }
            lastNotification.set(channel.id, { hash, time: Date.now() });

            const emoji = notification.type === 'completed' ? '✅' : '⏳';
            const status = notification.type === 'completed' ? 'Completed' : 'Waiting for Input';
            const fullMessage = (notification.message || '').substring(0, 4000);

            // Split user question (lines starting with >) from Claude's response
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
    logger.info(`Shard ${id} resumed`);
    try {
        await client.guilds.fetch(config.guildId);
        logger.info('Guild cache refreshed');
    } catch (_) {}
});
client.on('shardError', (e, id) => logger.error(`Shard ${id} error:`, e.message));

// Watchdog: only restart if WebSocket status is not READY or ping is -1 (dead)
let watchdogRestarts = 0;

async function watchdog() {
    const ws = client.ws;

    // Check: WebSocket status is not READY (0)
    if (ws.status !== 0) {
        logger.error(`WebSocket unhealthy (status: ${ws.status}). Force reconnect...`);
        await forceReconnect();
        return;
    }

    // Check: ping is -1 (no heartbeat ack received)
    if (ws.ping === -1) {
        logger.warn('No heartbeat ack — connection may be stale');
    }
}

async function forceReconnect() {
    watchdogRestarts++;
    logger.info(`Watchdog restart #${watchdogRestarts}`);

    try {
        client.destroy();
        await new Promise(r => setTimeout(r, 2000)); // brief cooldown
        await client.login(config.botToken);
        watchdogRestarts = 0;
        logger.info('Reconnected successfully');
    } catch (e) {
        logger.error('Reconnect failed:', e.message);
        // If we've failed too many times in a row, exit and let the process manager restart us
        if (watchdogRestarts > 5) {
            logger.error('Too many reconnect failures. Exiting for process manager restart.');
            process.exit(1);
        }
        // Retry after backoff
        const backoff = Math.min(watchdogRestarts * 5000, 30000);
        logger.info(`Retrying in ${backoff / 1000}s...`);
        setTimeout(() => forceReconnect(), backoff);
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
