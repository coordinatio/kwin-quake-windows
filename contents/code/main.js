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
   script watches the active window: when the settings dialog loses focus, KWin is
   asked to reload its configuration through D-Bus; KWin then emits
   options.configChanged and the new values become visible to readConfig(). A
   hotkey pressed before that happens is deferred until the new values are in
   place, because readConfig() cannot be refreshed synchronously.
*/

var SLOT_COUNT = 7;

// Upper bound for the queue of hotkey presses waiting for a fresh configuration.
var MAX_PENDING_TOGGLES = 8;

// If KWin never confirms the reload, replay the queued presses after this delay.
var SAFETY_TIMEOUT_MS = 1000;

// Applications that host the settings dialog.
var SETTINGS_APP_CLASSES = ["systemsettings", "plasma-systemsettings", "kcmshell", "kcmshell6"];

var slotRegex = [];
var activeSlotCount = 0;
var configSignature = null;

// A settings window was activated since the last reload attempt.
var settingsWindowSeen = false;

// A reconfigure was requested and options.configChanged has not arrived yet.
var awaitingConfig = false;

// Slot indices whose hotkey was pressed while the configuration was stale.
var pendingToggles = [];

// Single-shot safety net for the queue above, created lazily.
var pendingToggleTimer = null;

var initialized = false;

function warn(message) {
    try {
        console.warn("QuakeWindows: " + message);
    } catch (error) {
        // Nothing sensible is left to do: console is the only output a script has.
    }
}

function info(message) {
    try {
        console.info("QuakeWindows: " + message);
    } catch (error) {
        // Nothing sensible is left to do: console is the only output a script has.
    }
}

/**
 * Window properties are null or undefined for windows that are going away, so
 * every string read goes through here.
 */
