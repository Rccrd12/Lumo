# Changelog

## Windows and Linux 0.5.1 — October 10, 2026

- **The Claude plan's 5 hours no longer vanish**: Claude Code's status line leaves the 5-hour window out while it is far from its limit, and each of its updates used to drop the figure a chat answer had brought. The window it leaves out is now kept, and when none was ever reported the 5 hours read "plenty left — Claude Code reports it only near the limit", in the chat's usage menu and on the plan card
- **The effort slider is one short row**: a track that fills up to a white knob, a mark per level, the level it is on beside it and Auto at the end (no "Effort" label above). Dragged, the knob snaps to a level as soon as the pointer is past half way to it, and glides there; the arrow keys, Home and End move it too
- **The live activities keep their size off the island**: their own window is drawn at the island's zoom, so they no longer shrink when taken off it. Their title is "Live Activities" in every view (in Italian too)
- **Settings → Island → Distance from the edge**: none, light (as before, the default), medium — just enough room for the mouse to cross the top of the screen above the island without opening it — or wide. A change slides the island to its new place
- **Settings → General → Sound shows the volume as a percentage**
- **A bulb in Gemini Live**, left of the send button: lit, Gemini 3.8 Live Extended Thinking; off, Gemini 3.8 Live. It shows and sets the model, saved for the next calls; during a call it moves to the other model on a new connection (Gemini starts afresh, the transcript stays)
- Settings → Agents no longer lists Gemini CLI
- **Settings group long sections under small headings** (Island: opening and closing, the closed island, Live Activities, Lumo, position and size), and the tips about dragging and resizing the island sit together at the end. The settings themselves look as before: the name and its control on one line, what it does underneath
- **Settings → Agents says what is what**: Antigravity's hooks are for the Antigravity app and for Antigravity CLI alike
- **The island opened from a shortcut stays open for 10 seconds** with the mouse elsewhere, even set to close as soon as the mouse leaves: Open or close the island, Open the chat, Go to the waiting permission, Next or previous pill, as Ask about my screen and Ask about the selected text already did (now 10 seconds for those too, and each key typed gives it 10 more)
- **Shift+Enter starts a new line in the chat**; Enter sends. The field grows with the lines, up to five, then scrolls
- Integrations: Resend is shown as "Resend" in every language (it was translated as "send again")
- **The live activities no longer blink when they come off the island or join it again** (Windows): their own window shows where they are drawn before the island lets go of them, and when dropped against the island it slides into place, is drawn there, and only then goes. The island's window keeps their room meanwhile, so it is never resized in between
- **The chat's remaining usage is a ring** next to the past chats, instead of a line that was cut off on a narrow island: it fills with the most used of the limits (the 5 hours or the week, whichever is closer to its end) and turns from green to orange to red. A click opens a menu with each limit, how much of it is used, its bar and when it resets; a click outside closes it
- **The Code section's cards use their room**: bigger text, and for each tool what it did lately — the last session and its project, this week's sessions, time and lines changed (from the weekly recap), and for VS Code the Claude plan's usage. The Claude plan card shows each limit on three lines (how much is used, a bar, "Resets in 3 h 31") so nothing is cut off; the ↻ that looked like a button was only the reset time's mark, and is now a clock beside the words
- **Refresh shows that it works**: the buttons light up under the mouse and press in, Refresh turns while it looks again, then says "Updated just now" or what went wrong. On a hook pill it reads the hooks and the sessions again; on a service it waits for the server's answer. The Codex plan card has a Refresh of its own, which asks Codex again
- **Email senders and subjects read right in more cases**: an apostrophe split across two encoded words, UTF-8 that was read as Windows-1252 on the way ("McDonaldâ€™s"), the "ÿ" some mailers leave for an apostrophe ("McDonaldÿs"), `&#146;`-style numbers, UTF-16, and a stray Latin-1 byte inside UTF-8 text all come out as they were written
- **The email buttons in the live activities stay on one line**, in Italian too: the eye sits by the sender, and Summarize and Draft a reply have the row to themselves
- **The model picker shows only the providers that are set up**: a key in the credential store, Claude Code or Antigravity CLI installed with Lumo's hooks, a model server with its address. With none, it points to Settings. The providers take one short row, so the model list has more room, and the effort slider is shorter and taller, with only the level it is on beside it
- **The live activities' last card stays inside the panel's rounded corners** when the list scrolls to the bottom
- **The Claude plan's 5 hours from Anthropic** (Settings → Agents → Plan usage → Ask Anthropic, off by default): Claude Code's status line only runs in a terminal and its answers give the 5 hours only near the limit, so from VS Code they never moved. Turned on, Lumo asks Anthropic for the plan's usage with Claude Code's own sign-in, as its /usage does: every 3 minutes while the island is open, and when the usage menu opens. The sign-in is read from Claude Code's credentials at each ask and never kept, logged or sent anywhere but api.anthropic.com. Without it, the usage menu says where to turn it on. The status line's figures now add to what is known instead of replacing it
- **Allow simple requests from the closed island** (Settings → Island, on by default): when an agent asks to read files or run a command that only looks (`ls`, `git status`, `git log`, `grep`…, with no redirection or substitution), the closed island comes out with who asks, the command, and Deny and Allow. Nothing is ever allowed without a click, and clicks in the first moments are ignored; a click elsewhere on it opens the full card. Edits, writes and any other command open the full card as before. It covers Antigravity's commands (`run_command`) and the chat's own requests too
- **The chat's Claude Code asks every time again**: set to Ask every time, a command, an edit or a web fetch of the chat's Claude Code comes up as an Allow / Deny card, whatever the Claude Code version. `claude -p` only asks its PermissionRequest hook in some versions, and denied the rest silently ("the command needs your approval and did not start"); the chat's run now adds a PreToolUse hook of its own for that run only (`--settings`), and your settings.json is not touched
- **A right-click menu of Lumo's own**, instead of the webview's: on the island and its Live Activities, **Refresh** (also Ctrl+R or F5) asks everything again at once — the calendar, the emails and the other services, the plan usage, the agents' hooks and sessions, the weekly recap — and Cut, Copy, Paste and Select all are there in a text field. Settings → General → Right-click menu picks what else it offers: New chat, Open the chat, Timer: 5 minutes, Keep the island open, Sounds, Live Activities, Put the island back in the middle, Wardrobe, Settings, Quit Lumo. The Settings window has the text actions only. Linux reads the clipboard with wl-paste, xclip or xsel
- **The Live Activities follow the island's height** (Settings → Island, on by default): as tall as the open island, they grow and shrink with it when you resize it; turned off, they keep the height you give them
- **A pasted or dropped file has its ×** in the chat, to take it out before sending
- **The physics package's notation reads as math** in answers: `\dd`, `\dv`, `\pdv`, `\abs`, `\norm`, `\vb`, `\vu`, bra-kets, `\grad`, `\qty` and `\order` no longer show as their names ("dd"). The chat also tells the AI to write standard LaTeX, never a macro from your own files
- **Past sessions in the Code section**: "All sessions" on a tool's card lists its recent sessions — project, when, how long, files, lines and commands — and a click reopens the project's folder in its editor or terminal
- **Search the past chats**: a field at the top of the past chats finds words in questions and answers alike (accents and case aside), with the matching words highlighted; Enter opens the first, Escape clears the search
- **The island lands where you drop it**: moved while open, it no longer shifts by the live activities' room when let go, and settles with a softer spring
- The README shows the live activities, the closed island and a new email, lists 0.5.0's features and the Email and Calendar setup, and links the Linux AppImage directly

