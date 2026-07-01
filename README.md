# discord-author-exporter

**[中文说明](./README.zh-CN.md)** | English

A Chrome (Manifest V3) extension that searches and exports **all messages from a specific user** in a Discord server or channel. Supports JSON / CSV / TXT / HTML export.

Author: Catie · License: [MIT](./LICENSE)

## ⚠️ Disclaimer (please read)

This tool works by reusing the authorization token from **your own** logged-in session to call internal Discord web-client endpoints that are not publicly documented for third-party use. This is, in effect, self-bot-style account automation and **does not fully comply with Discord's Terms of Service**.

By using this tool, you understand and accept the following:

1. **Account risk is yours alone.** Using this tool may result in Discord warning, restricting, or banning your account. This is a platform-policy risk borne entirely by the **user**, not the author.
2. **Provided "as is", with no warranty.** This project is released under the [MIT License](./LICENSE). Per that license, the software is provided without warranty of any kind, and the author is not liable for any direct or indirect damages, account actions, data loss, or other consequences arising from the use or inability to use this tool.
3. **Intended for personal, lawful use only.** This tool is meant for exporting chat history **you already have permission to access**, for personal backup, organization, or research purposes. Do not use it to:
   - scrape, resell, or publicly republish other users' messages or personal information at scale;
   - monitor, track, or harass specific individuals without consent;
   - violate Discord's Terms of Service or applicable privacy/data-protection laws (e.g. GDPR) in any other way.
4. **Responsibility follows how you use it, not the tool itself.** Labeling something "for personal/educational use" does not by itself provide legal immunity. What actually determines your risk level is what you do with the exported data — keeping it for yourself is low-risk; publishing it, harassing someone with it, or processing others' data at scale shifts responsibility and risk onto you as the user.
5. **This is not legal advice.** If your use case involves commercial purposes, large-scale data processing, or a jurisdiction with strict privacy regulation, consult a qualified professional.

By installing or using this extension, you confirm that you have read, understood, and accept sole responsibility for the risks described above.

## How it works

The extension uses Discord's own web client search endpoint:

```
GET /api/v9/guilds/{guildId}/messages/search?author_id={userId}
```

- It intercepts requests made by your **already logged-in** browser session to capture the authorization token it needs (kept only in local memory/storage, never sent anywhere else).
- Pagination uses a snowflake cursor (`max_id`) instead of `offset`, so it isn't limited by the 5000-result offset cap.
- Automatically waits and retries on rate limits (429) and "search index not ready yet" (202) responses.
- On network interruption, it retries with backoff and checkpoints progress to the browser's local IndexedDB, so large exports can resume after a disconnect or page reload.
- You can look up the target user by username or user ID; alternatively, you can reuse the exact request Discord's own search bar just made (most reliable, since it's guaranteed to use valid parameters).

## Installation

1. Open Chrome and go to `chrome://extensions/`.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked" and select this project folder.
4. Once the extension icon appears in the toolbar, you're ready to go.

## Usage

1. Open `https://discord.com/app`, log in, and navigate to any channel in the target server.
2. Click the extension icon. A **floating panel** appears in the top-right of the page (draggable by its header, can be minimized/closed; click the icon again to toggle it).
3. Choose how to find the target user:
   - **By username**: first open that user's profile card or view one of their messages on the page so the extension can capture their info, then type the username.
   - **By user ID**: enable Developer Mode in Discord settings, right-click the user's avatar → "Copy User ID", and paste it in — the most reliable option.
   - Or: search `from: someone` once in **Discord's own search bar** first, then click "Use the user from Discord's last search" in the panel to reuse that exact, already-validated search request.
4. Choose the search scope (whole server / current channel only) and export format. Optionally check "text-only messages" to filter out attachment-only messages.
5. Click "Start Export" and wait. The file downloads automatically when done. You can cancel at any time.

If your connection drops or the page closes mid-export, progress isn't lost — clicking "Start Export" again with the same user/scope will automatically resume from the last checkpoint.

## Export formats

| Format | Description |
|--------|--------------|
| JSON | Full raw fields, good for further processing |
| CSV  | Timestamp / author / content / attachments, opens in Excel |
| TXT  | Plain text, easy to read |
| HTML | Discord-styled webpage for browsing |

## Notes & limitations

- You can only export content from channels **you have permission to view**; the API won't return anything you can't already see.
- Username lookup depends on data the extension has already captured; if it fails, use the user ID or reuse Discord's native search instead.
- Fetch speed is bound by Discord's own rate limits; large histories will take time.

## Project structure

```
discord-message-exporter/
  manifest.json        Extension config (MV3)
  src/
    inject.js          Main-world script: captures auth token, intercepts user info & search requests
    content.js          Core logic: search API calls, checkpoint/resume, export, in-page floating panel UI
    background.js        Toggles the floating panel when the toolbar icon is clicked
  LICENSE               MIT License
  README.md / README.zh-CN.md
```

## License

Released under the [MIT License](./LICENSE). You're free to use, modify, and distribute it, as long as the copyright notice is retained.
