import { config } from "../../package.json"
import { getString } from "./utils/locale";
import { getSelectedText, getSelectedTextToEnd } from "./utils/readerUtils";
import { getPref } from "./utils/prefs";

export function registerReaderListeners() {
    Zotero.Reader._unregisterEventListenerByPluginID(config.addonID)

    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      (event) => {
          const { reader, doc, params, append } = event
          let speakSelectionButton = ztoolkit.UI.createElement(doc, "div",
            {
                children: [
                    {
                        tag: "div",
                        properties: {
                            innerHTML: `${ addon.data.ui.icons.speak }`
                        },
                        styles: {
                            display: "inline-block",
                            verticalAlign: "middle",
                            height: "16px",
                            paddingRight: "0.5em",
                            paddingLeft: "0.2em"
                        }
                    },
                    {
                        tag: "div",
                        properties: {
                            innerHTML: getString("textPopup-selection")
                        },
                        styles: {
                            display: "inline-block",
                            verticalAlign: "middle",
                        }
                    }
                ],
                listeners: [
                    {
                        type: "click",
                        listener: (e) => {addon.hooks.onSpeak(getSelectedText(reader))}
                    }
                ],
                styles: {
                    height: "fit-content",
                    display: "flex",
                }
            }
          )
          let speakFromHereButton = ztoolkit.UI.createElement(doc, "div",
            {
                children: [
                    {
                        tag: "div",
                        properties: {
                            innerHTML: `${ addon.data.ui.icons.speak }`
                        },
                        styles: {
                            display: "inline-block",
                            verticalAlign: "middle",
                            height: "16px",
                            paddingRight: "0.5em",
                            paddingLeft: "0.2em"
                        }
                    },
                    {
                        tag: "div",
                        properties: {
                            innerHTML: getString("textPopup-fromHere")
                        },
                        styles: {
                            display: "inline-block",
                            verticalAlign: "middle",
                        }
                    }
                ],
                listeners: [
                    {
                        type: "click",
                        listener: async (e) => {
                            addon.hooks.onSpeak(await getSelectedTextToEnd(reader))
                        }
                    }
                ],
                styles: {
                    height: "fit-content",
                    display: "flex",
                }
            }
          )

          append(speakSelectionButton)
          append(speakFromHereButton)
      },
      config.addonID
    )

    Zotero.Reader.registerEventListener(
      "renderSidebarAnnotationHeader",
      (event) => {
            const { reader, doc, params, append } = event
            const speakAnnotationButtons = ztoolkit.UI.createElement(doc, "div",
                {
                    children: [
                        {
                            // annotation button
                            tag: "div",
                            children: [
                                {
                                    tag: "div",
                                    properties: {
                                        innerHTML: `${ addon.data.ui.icons.speak }`
                                    },
                                    styles: {
                                        display: "inline-block",
                                        verticalAlign: "middle",
                                        height: "16px",
                                        paddingRight: "0.5em",
                                        paddingLeft: "0.2em"
                                    }
                                },
                                {
                                    tag: "div",
                                    properties: {
                                        innerHTML: getString("anno-annotation")
                                    },
                                    styles: {
                                        display: "inline-block",
                                        verticalAlign: "middle",
                                    }
                                }
                            ],
                            listeners: [
                                {
                                    type: "click",
                                    listener: (e) => {
                                        addon.hooks.onSpeak(params.annotation.text)
                                    }
                                }
                            ],
                            styles: {
                                height: "fit-content",
                                display: "flex",
                            }
                        },
                        {
                            // comment button
                            tag: "div",
                            children: [
                                {
                                    tag: "div",
                                    properties: {
                                        innerHTML: `${ addon.data.ui.icons.speak }`
                                    },
                                    styles: {
                                        display: "inline-block",
                                        verticalAlign: "middle",
                                        height: "16px",
                                        paddingRight: "0.5em",
                                        paddingLeft: "0.2em"
                                    }
                                },
                                {
                                    tag: "div",
                                    properties: {
                                        innerHTML: getString("anno-comment")
                                    },
                                    styles: {
                                        display: "inline-block",
                                        verticalAlign: "middle",
                                    }
                                }
                            ],
                            listeners: [
                                {
                                    type: "click",
                                    listener: (e) => {
                                        addon.hooks.onSpeak(params.annotation.comment as string)
                                    }
                                }
                            ],
                            styles: {
                                height: "fit-content",
                                display: "flex",
                            }
                        },
                    ],
                    styles: {
                        display: "flex",
                        flexDirection: "column",
                        paddingRight: "5px",
                        width: "70px"  // forced width here prevents elements shifting around when comm. is hidden
                    }
                }
            )

            // if no comment, hide button to speak it
            if (! params.annotation.comment) {
                (speakAnnotationButtons.children.item(1) as HTMLElement).style.display = "none"
            }

            append(speakAnnotationButtons)
        },
      config.addonID
    )

    Zotero.Reader.registerEventListener(
      "renderToolbar",
      (event) => {
            const { reader, doc, params, append } = event
            let readerToolbarUI = ztoolkit.UI.createElement(doc, "div",
                {
                    children: [
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${ addon.data.ui.icons.skipBackward }`,
                            },
                            classList: ["toolbar-button",],
                            listeners: [
                                {
                                    type: "click",
                                    listener: (e) => {
                                        addon.hooks.onSkipBackward()
                                    }
                                }
                            ]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${ addon.data.ui.icons.replay }`,
                            },
                            classList: ["toolbar-button",],
                            listeners: [
                                {
                                    type: "click",
                                    listener: (e) => {
                                        addon.hooks.onReplaySection()
                                    }
                                }
                            ]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${ addon.data.ui.icons.skipForward }`,
                            },
                            classList: ["toolbar-button",],
                            listeners: [
                                {
                                    type: "click",
                                    listener: (e) => {
                                        addon.hooks.onSkipForward()
                                    }
                                }
                            ]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${ addon.data.ui.icons.play }`,
                            },
                            classList: ["toolbar-button",],
                            listeners: [
                                {
                                    type: "click",
                                    listener: (e) => {
                                        addon.hooks.onSpeakOrResume()
                                    }
                                }
                            ]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${ addon.data.ui.icons.pause }`,
                            },
                            classList: ["toolbar-button",],
                            listeners: [
                                {
                                    type: "click",
                                    listener: (e) => {
                                        addon.hooks.onPause()
                                    }
                                }
                            ]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${ addon.data.ui.icons.cancel }`,
                            },
                            classList: ["toolbar-button",],
                            listeners: [
                                {
                                    type: "click",
                                    listener: (e) => {
                                        addon.hooks.onStop()
                                    }
                                }
                            ]
                        },
                    ],
                    styles: {
                        display: "flex",
                    }
                }
            )

            // TODO: future - need to add check for addon.tts.engines[add.tts.current].canPause
            //   WSA makes pausing easy to do, future TTS engines might not have the feature,
            //   this button should be hidden in that case

            append(readerToolbarUI)
            addon.data.ui.toolbars.push(readerToolbarUI)
        },
      config.addonID
    )

    // Inject UI into existing open readers without reloading tabs
    // This is safe because it only refreshes the reader UI, doesn't close/reopen tabs
    if (getPref("general.reloadTabs")) {
        injectUIIntoExistingReaders();
    }
}

