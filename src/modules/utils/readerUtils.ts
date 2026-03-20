import ReaderInstance = _ZoteroTypes.ReaderInstance;
import AnnotationJson = _ZoteroTypes.Annotations.AnnotationJson;
import { notifyGeneric } from "./notify";
import { getString } from "./locale";
import { getPref } from "./prefs";

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildFlexibleWhitespaceRegex(text: string): RegExp | null {
    const trimmed = text.trim()
    if (!trimmed) {
        return null
    }

    const pattern = escapeRegex(trimmed).replace(/\s+/g, "\\s+")
    return new RegExp(pattern, "g")
}

function findUniqueMatchStart(haystack: string, needle: string): {
    index: number
    unique: boolean
} | null {
    const regex = buildFlexibleWhitespaceRegex(needle)
    if (!regex) {
        return null
    }

    const firstMatch = regex.exec(haystack)
    if (!firstMatch) {
        return null
    }

    const secondMatch = regex.exec(haystack)
    return {
        index: firstMatch.index,
        unique: !secondMatch
    }
}

function getPrefixCandidate(text: string, maxLength: number): string {
    const trimmed = text.trim()
    if (trimmed.length <= maxLength) {
        return trimmed
    }

    let candidate = trimmed.slice(0, maxLength)
    const lastWhitespace = candidate.search(/\s+\S*$/)
    if (lastWhitespace > Math.floor(maxLength * 0.5)) {
        candidate = candidate.slice(0, lastWhitespace)
    }

    return candidate.trim()
}

function splitTextIntoPages(text: string): Array<{ text: string; offset: number }> {
    const pages: Array<{ text: string; offset: number }> = []
    let start = 0

    while (start <= text.length) {
        const separatorIndex = text.indexOf("\f", start)
        if (separatorIndex === -1) {
            pages.push({ text: text.slice(start), offset: start })
            break
        }

        pages.push({ text: text.slice(start, separatorIndex), offset: start })
        start = separatorIndex + 1
    }

    return pages
}

function findStartInText(
    text: string,
    selected: string,
): {
    index: number
    ambiguous: boolean
} | null {
    const exactMatch = findUniqueMatchStart(text, selected)
    if (exactMatch?.unique) {
        return {
            index: exactMatch.index,
            ambiguous: false
        }
    }

    if (exactMatch && !exactMatch.unique) {
        return {
            index: -1,
            ambiguous: true
        }
    }

    const prefixLengths = [240, 160, 120, 80, 60, 40, 24, 16, 12, 8]
    let sawAmbiguousMatch = false

    for (const prefixLength of prefixLengths) {
        const prefix = getPrefixCandidate(selected, prefixLength)
        if (prefix.length < 8) {
            continue
        }

        const match = findUniqueMatchStart(text, prefix)
        if (!match) {
            continue
        }

        if (match.unique) {
            return {
                index: match.index,
                ambiguous: false
            }
        }

        sawAmbiguousMatch = true
    }

    if (sawAmbiguousMatch) {
        return {
            index: -1,
            ambiguous: true
        }
    }

    return null
}

function findStartFromPage(
    full: string,
    selected: string,
    pageIndex: number
): {
    index: number
    ambiguous: boolean
} | null {
    const pages = splitTextIntoPages(full)
    const page = pages[pageIndex]
    if (!page) {
        return null
    }

    const pageMatch = findStartInText(page.text, selected)
    if (!pageMatch) {
        return null
    }

    if (pageMatch.ambiguous) {
        return {
            index: -1,
            ambiguous: true
        }
    }

    return {
        index: page.offset + pageMatch.index,
        ambiguous: false
    }
}

async function getReaderPdfDocument(reader: ReaderInstance): Promise<_ZoteroTypes.Reader.PDFDocumentProxy | null> {
    if (reader.type !== "pdf") {
        return null
    }

    const pdfView = reader._internalReader._primaryView as _ZoteroTypes.Reader.PDFView | undefined
    if (!pdfView) {
        return null
    }

    try {
        await pdfView.initializedPromise
    } catch (error) {
        ztoolkit.log(`Reader PDF view initialization failed: ${error}`)
        return null
    }

    return pdfView._iframeWindow?.PDFViewerApplication?.pdfDocument || null
}

async function getPdfPageText(
    pdfDocument: _ZoteroTypes.Reader.PDFDocumentProxy,
    pageIndex: number
): Promise<string> {
    const page = await pdfDocument.getPage(pageIndex + 1)
    const textContent = await page.getTextContent()

    return textContent.items
        .map((item) => "str" in item ? item.str : "")
        .join(" ")
}

