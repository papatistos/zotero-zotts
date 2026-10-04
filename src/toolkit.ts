import { BasicTool, UITool, ReaderTool, FieldHookManager, KeyboardManager, unregister } from "zotero-plugin-toolkit";
import { config } from "../package.json";

// ZoteroToolkit constructs KeyboardManager before callers can set pluginID.
// Construct the managers ZoTTS uses only after configuring their owner.
export class ZoTTSToolkit extends BasicTool {
    public UI: UITool;
    public Reader: ReaderTool;
    public FieldHooks: FieldHookManager;
    public Keyboard: KeyboardManager;
    private readerKeyboardWindows = new Set<Window>();
    private disposed = false;

    // Toolkit 5.1.4 does not remove reader-frame DOM keyboard listeners.
    private get keyboardInternals(): {
        _initKeyboardListener: (win: Window) => void;
        unInitKeyboardListener: (win: Window) => void;
    } {
        return this.Keyboard as unknown as {
            _initKeyboardListener: (win: Window) => void;
            unInitKeyboardListener: (win: Window) => void;
        };
    }

    constructor() {
        super();
        this.basicOptions.api.pluginID = config.addonID;
        this.UI = new UITool(this);
        this.Reader = new ReaderTool(this);
        this.FieldHooks = new FieldHookManager(this);
        this.Keyboard = new KeyboardManager(this);
        const initialize = this.keyboardInternals._initKeyboardListener.bind(this.Keyboard);
        this.keyboardInternals._initKeyboardListener = (win: Window) => {
            if (this.disposed || !win) return;
            this.readerKeyboardWindows.add(win);
            initialize(win);
        };
    }

    public unregisterAll(): void {
        this.disposed = true;
        for (const win of this.readerKeyboardWindows) {
            try {
                this.keyboardInternals.unInitKeyboardListener(win);
            } catch (error) {
                // Reader frames may have closed since the keyboard listeners were attached.
                this.log(`Reader keyboard cleanup: ${error}`);
            }
        }
        this.readerKeyboardWindows.clear();
        unregister(this);
    }
}
