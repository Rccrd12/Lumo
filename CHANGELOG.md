# Changelog

## Windows 0.22.0 — November 11, 2026

- **Cloud answers stream in, no longer cut at 4096 tokens or 90 seconds**: with the Claude API, OpenAI, Google AI and OpenRouter an answer shows as it is written, as with the local models. Lumo sets no length limit of its own (Claude gets its model's own ceiling) and stops an answer only after 3 minutes with nothing from the server; one cut at the model's length limit says so under it, and Stop keeps what was already shown. A paused Claude web search goes on by itself, a passing error on the provider's side (500, 502, 503, 504, Claude's 529) is asked once more after 2 seconds, and an answer may use 25 rounds of tools instead of 8. Gemma's `<thought>` reasoning stays out of the answer. Antigravity CLI is no longer stopped after 15 minutes while it works
- **Effort, context and permissions for the API providers**: Anthropic, OpenAI, Google AI and OpenRouter get the effort slider for the models that reason, the context ring (Google's too), with **Compact the chat** in its menu, and the shield with the local models' four modes and the sandbox. In **Ask for approval**, the default, they now ask before every call of a tool, trusted ones included; Anthropic's web search runs on Anthropic's servers, so it has no card
- **The function plot is a plane**: a squared grid with the axes' numbers, up to six curves, drag to move it and zoom with + and −, Ctrl and the wheel or the keyboard; zeros, highs and lows and where two curves cross are marked, and read with their coordinates under the pointer; `region:` shades where inequalities hold. A wave no longer takes the whole island
- **Rich cards from local models**: the callouts, chart rows, calculators and quizzes local models write their own way are drawn, formulas written in TeX (`\sin`, `\pi`, `\frac`) are read, and local models get one worked example of each card
- **Allow only what is on screen**: a permission card shows the whole command, wrapped, scrolling past six lines, and all the input of an MCP tool's call. A request that reached Lumo cut can't be allowed from the island: answer it in the agent's own window. **Allow for this session** remembers that same command in that same folder, file, page with its method (GET, POST…) or MCP call, and no longer hands Claude Code the broader rules it suggests (`npm run:*`, a whole tool, a folder): Claude Code asks again for anything else, and Lumo answers what it remembers by itself. A session's rules go after 12 hours without a request. A file to write shows the lines it adds and removes (`+12 −3`, and its size for a new file), a long Write, Edit or plan can be allowed, and the card grows to show the whole command with its buttons. An MCP tool's card shows all of its input whenever it has more than the one field it is named by
- **Y and N wait for you**: they answer a card only once you turned to it (a click on it, its shortcut). A card that comes up while you type in the chat leaves your keys alone
- **Listening asks first**: a `[[listen …]]` line in an answer shows a **Start listening?** box, and Lumo listens only after **Listen**. Lines in code blocks or quotes are ignored, and web watches take only public https pages
- **Antigravity CLI has its own permission mode**: Claude Code's Auto (the AI decides) is no longer Antigravity's Turbo (everything runs). If you had Antigravity on Turbo it keeps Auto; otherwise it asks until you pick a mode
- **Updates signed by Lumo**: on top of GitHub's SHA-256, an update's installer runs only when its `.sig` signature, made with Lumo's own key, holds. Without it nothing is installed. A second signature covers the installer's name, with its version and channel, so a release never installs a beta, and the installer is kept locked from its check until it starts. From this version on, Lumo accepts only signed updates
- **Chat tools ask before they act**: a chat model can only call the tools offered in its turn; Gemini Live counts a file as given only in a folder you opened in Explorer, and its helper works in Lumo's folder; moving files checks the real path (trailing dots and spaces, alternate streams, junctions); hooks, agent hooks and the status line install only from a preview you confirm in Settings; the workshop's Try shows the full path and arguments it runs, and a tool can no longer be a shell, an interpreter or a program of Windows; your tools no longer get Lumo's keys and tokens in their environment
- **Chat programs end with Lumo**: Claude Code, Codex, the ACP agents and agy that a chat started stop when Lumo quits, with what they started (a dev server Claude launched, say)
- **Pausing answers the waiting cards**: pause declines every card that waits, so the agents ask in their terminal at once, and a Gemini Live call ends when the island hides
- **Your own hooks stay**: reinstalling or removing Lumo's Claude Code hooks takes only Lumo's hook out of a group, never yours beside it; removing a key from settings.json keeps the others in their order, and the diff before writing says when the file's own layout (indentation, line ends, BOM) is rewritten too
- **A notice stays to be read**: an alert that opens the island while the mouse is elsewhere ("Claude Code finished", an error, the recap) waits 8 seconds, with its countdown bar, instead of closing at once
- **Images from other sites wait for your click**: an image in an answer loads by itself only from Wikimedia; from any other site the answer shows **Load image**, since that site sees the address the AI wrote
- **More cards where a page or a file could steer the AI**: the island's Antigravity chat asks before a read outside the chat's folders or of a key or password file, before a web page or a web search, a subagent and any tool Lumo doesn't know; Gemini Live asks before opening a web page, with its whole address; Claude using the computer can't click on Lumo's Settings and its screenshots leave Settings out; what a watch saw reaches the AI marked as coming from outside, never as an instruction; a click on Allow for one of your tools covers only that same call; more key and password files (gcloud, `.npmrc`, `.pgpass`, Thunderbird, Vivaldi, Arc…) and Lumo's own data stay out of the AI's reach
- **Only Lumo's own tools go without a card**: the relay lets through only the MCP server named `lumo` and your own tools (`lumo_tools`), and with Antigravity's names only a tool you really have; what a call's arguments say never makes it one of Lumo's
- **Settings in the island hand changes to the Settings window**: Install hooks, Install relay, the plan switch and an agent's Install or Uninstall, clicked in the Settings shown inside the island, open the Settings window with the change ready, and it is written only after you confirm its diff there
- **The error card says what went wrong**: the reason in words ("Usage limit reached") with its code, and the last step in grey below it, instead of the last step in red; **Retry** is now **Open the terminal** (**Open Claude** for the desktop app)
- **The island fits what it shows**: each view keeps the size you drag it to, so a bigger chat no longer makes the home, Settings or the Tools bigger too (a double click on the edge resets only the view shown); the chat grows with what the last two messages say, up to 440 px (a height you set by dragging the edge still wins); "Finished" takes up to three lines, cut between two words with "…"; the Tools view is as tall as its list; a long name on the closed island no longer hides what is happening; a table in the chat has no empty space at its right
- **Email that may have gone is not sent twice**: when the mail server never confirmed a send, the AI is told it may have gone and not to send it again; each step of a send has its own minute, so big attachments on a slow line no longer time out; with Outlook, a send that took too long says to check Sent Items and the Outbox
- **Stop stops sooner, long answers end well**: Stop works while Lumo reads the open windows and the emails before a question, and while Unsloth Studio starts; an answer that uses its 25 rounds of tools keeps what it said and ends with a note, and the next question no longer fails; **Compact the chat** uses the model's own room; an answer whose stream ended early says it may be cut; an update of Lumo never leaves an old relay behind
- **Safer connections**: the TLS libraries behind the cloud chats, the updater, web images and the mail (rustls, rustls-webpki, webpki-roots) carry their security fixes of October 2026
- **Fixed**: a finished answer left the chat higher up than where you were reading when it had a rich card above; the chat had a horizontal scrollbar under the messages since 0.21.0; the closed island named the model picked since, instead of the one answering; a question sent while the picker started Unsloth Studio said "Thinking…" instead of "Starting Unsloth Studio…"
- **Fixed**: a reminder rang up to an hour late after sleep; a repeating event set up more than 2000 days ago didn't show; an event's time zone (`TZID`) was ignored; a click in the first 600 ms of a question card counted; `git -c …` and other options before the subcommand counted as only looking; a command with `sleep` inside quotes was refused as a long wait
- **Fixed**: an email whose `List-Unsubscribe` had an accented letter at the wrong place stopped the mail check, and a calculator range with many spaces took seconds; a question asked while the chat was compacting went to another chat; with storage full no chat was saved again (now the oldest go); a word that only began like one about the open document ("tablet" for a table, say) attached it; a link dropped on the island opened in it; the embedded Settings page showed old values after a change elsewhere
- **Fixed**: Lumo could close when Outlook renumbered its emails; Gemini Live told the AI about your pull requests with GitHub kept from the AI; a computer-use card dropped by Stop kept the mouse away from Claude until Lumo restarted; a card answered in the terminal reopened the island with a sound; a command with a lone carriage return in it counted as only looking; a timer could ring late after a pause or with the island hidden, and pills stayed "working" after a pause; a repeating event with a time zone moved by an hour across daylight saving time
- **Fixed**: a fence of three backticks inside a code block opened with more ended it; a quiz asked again kept the old score; dragging the island wiped a key being typed in Settings; Gemini Live's saved transcript kept only its last 400 lines; Italian texts cut on the home and in the Settings search, and "Live Activities" left in English; a finished session listed under "Working"; the "later" button was hard to hit
- **Fixed**: "ci" in an Italian question loaded the GitHub tools and "risposta" the email tools; a big image or PDF given to Claude failed the whole turn instead of being described to it; an LM Studio error counted as a model in memory; an empty answer was saved as Lumo's own message
- **Fixed**: a new push said "Checks passed" before its own checks started; a moment settings.json couldn't be read turned web images back on; a local model's answer whose plan check went back to work left the chat; a failed Stripe payment sounded like a success, and the balance added up different currencies; work Microsoft 365 accounts opened the wrong Outlook; copying a folder after one of its files failed; forwarding more than 10 attachments dropped some; Voice could open a program named with a trailing dot or a stream
- **Fixed**: in the steps card, a shorter step stayed at the top with all the room left empty above the bar (it now sits in the middle), and the formula of the step before, small and dim above, was cut at the top and kept its root sign bright
- **Fixed**: in the steps card's list of every step, a taller row's number sat off its line and formulas lost the bottom of a subscript or a fraction; two `\underbrace`s side by side ran their notes together, in the whole chat

## Windows 0.21.0 — November 10, 2026

- **Rich cards in the answers**: an answer can show cards made for the island, and the AI uses them on its own wherever they make it clearer: callouts (`> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`), steps to go through one at a time, cards side by side to compare, a calculator and a function plot with sliders, a quiz answered with a click, a chart of data as bars or lines (or as a table), a timeline, a checklist you tick yourself (the AI hears of your ticks with your next question) and a diff in one column or two. A card's formulas are read by Lumo's own small calculator, never run as code, and a block a card can't read shows as the code it was written as. The island stays smooth with many cards, and a function plot is as tall as its curves need
- **Images in the answers**: a line that is only an image's address (`![alt](https://…)`) shows the picture, with rounded corners, its caption and the site it came from, which opens it. Lumo downloads it at once, only over https from public addresses, only image files and 8 MB at most; the site sees the address the AI wrote. Settings → Security → **Images from the web** turns it off
- **Answers written in ink**: an answer being written comes at a steady pace behind a soft edge, letter by letter, instead of in bursts; a formula, a link or a bold word shows whole, never half-written. With Windows' animation effects off, it shows as before
- **Actions under the messages**: as in Claude's app, an answer has Copy, Retry and when it came under it, and a question has when it was sent, Retry, Edit and Copy. They show under the mouse, and always under the last answer. Retry sends the last question again in place of its answer, and stays in sight when an answer failed
- **Permissions and a sandbox for local models**: with Ollama, LM Studio, Unsloth Studio or your own server, the chat's shield has the modes Unsloth Studio has. **Ask for approval** asks before each of your tools and each web search; **Approve for me** asks for a trusted tool only when it reaches the internet, writes, touches the system or the supervisor said to be careful with it; **Run automatically** never asks for a trusted tool that runs in the sandbox; **Plan only** is as before. A tool left on **Ask every time** always asks, whatever the mode. **Sandbox** at the top of the menu picks **Low** (Lumo's guard, as before) or **High** (the default): your tools that need nothing but the internet also run in a Windows sandbox (an AppContainer), which keeps them from every file and folder but their own, from the internet unless they declared it, and from the clipboard and other windows. An email still waits for your click in every mode
- **Local models plan without being asked, and keep their plan up to date**: the plan tool is always offered to a local model that takes tools, and it is asked to make a plan for any job of more than one step, not only when the question says "plan"; one that goes on changing files for two rounds with no plan is asked for one. When Ollama, LM Studio, Unsloth Studio or a custom server's model shows a plan on the Plan island and then works on with its tools without ticking it, Lumo reminds it which step the plan shows; if it answers with the plan still behind the work, Lumo has it put each step where it stands, unseen: the answer stays as it was. A list of steps it writes right before its first tools is shown as the plan, and it is told so; each new question in that chat says where the plan stands
- **Outlook stops asking**: with Outlook on this PC on, Outlook no longer asks again and again whether "a program is trying to access e-mail address information": Lumo reads the sender, the text and the headers through Outlook's own MAPI, which never asks, and changes nothing in Outlook's or Windows' security settings. Sending still goes through Outlook, after your click. With a 32-bit Office, the island shows an email's subject alone
- **Usage turns orange later**: the usage ring in the chat, its menu and the plan pills stay green up to 75 % of a limit, turn orange up to 90 % and red above (before: 50 % and 80 %)
- **One look**: Settings → Island → **Previous look** is gone, and with it the look from before 0.18 (Lumo in a column on the left, the tabs, and the gear, sound, – and power buttons in the top bar). Everything is where the current look already has it: on the home and in the **…** menu. If you had picked the previous look, Lumo opens in the current one, with the rest of your settings as they were
- **Lumo is Filo**: the wardrobe's outfits (the leaf, the round glasses, the bow tie, the headphones, the scarf and the seasons' auto) and Lumo's other styles (Punto, Goccia, Lucciola) are gone with the previous look, which was the only one that showed them, and so is Settings → Island → **Lumo's look**. Lumo is his two eyes on the island, now also in the little pill while Claude uses the computer (it showed the whole Lumo of the previous look), and the ring of light on the weekly recap's image. The wardrobe keeps the light along the island's edge and Claude's mouse
- **No more windows of their own for the live activities and the plan**: the live activities are the home's tiles and the plan is in its chat and on the home, as in the current look already. If you had moved them out of the island before 0.18, their windows no longer open, and they are where everyone has them; your settings.json from before still loads. Settings → Island loses the **Live Activities** and **Follow the island's height** switches, which only that panel read (the calendar's address stays there). **Live Activities** in the **…** menu and the right-click menu stays: it shows or hides the home's tiles
- **A deletion says so**: on the cards of Copilot CLI and Cursor CLI in the chat, a file to delete is **Delete** ("Deletes a file.") and one to move or rename is **Move**, with where it goes, instead of Edit. In Auto, the new look's card says that Allow counts for the rest of the chat
- **The agents' sign-ins stay out**: Gemini Live never reads, and a chat's folder of copies never takes, the sign-ins of Codex, Gemini CLI, Copilot CLI, Cursor CLI and GitHub CLI, nor Claude Code's folder where `CLAUDE_CONFIG_DIR` puts it
- **No update without its fingerprint**: an installer is run only when it matches the SHA-256 GitHub published for it; when Lumo doesn't have it yet it asks GitHub again, and with none it installs nothing
- **Releases scanned with Microsoft Defender**: every release and beta is scanned with Defender's latest definitions before it is published, and one it flags is not published
- **Unsloth Studio ends with Lumo**: the server Lumo started stops with it even after a crash or the Task Manager, instead of keeping the graphics card's memory; with Stop after set to Never it still keeps running
- **Fixed**: what Claude Code writes in the chat by itself, with no message of yours (when a command it left running in the background ends, or an agent it started reports), was lost: it now joins its last answer, is saved with the chat, and the closed island says it answered. Its process also stays, up to 3 hours, while such work runs, instead of ending it after 10 minutes
- **Fixed**: a beta could take a pull request's newest commit before its checks had passed on it; it now waits for them
- **Fixed**: pressing Esc to stop Claude using the computer froze Lumo until Windows closed it; Claude now stops, and Esc is yours again at once
- **Fixed**: editing a question in the chat drops the plan its answer made from the Plan island, so the new answer's plan starts on its own instead of adding its steps (and ticks) to the old one
- **Fixed**: the seconds of "Starting Unsloth Studio…" in the chat's picker and in Settings go up one at a time, instead of two or three at once while Lumo waited for the server to answer

## Windows 0.20.1 — November 9, 2026

- **Sessions another program starts share one row**: when a program asks Claude Code many questions on its own (with `claude -p`, or any agent run with `LUMO_BACKGROUND=1`), the home shows one row for that program, named after it, with how many are done, running and failed and a bar along its foot, which fills as the batch goes when the program sets `LUMO_BATCH_TOTAL`. A click opens what each running session is about, the last answer and the errors. "Work" plays once when the batch starts and "finish" once when it ends, the island never opens on its own for them, and they stay out of the folder history, the Plan island and the weekly recap; their permission requests still come up as cards. Settings → Agents → **Background sessions** has Grouped, One by one (as before) and Hidden
- **No sounds in a burst**: work, finish, error, approval, question and rate play at most once every 1.5 s; the sounds of your own clicks always play
- **Your questions as Markdown and formulas**: a question, once sent, is drawn like the answers, with its bold, lists, code and TeX formulas. The box stays plain text while you write, and Copy and Edit take the text as you wrote it
- **Fixed**: each Unsloth Studio model shows once in the chat's picker, by its name and quant, instead of twice

## Windows 0.20.0 — November 8, 2026

- **A card answered in the terminal goes away**: when you answer a permission request in the terminal (or in the Claude app) instead of on the island, its card leaves at once, and so does one whose command has already run. A relay left behind by a closed shell now ends too, so it no longer keeps a card up
- **Claude Desktop on the island**: permission requests and questions from Claude Code sessions in the Claude desktop app come up on the island, with Deny and Allow or the choices, like a terminal's
- **Antigravity asks on the island**: when Antigravity (the app or `agy` in a terminal) wants to run a command that none of its own rules allows or blocks, the island shows it with **Deny** and **Allow**, and **Reply in Antigravity** under them to answer in its window instead (for its "Always allow", say). The commands its rules already decide never reach Lumo, and with no click, or Lumo closed, Antigravity asks as before. Hooks installed before the island's chat with Antigravity CLI came give Lumo no time to wait: **Reinstall…** in Settings → Agents → Antigravity fixes that
- **OpenCode asks on the island**: its permission requests come up with Deny and Allow, like Claude Code's. With no click, or Lumo closed, OpenCode asks as before. **Reinstall…** in Settings → Agents → OpenCode adds it to a plugin installed before
- **Email from Outlook, with no password**: Settings → Pills & integrations → Email has **Outlook on this PC**, which reads the classic Outlook (Office, Microsoft 365) already set up on the PC, every account in it, and **IMAP**, as before. Turn on one or both: the emails of both reach the island, the chat and the agents' email tools. Lumo reads Outlook from within Windows and keeps no password for it. The new Outlook for Windows lets no other app read it: with it, use IMAP
- **More than one IMAP account**: Settings → Pills & integrations → Email → IMAP lists your accounts, up to five, each with its state, a switch to pause it and **Remove**. **+ Add an account** asks for the address, the app password and (only if Lumo can't find it from the address) the server, all at once: **Check and save** signs in first and keeps nothing if the server refuses, saying why. The emails of every account come together on the island, in the chat and in the agents' email tools; a new email goes out of the first account (the **Default**), a reply out of the account the email came to. The account you already had is the first one, with nothing to type again
- **What the AI sends goes out of Outlook**: with Settings → Security → Email set to send, a reply or a forward goes out of the mailbox the email came to, a new email out of Outlook when it is on, so it is in its Sent Items; each still waits for your click on its card, and so does each email marked, moved, archived or put in Deleted Items
- **Open Outlook if it's closed**: in Settings → Security, off by default. When Lumo starts, it opens Outlook in the background, with no window; if you close it yourself, Lumo doesn't open it again until it next starts. With it off, Outlook closed only pauses its emails, and they come back when you open it
- **Open in Outlook**: Open on an Outlook email of the island shows it in Outlook
- **Chat with Copilot CLI and Cursor CLI**: pick **Copilot CLI** or **Cursor CLI** above the chat box and the island talks to the CLI you already use, with your GitHub Copilot or Cursor plan and no key in Lumo. Like Codex, each streams its answer and says what it is doing, shows its plan on the Plan island, keeps the files it read or changed in the chat's files, uses Lumo's timer, GitHub and email tools and yours, and asks for each action with a Deny / Allow card. The shield works with them too: in **Auto**, what you allow is allowed for the rest of the chat; **Plan only** uses the CLI's own plan mode. Settings → Chat has their models (and Copilot's effort), and says how to install and sign in while one isn't on the PC. **Show in the chat**, there and on Antigravity CLI's and Codex's, takes a CLI you don't want out of the chat's providers without uninstalling it
- **Unsloth Studio starts when the chat needs it**: with Unsloth Studio installed on this PC and connected at a local address, picking it in the chat or writing to it starts it in the background, with no window, and the picker and the chat say "Starting Unsloth Studio… N s". It stops again after 15 minutes with no question. Settings → Chat → Local models has **Start and stop it by itself** and **Stop after** (5 min, 15 min, 1 h, when Lumo quits, never), with Start now and Stop now, and shows Off instead of a red error while Lumo can start it. Lumo only ever stops a server it started
- **Security in a tab of its own**: Settings → Security leaves General for a page of its own, in three groups that each answer one question (what the AI may do on its own, what it sees with every message, your accounts), with short plain hints, and **Always on** lists what Lumo does without a switch
- **Sessions go by their title**: a Claude Code session shows the title Claude Code gave it (or yours, from `/rename`), with its folder beside it; until it has one, the folder as before
- **Open PRs that only wait share one row**: on the home, a pull request whose checks run or fail keeps its own row; two or more that only wait (checks passed, or none) share one, "3 open PRs", whose click opens the GitHub card on My PRs. In the new look the GitHub card's lists (My PRs, To review, Default branch CI) have rows like the home's, scroll past what fits and cut long titles with "…", and the island grows to show three of them
- **Approve a plan and let it edit files**: under the buttons of a plan asking to start, **Approve and let it edit files without asking** starts it in Claude Code's accept-edits mode for that session only
- **Your Claude Code folder, wherever it is**: with `CLAUDE_CONFIG_DIR` set, the hooks go in the settings Claude Code really reads there
- **Less memory**: the Settings window keeps only what it needs while it is hidden
- **Safer**: only your Windows account can open the pipe the hooks talk to Lumo on; the relay Lumo installs is checked byte for byte, not by size and date; an update's installer must match the SHA-256 GitHub published for it, or it is not run; and the release workflows give write access only to the step that publishes
- **Fixed**: Copilot CLI's model menu shows each model once ("Auto" was there twice); a price written `\$0,20` in an answer is a dollar sign again, instead of the edge of a formula that hid the amount and broke the bold around it

## Windows 0.19.1 — November 8, 2026

- **Menus with their text centred**: every row of Lumo's menus has its text in the middle of the row, instead of sitting low on it
- **No beta that is the release again**: with Beta versions on, Lumo offers a beta only when it holds something the last release does not; a pull request that changes only tests, screenshots or notes no longer makes one

## Windows 0.19.0 — November 8, 2026

- **The chat reads your GitHub**: with the GitHub pill set up and Settings → General → Security → **GitHub** on Read only, every chat provider (local models too) can read your pull requests with their checks and reviews, issues, repositories, commits and GitHub Actions runs. It is off until you turn it on, so no repository reaches an AI without your yes
- **The Plan island follows every provider**: the API providers and local models show their steps on it as they work, as Claude Code, Codex and Antigravity CLI do
- **Chats at work on the home**: the new look's home lists the chats answering in the background with what each is doing, and a finished one stays a few seconds with a green Done; a click opens it. The home's GitHub items refresh when it comes on screen, and long chat titles shorten before the model's name
- **Unsloth Studio loads and frees its models better**: Lumo loads them by the name Unsloth Studio lists (its quant and local files included) and falls back to the older call for older builds; Settings → Local models shows what it holds in memory with Free memory; its errors say what went wrong, a refused key included
- **Beta versions**: Settings → Updates → Beta versions (off unless turned on) offers one beta build, main with every open pull request merged in, to try changes before they are released
- **Fixed**: a pull request or a github.com link in a question brings in the listening tools again for local models

## Windows 0.18.0 — November 8, 2026

- **A new look**: Lumo is two eyes in the open island's top bar and on the closed island, and the island's light runs along its edge, in a colour picked in the wardrobe. It is on for everyone; Settings → Island → **Previous look** brings back the look of 0.17, exactly as it was
- **One home instead of the tabs**: what waits for you, the sessions at work, the plans under way, the live activities as tiles (the timer with its ring round the tile's edge, the music, the calendar, the email), the services and the plans' usage, and the field to the chat. It resizes like the rest of the island, and goes narrower than the other views
- **The chat in one field**, with "+" for the rest and past chats in the top bar; the plan is a chip beside the model, its steps rising over the chat
- **A plan asking to start shows its steps**: in the chat, above the field, with Keep planning and Approve (or write what to change), and on the permission card as a numbered list
- **The chat's usage as bars**: how full the context is after every answer (from Claude Code, and about how full for Antigravity CLI), what fills it after `/context`, and each limit of the plan with when it resets
- **Share as pills and tiles**: open windows, screens, tabs and folders, nothing captured until Send to the chat
- **What Lumo listens to as cards**, and tools as blocks with what each uses written out
- **Permission cards with two big buttons**, and Allow for this session under them
- **Settings in the island** with the search and the sections on top, always in sight while scrolling, and a thin scrollbar
- **The opening is the island's light coming on**, with a sound of its own; a dropped file flies up to Lumo in the top bar

## Windows 0.17.1 — November 7, 2026

- **Formulas as LaTeX draws them**: the chat's formulas are in Latin Modern Math, the face of LaTeX, shipped with the app, so they look the same on every PC
- **Formulas on the chat's background**: a formula on its own line no longer sits in a grey box, and takes less room above and below; Copy for its TeX sits at its right, level with it
- **Answers with room between their lines**: paragraphs, lists, quotes and formulas in the chat are spaced as in a page, easier to read
- **Fixed**: a minus in front of a fraction sat a pixel above its bar; it is now drawn on the same line, a hair away from the fraction

## Windows 0.17.0 — November 7, 2026

- **Local models do much more**: tools, pictures and reasoning by what the model can do, the chat's permission modes and its / commands, the email and listening tools, and a short prompt of their own with the tools in groups. The tools not loaded are in a catalog the model loads by name. The picker shows the context ring and loads or ejects a model
- **A folder of copies for each chat**: a local model works on copies of your files, never on the originals. What changed shows under the answer, and the copy goes over the original only with a click
- **Unsloth Studio** as a server of its own, with its key, loading its models from Lumo
- **PDFs reach every model**: a short PDF goes as pictures of its pages, as far as the model's context has room, a longer one as its text, and to a local server that refuses the pictures, its text in their place
- **Lumo's own web search** for the providers without one (local models, OpenAI, Google, OpenRouter), and the email and listening tools for every API provider
- **/compact** for the providers called by their API. With a local model the context ring offers it, and Compact the chat is a small pill at the bottom of the context menu. A local model's chat compacts itself before a question once its context is over 80 % (Settings → Chat → Local models), and the ring shows an estimate until the next answer
- **The seconds next to Thinking…** for every provider, from 2 s on, and for a local model reading the prompt
- **A dropped file fills up to 60 % of a local model's context**, instead of 24,000 characters whatever the model: a 32k context takes some 50,000 characters of a book, a 128k one far more. A file cut short says so, and with a folder of copies the model reads on in it
- **Steadier answers from local models**: a request the server drops (LM Studio's "terminated" or "fetch failed") is asked again, and a stream that hangs is asked for whole. A tool call written as text, a change said but not made, or a task left halfway goes back to the model once, and a made-up tool is answered with the real ones. A failed answer always says why, and an answer cut before its first word says whether the context was full or the reasoning took all the room. The chat says what a local model is doing in the same words as every provider (Thinking…, Using a tool), plus reading the prompt, asked again after its server dropped the request, or sent back
- **Formulas drawn as real math**: the chat lays formulas out as MathML with the math font, so integrals, sums, brackets, fractions and roots take the sizes TeX gives them. Over 500 symbols from LaTeX and AMS, `\dfrac`, `\binom`, `\cancel`, `\substack` and more; a formula on its own line sits in a box with Copy for its TeX
- **Every file dropped on the island is taken**, not just the first: several files upload together with a bar for each (+X past four), and the chat lists them all
- **The chat follows the answer** while it is written, as long as you are at the end; a turn of the wheel up lets go, and an arrow brings you back down
- **A message sent while the AI answers waits in sight**: it leaves the field for a Queued row, with a pencil to edit it and × to cancel, and goes on its own when the answer ends (after Stop it comes back to the field)
- **A chat's files in the inbox go with the chat**: deleting a chat deletes the copies it sent, unless another chat still names them, and on start the inbox drops copies no chat names after a day
- **Safer copies and PDFs**: the record of what each copy came from is kept outside the model's folder, and the card shows the original's full path before **Write it over the original**. Names Windows reads as something else (a trailing dot, `con`, `NOTES~1.TXT`) and network paths are refused. A malformed PDF can no longer close Lumo, and a PDF's streams decompress to 64 MB at most
- **Gemini Live asks before a file you didn't give it**: reading or opening a file that wasn't dropped on the island or in a folder open in File Explorer is the usual Allow / Deny card, with the file's full path. Keys, passwords and browser profiles are never read or opened for the voice. More types that run something (`.chm`, `.iso`, `.xlsm`, `.diagcab`…) are never opened by their type
- **Recovery codes and passwords stay out**: a file named for recovery or backup codes, a wallet's words or passwords is never read by Gemini Live, nor copied into a chat's folder; a folder copied skips them, and keys, as well
- **Fixed**: a picture earlier in a local model's chat counted as its text (hundreds of thousands of characters), so the answer was given as little room as 2 048 tokens and a reasoning model could be cut before its first word
- **Web pages are read from the address that was checked**: a site can no longer point Lumo's web search at this computer or the local network after the check (DNS rebinding), NAT64 and 6to4 addresses included
- **Fixed**: a tool's guard in Python checks what `r+`, a copy or a move reads; a cloud model's request no longer drops its tools after the first round; a line of Claude Code or Antigravity CLI over 4 MB no longer spills into the next one; a local model's answer that says "length" in its text is no longer taken for one cut short; a question sent while the model picker is still loading the model waits for it, with its percent, instead of saying it reads the prompt; a local model no longer says it is thinking while it still reads the prompt; its reasoning switch and context show after the answer that loaded it, without opening the picker again; the closed island says when the chat is being compacted; a local model's context ring follows each round of tools and each chat keeps its own
- **Fixed**: the Antigravity CLI usage card shows every limit, not two and a summary, and on a short island the limits of every plan card scroll while Refresh stays in view
- **Fixed**: the error card and the error note have a Close button: they no longer stay open while the mouse is on the island

## Windows 0.16.1 — October 29, 2026

- **A width for the closed island alone**: Settings → Island → Closed island width makes the closed island Wide (as before), Mid-width, Short or Just Lumo, without zooming the text, the icons or the open island. When it has something to say (an activity, a timer, an email, a request) it still widens as much as it needs
- **Fewer words on the closed island**: it says a verb and, at most, a file's name or a pull request's number ("Runs a command", "Edits island.ts", "CI failed #125", "Waits for the merge #125"). The details are still in the open island. With one activity it stops at 380 px instead of 460
- **Computer use**: while Claude uses the computer, the closed island is a short pill with Lumo alone in the middle, in his own yellow
- **Fixed**: saving or removing an integration's key in Settings → Pills left its pill's row saying "Key not configured" until Settings was opened again. The row now updates at once

## Windows 0.16.0 — October 29, 2026

- **Listening**: the waves beside the chat's folder open the Listening panel, with what Lumo is listening to (each with Pause, Edit, Go to the chat and Stop) and the history of what it heard. "Listen for something" starts a watch by hand, and Claude's `listen` tool can start one from any chat. Lumo can listen to a GitHub pull request, a file or a folder, a program or a port, a web page, an email, the calendar and the services of your pills (Vercel, Stripe, n8n, Resend, Notion, Cal.com), Windows (an app's notification, the battery, the charger, the network, a USB drive, when you're back), your agents (finished, asking for you, failed), a webhook on this PC, or one of your own tools. Each one listens once or every time, and can tell you or have the chat do something
- **A Security section** in Settings → General: what Claude Code, Codex and Antigravity CLI may do without asking, what goes with every message (what's open, the folders open in File Explorer, the browser tabs), what the AI may do with the email and the calendar, and computer use, in one place
- **More the AI can do with the email**, each step on a card: send an email (attachments included), reply in the conversation, forward with its files, read the files attached, search every folder, save drafts and, with Read, send and manage, mark, star, move, archive and trash. An email leaves only with a click on Send, after the card shows it whole, recipients included
- **Attachments and chat files in folders**: what comes from the computer waits in its own folder, the chat's files are grouped by what happened to them (attached, read, edited, created), and the × on one takes it out of the chat's context. The screen menu lists every folder open in File Explorer, and Codex's and Claude Code subagents' files join the list
- **A new look for computer use**: Claude's arrow, a light along the screen's edge that is brightest by the mouse, corners that close in where it is about to click (Aim, which stays whole even in a corner) and, in the wardrobe, Lucciola with a light in its tail. Clicks land exactly where asked
- **The island opens when a dragged file comes near it**, not only once it is over it; the file is still taken only on the island
- **Lumo keeps his own colour** when an integration's pill is in front
- **Antigravity CLI's Auto is its own Turbo**: Turbo is no longer a mode of its own, and a Turbo picked before reads as Auto
- **Small fixes**: clicking a pill on the overview no longer moves the others under the mouse; the files panel highlights the tab you are on; the Security menus share one width; searching the settings leaves no gap between the sections found

## Windows 0.15.0 — October 25, 2026

- **The session's steps fill the card**: on the overview, an agent at work shows as many of its steps as the card holds, the newest last and readable, without the fade that hid it. A click opens all its steps; where a step has more to show (the whole command, the full path, a failed command's error, the whole prompt or answer) its arrow opens it in place
- **Your tools for every CLI**: Antigravity CLI now gets your tools too, each call asking with Lumo's card as with Claude Code, and the "/" menu lists your tools' commands with Codex as well
- **Antigravity CLI's own commands in the chat**: with Antigravity CLI the "/" menu offers `/compact`, `/usage`, `/credits` and `/skills`. `/usage` answers with a card of your limits, with the bar, the percentage used and when it resets
- **Fixed**: an Antigravity session that stopped without saying so stayed on the island as working for good. After 10 minutes without news it goes away, unless one of its cards is waiting for you
- **Fixed**: in the tool workshop, Claude Code installed with npm never started and the island asked whether it was signed in. It starts again
- **Change with Lumo** goes back to the tool's workshop chat instead of starting a new one each time, and **Add to Claude Code** says it is working while it adds the tools
- **Fixed**: in a narrow window, the effort's Auto no longer runs past the edge of the picker, and the chat's buttons keep their spacing

## Windows 0.14.0 — October 23, 2026

- **`/context` as a card**: with Claude Code, `/context` no longer fills the chat with tables. It answers with a small card: how much of the context is used, a bar of what fills it with a short legend, and under Details the MCP servers, skills, memory files and the tools loaded only when needed. Copy still copies Claude Code's own text
- **Tables in the answers**: a Markdown table (`/doctor` writes them, and so do the models) shows as a table instead of rows of `|`. One too wide for the chat shows row by row, each value beside its column's name
- **A tidier "/" menu**: Claude Code's commands that do nothing in the chat (`/design`, `/color`, `/config`, `/rename`, `/usage`, `/loop` and the like) are no longer listed. `/effort` opens the picker where the effort is set, as `/model` does, with Claude Code and Codex
- **Update now with the .msi**: a Lumo installed from the .msi is updated with the .msi, in place, instead of getting a second Lumo installed beside it
- **Fixed**: after uninstalling Lumo, every Claude Code hook failed with an error. The relay now stays behind and exits at once, as it does when Lumo is closed
- **Fixed**: after a failure, the relay to the island could stop delivering approval cards until Lumo restarted; it now reconnects. A question answered in the terminal no longer keeps the relay waiting, and the chat's guard reads what some shells send with a BOM
- **Saving the settings no longer reconnects the email** unless a mail setting changed

## Windows 0.13.2 — October 23, 2026

- **Formulas in the chat look right**: matrices get brackets as tall as their rows, `\left( … \right)` stretches around what it holds, and `aligned`, `cases`, `array` and the other environments line their columns up. Vectors written as `\vect{v}`, `\vv{v}` or `\overrightarrow{v}` show their arrow, and a command Lumo doesn't know shows what it holds instead of its name. `=` and `+` get their spacing, a formula on its own line puts the limits of ∑ and lim above and below, and `\boxed`, `\overset`, `\underbrace`, `\xrightarrow` and `\color` work too
- **Fixed**: with Claude Code in the chat, a command such as `/context` or `/compact` was answered by the model as a question when Lumo shared what's open, a folder or the screen. Claude Code's commands now reach it exactly as typed
- **Fixed**: an old file dropped on the island could disappear from the chat right after being added, if the inbox was being cleaned at the same moment

## Windows 0.13.1 — October 22, 2026

- **Attachments and Chat files stay put**: switching between the two lists no longer moves their buttons
- **Chat files show where they are**: under each file, the folder it is in
- **One row per file in Chat files**: a file you attached and the AI then read shows once, as "Attached · Read by the AI", where the file really is
- **The attachments' number is in their button**, so it is clear it counts the attachments and not the chat's files

## Windows 0.13.0 — October 22, 2026

- **Commands in the chat**: type `/` as the first character in the chat box and a menu of commands opens above it, filtered as you type (arrows move, Enter runs, Tab writes the name, Escape closes it). Lumo's own work with every provider: `/new`, `/history`, `/model`, `/attach`, `/screen`, `/permissions` and `/timer 10m pasta`. With Claude Code, its own commands are listed too (`/compact`, `/context`, your commands and skills). The menu lists only what works with the provider picked
- **Your tools as commands**: the workshop's AI gives each tool it makes a command (`/pdfcraft`), which the tool's detail in the Tools tab changes or clears. `/pdfcraft merge the PDF in the open folder with the one in X` asks the AI to use that tool for the rest of the message
- **Chat with your ChatGPT account (Codex)**: pick Codex above the chat box and the island talks to the Codex CLI you are signed in to, no API key in Lumo. It shows what it is doing, follows its plan on the Plan island, stops on Stop and keeps the conversation until New chat. The shield works with Codex too, and what Codex would ask you comes up as its Deny / Allow card. Your Codex configuration is never touched
- **Claude Code's cards only when needed**: in the island chat, an action comes up as a Deny / Allow card exactly when Claude Code would ask for it. What your own Claude Code rules, the mode or Allow for this session already allow goes through without one, even before the hooks are installed
- **Local models' memory**: under a connected Ollama or LM Studio, Settings shows the model held in memory now, **Free memory** unloads it, and **Download a model** downloads one there with a progress bar
- **Chat files**: beside the attachments' title, the files of the chat you are in, kept with it: what you attached, and what Claude Code or Antigravity CLI read, edited or created while answering. A click opens one, a right click offers Open, Open file location and Copy path
- **Update now without a window**: the update installs silently and Lumo opens again by itself a few seconds later, with a progress bar in Settings while it downloads
- **Fixed**: a development build of Lumo no longer takes over the start with Windows entry, so the installed Lumo starts again at login instead of an error page

## Windows 0.12.0 — October 22, 2026

> After updating, open Settings → Claude Code and click **Reinstall hooks…** once: Claude Code then waits for Lumo only to ask for a permission (see below). Hooks installed before keep working as they did.

- **Tools tab**: a third tab, after the agents, lists your own tools, each with its switch (a new tool is on). A tool is a small program Lumo and its agents can use for you: a benchmark of your PC, a report from your app, anything you have a script for
- **The tool workshop**: Add a tool opens a chat of its own where Lumo writes the tool with you, or brings in a script you already have, and shows it beside the conversation with what it needs, its files and its parameters. Try runs it on your PC, Save adds it. How it works shows over the workshop at first, and its "?" brings it back. A tool still being made is listed first on the Tools tab, In progress
- **Lumo's supervisor**: once saved, and after any change, a tool is read by a second model in a conversation of its own. It says in plain words what the tool really does, what to know before using it, and whether it looks safe, needs reading first or is dangerous (a dangerous tool is turned off). Agents only get a tool the supervisor read as it is now
- **What a tool needs is enforced**: Python tools can't use the internet, read outside their folder, write outside their work folder or start programs unless they said so; Node.js tools run under Node's permission model
- **Each call asks you**: when an agent uses one of your tools, Lumo shows its card with what it will do and the supervisor's words. A reviewed tool Lumo can hold to what it declared can be trusted to run without asking
- **Your tools everywhere**: Claude Code and the API providers in the island chat get them, and a button on the Tools tab adds them to Claude Code in the terminal
- **The supervisor speaks your language in the list**: under each tool's name, the Tools tab shows what the supervisor said it does; the description written for the agents is folded under What it tells the agents. The supervisor also works with Antigravity CLI, and a tool changed to run another file no longer keeps the old one in its folder
- **Allow for this session**: a third button on the permission card lets the same command, file, URL or MCP tool through without a card until that agent's session ends. It works for Claude Code, Codex, Copilot CLI, Muse Code and the island chat; Lumo keeps the rule in memory only, and Claude Code stops asking too
- **Claude Code no longer waits for Lumo** on every event: once the hooks are reinstalled, only a permission request waits for the island's click
- **More on the island**: Claude Code's compaction and its auto-mode denials (and Gemini CLI's and Copilot's compaction) show as steps on the pill, and a notification that needs you shows as a question
- **Timer and pull request listening as real tools**: the chat's Claude Code, Antigravity CLI and API models set timers and listen to a pull request through tools of their own, checked at once, instead of writing a special line
- **One Claude Code per chat**: the island chat keeps each chat's Claude Code running between messages, so answers start sooner; Stop interrupts the answer, and a message typed while an answer is being written goes once it ends
- **Email reconnects within seconds**: a connection that went quiet (back from sleep, a new network) is redone after 2 s, then 5 s, and the emails already read stay on screen instead of an error until three tries in a row have failed
- **Auto with Antigravity CLI is really auto**: Auto now uses Antigravity's own Proceed in Sandbox. Commands run in Antigravity's terminal sandbox without asking; one that wants to leave the sandbox, an MCP tool or the browser still asks with a card. On Windows the sandbox is in preview and may not see some programs (npm, for example): Antigravity then asks to leave it
- **Turbo for Antigravity CLI**: a fourth mode in the chat's shield, with Antigravity CLI only. Antigravity's own Turbo preset runs every command and changes any file without asking. With Claude Code it reads as Ask every time
- **Fixed**: in the island chat, Antigravity CLI could change a file outside the chat's folders without asking, in every permission mode. Every such change is now a card

## Windows 0.11.1 — October 20, 2026

- **The island opens on the chat at startup** again, instead of the Agents tab. Only a tab seen on the open island counts as the last one
- **Deleting a chat drops its plans**: a chat deleted from Past chats takes its plans off the Plan island, finished or not. If nothing else is left, the island and its icon go away

## Windows 0.11.0 — October 16, 2026

- **The Plan island behaves as the live activities**: beside the open island, on the side they leave free, it fades in and out with the island and follows it as it opens, closes and resizes, as tall as the island. Dragged by its top bar it comes off into a window of its own that stays on screen until its "–", and let go against the island's side it joins it again
- **Its icon in the chat opens and folds it**: the icon stays while the Plan island is open, a click folds it into the icon, and it comes back out of it
- **Antigravity CLI's plan, step by step**: in the island chat, Antigravity CLI writes its plan with Lumo's own `update_plan` tool and moves it on as each step starts and ends, instead of ticking every step at the end. Lumo's own plan and email tools no longer ask for permission with a card
- **The live activities fold toward the island**: in their own window, they fold toward the island and come out of it, instead of the screen's corner
- **The step under way** has its dot in the middle of its ring

## Windows 0.10.1 — October 16, 2026

- **The chat's plan, for real**: Claude Code in the island chat now writes its plan as its first step for any job of more than one step, so the Plan island opens and follows it; before, the model mostly skipped it
- **Steps that move on**: Claude Code's step numbers go on from one plan to the next, and the Plan island now follows them by the number each step was given, in the chat and in a terminal, where each new step no longer shows twice
- **Antigravity CLI's plan**: in the island chat it writes its plan as a checklist, ticked as it goes, which the Plan island follows

## Windows 0.10.0 — October 16, 2026

- **The Plan island joins the island again**: let go near its place beside the island, it slides back there and follows the island again; resizing it from its right or bottom edge keeps it there
- **Its icon in the chat**: the folded Plan island now waits in the chat, left of the usage ring, instead of the top bar
- **Plans done are kept**: a finished plan, or one whose session ended, is kept (the newest twenty). The island folds into its icon instead of going away, the icon opens it on the newest plan, and arrows go back through the older ones
- **A new look for the Plan island**: a progress ring, a thread between the steps, and short animations as steps come in, get checked and light up, and as plans slide in
- **The chat stays where you read**: sending a question, the answer being written and the finished answer no longer scroll the chat. Only a chat coming on screen opens at its end

## Windows 0.9.2 — October 16, 2026

- **The chat's plan with the newest models**: Claude Code only hands its newest models (such as claude-haiku-5-5) the tools it writes a plan with when asked, so in the island's chat the plan stayed text and the Plan island shut. The chat now asks for them, and the Plan island follows the plan step by step. A second plan in the same chat follows its own steps too

## Windows 0.9.1 — October 16, 2026

- **The chat's plan on the Plan island**: Claude Code in the island's own chat now opens the Plan island too. Given a job of several steps, it writes its plan as a list of steps, which the island follows live as for an agent in a terminal

## Windows 0.9.0 — October 16, 2026

- **Plan island**: when an agent writes its plan (Claude Code, Codex, Gemini CLI, OpenCode), a third island opens right of the island in a window of its own and follows the steps live. It moves by its top bar, resizes from its grips, and its "–" folds it into an icon left of the usage pills. A finished plan stays a few seconds, then the island shuts
- **Changelog in Settings**: Settings → Updates lists every version's notes, folded, with the installed one marked
- **A note when a newer Lumo is out**: when it opens, Lumo asks GitHub once for the newest Windows release; a newer one shows a note on the island and leaves Settings on Updates with Update now ready. "Check when Lumo opens" in Settings → Updates turns it off
- **Antigravity CLI reads email** as Claude Code does: the newest emails, a search of the whole mailbox and one email in full, while the Email pill is on. Read only, so no card. A question about email in the chat brings the ten newest emails, read or not, for every provider
- **Usage for every agent**: Codex and Antigravity CLI show their usage pill as soon as their hooks are installed; turning it off in Settings keeps it off
- **The island reopens on its tab**: closed on Agents, it opens again on Agents; a card waiting for an answer still comes first
- **Email and Calendar boxes** light up under the pointer, and the Calendar box opens the calendar's web page (Google Calendar, Outlook or iCloud)
- **Detached live activities stay open**: in their own window they no longer go away when the island closes; only their "–" puts them away, and the music on them stays current

## Windows 0.8.0 — October 15, 2026

- **Gemini Live does more on the computer**: it changes the volume, a laptop's brightness and the power plan, and locks the computer; it arranges the windows (front, left or right half, maximise, minimise, close); it says how the computer is doing (processor, memory, disks, battery, the busiest programs); it tidies files in your home folder, in two steps, with the plan read out first and "put them back" to undo it; it reads Windows' notifications; and it sets reminders at a time, which ring on the island and are kept across restarts
- **Gemini Live knows what Lumo knows**: what each agent is doing, the cards waiting for you, the usage limits, GitHub, the newest emails, the calendar, the services you connected, timers and music, the chat and the week's recap. "What is Claude doing?" and "did CI pass?" are answered from Lumo itself, with no call to any service. It still never answers a card: only your click does. The emails, the chat and the other services are only counted until you ask about them, and a code in a notification (a sign-in code, a PIN) is hidden before Gemini reads it
- **Y and N answer a waiting permission** with the chat field focused too, whenever the island has the keyboard. In another app they stay letters
- **Ctrl+Alt+L** starts a call without opening the island, and pressed again pauses the microphone and picks it up again
- **The island stays above** other always-on-top windows
- **The island waits before folding** while you are writing in the chat or the drop menu is open: 10 seconds with the field empty, and not at all while a message is half written
- **Drop menu**: the title and the chips are centred, Lumo waits in the card's corner and watches the file, and a file is taken only on the island itself
- **Email**: a click on the Email box opens the inbox in Gmail or Outlook, and a question about email brings the newest unread ones whichever provider answers
- **Fixes found reviewing all of the above**: a question holding a word like "proposta" or "impostazioni" no longer sends the inbox with it; reminders are written the way the settings are, so a crash cannot lose them, and a pile of missed ones rings a few at a time instead of silently dropping the oldest; a clock put back no longer stops them ringing; a plan of file moves the user refused can no longer be confirmed afterwards; a hidden folder at any depth (`.ssh`, a project's `.git`) is left alone, not only one at the top; `Ctrl+Alt+L` on a hidden island brings it out instead of opening the microphone with nothing on screen

## Windows 0.7.0 — October 13, 2026

- **Antigravity CLI usage**: a new pill in the island's header shows your Antigravity CLI quotas (5-hour and weekly), asked of agy as its own `/usage` does, with a card for the details and a Refresh button. Nothing is installed; off by default, in Settings → Agents → Plan usage. With "Show remaining usage in the chat" on, the chat's usage ring shows the same quotas while you chat with Antigravity CLI
- **Calendar that rides out a bad network**: a failed fetch (the network not back yet after sleep, a dropped connection, a passing server error) is tried again within the minute, and the events already read stay on screen; the error shows only after a few failures in a row
- **Drop zone that closes**: a file dragged over the island and then dropped somewhere else, or cancelled, no longer leaves the drop zone open
- **Permission cards with computer use**: a card answered while Claude was using the computer no longer leaves the next cards without the mouse. Esc keeps stopping Claude after the shortcuts change in Settings
- **Cards go when Lumo stops waiting**: an unanswered card leaves at 107 seconds, before the terminal takes over, so a late click is never lost
- **Auto only allows what only looks**: `git branch new-name`, `git reflog expire`, `git grep -O`, `find -fprint0`, `tree -o`, `rg --pre`, PowerShell script blocks, `hostname new-name` and `date -s` now ask. Auto can only ever allow the island chat's own Antigravity CLI requests
- **Hooks keep arriving**: a relay that came and went too fast no longer stops Lumo from hearing the next ones
- **Calendar**: monthly events on "the 2nd Thursday" go on after December, and "every Monday of the month" shows every Monday
- **Fewer freezes**: a big dropped file is copied without stopping the island, the live activities' window opens without risking a deadlock, and two saves of the settings at once no longer mix. Reading and writing hooks, keys and saved images happens off the main thread, so the island no longer stutters on them
- **Pin stays**: a pin set with Ctrl+P is still there after a permission card
- **Smaller fixes**: quick clicks outside the island are seen in Energy Saver; local models are no longer cut off after 5 minutes; an emoji is never typed in two halves; the Monday recap still comes when the greeting is cut short, and never twice; Gemini Live never starts two calls; a failed drop keeps the file that was waiting; a stray `}` no longer cuts a formula short; "Tell the AI what's open" only sends the document when the question is about it
- **Settings**: integration keys and the calendar address have a Remove button, and Save with an empty field no longer erases them. Gemini CLI comes back in Agents only while hooks from an earlier version are still installed, to remove them. Proton Mail has no default server any more (its Bridge never connected)
- "Open in n8n" on an error card opens n8n, and shows only for n8n workflows

## Windows 0.6.4 — October 12, 2026

- **Permission requests wait in line**: a second request while a card is up no longer goes back to its terminal. Up to 4 wait behind the card, each with its sound and its pill in approval, and comes up once the one before is answered, dropped or timed out. The card says "1/N" and the project of the session asking, and a click or Y/N answers only the request on screen
- **Several sessions on one pill**: two VS Code projects no longer clobber each other. A Stop finishes the pill only when no other session is at work, and the card, steps and diffs stay with the sessions still there
- **Energy None asks everything more often**: the inbox every 5 seconds, GitHub every 10 (5 while a CI runs), the other services a sixth of their usual interval, the calendar every minute and the music every second. Light and On are unchanged
- **A lighter app**: about 2,500 lines of code nothing used are gone, among them Lumo on the desktop (switched off since 0.3.2), island views and shortcuts nothing could open, and a stray screenshot. The integrations and pull request watches reuse one connection instead of opening a new one each time. Nothing changes on screen

## Windows 0.6.3 — October 12, 2026

- **Listening starts however Claude writes the line**: the event is optional (it waits for the checks), other words for it are read, and backticks, code blocks, a sentence around it, spaces or a link to the pull request all work. A line Lumo cannot read or start is taken out and said under the answer
- **The chat shows what it listens for**: a chip with × to stop it. The lines kept from before a tool call are found anywhere in the text
- **GitHub's limit is never hit**: without signing in, the rounds space out with the number of watches
- **Steadier tests on Windows**: the network tests no longer fail by chance

## Windows 0.6.2 — October 12, 2026

- **Y and N answer a permission card**: once the island has the keyboard (a click on the card, or `Ctrl+Alt+A`), the letters shown on the buttons allow or deny. A letter typed right after another key is ignored, so a card that pops up while you type never takes a word's letter as an answer
- **A permission card says what it is for**: under the request, the agent's own explanation of it (Claude Code, Gemini CLI, Codex, Antigravity), else what the request does
- **Auto for Antigravity CLI in the chat**: a command that only looks runs without a card, unless Antigravity marked it unsafe; everything else still asks
- **Every chat control works while an answer is written**: attachments, past chats, new chat, the shield, the model, its effort and the usage menu; a change of model, effort or permission goes with the next message
- **An answer goes on in its own chat**: moving to another chat leaves the answer running in the background; it lands and is saved in its chat, and coming back shows it as far as it got. Another chat can ask meanwhile
- **The chat no longer sits on a command that waits for GitHub**: asked to merge and say when it is done, Claude is told to let Lumo listen instead of running a command that waits, and the line by the dots says what a command is for ("Running a command: Watch the PR's checks")
- **A dropped file joins the open chat**: a file dropped on the island, picked with the paperclip or pasted waits in the chat on screen and goes with the next question, whatever the provider, instead of starting a new chat
- **Shorter Settings descriptions**: the longest ones are rewritten to the point, in every language

## Windows 0.6.1 — October 11, 2026

- **Listening mode keeps its word**: when Claude wrote the line that starts listening before running a command (checking the CI, say) and then answered, the line was lost and Lumo never listened. Every line of the turn now counts, wherever it was written
- **Listening mode for Antigravity**: Antigravity in the chat can ask Lumo to keep an eye on a pull request too, as Claude Code does
- **A screenshot that went no longer stays behind**: after a message, a screenshot sent with it could stay listed in the attachments, and the next message failed with "Only a file dropped on the island can be sent with a question". What went is now taken out, files too
- **The upload ends on the full bar**: Lumo stays on the full bar while the check pops and the chat takes over, instead of sliding onto an empty card first

## Windows 0.6.0 — October 11, 2026

- **Windows only**: Lumo no longer ships for Linux. Its build, packages and release, and the Linux-only code behind them, are gone; every release from now on is for Windows
- **Drop a file on any island size**: on an island smaller than the drop scene, the scene shrinks inside a card that reaches the island's edges, so the frame and the upload bar stay whole
- **Straight into the chat**: once the bar is full the file waits in the chat, which says "File uploaded" for a moment, with no "what do you want to do with it?" card in between
- **The upload goes on with the island closed**: its bar carries on as a live activity, and the closed island says when the file is in
- **Listening mode for GitHub**: Claude in the chat can ask Lumo to keep an eye on a pull request (its checks, green CI, an approval, ready, merged or closed) instead of waiting itself. The closed island says what Lumo is waiting for; when it happens a note and a sound tell you, and with a task the chat that asked lets Claude carry on (merging still asks for your click). The watch survives a restart and asks GitHub only while it is on
- **No time limit on Claude Code turns**: a turn in the chat is no longer stopped after 15 minutes; it runs until it ends or you press Stop

## Windows 0.5.8 — October 11, 2026

- **One attachment, one row**: two `Ctrl+Alt+P` of the same screen, two windows, two tabs or two selected texts no longer share one chip: each waits on its own, and its × takes back that one only (a screenshot's file with it)
- **The attachments, made anew**: the folder beside the past chats lists everything in rows of one width, lined up whatever the length of their names: the picture (a screenshot, an attached picture) or the kind's icon, the name, what it is under it ("Screenshot", "Window · Code", "Web page · github.com", "File · PDF · 2.0 KB") and a ×. How many sits by the title, **Remove all** shows when there are several, and with nothing attached it says what the folder is for. A click on a row shows what it sends; Close or Remove brings the list back
- **A file that already went is no longer listed**: sent with a question, it stops waiting in the attachments and in the folder's number
- **The big picture fills the island**: a click on a picture in a preview shows it over the whole open island, its top bar too, and Lumo steps out of its way until a click or `Esc`
- **The upload bar in the middle**: the bar of a dropped file runs as far from the card's right side as from its left

## Windows 0.5.7 — October 11, 2026

- **Several of a kind**: each `Ctrl+Alt+P` adds its screenshot to the ones waiting (Screen 1, Screen 1 (2)…), each shared selection joins the others, and a file added while another waits goes with it in the same question
- **Service cards like the tools'**: GitHub, Email, Stripe, Notion, Cal.com and Resend show their name and kind, whether they are connected, their rows like VS Code's facts, and Open… and Refresh at the bottom
- **The drop**: Lumo waits under the dragged file, mouth up, instead of on top of it
- **The big preview** of a picture leaves Lumo's column free

## Windows 0.5.6 — October 11, 2026

- **A PDF open in the browser goes as the PDF**: `Ctrl+Alt+B` on a tab that shows a file (a PDF opened from the disk or the web, a .docx…) attaches the file itself instead of the text its viewer shows. Any other page still goes as its text and address
- **Attachments in a folder**: a folder beside the past chats holds everything attached to the next question (files, screenshots, windows, tabs, the selection, the folder), with a number on it for how many. The chat keeps its whole height, and its text is a size bigger
- **Deleting the chat on screen closes it**: an empty chat takes its place
- **GitHub keeps up on the closed island**: "CI running" comes and goes whichever pill is in front, without opening the GitHub card (pull requests are checked every minute, every 30 seconds while a CI runs)
- **Gentler scrolling in the chat**: a notch of the mouse wheel moves a few lines, gliding, instead of most of the chat
- **The drop follows the file**: on a resized island the drop card fills it and Lumo chases the file across it, up and down too. Dragging a picture from the chat's preview no longer opens the drop, and a drop with nothing readable no longer leaves the next one stuck
- **Big previews**: a picture alone fills the preview, and a click on any preview picture shows it over the whole chat (a click or Esc closes it)
- **Settings read more easily**: each setting's name sits on one line with its switch or list, what it does underneath, the whole width

## Windows 0.5.5 — October 11, 2026

- **Energy saving** (Settings → General): **None** asks the inbox, GitHub, the calendar, the services, the plan usage and the music more often, near real time; **Light** is Lumo as always; **On** saves energy: the closed island draws 15 frames a second, Lumo dozes with the mouse far away (eyes shut, grey, still) and stops moving with the mouse at rest, the cursor far from the island is read 10 times a second instead of 60, and everything is asked half as often. A permission or a question waiting keeps him awake. **Automatic**, the default, saves energy on battery and, plugged in, does what **On mains power** says (Light or None)
- **A green leaf** at the closed island's right end while it saves energy
- **Hide the island into its edge**: a – beside the power button slips it into the edge of the screen, as Hide when unused does; the power button still quits Lumo
- **The hidden island comes back again**: with Hide when unused, the island often stayed hidden when the mouse went back to the edge. The piece of edge that brings it back is now as long as the closed island, and right where it was, if you moved it
- **The tray icon**: a left click hides the island or brings it back (Windows); the right click opens the menu, where Pause reads Resume while Lumo is paused

## Windows 0.5.4 — October 11, 2026

- **The chat lets you scroll up while an answer is written**: scrolled up to read, it stays where you are until you scroll back to the end, then follows the answer again; the finished answer replaces the streamed one where you were reading. A new question goes back to the end
- **Every agent at work shows on the closed island**: VS Code, Cursor, Codex and Antigravity sessions now say what they are doing there ("VS Code · Editing app.ts", "Waiting for your OK"), as the other agents did, and count for the Agents tab's badge; two at work show side by side
- **GitHub on the closed island**: "GitHub · CI running on lumo#12" while the CI of a pull request of yours or of a default branch runs (after a push or a merge), then a note when it passes or fails, and when a review is asked of you
- **Attaching the screen never sends**: the screenshot preview's button is now Attach, and the message goes only when you press Enter, with the text you added
- **Hide promotional emails** (Settings → Pills & integrations → Email, off by default): on Gmail the emails in its Promotions tab, with other providers the ones with an unsubscribe link (newsletters, offers), stay off the card and the closed island
- **The usage ring sits right before the model button** in the chat
- **Settings inside the island**: the list of sections fits without a scrollbar of its own, and "Right-click menu" in General reads like the other settings (Weekly recap…)

## Windows 0.5.3 — October 11, 2026

- **Browser tabs show up in the chat's screen menu on Windows**: Edge and Chrome lock their list of open tabs while they run, so Browser tabs never appeared. The tabs now come from the browsers' windows themselves (each window's tab strip, through UI Automation): the tab on screen is read like a window, with your login, and a tab in the background is brought forward for a moment, read, and the tab you were on put back (six at most for one message). A slow browser no longer holds the menu: its entry joins when it answers
- **Ask about the page in the browser** (`Ctrl+Alt+B`): the page on screen in the front-most Edge or Chrome window waits in the chat with its text and address, like the selected text
- **See what goes before it goes**: a click on a chip above the chat field shows the screenshots and attached pictures big, the text read from a window or a tab and how it was read, the selected text, the folder's listing, a file's name and path; Close keeps it, Remove takes it back
- **Search in Settings**: a field above the list of sections shows the matching settings, shortcuts and pills of every section at once, whatever the case, the accents or singular and plural
- **Readable group headings in Settings** ("Right-click menu"…), near the names' white instead of the hints' grey

## Windows 0.5.2 — October 11, 2026

- **Claude can use your computer** (Settings → Chat → Computer use → Let Claude use the computer, off by default, Windows): Claude Code in the chat sees the screen and clicks, types, presses keys, scrolls and drags, through Lumo's own MCP server (`lumo-hook --mcp`, passed to the chat's runs only; your Claude Code settings are untouched), on your Claude plan. Asking every time, each action is an Allow / Deny card that says what it does ("Click · 640, 320", "Type · …"); screenshots don't ask. Esc anywhere stops it. Screenshots leave Lumo out, are sized for every model, and Claude's coordinates are turned back into your screen's, whatever its scaling
- **You can watch it work**: the screen it uses glows around its edges (on whichever display it is), the mouse becomes Claude's own orange arrow and glides from point to point, and each action is drawn where it happens: rings for clicks, a trail for drags, chevrons for scrolling, a bubble with the text typed or the keys pressed. While Claude answers the mouse is its own: your hand gets it back for a card, with Esc, or at the end
- **Gemini Live hands screen work to Claude Code**: "click Send", "open the display settings and turn on night light" go to Claude Code on Haiku 5.5 at medium effort, whoever helps Gemini otherwise, when Claude Code is set up for Lumo and computer use is on
- **Share windows and browser tabs with what they show**: the chat's screen button opens a second list for Open windows and for the new Browser tabs (Edge, Chrome): one or all of them. A window goes with its text (read as screen readers do) and the document it has open, a single one also with a picture of it; a tab with its page's text. The folder open in File Explorer is offered only when there is one
- **Settings from the right-click menu open inside the island**, as the gear does (the Live Activities' one too); "Open the chat" is no longer a right-click item, and the small group headings in Settings are readable
- **A pill's name never runs under Lumo** on a narrow island

## Windows 0.5.1 — October 10, 2026

- **The Claude plan's 5 hours no longer vanish**: Claude Code's status line leaves the 5-hour window out while it is far from its limit, and each of its updates used to drop the figure a chat answer had brought. The window it leaves out is now kept, and when none was ever reported the 5 hours read "plenty left — Claude Code reports it only near the limit", in the chat's usage menu and on the plan card
- **The effort slider is one short row**: a track that fills up to a white knob, a mark per level, the level it is on beside it and Auto at the end (no "Effort" label above). Dragged, the knob snaps to a level as soon as the pointer is past half way to it, and glides there; the arrow keys, Home and End move it too
- **The live activities keep their size off the island**: their own window is drawn at the island's zoom, so they no longer shrink when taken off it. Their title is "Live Activities" in every view (in Italian too)
- **Settings → Island → Distance from the edge**: none, light (as before, the default), medium — just enough room for the mouse to cross the top of the screen above the island without opening it — or wide. A change slides the island to its new place
- **Settings → General → Sound shows the volume as a percentage**
- **A bulb in Gemini Live**, left of the send button: lit, Gemini 3.8 Live Extended Thinking; off, Gemini 3.8 Live. It shows and sets the model, saved for the next calls; during a call it moves to the other model on a new connection (Gemini starts afresh, the transcript stays)
- Settings → Agents no longer lists Gemini CLI
- **Settings read clearly**: every setting is one line with its name, and under it in smaller grey what it does, on the left and its switch, list or buttons on the right, divided from the next by a thin line; long sections (Island) are grouped under small headings, and the tips about dragging and resizing the island sit together in a note at the end. Keys and addresses take the whole width under their name. Inside the island the list of sections stays on the left, as in the window
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
- **A right-click menu of Lumo's own**, instead of the webview's: on the island and its Live Activities, **Refresh** (also Ctrl+R or F5) asks everything again at once — the calendar, the emails and the other services, the plan usage, the agents' hooks and sessions, the weekly recap — and Cut, Copy, Paste and Select all are there in a text field. Settings → General → Right-click menu picks what else it offers: New chat, Open the chat, Timer: 5 minutes, Keep the island open, Sounds, Live Activities, Put the island back in the middle, Wardrobe, Settings, Quit Lumo. The Settings window has the text actions only
- **The Live Activities follow the island's height** (Settings → Island, on by default): as tall as the open island, they grow and shrink with it when you resize it; turned off, they keep the height you give them
- **A pasted or dropped file has its ×** in the chat, to take it out before sending
- **The physics package's notation reads as math** in answers: `\dd`, `\dv`, `\pdv`, `\abs`, `\norm`, `\vb`, `\vu`, bra-kets, `\grad`, `\qty` and `\order` no longer show as their names ("dd"). The chat also tells the AI to write standard LaTeX, never a macro from your own files
- **Past sessions in the Code section**: "All sessions" on a tool's card lists its recent sessions — project, when, how long, files, lines and commands — and a click reopens the project's folder in its editor or terminal
- **Search the past chats**: a field at the top of the past chats finds words in questions and answers alike (accents and case aside), with the matching words highlighted; Enter opens the first, Escape clears the search
- **The island lands where you drop it**: moved while open, it no longer shifts by the live activities' room when let go, and settles with a softer spring
- The README shows the live activities, the closed island and a new email, lists 0.5.0's features and the Email and Calendar setup

## Windows 0.5.0 — October 9, 2026

- **Gemini Live types in the text box you clicked in**, in any app, when you ask it to write something there. It never presses Enter or sends: line breaks are Shift+Enter, or spaces in a terminal. Nothing is typed into Lumo itself or while a key like Ctrl is held
- **Gemini Live asks its helper before saying it can't**: "add this to my calendar", "check my agenda", "draft an email" go to Claude Code (or Antigravity CLI) with the apps and accounts you connected to it, instead of Gemini answering that it can't
- **Settings → Voice picks the helper's model**, and for Claude Code its effort, as the chat's picker does
- **The model picker's Effort block takes half the height**: Faster and Smarter sit beside a thinner slider, so a small island leaves the model list its room
- **Auto replaces Accept edits** in the chat's permissions (the shield): the AI decides what is safe to do without asking and asks for the rest (Claude Code's auto mode; Antigravity CLI's own judgement). Accept edits, if you had picked it, becomes Auto
- **Antigravity CLI no longer claims a permission was refused when it wasn't**: an empty answer now says what agy itself reported, and the permission mode no longer goes to agy as `--mode accept-edits`, which left it without an answer
- **The closed island says what is going on**, like a Dynamic Island: what the AI is doing ("Haiku · Reading main.ts", "Gemini Live · Looking at the screen", "Claude Code · Waiting for your OK"), and for a few seconds what just happened ("Haiku answered", a session that finished, a deploy). Nothing while nothing is going on. Settings → Island → Say what's going on turns it off
- **The Email pill**: new emails in your inbox (Gmail, Outlook, iCloud, Yahoo or any IMAP server, with an app password) show on the closed island with the sender, the subject and the first lines, and **Summarize**, **Draft a reply** and **Open**. Lumo only reads the inbox: emails stay unread, and nothing is ever sent, moved or deleted. The server says when one arrives (IMAP IDLE), so it shows within seconds. A refused sign-in says what to do (Gmail wants an app password, not the account's), and a long error no longer runs off the card
- **Live activities beside the open island**: a second island with the timers (one click for 1, 5, 10 or 25 minutes, or type `15m pasta`), the music playing with its buttons, the calendar's next events and the newest emails with Summarize and Draft a reply. Its "–" folds it into an icon right of the "+" in the top bar, and that icon brings it back. The calendar is read from its secret iCal address (Settings → Island → Calendar), and an event about to start shows on the closed island ("Stand-up · in 5 min")
- **Italiano**: the island, the settings and the tray in Italian (Settings → General → Language, or System on an Italian Windows)
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
- **Timers and the music on the closed island**: ask Gemini Live for a timer, or type `/timer 10m pasta` in the chat, and it counts down next to Lumo and rings at the end. The music playing (the system's media controls) shows with previous, play/pause and next, and Gemini Live can play, pause and skip. Settings → Island → Show the music playing turns it off
- **The Claude plan's 5-hour limit shows again**: while it is low Claude Code leaves its figure out, and the line now says "plenty left" instead of showing the week alone
- **A sharing shortcut's island waits for your question**: after Ctrl+Alt+X (or Ctrl+Alt+P) it no longer folds as soon as the mouse is elsewhere; it stays a few seconds, longer while you type, and a click outside closes it at once
- **"Claude Code answered" no longer looks busy**: the line under a call says it without the moving dots, and goes after a few seconds
- **Lumo's own names everywhere**: settings in `%APPDATA%\com.rccrd12.lumo`, the relay, the inbox, the log (`lumo.log`), the recap and the chat history in `%LOCALAPPDATA%\com.rccrd12.lumo`, the keys under `com.rccrd12.lumo` in the keychain, Claude Code's folder `~/Lumo`. Everything moves there by itself at the first launch. Hooks installed before keep working; Settings → Agents → Reinstall points them at the new folder. The variable is `LUMO_ANTHROPIC_BASE_URL`. From 0.3.1 or earlier, uninstall the old app before installing this one

## Windows 0.4.0 — October 9, 2026

- **Talk with Gemini Live**: the microphone button in the chat box, or `Ctrl+Alt+L` from any app, starts a spoken call with Gemini 3.8 Live or Gemini 3.8 Live Extended Thinking, with your Google AI key. You can speak over it, type to it or turn the microphone off; what is said is written in the island as you go, and kept in the past chats. Gemini looks at the screen by itself when it needs to (Windows; Settings → Voice can turn that off), sees the open windows and the folder open in File Explorer, finds files by name, reads text files, images, folders, PDFs and Office documents, opens documents, folders and web pages, starts apps by name, and hands anything else to Claude Code or Antigravity CLI, whose actions come up as Allow / Deny cards over the call. The call goes on when the island closes, moves to a new connection when Google asks without you hearing it, and ends on its own after 5 minutes of silence. The key never leaves the keychain: each connection opens with a short-lived token
- **Settings → Voice**: the Google AI key, the model, Extended Thinking's level, the voice (30 of Google's), whether Gemini may look at the screen, and the helper
- **Every look moves with what is going on**: Filo, Punto, Goccia and Lucciola breathe at rest; blue, they pulse and bob while an agent works; orange, their light beats twice and sends out a ripple when something waits for you, and they look up at you; red, they shake once, flash and look down with × eyes on an error; green, they hop, land with a squash and smile ^^ when it is done, then smile again now and then. Each state eases into the next instead of jumping. Goccia's pool of light stays on the floor and shrinks as it hops. Lucciola's antenna lights twinkle in turn at rest, twinkle quickly while an agent works, perk up with the heartbeat when it waits, droop and dim on an error and sparkle when it is done, and its tail beats and sends out a ripple while it waits. It all stops when the island hides
- **Lumo moves with the chat too**: blue and busy while it writes its answer, a green hop when the answer comes, a red shake if it fails. Before, he stayed still while the chat wrote
- **The wardrobe is in two parts**, side by side, each with its title: **Outfits** (auto, none, the leaf, the round glasses, the bow tie, the headphones and the scarf) and **Lumo's style** (Filo, Punto, Goccia or Lucciola, the same choice as Settings → Island → Lumo's look). Rest the pointer on a button to try it on, click to keep it, as before

## Windows 0.3.2 — October 9, 2026

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

## Windows 0.3.1 — October 8, 2026

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

## Windows 0.3.0 — October 8, 2026

- **Chat with your Claude plan**: a Claude Code choice in the model picker runs your own `claude` CLI, signed in with your subscription, with no API key. It reads the files you drop or attach, can edit files and run commands, and every permission is an Allow/Deny card in the island. Pick its effort level under the models
- **The chat is the home screen**: the island opens on the chat, with three quick starts in a new one. Claude Code and the other agents have their own Agents tab, with a blue dot while a session works and an orange one when it waits for you. The island takes the keyboard only after a click or a shortcut
- **Ask from anywhere**: `Ctrl+Alt+P` opens the chat with a screenshot of the screen under the mouse, `Ctrl+Alt+X` with the text selected in the app in front (a PDF, a web page). Each waits as a chip until you type the question and press Enter; the clipboard is put back as it was
- **Chats**: start a new chat, reopen or delete past ones, attach a file with the paperclip
- **Your screen, when you ask**: a screen button in the chat sends the list of open windows or a screenshot of one or every display, after a preview you confirm. Nothing is captured before you click (Windows)
- **The island** is bigger by default (115 %, 80–160 % in Settings or Ctrl +/−/0) with bigger icons (125 %, 100–150 %). Drag it by its top bar and let go near any edge of the screen: it docks there, upright on the sides, centred near the middle, with a bounce. Resize it from any free edge or corner; a double click puts the usual size back. A power button quits the app
- **Settings** are split into sections, with an Updates section that checks GitHub for a newer Windows release and runs its installer, only when you click
- The chat's answers no longer show up as a finished VS Code session

## Windows 0.2.0 — October 8, 2026

The Windows app catches up with the Mac, from 0.1.1 to 0.2.1 — everything except Apple Music and the iPhone, which depend on macOS and iCloud.

- **Agents**: Codex, GitHub Copilot CLI and Muse Code sessions with Allow / Deny in the island; Gemini CLI, Antigravity, Cursor Agent, OpenCode, Amp and Hermes sessions on their own pills; Claude Code sessions from the Claude app on Windows. Install them all from Settings → Agents, which shows the diff and takes a dated backup before writing — one hardened writer for every agent's config (#278 by @Totopo27, #298 by @kobaltgit, #231 by @BeyondBirthday07)
- **Questions**: answer Claude Code's multiple-choice questions from the island; answers are checked against the questions asked, and a question answered in the terminal takes the card down (#216 by @PythonTilk)
- **The permission card** comes up for every agent, brings its pill forward, can be folded without answering, and never decides on its own
- **Chat**: Anthropic, Google AI, OpenAI and OpenRouter, switchable by clicking the model name; local models through Ollama, LM Studio or any OpenAI-compatible server, streamed, thinking hidden; Markdown answers with a copy button; full answers; your first name in the greeting; `LUMO_ANTHROPIC_BASE_URL` for a gateway, https only (#161 by @4rchila, #166 by @AlphaIsYour, #173 by @AinzDerErste, #206 by @Totopo27)
- **Plan usage**: Claude's 5-hour and weekly limits and Codex's, in the island header (#171 by @AinzDerErste)
- **Live diff**: each file Claude edits shows in the ticker with its +N −M, and a click opens the diff; the finished card shows Claude's final message
- **GitHub**: your pull requests with their CI, reviews waiting for you, the CI of your default branches, alerts when CI turns red or green, and your contribution grid
- **Mochi**: the wardrobe and seasonal outfits, the new greeting and its sound, and Mochi on the desktop
- **Keyboard shortcuts** from anywhere, changeable in Settings → Shortcuts; the defaults never type an AltGr character on French, German, Spanish, Italian or Portuguese keyboards
- **Weekly recap** on Monday mornings, shareable as an image; history stays on your computer
- **Pills**: declare the tools you use and pick your main one; hook-based pills no longer ask for a key; "Open terminal" brings the session's own window forward on Windows
- **10 languages**: English, 中文, हिन्दी, Español, العربية, Français, বাংলা, Português (Brasil), Русский, Bahasa Indonesia — Settings → General → Language (#228; picker from #226 by @alexisrja)
- **File drop** works from every Explorer view, and Cancel works (#240 by @KauaDc, #126); only files a real drop delivered can be read
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
