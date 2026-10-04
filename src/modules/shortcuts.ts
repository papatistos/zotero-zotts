import { getPref } from "./utils/prefs";

export function registerShortcuts() {
    ztoolkit.Keyboard.register((ev, data) => {
        if (data.type === "keyup") {
            const acceleratorHeld = Zotero.isMac ? ev.metaKey : ev.ctrlKey
            if (acceleratorHeld &&
                ev.key.toLowerCase() === (getPref("shortcuts.speak") as string).toLowerCase()) {
                addon.hooks.onSpeakOrResume(ev.shiftKey)
            }

            if (acceleratorHeld && ev.shiftKey &&
                ev.key.toLowerCase() === (getPref("shortcuts.pause") as string).toLowerCase()) {
                addon.hooks.onPause()
            }

            if (acceleratorHeld && ev.shiftKey &&
                ev.key.toLowerCase() === (getPref("shortcuts.cancel") as string).toLowerCase()) {
                addon.hooks.onStop()
            }

            if (acceleratorHeld && ev.shiftKey &&
                ev.key.toLowerCase() === (getPref("shortcuts.cycleFavourite") as string).toLowerCase()) {
                addon.hooks.onCycleFavourite()
            }

            if (acceleratorHeld && ev.shiftKey &&
                ev.key.toLowerCase() === (getPref("shortcuts.speedUp") as string).toLowerCase()) {
                addon.hooks.onSpeedChange(true)
            }

            if (acceleratorHeld && ev.shiftKey &&
                ev.key.toLowerCase() === (getPref("shortcuts.speedDown") as string).toLowerCase()) {
                addon.hooks.onSpeedChange(false)
            }

        }
    })
}