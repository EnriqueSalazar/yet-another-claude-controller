#!/usr/bin/env node

/**
 * Claude Hook Notification Script
 * Called by Claude Code hooks (Stop / SubagentStop / Notification).
 * Writes a notification file that the Discord bot picks up.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const projectDir = __dirname;
const NOTIFY_DIR = path.join(projectDir, 'src/data/notifications');
fs.mkdirSync(NOTIFY_DIR, { recursive: true, mode: 0o700 });

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (result) => { if (!resolved) { resolved = true; resolve(result); } };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => {
            clearTimeout(timer);
            try { done(JSON.parse(data)); } catch { done({}); }
        });
        const timer = setTimeout(() => done({}), 1000);
    });
}

/**
 * Filter out terminal UI noise that doesn't belong in Discord.
 */
function isTerminalNoise(line) {
    const trimmed = line.trim();
    // Terminal UI hints
    if (trimmed.match(/^(Esc to cancel|Tab to amend|ctrl\+[a-z] to|shift\+tab)/i)) return true;
    if (trimmed.match(/Esc to cancel.*Tab to amend/)) return true;
    // Status bar lines
    if (trimmed.match(/bypass permissions on/)) return true;
    if (trimmed.match(/accept edits on/)) return true;
    if (trimmed.match(/^\d+ shell/)) return true;
    if (trimmed.match(/ctrl\+t to show tasks/)) return true;
    // Box-drawing only lines (separators)
    if (trimmed.match(/^[─━═│┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬\-\+\|]+$/)) return true;
    // Empty prompt indicators
    if (trimmed === '›' || trimmed === '❯' || trimmed === '>') return true;
    return false;
}

/**
 * Read visible terminal content from a specific TTY tab via AppleScript.
 * Tries iTerm2 first, then Terminal.app.
 */
function readTerminalScreen(ttyPath) {
    const ttyName = path.basename(ttyPath);
    if (!/^ttys\d+$/.test(ttyName)) return '';

    try {
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
        if (output) return extractPrompt(output);
    } catch (_) {}

    return '';
}

/**
 * Extract the permission prompt block from raw terminal output.
 * Strips terminal UI noise, keeps tool context.
 */
function extractPrompt(output) {
    const lines = output.split('\n');

    // Only look for "Do you want to proceed?" in the last 20 lines
    // to avoid matching old prompts deep in the scrollback
    let proceedLine = -1;
    const searchStart = Math.max(0, lines.length - 40);
    for (let i = lines.length - 1; i >= searchStart; i--) {
        if (lines[i].match(/Do you want to proceed\?/)) {
            proceedLine = i;
            break;
        }
    }

    if (proceedLine >= 0) {
        let blockStart = proceedLine;
        for (let i = proceedLine - 1; i >= Math.max(0, proceedLine - 15); i--) {
            const line = lines[i].trim();
            if (line.match(/^(Bash|Read|Edit|Write|Glob|Grep|Web|Delete|Notebook)/i)) {
                blockStart = i;
                break;
            }
            if (line.match(/^[─━═]{3,}/)) {
                blockStart = i + 1;
                break;
            }
        }
        return lines.slice(blockStart)
            .filter(l => l.trim())
            .filter(l => !isTerminalNoise(l))
            .join('\n');
    }

    const nonEmpty = lines.filter(l => l.trim()).filter(l => !isTerminalNoise(l));
    return nonEmpty.slice(-15).join('\n');
}

/**
 * Extract tool activity from the last turn of the transcript.
 * Returns a compact summary of files edited, commands run, etc.
 */
function readToolActivity(transcriptPath) {
    try {
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.trim().split('\n');

        // Find last user message, then collect tool_use blocks after it
        let turnStart = lines.length;
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
            try {
                const entry = JSON.parse(lines[i]);
                const role = (entry.message || entry).role || entry.type;
                if (role === 'user' || entry.type === 'human') { turnStart = i; break; }
            } catch (_) {}
        }

        const activity = [];
        const seenFiles = new Set();

        for (let i = turnStart; i < lines.length; i++) {
            try {
                const entry = JSON.parse(lines[i]);
                const msg = entry.message || entry;
                const blocks = Array.isArray(msg.content) ? msg.content : [];

                for (const block of blocks) {
                    if (block.type !== 'tool_use') continue;
                    const name = block.name || '';
                    const input = block.input || {};

                    if (name === 'Edit' || name === 'Write') {
                        const fp = input.file_path || '';
                        const short = fp.split('/').slice(-2).join('/');
                        if (!seenFiles.has(short)) {
                            seenFiles.add(short);
                            activity.push(`📝 ${short}`);
                        }
                    } else if (name === 'Bash') {
                        const cmd = (input.command || '').substring(0, 80);
                        if (cmd.includes('git commit')) {
                            const msgMatch = cmd.match(/-m\s+"([^"]+)"|--message\s+"([^"]+)"/);
                            activity.push(`📦 commit: ${msgMatch ? (msgMatch[1] || msgMatch[2]).substring(0, 60) : 'committed'}`);
                        } else if (cmd.includes('git push')) {
                            activity.push('🚀 pushed');
                        } else if (cmd.includes('npm install') || cmd.includes('npm uninstall')) {
                            activity.push(`📦 ${cmd.substring(0, 60)}`);
                        }
                    } else if (name === 'Read' || name === 'Glob' || name === 'Grep') {
                        // Skip read-only operations
                    } else if (name) {
                        activity.push(`🔧 ${name}`);
                    }
                }
            } catch (_) {}
        }

        return activity.length > 0 ? '\n' + activity.slice(0, 8).join('\n') : '';
    } catch (_) {
        return '';
    }
}