/**
 * Safely inject UI elements into already-open reader tabs without reloading them.
 * This manually adds toolbar buttons to readers that were opened before the plugin loaded.
 */
function injectUIIntoExistingReaders(): void {
    try {
        // Get all reader tabs using Zotero_Tabs._tabs
        const tabs = Zotero_Tabs._tabs;
        ztoolkit.log(`Found ${tabs.length} total tabs`);
        
        let readerCount = 0;
        for (const tab of tabs) {
            try {
                // Only process reader tabs
                if (tab.type !== 'reader') {
                    continue;
                }
                
                readerCount++;
                const reader = Zotero.Reader.getByTabID(tab.id);
                if (!reader) {
                    ztoolkit.log(`No reader found for tab ${tab.id}`);
                    continue;
                }
                
                // Check if reader is fully loaded
                if (!reader._iframeWindow?.document) {
                    ztoolkit.log(`Reader ${tab.id} not fully loaded yet`);
                    continue;
                }
                
                const doc = reader._iframeWindow.document;
                
                // Log toolbar structure for debugging
                const toolbarElement = doc.querySelector('.toolbar');
                if (toolbarElement) {
                    ztoolkit.log(`Toolbar HTML for tab ${tab.id}: ${toolbarElement.outerHTML.substring(0, 500)}`);
                }
                
                // Find the toolbar container - look for the right-side toolbar section
                // The append() function from renderToolbar adds to a specific container
                let toolbar = doc.querySelector('.toolbar .end');
                if (!toolbar) {
                    // Fallback to main toolbar
                    toolbar = doc.querySelector('.toolbar');
                }
                if (!toolbar) {
                    ztoolkit.log(`No toolbar found in reader for tab ${tab.id}`);
                    continue;
                }
                
                // Check if our buttons are already there
                if (toolbar.querySelector('[data-zotts-toolbar]')) {
                    ztoolkit.log(`Toolbar already has ZoTTS buttons for tab ${tab.id}`);
                    continue;
                }
                
                // Create the same toolbar UI as in the renderToolbar event
                const readerToolbarUI = ztoolkit.UI.createElement(doc, "div", {
                    attributes: {
                        'data-zotts-toolbar': 'true'  // Mark so we don't duplicate
                    },
                    children: [
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${addon.data.ui.icons.skipBackward}`,
                            },
                            classList: ["toolbar-button"],
                            listeners: [{
                                type: "click",
                                listener: () => addon.hooks.onSkipBackward()
                            }]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${addon.data.ui.icons.replay}`,
                            },
                            classList: ["toolbar-button"],
                            listeners: [{
                                type: "click",
                                listener: () => addon.hooks.onReplaySection()
                            }]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${addon.data.ui.icons.skipForward}`,
                            },
                            classList: ["toolbar-button"],
                            listeners: [{
                                type: "click",
                                listener: () => addon.hooks.onSkipForward()
                            }]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${addon.data.ui.icons.play}`,
                            },
                            classList: ["toolbar-button"],
                            listeners: [{
                                type: "click",
                                listener: () => addon.hooks.onSpeakOrResume()
                            }]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${addon.data.ui.icons.pause}`,
                            },
                            classList: ["toolbar-button"],
                            listeners: [{
                                type: "click",
                                listener: () => addon.hooks.onPause()
                            }]
                        },
                        {
                            tag: "button",
                            namespace: "html",
                            properties: {
                                innerHTML: `${addon.data.ui.icons.cancel}`,
                            },
                            classList: ["toolbar-button"],
                            listeners: [{
                                type: "click",
                                listener: () => addon.hooks.onStop()
                            }]
                        },
                    ],
                    styles: {
                        display: "flex",
                    }
                });
                
                // Append to the toolbar
                toolbar.appendChild(readerToolbarUI);
                addon.data.ui.toolbars.push(readerToolbarUI);
                
                ztoolkit.log(`Successfully injected toolbar into reader for tab ${tab.id}`);
            } catch (error) {
                ztoolkit.log(`Failed to inject UI into tab: ${error}`);
            }
        }
        
        ztoolkit.log(`Processed ${readerCount} reader tabs`);
    } catch (error) {
        ztoolkit.log(`Failed to inject UI into existing readers: ${error}`);
    }
}