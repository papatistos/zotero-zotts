# ![](addon/chrome/content/icons/favicon@48.svg) ZoTTS
ZoTTS is a Zotero plugin to add TTS functionality

[![Zotero 7–10](https://img.shields.io/badge/Zotero-7%E2%80%9310-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

> [!NOTE]
> This is a fork of [the original repository](https://github.com/ImperialSquid/zotero-zotts/) (via https://github.com/KanaHayama/zotero-zotts). 
>
> This version adds
> - support for OpenAI's TTS engine,
> - support for a local TTS engine via an OpenAI-compatible API,
> - a dedicated Kokoro TTS engine for kokoro-web / [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) with dynamic language, model and voice loading,
> - buttons to skip 10s forward or backwards and to replay the current selection, 
> - a cache for the current text selection (to avoid unnecessary API calls for such skipping or replaying),
> - an option to ignore certain text parts (e.g. page numbers in headers/footers) by marking them with annotations of a specific color (default: grey),
> - a short queued-speech cue for delayed Kokoro synthesis requests.

## Install :rocket:

This fork does not provide releases. To install it, obtain or build an `.xpi` file.

1. Save the `.xpi` file on your computer.
2. In Zotero, go to `Tools > Plugins`
3. Click the gear icon in the top right
4. Select `Install Add-on From File...`
5. Browse to the downloaded .xpi file and select it

Install newer `.xpi` files manually using the same steps.

> [!TIP]
> If you want some information about finding more voices for ZoTTS, please see [this documentation](docs/BETTER_VOICES.md).

> [!NOTE]
> ZoTTS might fail to init the TTS engine for Linux users who use Zotero in sandboxed environments (flatpak/snap/etc) due to a long-standing non-trivial bug, a workaround might be possible but you might find it easier to use a non-sandboxed Zotero if you can, feel free to open a bug report for further assistance

## Features :sparkles:
### Shortcuts
- `Ctrl/Cmd + S` will begin **s**peaking (extra functionality is available with `Ctrl/Cmd + Shift + S`, discussed below)
- `Ctrl/Cmd + Shift + P` will **p**ause
- `Ctrl/Cmd + Shift + C` will **c**ancel
- `Ctrl/Cmd + Shift + Q` will cycle to the next favourite, if set

In the Library tab, by default `Ctrl/Cmd + S` will speak a paper's title, `Ctrl/Cmd + Shift + S` will speak its abstract.

In Reader tabs:
- If there's any text selected, `Ctrl/Cmd + S` will speak it, `Ctrl/Cmd + Shift + S` will speak from that selection to the end
- If there's no text selected, but there are annotations selected, `Ctrl/Cmd + S` will speak their annotated text, `Ctrl/Cmd + Shift + S` will speak their comments (if any)
- If there's no text and no annotations selected, `Ctrl/Cmd (+ Shift) + S` will default to reading the full text of the paper

You can swap the behaviour of `Ctrl/Cmd + S` and `Ctrl/Cmd + Shift + S` in the preferences.

### UI Elements
In the Library tab, right clicking an item will bring up a context menu, you can tell ZoTTS to speak the title or abstract from here.

![](docs/resources/right-click-buttons.png)

In Reader tabs there's also buttons for playing/pausing/cancelling in the top right, as well as skipping forward/backward and replaying the last segment. Skip/replay currently work with the OpenAI, Local and Kokoro engines. These will act the same as using the speak/pause/cancel shortcuts in terms of speaking selected text/annotations/full text.

(Note that doing this ignores whatever Shift Modifier settings you have, and whether you're holding shift when the button is clicked).

![](docs/resources/play-pause-cancel-buttons.png)

On each annotation there are also buttons to speak the annotated text, and the comment if one exists.

![](docs/resources/anno-comm-buttons.png)

### Preferences
The settings sections are collapsible and start expanded. Favourites is the first section, followed by Substitutions & omissions.

- Favourites save speech presets with an engine, voice and related settings. Cloud API keys are not saved in favourites. You can create presets for different languages and cycle between presets with `Ctrl/Cmd + Shift + Q`.
- Substitutions & omissions lets you replace text before speaking it, using plain text or regular expressions. Its "Per document ommissions" subsection lets you omit text marked with annotations of a chosen colour, such as page numbers in headers or footers.
- Queueing settings let you choose whether a new speech request joins the queue or cancels the current speech.
- Voice settings let you choose System Voices, Azure TTS, OpenAI TTS, the Local OpenAI-compatible engine or the dedicated Kokoro engine. System Voices uses your computer's installed voices without requiring a cloud TTS service. Rate, pitch and volume controls are available where the engine supports them.
- The Local engine has a model field. The Kokoro engine can auto-detect the API base URL and load available languages, models and voices from the server.
- Shortcut settings let you rebind the speak, pause and cancel shortcuts and swap the behaviour of `Ctrl/Cmd + S` and `Ctrl/Cmd + Shift + S`.

If a settings search matches a control inside a collapsed section, expand the section to see the control.

When using the Kokoro engine, ZoTTS also plays a short cue as soon as a request is sent so you get immediate feedback while the audio is being synthesized.

## Contributing :wrench:

I made the changes to the plugin mainly for myself but am happy to share them with anyone who wants to use them. If you make further changes that you’d like to share, feel free to submit a PR. 