/**
 * Extract the last user question from the transcript JSONL file.
 * Returns just the question text (for the notification title).
 */
function readLastUserQuestion(transcriptPath) {
    try {
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.trim().split('\n');

        // Search backward for the last user message
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
            try {
                const entry = JSON.parse(lines[i]);
                const msg = entry.message || entry;
                const role = msg.role || entry.type;

                if (role === 'user' || entry.type === 'human') {
                    const c = msg.content;
                    const text = typeof c === 'string'
                        ? c
                        : (Array.isArray(c) ? c : []).filter(b => b.type === 'text').map(b => b.text).join(' ');
                    if (text && text.trim()) return `> ${text.trim().substring(0, 200)}`;
                }
            } catch (_) {}
        }
        return '';
    } catch (_) {
        return '';
    }
}

async function sendHookNotification() {
    try {
        const notificationType = process.argv[2] || 'completed';
        if (!['completed', 'waiting'].includes(notificationType)) process.exit(1);

        const hookData = await readStdin();
        const lastMessage = hookData.last_assistant_message || '';
        const transcriptPath = hookData.transcript_path || '';
        const cwd = hookData.cwd || process.cwd();
        const sessionId = hookData.session_id || 'unknown';
        const projectRoot = process.env.CLAUDE_PROJECT_DIR || cwd;
        const projectName = path.basename(projectRoot);

        // Walk up process tree to find parent with a TTY
        let claudeTTY = null;
        try {
            let pid = process.ppid;
            for (let i = 0; i < 10; i++) {
                const info = execFileSync('ps', ['-o', 'ppid=,tty=,comm=', '-p', String(pid)], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
                }).trim();
                const match = info.match(/^\s*(\d+)\s+(ttys\d+)\s+(.+)$/);
                if (match) {
                    claudeTTY = '/dev/' + match[2];
                    break;
                }
                const ppidMatch = info.match(/^\s*(\d+)/);
                if (!ppidMatch) break;
                pid = parseInt(ppidMatch[1]);
                if (!pid || pid <= 1) break;
            }
        } catch (_) {}

        // Only notify for interactive terminal sessions
        if (!claudeTTY) return;
        if (!/^\/dev\/ttys\d+$/.test(claudeTTY)) return;

        // For 'completed', extract the user question from transcript (for title)
        // and use last_assistant_message as the body
        let displayMessage = lastMessage;
        let userQuestion = '';
        let toolActivity = '';
        if (notificationType === 'completed' && transcriptPath) {
            userQuestion = readLastUserQuestion(transcriptPath);
            toolActivity = readToolActivity(transcriptPath);
        }
        // Prepend question so the bot can extract it for the embed title
        // Append tool activity so the bot shows what changed
        if (userQuestion) {
            displayMessage = `${userQuestion}\n${lastMessage}`;
        }
        if (toolActivity) {
            displayMessage = `${displayMessage}\n${toolActivity}`;
        }

        // For 'waiting', read the terminal screen — but only notify if there's
        // an actual permission prompt. Skip if Claude is just idle.
        if (notificationType === 'waiting') {
            await new Promise(r => setTimeout(r, 500));
            const screen = readTerminalScreen(claudeTTY);
            // Only notify if the extracted screen content actually has a fresh prompt
            // (extractPrompt returns just the prompt block if found, or last 15 lines as fallback)
            // Check the extracted content, not the full scrollback
            if (screen && screen.includes('Do you want to proceed?') && screen.length < 1000) {
                displayMessage = screen;
            } else {
                // No fresh permission prompt — skip
                return;
            }
        }

        // Truncate to prevent oversized notification files
        if (displayMessage && displayMessage.length > 4000) {
            displayMessage = displayMessage.substring(0, 4000) + '...';
        }

        // Write notification file for the Discord bot to pick up
        const notification = {
            type: notificationType,
            project: projectName,
            claudeTTY: claudeTTY,
            message: displayMessage || `Claude ${notificationType === 'completed' ? 'completed a task' : 'is waiting for input'}`,
            timestamp: Date.now()
        };

        const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`;
        const fp = path.join(NOTIFY_DIR, filename);
        const fd = fs.openSync(fp, 'w', 0o600);
        fs.writeSync(fd, JSON.stringify(notification));
        fs.closeSync(fd);
    } catch (e) {
        console.error('Hook notification failed:', e.message);
        process.exit(1);
    }
}

sendHookNotification();
