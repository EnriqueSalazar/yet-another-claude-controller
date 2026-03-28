# YACC — Yet Another Claude Controller

Control multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) terminal sessions from your phone via Discord. Each session gets its own channel — just type in the right channel and it goes to the right terminal.

## Features

- **Channel per session** — auto-created Discord channel for each Claude Code terminal tab
- **Two-way communication** — see Claude's responses, send commands back
- **Permission prompts** — see "Do you want to proceed?" dialogs and reply remotely
- **Images** — send images from Discord, Claude reads them
- **TTY-targeted injection** — commands go to the exact Terminal tab via AppleScript
- **Interactive-only** — skips background/programmatic Claude invocations
- **Secure** — user allowlist, TTY validation, SSRF prevention, rate limiting

## How it works

```
Terminal (Claude Code)  ──hook──>  Discord Bot  ──notification──>  #project-channel
#project-channel  ──message──>  Discord Bot  ──AppleScript paste──>  Terminal (Claude Code)
```

1. Claude Code **hooks** fire when Claude stops or needs input
2. Hook script detects which Terminal tab triggered it, writes a notification file
3. Discord bot picks it up and posts to the project's channel (creates it if needed)
4. You type in the channel — bot pastes it into the correct Terminal tab

## Requirements

- **macOS** (AppleScript + Terminal.app)
- **Node.js** >= 18
- **Claude Code** running in Terminal.app
- **Discord** account + private server

## Setup

### 1. Create a Discord server

Create a new server (private, just for you). The bot will create a "Claude Sessions" category with channels inside.

### 2. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. New Application → name it → Create
3. **Bot** tab → Reset Token → copy the **Bot Token**
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. **OAuth2** → URL Generator → scope: `bot` → permissions: Manage Channels, View Channels, Send Messages, Embed Links, Attach Files, Read Message History
6. Open the generated URL → add bot to your server

### 3. Get your Server ID

1. Discord Settings → Advanced → enable **Developer Mode**
2. Right-click your server name → **Copy Server ID**

### 4. Install

```bash
git clone https://github.com/YOUR_USERNAME/yacc.git
cd yacc
npm install
cp .env.example .env
```

Edit `.env` with your `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`.

### 5. Configure Claude Code hooks

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/yacc/claude-hook-notify.js completed",
            "timeout": 10
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/yacc/claude-hook-notify.js waiting",
            "timeout": 10
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/yacc/claude-hook-notify.js waiting",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Replace `/absolute/path/to/yacc` with the actual install path.

### 6. Grant Accessibility permissions

**System Settings > Privacy & Security > Accessibility** — add Terminal.app.

### 7. Start

```bash
npm start
```

Channels appear in Discord as Claude sessions become active.

## Usage

| Action | How |
|--------|-----|
| **Send command** | Type in the session's channel |
| **Send image** | Attach an image in the channel |
| **Answer permission prompt** | Reply with `1`, `2`, or `3` |

No session switching needed — each project has its own channel.

## Security

**This tool remotely executes text in your terminal. Treat your Discord bot token with the same care as SSH keys.**

- **Authorization** — only the server owner (or users in `DISCORD_ALLOWED_USERS`) can send commands. Others are silently ignored.
- **Private server** — Discord servers are invite-only by default. Don't share the invite link.
- **Rate limiting** — 2s minimum between commands per channel.
- **TTY validation** — paths checked against `/^ttys\d+$/` before AppleScript injection.
- **SSRF prevention** — image downloads only from Discord CDN origins.
- **File permissions** — session files, images, and channel maps created with `0600`.
- **No shell interpretation** — `execFile`/`spawn` used instead of `exec`.
- **Symlink rejection** — notification files validated as regular files.
- **Auto-cleanup** — expired sessions and old images purged hourly.

## Limitations

- **macOS only** — relies on AppleScript and Terminal.app
- **Foreground paste** — injecting a command briefly brings the target Terminal tab to focus
- **Discord message limit** — responses truncated to 4000 chars

## Origin

This project started as a fork of [Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) by [JessyTsui](https://github.com/JessyTsui), which provides email, LINE, and Telegram (webhook) support with tmux integration.

YACC diverged significantly — replacing Telegram with Discord, webhooks with gateway, tmux with direct TTY detection, and adding channel-per-session, permission prompt capture, image support, and security hardening. The only shared concept is using Claude Code hooks for notifications.

## License

MIT