async function getSelectedTextToEndFromPdf(
    reader: ReaderInstance,
    selected: string,
    startPageIndex: number
): Promise<{
    text: string
    ambiguous: boolean
} | null> {
    const pdfDocument = await getReaderPdfDocument(reader)
    if (!pdfDocument) {
        return null
    }

    try {
        const startPageText = await getPdfPageText(pdfDocument, startPageIndex)
        const startMatch = findStartInText(startPageText, selected)
        if (!startMatch) {
            return null
        }

        if (startMatch.ambiguous) {
            return {
                text: "",
                ambiguous: true
            }
        }

        const remainingPageIndexes = Array.from(
            { length: Math.max(0, pdfDocument.numPages - startPageIndex - 1) },
            (_, index) => startPageIndex + index + 1
        )
        const remainingPages = await Promise.all(
            remainingPageIndexes.map((pageIndex) => getPdfPageText(pdfDocument, pageIndex))
        )

        return {
            text: [startPageText.slice(startMatch.index), ...remainingPages]
                .filter(Boolean)
                .join("\n\n"),
            ambiguous: false
        }
    } catch (error) {
        ztoolkit.log(`Reader PDF text extraction failed: ${error}`)
        return null
    }
}

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

export async function getSelectedTextToEnd(
    reader: ReaderInstance,
    selectionAnnotation?: Pick<AnnotationJson, "position"> | null
) {
    const selected = getSelectedText(reader)

    if (selected.trim() === "") {
        // cannot "read from here" without a here to read from
        notifyGeneric(
          [getString("popup-SFH-noSelection")],
          "info"
        )

        return ""
    }

    const selectionPageIndex = selectionAnnotation?.position?.pageIndex
    if (typeof selectionPageIndex === "number") {
        const pdfText = await getSelectedTextToEndFromPdf(reader, selected, selectionPageIndex)
        if (pdfText?.text) {
            return removeIgnoredText(pdfText.text, reader)
        }

        if (pdfText?.ambiguous) {
            notifyGeneric(
              [
                  getString("popup-SFH-nonspecificSelection1"),
                  getString("popup-SFH-nonspecificSelection2")
              ],
              "info"
            )

            return ""
        }
    }

    const full = await getFullText(reader)

    if (typeof selectionPageIndex === "number") {
        const pageAnchoredMatch = findStartFromPage(full, selected, selectionPageIndex)
        if (pageAnchoredMatch && pageAnchoredMatch.index >= 0) {
            return removeIgnoredText(full.slice(pageAnchoredMatch.index), reader)
        }

        if (pageAnchoredMatch?.ambiguous) {
            notifyGeneric(
              [
                  getString("popup-SFH-nonspecificSelection1"),
                  getString("popup-SFH-nonspecificSelection2")
              ],
              "info"
            )

            return ""
        }
    }

    const exactParts = full.split(selected)

    if (exactParts.length === 2) {
        return removeIgnoredText(selected + exactParts[1], reader)
    }

    if (exactParts.length > 2) {
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

    const flexibleFullSelection = findUniqueMatchStart(full, selected)
    if (flexibleFullSelection?.unique) {
        return removeIgnoredText(full.slice(flexibleFullSelection.index), reader)
    }

    if (flexibleFullSelection && !flexibleFullSelection.unique) {
        notifyGeneric(
          [
              getString("popup-SFH-nonspecificSelection1"),
              getString("popup-SFH-nonspecificSelection2")
          ],
          "info"
        )

        return ""
    }

    const prefixLengths = [240, 160, 120, 80, 40]
    let sawNonUniquePrefix = false

    for (const prefixLength of prefixLengths) {
        const prefix = getPrefixCandidate(selected, prefixLength)
        if (prefix.length < 20) {
            continue
        }

        const prefixMatch = findUniqueMatchStart(full, prefix)
        if (!prefixMatch) {
            continue
        }

        if (prefixMatch.unique) {
            return removeIgnoredText(full.slice(prefixMatch.index), reader)
        }

        sawNonUniquePrefix = true
    }

    notifyGeneric(
      sawNonUniquePrefix
        ? [
            getString("popup-SFH-nonspecificSelection1"),
            getString("popup-SFH-nonspecificSelection2")
        ]
        : [
            getString("popup-SFH-unknownSelection1"),
            getString("popup-SFH-unknownSelection2")
        ],
      "info"
    )

    return ""
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
