import { config } from "../../package.json"
import { getString } from "./utils/locale"

// MenuManager was removed in toolkit 5.1. Own menu nodes in their actual window.
export function registerMenu(win: Window = Zotero.getMainWindow()): () => void {
    const popup = win.document.getElementById("zotero-itemmenu")
    if (!popup) { return () => {} }
    const nodes: Element[] = []
    const separator = win.document.createXULElement("menuseparator")
    popup.appendChild(separator)
    nodes.push(separator)
    for (const field of ["title", "abstractNote"] as const) {
        const item = win.document.createXULElement("menuitem")
        item.setAttribute("label", getString(field === "title" ? "itemMenu-title" : "itemMenu-abstract"))
        item.setAttribute("style", `list-style-image: url(chrome://${config.addonRef}/content/icons/speak@16.svg)` )
        item.addEventListener("command", () => {
            const selected = (win as _ZoteroTypes.MainWindow).ZoteroPane.getSelectedItems(true)
            const selectedItem = Zotero.Items.get(selected[0])
            addon.hooks.onSpeak(selectedItem.getField(field) as string)
        })
        popup.appendChild(item)
        nodes.push(item)
    }
    return () => nodes.forEach(node => node.remove())
}
