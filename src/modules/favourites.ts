import { getPref, setPref } from "./utils/prefs";
import { notifyGeneric } from "./utils/notify";
import { getString } from "./utils/locale";

function cycleFavourites() {
    let faves: { [key: string]: string | number | boolean }[]
        = JSON.parse(getPref("favouritesList") as string)

    if (faves.length === 0) {
        // no faves set, so return out
        notifyGeneric([getString("popup-faveLoaded-noneSet")], "error")
        return
    }

    const currSettings = constructFav()
    // if current settings aren't in favourites, findIndex returns a -1, turned into a 0,
    // so we default to the first favourite always
    const index = faves.findIndex((f) => compareFav(f, currSettings))
    const newSettings = faves[(index + 1) % faves.length]

    // Dispose of current engine if switching to a different one
    const previousEngine = getPref("ttsEngine.current") as string;
    const newEngine = newSettings["engine"] as string;
    
    if (previousEngine !== newEngine) {
        const prevEngineData = addon.data.tts.engines[previousEngine];
        if (prevEngineData?.extras?.dispose) {
            try {
                prevEngineData.extras.dispose();
            } catch (error) {
                ztoolkit.log(`Error disposing ${previousEngine} engine: ${error}`);
            }
        }
    }

    // set new engine, then cycle through the rest of the keys an set values
    setPref("ttsEngine.current", newEngine)
    addon.data.tts.current = newEngine;
    Object.keys(newSettings).forEach((key) => {
        if (key === "engine") {
            return
        }
        setPref(`${newSettings["engine"]}.${key}`, newSettings[key])
    })

    notifyGeneric([
        getString("popup-faveLoaded-title", {args: newSettings}),
        getString("popup-faveLoaded-body", {args: newSettings}),
    ], "info")
}

function addFavourite() {
    let faves: { [key: string]: string | number | boolean }[]
        = JSON.parse(getPref("favouritesList") as string)

    const favToAdd = constructFav()

    if (! faves.some(f => { return compareFav(f, favToAdd) })) {
        faves.push(favToAdd)
        setPref("favouritesList", JSON.stringify(faves))
    }
}

function removeFavourite(
    favToRemove: { [key: string]: string | number | boolean }
) {
    let faves: { [key: string]: string | number | boolean }[]
        = JSON.parse(getPref("favouritesList") as string)

    faves = faves.filter(f => {
        return ! compareFav(f, favToRemove)
    })

    setPref("favouritesList", JSON.stringify(faves))
}

function constructFav() {
    let newFav: { [key: string]: string | number | boolean } = {}

    newFav["engine"] = (getPref("ttsEngine.current") as string)

    // Store voice settings, not cloud credentials.
    const settings: Record<string, string[]> = {
        webSpeech: ["voice", "pitch", "rate", "volume"],
        azure: ["voice", "language", "rate", "volume", "minSegmentSize"],
        openai: ["voice", "model", "rate", "volume"],
        local: ["apiUrl", "voice", "model", "rate", "volume"],
        kokoro: ["apiUrl", "voice", "model", "language", "rate", "volume"],
    }
    for (const key of settings[newFav["engine"] as string] ?? []) {
        const value = getPref(`${newFav["engine"]}.${key}`)
        if (value !== undefined) { newFav[key] = value }
    }

    return newFav
}

function compareFav(
    arg1: {[key: string]: string | number | boolean},
    arg2: {[key: string]: string | number | boolean}
): boolean {
    if (Object.keys(arg1).length !== Object.keys(arg2).length) {
        return false
    }

    const keys = Object.keys(arg1).concat(Object.keys(arg2))
    return keys.every((key: string) => arg1[key] === arg2[key])
}

export {
    cycleFavourites,
    addFavourite,
    removeFavourite
}