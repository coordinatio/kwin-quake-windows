/*
   SPDX-FileCopyrightText: 2023 Ivan Volkov <angrycore@gmail.com>
   SPDX-License-Identifier: GPL-3.0-or-later
*/

/*
   Quake Windows — KWin script.

   Configuration is stored in the "[Script-quakewindows]" group of kwinrc and is
   written by the native settings dialog (contents/ui/config.ui). Two keys per
   slot:

     WindowNameN — JavaScript regular expression matched against the window caption
     EnabledN    — whether the slot takes part in matching (missing key means "true")

   A slot that is disabled, empty or holds an invalid expression is ignored, but
   never breaks the other slots.

   KWin only re-reads kwinrc when it reconfigures itself, and the generic scripted
   configuration module does not notify KWin after writing the file. Therefore the
   script notices that the settings window was used and asks KWin to reload its
   configuration through D-Bus; KWin then emits options.configChanged and the new
   values become visible to readConfig().
*/

var SLOT_COUNT = 7;

// One cheap check per second: is the settings window the active window?
var POLL_INTERVAL_MS = 1000;

// While the settings window stays active, ask KWin to re-read its configuration
// at most every N polls.
var POLLS_BETWEEN_RECONFIGURE = 3;

// Delay before asking KWin to reconfigure, to coalesce focus changes.
var RECONFIGURE_DELAY_MS = 400;

// Applications that host the settings dialog.
var SETTINGS_APP_CLASSES = ["systemsettings", "plasma-systemsettings", "kcmshell", "kcmshell6"];

var slotRegex = [];
var configSignature = null;

var settingsWindowSeen = false;
var pollsSinceReconfigure = 1000000;
var reconfigurePending = false;

var pollTimer = null;
var reconfigureTimer = null;
var initialized = false;

function warn(message) {
    try {
        console.warn("QuakeWindows: " + message);
    } catch (error) {
        print("QuakeWindows: " + message);
    }
}

function info(message) {
    try {
        console.info("QuakeWindows: " + message);
    } catch (error) {
        print("QuakeWindows: " + message);
    }
}

function readString(key, fallback) {
    try {
        var value = readConfig(key, fallback);
        if (value === null || value === undefined) {
            return fallback;
        }
        return String(value);
    } catch (error) {
        warn("could not read " + key + ": " + error);
        return fallback;
    }
}

function readBool(key, fallback) {
    try {
        var value = readConfig(key, fallback);
        if (value === null || value === undefined || value === "") {
            return fallback;
        }
        if (typeof value === "boolean") {
            return value;
        }
        var text = String(value).toLowerCase();
        if (text === "true" || text === "1") {
            return true;
        }
        if (text === "false" || text === "0") {
            return false;
        }
        return !!value;
    } catch (error) {
        warn("could not read " + key + ": " + error);
        return fallback;
    }
}

function readRawSlots() {
    var slots = [];
    for (var index = 0; index < SLOT_COUNT; ++index) {
        var number = index + 1;
        slots.push({
            enabled: readBool("Enabled" + number, true),
            pattern: readString("WindowName" + number, "")
        });
    }
    return slots;
}

function compilePattern(pattern, index) {
    var source = pattern.replace(/^\s+/, "").replace(/\s+$/, "");
    if (!source) {
        return null;
    }
    try {
        return new RegExp(source);
    } catch (error) {
        warn("ignoring WindowName" + (index + 1) + ", invalid regular expression [" +
             source + "]: " + error);
        return null;
    }
}

/**
 * Re-reads the seven slots. Returns true when the stored configuration changed,
 * in which case the regular expressions have been recompiled.
 */
function applyConfig() {
    var raw = readRawSlots();
    var signature = JSON.stringify(raw);
    if (signature === configSignature) {
        return false;
    }
    configSignature = signature;

    var active = [];
    for (var index = 0; index < SLOT_COUNT; ++index) {
        slotRegex[index] = raw[index].enabled ? compilePattern(raw[index].pattern, index) : null;
        if (slotRegex[index]) {
            active.push((index + 1) + ": " + slotRegex[index].source);
        }
    }
    info("active slots: " + (active.length ? active.join(", ") : "none"));
    return true;
}

function activeWindow() {
    try {
        return workspace.activeWindow;
    } catch (error) {
        return null;
    }
}

function windowClass(client) {
    if (!client) {
        return "";
    }
    var name = "";
    try {
        name = String(client.resourceClass);
    } catch (error) {
        name = "";
    }
    if (!name) {
        try {
            name = String(client.resourceName);
        } catch (error) {
            name = "";
        }
    }
    return name.toLowerCase();
}

function isSettingsWindow(client) {
    var name = windowClass(client);
    if (!name) {
        return false;
    }
    for (var i = 0; i < SETTINGS_APP_CLASSES.length; ++i) {
        if (name === SETTINGS_APP_CLASSES[i]) {
            return true;
        }
    }
    return name.indexOf("kcmshell") === 0;
}