## Windows and Linux 0.5.0 — October 9, 2026

- **Gemini Live types in the text box you clicked in**, in any app, when you ask it to write something there. It never presses Enter or sends: line breaks are Shift+Enter, or spaces in a terminal. Nothing is typed into Lumo itself or while a key like Ctrl is held. Linux needs `xdotool` (X11) or `wtype` (Wayland)
- **Gemini Live asks its helper before saying it can't**: "add this to my calendar", "check my agenda", "draft an email" go to Claude Code (or Antigravity CLI) with the apps and accounts you connected to it, instead of Gemini answering that it can't
- **Settings → Voice picks the helper's model**, and for Claude Code its effort, as the chat's picker does
- **The model picker's Effort block takes half the height**: Faster and Smarter sit beside a thinner slider, so a small island leaves the model list its room
- **Auto replaces Accept edits** in the chat's permissions (the shield): the AI decides what is safe to do without asking and asks for the rest (Claude Code's auto mode; Antigravity CLI's own judgement). Accept edits, if you had picked it, becomes Auto
- **Antigravity CLI no longer claims a permission was refused when it wasn't**: an empty answer now says what agy itself reported, and the permission mode no longer goes to agy as `--mode accept-edits`, which left it without an answer
- **The closed island says what is going on**, like a Dynamic Island: what the AI is doing ("Haiku · Reading main.ts", "Gemini Live · Looking at the screen", "Claude Code · Waiting for your OK"), and for a few seconds what just happened ("Haiku answered", a session that finished, a deploy). Nothing while nothing is going on. Settings → Island → Say what's going on turns it off
- **The Email pill**: new emails in your inbox (Gmail, Outlook, iCloud, Yahoo or any IMAP server, with an app password) show on the closed island with the sender, the subject and the first lines, and **Summarize**, **Draft a reply** and **Open**. Lumo only reads the inbox: emails stay unread, and nothing is ever sent, moved or deleted. The server says when one arrives (IMAP IDLE), so it shows within seconds. A refused sign-in says what to do (Gmail wants an app password, not the account's), and a long error no longer runs off the card
- **Live activities beside the open island**: a second island with the timers (one click for 1, 5, 10 or 25 minutes, or type `15m pasta`), the music playing with its buttons, the calendar's next events and the newest emails with Summarize and Draft a reply. Its "–" folds it into an icon right of the "+" in the top bar, and that icon brings it back. The calendar is read from its secret iCal address (Settings → Island → Calendar), and an event about to start shows on the closed island ("Stand-up · in 5 min")
- **Italiano**: the island, the settings and the tray in Italian (Settings → General → Language, or System on an Italian Windows or Linux)
- **Math in answers**: formulas ($…$, $$…$$) are drawn as math — fractions, roots, vectors, ℝ, sums, matrices — instead of showing as TeX
- **Antigravity CLI runs what you allow**: with Lumo's Antigravity hooks, Allow on a command's card now lets it run (headless agy ignored a hook's allow and refused it anyway); no click is a refusal
- **The chat's lists close on a click outside**: the models, the past chats, the screen menu and the permissions
- **The live activities start level with the island**, and keep their height when it changes size; folded, their icon sits left of the "+"
- **The chat knows what's open on your PC**: every message carries the open windows and the documents they show (a PDF, a Word or Excel file…), found on disk, so "explain page 45 of the PDF I have open" works without sharing anything. Claude Code and Antigravity CLI read the file themselves; the other providers get the document in front attached when the question is about it. Settings → Chat → Tell the AI what's open turns it off (Windows)
- **The live activities move and resize** (Windows): drag their top bar to take them off the island and leave them anywhere, drop them against the island's left or right side to join it there, and resize them from their edges like the island. Their "–" is at the top right, and folding is smooth
- **The closed island shows several live activities at once**, and is only as wide as what it says: one alone sits in the middle; more sit side by side, each more compact. Its music and timer buttons work, as resting the mouse on them no longer opens the island
- **Emails read right**: senders and subjects in Windows-1252 ("McDonald’s") and HTML entities (&rsquo;, &egrave;…) no longer show as "�"
- **Emails in the live activities**: a click on one opens it, and the eye puts it away so the next one moves up. New emails show sooner: Lumo also looks every 20 seconds, fetching only the new ones
- **Any model sets timers**: ask the chat for one, whichever model answers, and it starts on the island
- **Timers and the music on the closed island**: ask Gemini Live for a timer, or type `/timer 10m pasta` in the chat, and it counts down next to Lumo and rings at the end. The music playing (the system's media controls on Windows, MPRIS on Linux) shows with previous, play/pause and next, and Gemini Live can play, pause and skip. Settings → Island → Show the music playing turns it off
- **The Claude plan's 5-hour limit shows again**: while it is low Claude Code leaves its figure out, and the line now says "plenty left" instead of showing the week alone
- **A sharing shortcut's island waits for your question**: after Ctrl+Alt+X (or Ctrl+Alt+P) it no longer folds as soon as the mouse is elsewhere; it stays a few seconds, longer while you type, and a click outside closes it at once
- **"Claude Code answered" no longer looks busy**: the line under a call says it without the moving dots, and goes after a few seconds
- **Lumo's own names everywhere**: settings in `%APPDATA%\com.rccrd12.lumo` (`~/.config/lumo`), the relay, the inbox, the log (`lumo.log`), the recap and the chat history in `%LOCALAPPDATA%\com.rccrd12.lumo` (`~/.local/share/lumo`), the keys under `com.rccrd12.lumo` in the keychain, Claude Code's folder `~/Lumo`. Everything moves there by itself at the first launch. Hooks installed before keep working; Settings → Agents → Reinstall points them at the new folder. On Linux the command is `lumo` (a desktop shortcut bound to the old one needs `lumo --shortcut …`) and the variables are `LUMO_X11`, `LUMO_DOCK`, `LUMO_LAYER_SHELL` and `LUMO_ANTHROPIC_BASE_URL`. From 0.3.1 or earlier, uninstall the old app before installing this one

## Windows and Linux 0.4.0 — October 9, 2026

- **Talk with Gemini Live**: the microphone button in the chat box, or `Ctrl+Alt+L` from any app, starts a spoken call with Gemini 3.8 Live or Gemini 3.8 Live Extended Thinking, with your Google AI key. You can speak over it, type to it or turn the microphone off; what is said is written in the island as you go, and kept in the past chats. Gemini looks at the screen by itself when it needs to (Windows; Settings → Voice can turn that off), sees the open windows and the folder open in File Explorer, finds files by name, reads text files, images, folders, PDFs and Office documents, opens documents, folders and web pages, starts apps by name, and hands anything else to Claude Code or Antigravity CLI, whose actions come up as Allow / Deny cards over the call. The call goes on when the island closes, moves to a new connection when Google asks without you hearing it, and ends on its own after 5 minutes of silence. The key never leaves the keychain: each connection opens with a short-lived token
- **Settings → Voice**: the Google AI key, the model, Extended Thinking's level, the voice (30 of Google's), whether Gemini may look at the screen, and the helper
- **Every look moves with what is going on**: Filo, Punto, Goccia and Lucciola breathe at rest; blue, they pulse and bob while an agent works; orange, their light beats twice and sends out a ripple when something waits for you, and they look up at you; red, they shake once, flash and look down with × eyes on an error; green, they hop, land with a squash and smile ^^ when it is done, then smile again now and then. Each state eases into the next instead of jumping. Goccia's pool of light stays on the floor and shrinks as it hops. Lucciola's antenna lights twinkle in turn at rest, twinkle quickly while an agent works, perk up with the heartbeat when it waits, droop and dim on an error and sparkle when it is done, and its tail beats and sends out a ripple while it waits. It all stops when the island hides
- **Lumo moves with the chat too**: blue and busy while it writes its answer, a green hop when the answer comes, a red shake if it fails. Before, he stayed still while the chat wrote
- **The wardrobe is in two parts**, side by side, each with its title: **Outfits** (auto, none, the leaf, the round glasses, the bow tie, the headphones and the scarf) and **Lumo's style** (Filo, Punto, Goccia or Lucciola, the same choice as Settings → Island → Lumo's look). Rest the pointer on a button to try it on, click to keep it, as before

## Windows and Linux 0.3.2 — October 9, 2026

- **The launch greeting is centred and whole again**: it keeps its own size, whatever size you dragged the island to, and is drawn for the island's zoom and the display it is on, so it is no longer cut off on one side. Resting the mouse on it no longer holds it on screen: it settles into the compact island on its own
- **Moving the island to another display** no longer cuts Lumo and the pills' mini Lumos: every drawing follows the new display's scale, and the window is put back in place and at the right size after Windows rescales it
- **The compact island shows Lumo alone**, without the other pills' mini Lumos next to him
- **Chat with Antigravity CLI works again**: newer versions of `agy` refused to start ("Attach the prompt to the flag (-p='your prompt')…"); Lumo no longer passes `-p`, since the prompt already goes in on stdin. Its answers now show: agy wraps each event's fields in an object of its own, which Lumo did not read, so a turn ended with an empty answer. agy also works in Lumo's folder now instead of a scratch folder of its own, and a question starting with "/" is no longer taken for one of agy's commands
- **Effort is a slider** in the model picker, from Faster to Smarter (low, medium, high, extra high, max), with **Auto** beside it to let Claude Code pick its model's own level. Antigravity CLI has no effort to pick any more: each of its models carries its effort in its name (`gemini-3.8-flash-low`), and agy refuses a mismatched one
- **A permissions button in the chat** (the shield next to the screen button, for Claude Code and Antigravity CLI): **Ask every time** (as before), **Accept edits** (file edits go through, everything else still asks) or **Plan only** (it reads and plans, and changes nothing). It applies from the next message, and the shield lights up while it may do more than ask. Nothing lets every action through
- **The Claude plan usage in the chat** no longer stays on "Waiting for a response from Claude Code": the numbers also come from Claude Code's answers in the chat when they report them, and until there are any the line says so and where they come from
- **Lumo sits closer to the left end** of the compact island
- **Gemini CLI is gone from Settings**: Google replaced it with Antigravity CLI. Its pill is no longer offered, and Settings → Agents only lists its hooks when they were installed before, so they can be removed
- **Lumo stays in the island**: he can no longer be dragged out onto the desktop. One left there by an earlier version comes home
- **The relay is `lumo-hook`** (`lumo-hook.exe` on Windows) instead of its earlier name. Lumo still puts the same relay beside it under the old name, so the hooks Claude Code and the other agents already have keep working; installing them again from Settings → Agents moves them to the new name
- **The Windows app is `lumo.exe`**. Installing over an older Lumo closes and removes the exe it had before, and its Start menu and desktop shortcuts and its autostart entry start `lumo.exe`

## Windows and Linux 0.3.1 — October 8, 2026

- **The app and its character are now called Lumo**, a small ring of light, instead of the names of the original project, which belong to it. Running the new installer over 0.3.0 replaces it (0.3.0's own Update now does not find it, since the repository is now called Lumo): one app, one Start menu entry, one autostart entry, with your settings, keys, hooks and history kept
- **Lumo has his own look**: a ring of light with two lit eyes, whose colour tells what is going on. He breathes softly at rest; blue, he pulses and reads along while an agent works; orange, his light beats twice and sends out a ripple when it waits for you; red, he flashes and shakes, then shows × eyes on an error; green, he hops and smiles ^^ when it is done. The app icon, the launch greeting, the file drop and the weekly recap image show him too. The wardrobe (and Settings → Island → Lumo's look) offers three more looks: Punto, a dot of light, Goccia, a soft drop, and Lucciola, the firefly with clear wings and a glowing tail. The outfits fit every look
- **Lumo moves on his own** (Settings → Island → Lumo moves): calm by default, he hovers, breathes and looks around once the mouse is still; lively does more; "Only when something happens" keeps him still. It all stops when the island hides
- **Lumo stays himself while the chat writes**, without a colour or a badge: the chat already shows its answer coming
- **No more "too many hits" scene**: poking Lumo several times only annoys him for a moment
- **The current Claude models**: Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 in the model picker, for the Anthropic API and for Claude Code. Settings → Chat shows Claude Code's model too and says the API key is only for the Anthropic API: Claude Code uses your Claude plan
- **Chat with Antigravity CLI**: an Antigravity CLI choice in the model picker runs your own `agy`, signed in with your Google account, with no API key, the way Claude Code does: it reads the files you drop or attach and the folder you share, says what it is doing, stops on Stop, and continues the same conversation until New chat. Pick its model (from `agy models`) in the picker or in Settings → Chat, and its effort (low, medium, high) under the models. Headless agy never prompts: with the Antigravity hooks installed (reinstall them for time to click), each shell command it wants to run is an Allow/Deny card in the island; without them, or with no click, the command does not run. Settings → Agents notes that Antigravity CLI replaced Gemini CLI for personal Google accounts
- **Remaining usage in the chat** (Settings → Chat, off by default): next to the model, what is left of your Claude plan with Claude Code, of your rate limits with the Anthropic API or OpenAI, or of your OpenRouter credits
- **Plain display names**: Settings → Island lists "Display 1 — 2560×1440 · main", numbered from left to right, instead of the system's device names
- **A short launch greeting**: a little light loops into the island and blooms into Lumo, who smiles and settles in, in about a second and a half instead of almost five
- **New sounds**, all 29 made from scratch in code (`npm run sounds`): soft bells, plucks and bubbles, quieter for the small things and clearer when something needs you
- **A new wardrobe** made for Lumo: a leaf, round glasses, a bow tie, headphones and a scarf. On auto he wears the scarf in winter and the leaf in spring; a Mochi outfit you had chosen goes back to auto
- **Settings open inside the island**, from the gear, the tray, `Ctrl+,` or a chat link, and stay open while you look something up elsewhere. Escape closes them; the separate window is still there if they cannot load
- **Choose how the island closes** (Settings → Island): a few seconds after the mouse leaves (as before), as soon as it leaves, on a click outside the island, or only when you close it. It can also open when the mouse rests on it
- **The island floats**: rounded all round and a little off the edge of the screen. Let it go anywhere and it stays there, growing down in the upper half of the screen and up in the lower half; near an edge it docks to it, still with the small gap
- **The island stays on screen**: the closed island no longer slips away a minute after you leave it. "Hide when unused" in Settings → Island brings that back
- **The model picker** shows on its own, without the screen panel behind it, and gets enough room even when the island is small
- **The folder open in File Explorer** joins the chat when you pick it from the screen button: the chat gets its list of files, a file you name in your question is attached as with the paperclip, and Claude Code can read the rest of the folder. Nothing is listed before you click it (Windows)
- **Always share the folder open in File Explorer** (Settings → Chat, off by default): every message carries that folder's path and list of files, shown as a chip you can remove for one message (Windows)
- **Paste into the chat**: `Ctrl+V` attaches a screenshot from the clipboard (`Win+Shift+S`) or a file copied in File Explorer, as the paperclip does; text pastes as before
- **Stop, edit and copy in the chat**: the send button turns into Stop while an answer is written (Escape too), and what was already written stays. Under the mouse, a question can be copied or edited (sending the edit replaces it and what followed), and every answer has a Copy button. You can type the next question while an answer comes
- **See what the chat is doing**: next to the typing dots, a quiet line says what the answer is busy with. With Claude Code it follows each step (Thinking…, Reading report.pdf, Searching for a pattern, Running a command, Editing main.rs, Searching the web, Looking at the screen, Using a tool) and comes back whenever it returns to its tools between bits of text. The other providers show the file or the screenshots they were given, then Thinking…

## Windows and Linux 0.3.0 — October 8, 2026

- **Chat with your Claude plan**: a Claude Code choice in the model picker runs your own `claude` CLI, signed in with your subscription, with no API key. It reads the files you drop or attach, can edit files and run commands, and every permission is an Allow/Deny card in the island. Pick its effort level under the models
- **The chat is the home screen**: the island opens on the chat, with three quick starts in a new one. Claude Code and the other agents have their own Agents tab, with a blue dot while a session works and an orange one when it waits for you. The island takes the keyboard only after a click or a shortcut
- **Ask from anywhere**: `Ctrl+Alt+P` opens the chat with a screenshot of the screen under the mouse, `Ctrl+Alt+X` with the text selected in the app in front (a PDF, a web page). Each waits as a chip until you type the question and press Enter; the clipboard is put back as it was
- **Chats**: start a new chat, reopen or delete past ones, attach a file with the paperclip
- **Your screen, when you ask**: a screen button in the chat sends the list of open windows or a screenshot of one or every display, after a preview you confirm. Nothing is captured before you click (Windows)
- **The island** is bigger by default (115 %, 80–160 % in Settings or Ctrl +/−/0) with bigger icons (125 %, 100–150 %). Drag it by its top bar and let go near any edge of the screen: it docks there, upright on the sides, centred near the middle, with a bounce. Resize it from any free edge or corner; a double click puts the usual size back. A power button quits the app (Windows; on Linux the island stays at the top)
- **Settings** are split into sections, with an Updates section that checks GitHub for a newer Windows release and runs its installer, only when you click
- The chat's answers no longer show up as a finished VS Code session

## Windows and Linux 0.2.0 — October 8, 2026

The Windows and Linux app catches up with the Mac, from 0.1.1 to 0.2.1 — everything except Apple Music and the iPhone, which depend on macOS and iCloud.

- **Agents**: Codex, GitHub Copilot CLI and Muse Code sessions with Allow / Deny in the island; Gemini CLI, Antigravity, Cursor Agent, OpenCode, Amp and Hermes sessions on their own pills; Claude Code sessions from the Claude app on Windows. Install them all from Settings → Agents, which shows the diff and takes a dated backup before writing — one hardened writer for every agent's config (#278 by @Totopo27, #298 by @kobaltgit, #231 by @BeyondBirthday07)
- **Questions**: answer Claude Code's multiple-choice questions from the island; answers are checked against the questions asked, and a question answered in the terminal takes the card down (#216 by @PythonTilk)
- **The permission card** comes up for every agent, brings its pill forward, can be folded without answering, and never decides on its own
- **Chat**: Anthropic, Google AI, OpenAI and OpenRouter, switchable by clicking the model name; local models through Ollama, LM Studio or any OpenAI-compatible server, streamed, thinking hidden; Markdown answers with a copy button; full answers; your first name in the greeting; `LUMO_ANTHROPIC_BASE_URL` for a gateway, https only (#161 by @4rchila, #166 by @AlphaIsYour, #173 by @AinzDerErste, #206 by @Totopo27)
- **Plan usage**: Claude's 5-hour and weekly limits and Codex's, in the island header (#171 by @AinzDerErste)
- **Live diff**: each file Claude edits shows in the ticker with its +N −M, and a click opens the diff; the finished card shows Claude's final message
- **GitHub**: your pull requests with their CI, reviews waiting for you, the CI of your default branches, alerts when CI turns red or green, and your contribution grid
- **Mochi**: the wardrobe and seasonal outfits, the new greeting and its sound, and Mochi on the desktop (Windows, X11 and layer-shell compositors)
- **Keyboard shortcuts** from anywhere, changeable in Settings → Shortcuts; the defaults never type an AltGr character on French, German, Spanish, Italian or Portuguese keyboards
- **Weekly recap** on Monday mornings, shareable as an image; history stays on your computer
- **Pills**: declare the tools you use and pick your main one; hook-based pills no longer ask for a key; "Open terminal" brings the session's own window forward on Windows
- **10 languages**: English, 中文, हिन्दी, Español, العربية, Français, বাংলা, Português (Brasil), Русский, Bahasa Indonesia — Settings → General → Language (#228; picker from #226 by @alexisrja)
- **File drop** works from every Explorer view, and Cancel works (#240 by @KauaDc, #126); only files a real drop delivered can be read
- **Linux**: auto-close on KDE/Wayland and GNOME (#160 by @4rchila, #136), the island at the top on GNOME (#149 by @betodoescher), pinned to its display on Hyprland and Sway with a display picker (#227 by @chuxclay), GNOME large text no longer cuts the island (#122), an Arch Linux PKGBUILD (#299 by @FabioLukas123, #230)
- The step ticker no longer stops at a session's 20th step (#265 by @PythonTilk), ticker steps keep their own line (from #203 by @shakibbinkabir), `tauri dev` no longer crashes on EBUSY (#202 by @Andrev-91)

## 0.2.2 — October 8, 2026

- **Choose Mochi's screen**: the screen with the notch, the main screen, a specific display, or "Follow the mouse" — Settings → General → Display. The island moves right away and finds its place again when screens are plugged in or out; Mochi's gaze is right on any display arrangement (#236 by @steeven-th)
- **Claude Desktop pill**: Claude Code sessions started from the Claude app's Code tab get their own pill instead of being ignored; their permission prompts stay in the Claude app (#191 by @samuelmtz2000)
- **Codex plan usage**: a Codex pill next to the Claude one shows your Codex limits and free resets, read from the Codex CLI — Settings → Agents → Plan usage *(GitHub build)* (#244 by @Ace3Z)
- **Questions** show in full, with each option's description (#249 by @Mehdi-fsn)
- A pending permission can be folded away with Escape in the notch or the toggle shortcut, without answering it; Escape typed in another app never hides it (#290 by @jhannesreimann)
- Pills that run on hooks (Claude Code, Cursor, Codex, Gemini CLI, Antigravity, Copilot CLI, Muse Code, OpenCode, Amp, Hermes) say whether their hooks are installed instead of asking for a key (#183 by @TheodoreRiant)
- The chat keeps Claude's whole answer — web-search answers were cut after the first block (#67 by @RAMZI0TO99)
- `~/.claude/settings.json` is never rewritten from scratch when it can't be read, the backup must succeed before anything is written, and nothing is written if the file changed since the preview (#243 by @Fabian-2026)
- The auto-close delay set in Settings is respected (#25 by @Kamasoutra); reopening the app brings the island back (#270 by @AndersonPGS)
- Fixed a crash an hour after a file edit (#286 by @i87ce)
- Lighter when hidden: the island checks the pointer 8 times a second instead of 60 while it is hidden and the pointer is away from it

## 0.2.1 — October 7, 2026

- **Hermes Agent** (Nous Research, open-source): sessions appear in the notch — live tool steps, the final response when done, and the platform (Telegram, Discord…) when running via the gateway. Install from Settings → Agents → Hermes: it writes a small Python plugin to `~/.hermes/plugins/lumo/` and enables it in `~/.hermes/config.yaml`, with the same preview, backup and confirmation flow as other agents *(macOS, GitHub build)* (#288)
- Hermes approval requests show a "⏳ Approval pending in Hermes" step in the notch. Approving directly from the notch isn't supported yet — current Hermes versions (0.15.x) don't expose the transport API. The Approvals toggle in Settings will activate automatically once Hermes adds it (#288)
- The app never blocks Hermes: if the app is closed or unreachable, Hermes continues normally and handles approvals itself (#288)

## 0.2.0 — October 6, 2026

- GitHub Copilot CLI and Muse Code sessions show up in the notch: see every step live and approve or deny permissions right from the island. Install from Settings → Agents → Copilot CLI / Muse Code, which shows what will change in your config and backs it up before writing *(GitHub build)* (#263)
- OpenCode sessions appear in the notch via a small JavaScript plugin: install it from Settings → Agents → OpenCode. Same installer flow — preview, backup, confirm. OpenCode never blocks on the plugin (fire-and-forget), so the app never slows it down *(macOS, GitHub build)* (#263)
- Amp sessions appear in the notch the same way, via a TypeScript plugin: Settings → Agents → Amp *(macOS, GitHub build)* (#263)
- Weekly recap: on Monday morning, the first time an agent starts working or your Mac wakes, the app shows a card for the past week — time spent, sessions, files and lines changed, commands run, permissions and questions, plus your top agent, top project, busiest day and longest session. Open it any time from the menu bar with "Weekly recap" (#264)
- Share your week as a 1080 × 1920 image with Mochi: copy it, save it or share it from the notch. A privacy toggle lets you hide project names before sharing (#264)
- Everything stays on your Mac: the recap reads from a local history file (12-week rolling window) that never leaves your machine. Clear it any time in Settings → General → Weekly recap (#264)
- The app now speaks English, 中文, हिन्दी, Español, العربية, Français, বাংলা, Português, Русский and Bahasa Indonesia. Pick your language in Settings → General → Language, independent of your system locale. Translations welcome — open a pull request (#268)

## 0.1.9 — October 6, 2026

- Services up close on the iPhone: tap a service and your Mac fetches live data from its API — Vercel, GitHub, Stripe, Resend, Cal.com, n8n and Notion. The keys never leave the Mac; the detail is written to your iCloud encrypted (#251)
- Act from the iPhone: Vercel (redeploy, promote to production, cancel a build), GitHub (re-run failed jobs, approve, squash and merge), n8n (activate, deactivate, retry a failed run). Each action runs only if it was offered on an item in the last detail the Mac published for that service, is used once, and must be less than 5 minutes old. Nothing that moves money or sends an email (#251)
- The Live Activity starts 20 seconds after the Mac locks, not immediately, so a quick lock and unlock doesn't spend one of iOS's hourly starts. It starts right away when an agent is waiting for a permission or has a question (#251)
- After unlocking, the Live Activity waits 30 seconds before ending, in case the Mac locks again — useful on a laptop that goes to sleep the moment you put it down (#251)
- If the iPhone has no update token yet (iOS held back the start), and an approval or question is waiting, the Mac starts the activity again once for that specific request (#251)
- Cal.com upcoming bookings work again: the API v2 expects `afterStart` / `beforeEnd`, not `start` / `end`, so the bookings page was empty (#251)

## 0.1.8 — October 5, 2026

- On iPhone: turn on Settings → General → iPhone (off by default) and your agent sessions show up live in the iPhone app and its widgets, through your own private iCloud. Project names, commands and questions are encrypted with your iCloud keys; turning it off deletes them (#209, #211, #212, #213)
- Allow or deny a permission from the iPhone: a notification with the command, Deny right from it, Allow behind Face ID. Your Mac only applies a decision meant for the exact request it is waiting on, and the request expires after 2 minutes. The iPhone keeps a history of your decisions (#220)
- Lock your Mac while an agent works and Mochi moves to your iPhone's Lock Screen and Dynamic Island, then comes back to the notch when you unlock. Turn it on under Settings → General → iPhone. It goes through a small relay that only sees the agent's name and state (#221)
- Mochi, the pills and the diff engine now live in a shared package used by both apps; nothing changes in the notch (#210)
- The iPhone sees more of what your Mac sees: every service Mochi (GitHub, Stripe, Vercel, Resend, Cal.com, n8n, Notion) with its latest items, and the last turn of each session with its commands and diffs, all encrypted with your iCloud keys. No API key ever leaves the Mac (#224)
- Send the next instruction to Claude Code from the iPhone (GitHub build, off by default): your Mac picks it up within 15 seconds and continues the session in its own folder (#224)
- Answer Claude's questions from the iPhone: your Mac applies an answer only if it matches the question still waiting (#241)
- The Live Activity counts the time since Mochi left, and shows Allow and Deny while a command waits for you (#232, #241)
- A new greeting sound for Mochi (#241)

## 0.1.7 — October 4, 2026

- Keyboard shortcuts from anywhere: ⌃⌥Space opens the chat, ⌃⌥A jumps to a waiting permission or question, ⌃⌥T brings your terminal forward, ⌃⌥] and ⌃⌥[ switch pills, ⌃⌥M mutes Mochi, ⌃⌥D sends him to the desktop and back, ⌃⌥G opens the wardrobe, and ⌃⌥W attaches the front window to the chat (GitHub build) (#205)
- In the open island: ⌘← ⌘→ and ⌘1–9 switch pills, ⌘↑ ⌘↓ and ⌘O move through a card's list, ⌘E opens the diff, ⌘↩ sends, ⌘K starts a new chat, ⌘P pins the island (#205)
- Every global shortcut can be changed or turned off in Settings → Shortcuts, which also flags combinations another app already uses. They need no Accessibility permission (#205)
- ⌘⇧N now opens and closes the island (#205)

## 0.1.6 — October 4, 2026

- Mochi on the desktop: drag him out of the notch and drop him anywhere on your desktop. He hangs out there, follows your cursor with his eyes, wears his outfit and dances to your music (#198)
- When Claude needs you, he flies back to the notch with the permission or the question, then returns to his spot once you answer. He does a happy jump when a task finishes (#198)
- Click him to poke him, right-click for the wardrobe, drop him on a window to attach it to the chat (GitHub build), and drop him on the notch or double-click him to bring him home (#198)
- He falls asleep when nothing is going on, and remembers his spot between launches (#198)

## 0.1.5 — October 4, 2026

- Dress Mochi up: right-click him to open the wardrobe and pick a party hat, beanie, crown, witch hat, Santa hat, bunny ears, bow, sunglasses, round glasses, scarf or pumpkin, all drawn in code (#195)
- Auto mode dresses Mochi for the seasons on his own (#195)
- Outfits follow his head in 3D, glasses stay on his eyes, soft parts react when you tap or move him, and outfits come and go with a transition. Only the main Mochi wears them (#195)
- A new launch greeting: Mochi drops into the island, bounces, slides to the side and waves hello with a quick little hand, then comes back, with a new soft whisper of a sound (#196)
- Mochi's body is no longer clipped at two corners during the greeting (#196)

## 0.1.4 — October 3, 2026

- See what Claude is editing, live: each file edit shows up in the session ticker with its +N −M lines, and a click opens the diff right in the notch (#177)
- When Claude finishes, the session card shows its final message instead of the last step, without the shimmer (#177, #179)
- GitHub pill: your open pull requests with their CI status, the pull requests waiting for your review, and the CI of the default branch of your recent repos. Click a row for the list, then an item to open it on github.com (#181)
- GitHub alerts: a badge and a sound when the CI of one of your pull requests turns red or green, when a default branch breaks, or when someone requests your review. Fast CI runs are caught too, and the card refreshes when you open it (#181, #185)
- Your GitHub contribution grid: the last 7 days in the GitHub card header, click it for the past 23 weeks, and click a day for its count (#187)
- The GitHub token needs read access to pull requests and CI: a classic token with the repo scope, or a fine-grained token with read access to Pull requests, Commit statuses and Actions (#181)
- The finished view no longer overflows the card (#179)

## 0.1.3 — October 3, 2026

- Answer Claude's questions from the notch: when Claude Code asks a multiple-choice question, pick an option or type your own answer right in the island, and Reply in terminal hands it back. Update your hooks in Settings to turn it on (#165) — thanks @Vega8991 for the idea (#94)
- Claude plan usage (GitHub build): turn on Settings → Agents → Plan usage to see your 5-hour and weekly limits in a small pill in the notch header, and click it for the details and reset times. Pro and Max plans; your current status line keeps working (#159)
- Chat with local models through Ollama or LM Studio, no API key needed: connect them in Settings → Chat → Local models. Answers stream in, and thinking blocks stay hidden (#156)
- Markdown in chat answers: bold, lists, headings, quotes, and code blocks with a copy button. Links open only when they are web links (#156)
- Apple Music (GitHub build): see what is playing in the notch, play, pause and skip on hover, and Mochi dances along (#144, #153)
- Settings are now organized in a sidebar (#153)
- The chat greets you by your own first name (#154)

## 0.1.2 — October 2, 2026

- Codex support (GitHub build): sessions show up live on the Codex pill, and permission requests get Allow and Deny in the notch. Install from Settings → Codex Hooks, then trust the hooks once with /hooks in Codex (#130) — thanks @lacatu5
- Cursor: Claude Code started in Cursor's terminal shows up on the Cursor pill, and you can answer its permission requests from the notch (#120).
- Pick your main coding tool in Settings → Active pills: VS Code, Cursor, Codex or Antigravity (Codex and Antigravity: GitHub build). It stays on and no longer takes one of the 4 slots (#120).
- The permission card stays in the notch until you answer it: the mouse no longer folds it, and reopening the island shows the request again (#117).
- The permission card also shows when the island is already open, and the pill you were on comes back once you answer (#120).

## 0.1.1 — October 2, 2026

- Declare the tools you use in Settings: Gemini CLI, Antigravity, Anthropic, Google AI and OpenAI pills join the existing ones (Cursor and Codex pills are coming soon), and you pick the main pill.
- Chat now supports Google AI (Gemini) and OpenAI in addition to Anthropic; switch provider and model by clicking the model name in the chat view, on macOS.
- Linux version: the Tauri app now builds for Linux too (AppImage, .deb, .rpm), with the island as a layer-shell overlay on Wayland and Claude Code hooks over a private Unix socket (#21) — thanks @Davy133
- Compact island on screens without a notch (#22) — thanks @Kamasoutra
- Only web links (http/https) open from the notch; other kinds of links from Claude or integrations are ignored (#16) — thanks @Cris1670
- Hook socket limited to your own user account, with size and time limits; logs no longer keep commands, n8n data or full URLs, and stay under 1 MB (#16) — thanks @Cris1670 and @Vignesh-Thangamariappan
- The island always reopens after folding, and Settings opens below it, resizable — thanks @rouderz
- Choose the Claude model for the chat in Settings; the list comes from your Anthropic account, and Claude Sonnet 4.6 stays the default — thanks @rouderz
- Windows build artifacts are now downloadable from a manual CI run — thanks @MysJofR
- Any agent can talk to Mochi: tag a hook payload with `lumo_agent` (e.g. `nb-hook --agent my-agent`) and it gets its own pill in the island (#7, #9) — thanks @lacatu5
- Gemini CLI and Antigravity (agy) hook support on macOS: install from Settings and their sessions show up in the island — thanks @corefusiion

## 0.1.0 — September 27, 2026

- First release: Mochi lives in your notch, breathing, blinking, with eyes that follow your cursor
- Claude Code sessions: live steps, approve permissions, answer questions, jump to the terminal
- Chat with Claude from the notch
- Drop a file on the notch to ask a question about it or send it by email
- Drag Mochi onto any window to attach it as context
- Integrations: Stripe, n8n, GitHub, Vercel, Resend, Notion, Cal.com
- 28 handcrafted sounds
- Hides when idle, peeks out when you hover