function text(value) {
    return typeof value === "string" ? value : "";
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
        var lower = String(value).toLowerCase();
        if (lower === "true" || lower === "1") {
            return true;
        }
        if (lower === "false" || lower === "0") {
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

/**
 * The pattern is compiled verbatim; only a pattern made of whitespace alone
 * disables the slot, so expressions that intentionally end with a space keep
 * working.
 */
function compilePattern(pattern, index) {
    if (!pattern || !pattern.replace(/\s/g, "")) {
        return null;
    }
    try {
        return new RegExp(pattern);
    } catch (error) {
        warn("ignoring WindowName" + (index + 1) + ", invalid regular expression [" +
             pattern + "]: " + error);
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
    activeSlotCount = active.length;
    info("active slots: " + (active.length ? active.join(", ") : "none"));
    return true;
}

function windowClass(client) {
    if (!client) {
        return "";
    }
    var name = text(client.resourceClass);
    if (!name) {
        name = text(client.resourceName);
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

/**
 * Asks KWin to re-read kwinrc. KWin coalesces reconfigure requests with its own
 * 200 ms timer, so there is no point in debouncing here.
 */
function requestConfigReload() {
    if (awaitingConfig) {
        return;
    }
    awaitingConfig = true;
    try {
        callDBus("org.kde.KWin", "/KWin", "org.kde.KWin", "reconfigure");
    } catch (error) {
        awaitingConfig = false;
        warn("could not ask KWin to reload its configuration: " + error);
    }
}

function safetyTimer() {
    if (pendingToggleTimer) {
        return pendingToggleTimer;
    }
    try {
        pendingToggleTimer = new QTimer();
        pendingToggleTimer.singleShot = true;
        pendingToggleTimer.interval = SAFETY_TIMEOUT_MS;
        pendingToggleTimer.timeout.connect(onPendingToggleTimeout);
    } catch (error) {
        warn("could not create the pending toggle timer: " + error);
        pendingToggleTimer = null;
    }
    return pendingToggleTimer;
}

function queuePendingToggle(index) {
    if (pendingToggles.length >= MAX_PENDING_TOGGLES) {
        pendingToggles.shift();
    }
    pendingToggles.push(index);

    var timer = safetyTimer();
    if (!timer) {
        return;
    }
    try {
        timer.start(SAFETY_TIMEOUT_MS);
    } catch (error) {
        warn("could not start the pending toggle timer: " + error);
    }
}

function replayPendingToggles() {
    if (!pendingToggles.length) {
        return;
    }
    var queued = pendingToggles;
    pendingToggles = [];
    for (var i = 0; i < queued.length; ++i) {
        try {
            toggleWindow(queued[i], true);
        } catch (error) {
            warn("failed to replay toggle of window " + (queued[i] + 1) + ": " + error);
        }
    }
}

/**
 * options.configChanged arrived, so readConfig() now returns the new values.
 */
function onConfigChanged() {
    try {
        applyConfig();
    } catch (error) {
        warn("failed to apply configuration: " + error);
    }
    awaitingConfig = false;
    if (pendingToggleTimer) {
        try {
            pendingToggleTimer.stop();
        } catch (error) {
            warn("could not stop the pending toggle timer: " + error);
        }
    }
    replayPendingToggles();
}

/**
 * KWin did not confirm the reload in time: a hotkey press must never be lost.
 */
function onPendingToggleTimeout() {
    if (!pendingToggles.length) {
        return;
    }
    warn("KWin did not confirm the configuration reload, applying the queued toggle(s) anyway");
    awaitingConfig = false;
    replayPendingToggles();
}

/**
 * Watches the active window to find out when the settings dialog was used. KWin
 * does not tell scripts about a script-configuration change, so this is the only
 * way to know when to ask KWin to re-read kwinrc.
 */
function onWindowActivated(client) {
    if (isSettingsWindow(client)) {
        // Values are written when the dialog is applied or closed, so the reload
        // has to wait until focus leaves it.
        settingsWindowSeen = true;
        return;
    }
    if (settingsWindowSeen) {
        settingsWindowSeen = false;
        requestConfigReload();
    }
}

function isRelevant(client, index) {
    var regex = slotRegex[index];
    if (!regex || !client) {
        return false;
    }
    var caption = text(client.caption);
    if (!caption) {
        return false;
    }
    return regex.test(caption);
}

/**
 * configIsFresh is true when readConfig() is known to return the current values,
 * i.e. for a press that is replayed after options.configChanged.
 */
function toggleWindow(index, configIsFresh) {
    if (!configIsFresh && (awaitingConfig || settingsWindowSeen)) {
        // The dialog was used and readConfig() still holds the old values, so the
        // press waits for options.configChanged instead of toggling a stale window.
        queuePendingToggle(index);
        requestConfigReload();
        return;
    }

    if (!slotRegex[index]) {
        // Disabled, empty or invalid slot: nothing to toggle.
        info("slot " + (index + 1) + " is disabled or has no valid expression, nothing to toggle");
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

function onCurrentDesktopChanged(oldDesktop, previousDesktop) {
    if (!activeSlotCount) {
        // Nothing is matched anyway, skip the window scan.
        return;
    }
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
            toggleWindow(index, false);
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
                onConfigChanged();
            } catch (error) {
                warn("failed to handle a configuration change: " + error);
            }
        });
    } catch (error) {
        warn("could not connect options.configChanged: " + error);
    }
}

function init() {
    if (initialized) {
        return;
    }

    applyConfig();

    for (var index = 0; index < SLOT_COUNT; ++index) {
        try {
            registerShortcut(
                "QuakeWindows " + (index + 1),
                "Toggle Window " + (index + 1),
                "",
                makeToggleHandler(index)
            );
        } catch (error) {
            warn("could not register shortcut " + (index + 1) + ": " + error);
        }
    }

    connectSignals();

    // Last statement: a re-entrant call must not register everything twice.
    initialized = true;
}

try {
    init();
} catch (error) {
    warn("failed to initialize: " + error);
}