function sendReconfigure() {
    reconfigurePending = false;
    pollsSinceReconfigure = 0;
    try {
        callDBus("org.kde.KWin", "/KWin", "org.kde.KWin", "reconfigure");
    } catch (error) {
        warn("could not ask KWin to reload its configuration: " + error);
    }
}

function requestConfigReload() {
    if (reconfigurePending) {
        return;
    }
    reconfigurePending = true;
    try {
        if (reconfigureTimer) {
            reconfigureTimer.start(RECONFIGURE_DELAY_MS);
            return;
        }
    } catch (error) {
        warn("timer failed: " + error);
    }
    sendReconfigure();
}

/**
 * Watches the active window to find out when the settings dialog was used. KWin
 * does not tell scripts about a script-configuration change, so this is the only
 * way to know when to ask KWin to re-read kwinrc.
 */
function pollSettingsWindow() {
    pollsSinceReconfigure += 1;

    if (isSettingsWindow(activeWindow())) {
        settingsWindowSeen = true;
        if (pollsSinceReconfigure >= POLLS_BETWEEN_RECONFIGURE) {
            requestConfigReload();
        }
        return;
    }

    if (settingsWindowSeen) {
        // Focus left the settings dialog: values may just have been applied.
        settingsWindowSeen = false;
        requestConfigReload();
    }
}

function onWindowActivated(client) {
    if (isSettingsWindow(client)) {
        settingsWindowSeen = true;
    }
}

function isRelevant(client, index) {
    var regex = slotRegex[index];
    if (!regex || !client) {
        return false;
    }
    var caption = "";
    try {
        caption = String(client.caption);
    } catch (error) {
        return false;
    }
    if (!caption) {
        return false;
    }
    return regex.test(caption);
}

function toggleWindow(index) {
    if (settingsWindowSeen) {
        // The dialog was used: the next hotkey press should already work with
        // the new expression.
        requestConfigReload();
    }

    if (!slotRegex[index]) {
        // Disabled, empty or invalid slot: nothing to toggle.
        return;
    }

    var allClients = workspace.windowList();
    for (var i = 0; i < allClients.length; ++i) {
        if (!isRelevant(allClients[i], index)) {
            continue;
        }
        var prevMini = allClients[i].minimized;
        allClients[i].onAllDesktops = !prevMini;
        allClients[i].minimized = !prevMini;
        allClients[i].skipTaskbar = !prevMini;
        allClients[i].skipPager = !prevMini;
        allClients[i].skipSwitcher = !prevMini;
        if (prevMini) {
            workspace.activeWindow = allClients[i];
        }
        break; // only toggle one window
    }
}

function onCurrentDesktopChanged(oldDesktop, movingClient) {
    // That is the workaround for the bug which makes the hidden windows reappear
    // on the taskbar on desktop change.
    var allClients = workspace.windowList();
    for (var i = 0; i < allClients.length; ++i) {
        for (var index = 0; index < SLOT_COUNT; ++index) {
            if (isRelevant(allClients[i], index)) {
                allClients[i].skipTaskbar = allClients[i].minimized;
            }
        }
    }
}

function makeToggleHandler(index) {
    return function () {
        try {
            toggleWindow(index);
        } catch (error) {
            warn("failed to toggle window " + (index + 1) + ": " + error);
        }
    };
}

function connectSignals() {
    try {
        workspace.currentDesktopChanged.connect(onCurrentDesktopChanged);
    } catch (error) {
        warn("could not connect currentDesktopChanged: " + error);
    }
    try {
        workspace.windowActivated.connect(onWindowActivated);
    } catch (error) {
        warn("could not connect windowActivated: " + error);
    }
    try {
        options.configChanged.connect(function () {
            try {
                applyConfig();
            } catch (error) {
                warn("failed to apply configuration: " + error);
            }
        });
    } catch (error) {
        warn("could not connect options.configChanged: " + error);
    }
}

function startTimers() {
    try {
        reconfigureTimer = new QTimer();
        reconfigureTimer.singleShot = true;
        reconfigureTimer.timeout.connect(sendReconfigure);
    } catch (error) {
        warn("could not create the reconfigure timer: " + error);
        reconfigureTimer = null;
    }

    try {
        pollTimer = new QTimer();
        pollTimer.interval = POLL_INTERVAL_MS;
        pollTimer.timeout.connect(pollSettingsWindow);
        pollTimer.start();
    } catch (error) {
        warn("could not create the configuration poll timer: " + error);
        pollTimer = null;
    }
}

function init() {
    if (initialized) {
        return;
    }
    initialized = true;

    applyConfig();

    for (var index = 0; index < SLOT_COUNT; ++index) {
        registerShortcut(
            "QuakeWindows " + (index + 1),
            "Toggle Window " + (index + 1),
            "",
            makeToggleHandler(index)
        );
    }

    connectSignals();
    startTimers();
}

try {
    init();
} catch (error) {
    warn("failed to initialize: " + error);
}
