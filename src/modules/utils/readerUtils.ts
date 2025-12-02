import ReaderInstance = _ZoteroTypes.ReaderInstance;
import { notifyGeneric } from "./notify";
import { getString } from "./locale";
import { getPref } from "./prefs";

function removeIgnoredText(text: string, reader: ReaderInstance): string {
    // Remove text marked by annotations with the configured ignore color
    const ignoreColor = getPref("ignoreAnnotations.color") as string
    const ignoreAnnotations = getAllAnnotations(reader).filter(anno => 
        anno.color === ignoreColor
    )
    
    for (const anno of ignoreAnnotations) {
        if (anno.text) {
            // Convert annotation text to a pattern where digit sequences become \d+
            // This allows "136 Asle H. Kiran" to match "137 Asle H. Kiran", etc.
            const pattern = anno.text
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars
                .replace(/\d+/g, '\\d+')                  // Replace digit sequences with \d+
            
            const regex = new RegExp(pattern, 'g')
            text = text.replaceAll(regex, "")
        }
    }
    
    return text
}

export function getSelectedText(reader: ReaderInstance) {
    let text = ztoolkit.Reader.getSelectedText(reader)
    return removeIgnoredText(text, reader)
}

export async function getSelectedTextToEnd(reader: ReaderInstance) {
    const selected = getSelectedText(reader)

    if (selected === "") {
        // cannot "read from here" without a here to read from
        notifyGeneric(
          [getString("popup-SFH-noSelection")],
          "info"
        )

        return ""
    }

    const full = await getFullText(reader)

    const parts = full.split(selected)

    if (parts.length < 2) {
        // "read from here" failed to find the selected text
        notifyGeneric(
          [
              getString("popup-SFH-unknownSelection1"),
              getString("popup-SFH-unknownSelection2")
          ],
          "info"
        )

        return ""
    }
    if (parts.length > 2) {
        // cannot "read from here" without a more specific start point
        notifyGeneric(
          [
              getString("popup-SFH-nonspecificSelection1"),
              getString("popup-SFH-nonspecificSelection2")
          ],
          "info"
        )

        return ""
    }

    // recombine separator with "from here" and return
    let result = selected + parts[1]
    return removeIgnoredText(result, reader)
}

export async function getFullText(reader: ReaderInstance) {
    let text = await Zotero.Items.get(reader.itemID ?? "").attachmentText
    return removeIgnoredText(text, reader)
}

export function getSelectedAnnotations(reader: ReaderInstance) {
    let annos = reader._internalReader._annotationManager._annotations
    return annos.filter((anno) => reader._internalReader._state.selectedAnnotationIDs.includes(anno.id))
}

export function getAllAnnotations(reader: ReaderInstance) {
    return reader._internalReader._annotationManager._annotations
}