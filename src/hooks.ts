import { config } from "../package.json"
import { setDefaultPrefs } from "./modules/utils/prefs"
import { registerMenu } from "./modules/menu"
import { prefsLoadHook, prefsRefreshHook, registerPrefsWindow } from "./modules/prefsWindow"
import { registerShortcuts } from "./modules/shortcuts"
import { registerReaderListeners } from "./modules/reader"
import { cycleFavourites } from "./modules/favourites";
import { initLocale } from "./modules/utils/locale"
import { initEngines, checkStatus } from "./modules/tts"
import { speak, stop, pause, resume, speakOrResume, speakTest, speedChange, skipBackward, skipForward, replaySection } from "./modules/tts/ttsHooks";
import { loadIcons } from "./modules/utils/icons";
import { notifyStatus } from "./modules/utils/notify";

const windowCleanups = new Map<Window, () => void>()
let globalControlsRegistered = false

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ])

  setDefaultPrefs()

  await initEngines(addon)

  initLocale()

  await loadIcons()

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  )
}

async function onMainWindowLoad(win: Window): Promise<void> {
  await new Promise((resolve) => {
    if (win.document.readyState !== "complete") {
      const listener = () => {
        if (win.document.readyState === "complete") {
          win.document.removeEventListener("readystatechange", listener)
          resolve(void 0)
        }
      }
      win.document.addEventListener("readystatechange", listener)
    } else {
      resolve(void 0)
    }
  })

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ])

  if (windowCleanups.has(win)) { return }
  windowCleanups.set(win, registerMenu(win))

  // The toolkit keyboard manager already listens across main windows and readers.
  if (!globalControlsRegistered) {
    if (ztoolkit.FieldHooks) {
      ztoolkit.FieldHooks.basicOptions.log.disableConsole = true
    }
    registerPrefsWindow()
    registerShortcuts()
    registerReaderListeners()
    globalControlsRegistered = true
  }

  notifyStatus()  // report ready or error status as soon as possible
}

async function onMainWindowUnload(win: Window): Promise<void> {
  windowCleanups.get(win)?.()
  windowCleanups.delete(win)

  // TODO: l10n - implement locale removal
  // win.document
  //     .querySelector(`[href="${config.addonRef}-mainWindow.ftl"]`)
  //     ?.remove()
}

function onShutdown(): void {
  for (const cleanup of windowCleanups.values()) { cleanup() }
  windowCleanups.clear()
  Zotero.Reader._unregisterEventListenerByPluginID(config.addonID)
  ztoolkit.unregisterAll()
  globalControlsRegistered = false

  // Clean up TTS engines
  for (const engineName in addon.data.tts.engines) {
    const engine = addon.data.tts.engines[engineName]
    if (engine?.extras?.dispose) {
      try {
        engine.extras.dispose()
      } catch (error) {
        ztoolkit.log(`Error disposing ${engineName} engine: ${error}`)
      }
    }
  }

  // Remove addon object
  addon.data.alive = false
  // @ts-ignore - Plugin instance is not typed
  delete Zotero[config.addonInstance]
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise, the code would be hard to read and maintain.
let onSpeak = speak

const onStop = stop

const onPause = pause

const onResume = resume

const onSpeakOrResume = speakOrResume

const onSpeakTest = speakTest

const onSpeedChange = speedChange

const onSkipBackward = skipBackward

const onSkipForward = skipForward

const onReplaySection = replaySection

const onCycleFavourite = cycleFavourites

const onPrefsLoad = prefsLoadHook

const onPrefsRefresh = prefsRefreshHook

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onSpeak,
  onStop,
  onPause,
  onResume,
  onSpeakOrResume,
  onSpeakTest,
  onSpeedChange,
  onSkipBackward,
  onSkipForward,
  onReplaySection,
  onCycleFavourite,
  onPrefsLoad,
  onPrefsRefresh
}