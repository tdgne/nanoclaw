# CLI Main

This is the CLI terminal channel. The user interacts via a terminal client.

## Message Formatting

Override global formatting rules — the CLI renders full Markdown:

- **double asterisks** for bold
- _underscores_ for italic
- ## headings are fine
- [links](url) are supported
- ```code blocks``` work as expected
- Bullet points, numbered lists, tables — all OK

Do NOT use WhatsApp/Telegram-style single *asterisks* for bold.

## Agent Teams

When creating a team to tackle a complex task, follow these rules:

### CRITICAL: Follow the user's prompt exactly

Create *exactly* the team the user asked for — same number of agents, same roles, same names. Do NOT add extra agents, rename roles, or use generic names like "Researcher 1". If the user says "a marine biologist, a physicist, and Alexander Hamilton", create exactly those three agents with those exact names.

### Team member instructions

Each team member MUST be instructed to:

1. **Share progress in the group** via `mcp__nanoclaw__send_message` with a `sender` parameter matching their exact role/character name (e.g., `sender: "Marine Biologist"` or `sender: "Alexander Hamilton"`). In the CLI, the `sender` name appears as a text label in the terminal — there are no separate bot avatars like in Telegram.
2. **Also communicate with teammates** via `SendMessage` as normal for coordination.
3. Keep group messages **short** — 2-4 sentences max per message. Break longer content into multiple `send_message` calls. No walls of text.
4. Use the `sender` parameter consistently — always the same name so the identity stays stable.
5. Use **Markdown formatting**: `**bold**`, `_italic_`, `##` headings, `[links](url)`, bullet points, ```code blocks```. No WhatsApp-style single asterisks.

### Example team creation prompt

When creating a teammate, include instructions like:

```
You are the Marine Biologist. When you have findings or updates for the user, send them to the group using mcp__nanoclaw__send_message with sender set to "Marine Biologist". Keep each message short (2-4 sentences max). Use Markdown formatting: **bold**, _italic_, ## headings, [links](url), bullet points. Also communicate with teammates via SendMessage.
```

### Lead agent behavior

As the lead agent who created the team:

- You do NOT need to react to or relay every teammate message. The user sees those directly in the terminal.
- Send your own messages only to comment, share thoughts, synthesize, or direct the team.
- When processing an internal update from a teammate that doesn't need a user-facing response, wrap your *entire* output in `<internal>` tags.
- Focus on high-level coordination and the final synthesis.
