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

// If KWin never confirms the reload, replay the pending presses after this delay.
var SAFETY_TIMEOUT_MS = 1000;

// A reload request that stays unanswered must not block the next one forever.
// callDBus() drops error replies, so this is the only way out.
//
// Two timers guard the reload: the safety timer above replays a deferred press
// when options.configChanged never arrives, and this watchdog only keeps the
// reload request path itself alive while no press is pending.
var CONFIG_WATCHDOG_MS = 2000;

var slotRegex = [];

// Slot indices (0-based) that have a compiled expression.
var activeSlots = [];

// Slots whose "nothing to toggle" line was already written for the current
// configuration. Cleared by applyConfig(), so a slot that is permanently blind
// costs one journal line per configuration change instead of one per press.
var inactiveSlotLogged = [];

// The same for a valid expression that matches no window at all.
var unmatchedSlotLogged = [];

var configSignature = null;

// A settings window was activated since the last completed reload. Rebuilt from
// the active window on every reload, so it cannot latch.
var settingsWindowSeen = false;

// A reconfigure was requested and options.configChanged has not arrived yet.
var awaitingConfig = false;

// A deferred press is being replayed right now.
var replaying = false;

// Slot indices whose hotkey was pressed an odd number of times while the
// configuration was stale. Toggling is parity-sensitive: two presses restore the
// original state, so counting them per slot beats queueing them, and the memory
// is bounded by SLOT_COUNT.
var pendingPresses = [];

// Single-shot safety net for the presses above, created lazily.
var pendingToggleTimer = null;

// Single-shot watchdog for an unanswered reload request, created lazily.
var configWatchdogTimer = null;

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
 * Re-reads the seven slots and recompiles them when the stored values changed.
 */
function applyConfig() {
    var raw = readRawSlots();
    var signature = JSON.stringify(raw);
    if (signature === configSignature) {
        return;
    }

    var compiled = [];
    var active = [];
    var sources = [];
    for (var index = 0; index < SLOT_COUNT; ++index) {
        compiled[index] = raw[index].enabled ? compilePattern(raw[index].pattern, index) : null;
        if (compiled[index]) {
            active.push(index);
            sources.push((index + 1) + ": " + compiled[index].source);
        }
    }
    var summary = "active slots: " + (sources.length ? sources.join(", ") : "none");

    // Everything is committed only after the loop finished, so a throw above
    // cannot leave a half-built generation marked as applied. The two "logged
    // once" memories belong to the same commit: a new generation reports every
    // unusable slot once again.
    slotRegex = compiled;
    activeSlots = active;
    inactiveSlotLogged = [];
    unmatchedSlotLogged = [];
    configSignature = signature;
    info(summary);
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

function endsWith(value, suffix) {
    return value.length >= suffix.length &&
        value.lastIndexOf(suffix) === value.length - suffix.length;
}

/**
 * Recognises the windows that host the settings dialog: systemsettings,
 * plasma-systemsettings, plasma-settings, kdesystemsettings and reverse-DNS ids
 * like org.kde.systemsettings, plus every kcmshell* module. The class and the
 * resource name are dot/hyphen separated identifiers, so only the last component
 * is judged: "not-settings-really" and "plasma-settings-helper" are not settings
 * windows, while "org.kde.systemsettings" is.
 */
function isSettingsWindow(client) {
    var name = windowClass(client);
    if (!name) {
        return false;
    }
    if (name.indexOf("kcmshell") === 0) {
        return true;
    }
    var parts = name.split(/[^a-z0-9]+/);
    return endsWith(parts[parts.length - 1], "settings");
}

/**
 * workspace.activeWindow throws for a window that is being destroyed, and no
 * press handling may break because of it.
 */
function currentActiveWindow() {
    try {
        return workspace.activeWindow;
    } catch (error) {
        warn("could not read the active window: " + error);
        return null;
    }
}

/**
 * True when readConfig() may still return the values from before the settings
 * dialog was used, so a press has to wait for options.configChanged instead of
 * toggling a window from a stale configuration. Three independent reasons: a
 * reload was requested and not confirmed yet, the dialog was activated since the
 * last reload, or the dialog is focused right now (it stays focused across a
 * reload, so a second Apply has to be noticed too).
 */
function configMayBeStale() {
    if (awaitingConfig || settingsWindowSeen) {
        return true;
    }
    return isSettingsWindow(currentActiveWindow());
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
    armConfigWatchdog();
    try {
        callDBus("org.kde.KWin", "/KWin", "org.kde.KWin", "reconfigure");
    } catch (error) {
        awaitingConfig = false;
        stopConfigWatchdog();
        warn("could not ask KWin to reload its configuration: " + error);
    }
}

// Two timers, because they answer two different questions: the 1 s safety timer
// guarantees that a deferred press is never lost even when KWin never confirms
// the reload, while the 2 s watchdog only keeps the reload request path alive and
// therefore fires when nothing is pending.

/**
 * Creates a single-shot timer lazily. Returns null when KWin cannot create one,
 * which both callers survive by doing nothing.
 */
function makeTimer(intervalMs, description, handler) {
    try {
        var timer = new QTimer();
        timer.singleShot = true;
        timer.interval = intervalMs;
        timer.timeout.connect(handler);
        return timer;
    } catch (error) {
        warn("could not create the " + description + " timer: " + error);
        return null;
    }
}

function configWatchdog() {
    if (!configWatchdogTimer) {
        configWatchdogTimer = makeTimer(CONFIG_WATCHDOG_MS, "configuration watchdog",
            onConfigWatchdogTimeout);
    }
    return configWatchdogTimer;
}

function armConfigWatchdog() {
    var timer = configWatchdog();
    if (!timer) {
        return;
    }
    try {
        timer.start(CONFIG_WATCHDOG_MS);
    } catch (error) {
        warn("could not start the configuration watchdog timer: " + error);
    }
}

function stopConfigWatchdog() {
    if (!configWatchdogTimer) {
        return;
    }
    try {
        configWatchdogTimer.stop();
    } catch (error) {
        warn("could not stop the configuration watchdog timer: " + error);
    }
}

/**
 * options.configChanged never arrived. Clearing awaitingConfig keeps the reload
 * request path alive instead of ignoring every later request.
 */
function onConfigWatchdogTimeout() {
    if (!awaitingConfig) {
        return;
    }
    awaitingConfig = false;
    warn("KWin did not confirm the configuration reload");
}

function safetyTimer() {
    if (!pendingToggleTimer) {
        pendingToggleTimer = makeTimer(SAFETY_TIMEOUT_MS, "pending toggle",
            onPendingToggleTimeout);
    }
    return pendingToggleTimer;
}

function notePendingPress(index) {
    // Toggling is parity-sensitive, so remember only whether the number of
    // presses for this slot is odd. Dropping presses of a bounded queue could
    // leave the window in the opposite state.
    pendingPresses[index] = !pendingPresses[index];

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

function hasPendingPresses() {
    for (var index = 0; index < SLOT_COUNT; ++index) {
        if (pendingPresses[index]) {
            return true;
        }
    }
    return false;
}

function replayPendingPresses() {
    if (!hasPendingPresses()) {
        return;
    }
    var pressed = pendingPresses;
    // Cleared before replaying, so a toggle that re-enters this path sees an
    // empty state instead of replaying the same presses again.
    pendingPresses = [];
    // Toggling a hidden window activates it, which fires windowActivated. The
    // configuration was just reloaded, so such an activation must not request
    // another reload.
    replaying = true;
    try {
        // The loop runs in slot-index order, not in the order the keys were
        // pressed. That is safe because presses of different slots are
        // independent: each one reads its own expression and its own windows.
        // Only the resulting activeWindow choice could differ if two expressions
        // match the same window.
        for (var index = 0; index < SLOT_COUNT; ++index) {
            if (!pressed[index]) {
                continue;
            }
            if (!slotRegex[index]) {
                // The slot was disabled or emptied while the press was deferred.
                info("the press on slot " + (index + 1) +
                     " was dropped because the slot is now disabled");
                continue;
            }
            try {
                toggleWindow(index, true);
            } catch (error) {
                warn("failed to replay toggle of window " + (index + 1) + ": " + error);
            }
        }
    } finally {
        replaying = false;
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
    // After a reload "the dialog was used since the last reload" is rebuilt from
    // the active window instead of being cleared unconditionally: with a settings
    // window still focused the flag only means "the dialog is still up, so another
    // Apply may still come". With a normal window focused it becomes false, which
    // keeps the flag self-healing when the dialog was closed without any window
    // becoming active afterwards.
    settingsWindowSeen = isSettingsWindow(currentActiveWindow());
    stopConfigWatchdog();
    if (pendingToggleTimer) {
        try {
            pendingToggleTimer.stop();
        } catch (error) {
            warn("could not stop the pending toggle timer: " + error);
        }
    }
    replayPendingPresses();
}

/**
 * KWin did not confirm the reload in time: a hotkey press must never be lost.
 */
function onPendingToggleTimeout() {
    if (!hasPendingPresses()) {
        return;
    }
    warn("KWin did not confirm the configuration reload, applying the pending toggle(s) anyway");
    awaitingConfig = false;
    // Best effort: if KWin reparsed kwinrc but the configChanged signal was lost,
    // this picks the fresh values up. When nothing changed, applyConfig() is a
    // no-op thanks to the signature check.
    try {
        applyConfig();
    } catch (error) {
        warn("failed to apply configuration: " + error);
    }
    replayPendingPresses();
}

/**
 * Watches the active window to find out when the settings dialog was used. KWin
 * does not tell scripts about a script-configuration change, so this is the only
 * way to know when to ask KWin to re-read kwinrc.
 */
function onWindowActivated(client) {
    if (replaying) {
        // Caused by replaying a press after a reload, which the user did not
        // trigger: the configuration was reloaded a moment ago.
        return;
    }
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
    if (!configIsFresh && configMayBeStale()) {
        // readConfig() still holds the old values, so the press waits for
        // options.configChanged instead of toggling a stale window.
        notePendingPress(index);
        requestConfigReload();
        return;
    }

    if (!slotRegex[index]) {
        // Disabled, empty or invalid slot: nothing to toggle. Reported once per
        // configuration generation, otherwise a forgotten slot fills the journal.
        if (!inactiveSlotLogged[index]) {
            inactiveSlotLogged[index] = true;
            info("slot " + (index + 1) +
                 " is disabled or has no valid expression, nothing to toggle");
        }
        return;
    }

    var allClients = workspace.windowList();
    var matched = false;
    for (var i = 0; i < allClients.length; ++i) {
        if (!isRelevant(allClients[i], index)) {
            continue;
        }
        matched = true;
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
    if (!matched && !unmatchedSlotLogged[index]) {
        // The expression is valid, so a typo in it is the likely cause. Again
        // once per configuration generation, not once per press.
        unmatchedSlotLogged[index] = true;
        info("no window matches slot " + (index + 1));
    }
}

function onCurrentDesktopChanged(previousDesktop, newDesktop) {
    if (!activeSlots.length) {
        // No slot has a usable expression, skip the window scan.
        return;
    }
    // That is the workaround for the bug which makes the hidden windows reappear
    // on the taskbar on desktop change.
    var allClients = workspace.windowList();
    for (var i = 0; i < allClients.length; ++i) {
        for (var j = 0; j < activeSlots.length; ++j) {
            if (isRelevant(allClients[i], activeSlots[j])) {
                // Assigning the same value twice is pointless, so the first
                // matching slot decides for this window.
                allClients[i].skipTaskbar = allClients[i].minimized;
                break;
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

function handleCurrentDesktopChanged(previousDesktop, newDesktop) {
    try {
        onCurrentDesktopChanged(previousDesktop, newDesktop);
    } catch (error) {
        warn("failed to handle a desktop change: " + error);
    }
}

function handleWindowActivated(client) {
    try {
        onWindowActivated(client);
    } catch (error) {
        warn("failed to handle a window activation: " + error);
    }
}

function connectSignals() {
    try {
        workspace.currentDesktopChanged.connect(handleCurrentDesktopChanged);
    } catch (error) {
        warn("could not connect currentDesktopChanged: " + error);
    }
    try {
        workspace.windowActivated.connect(handleWindowActivated);
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

    try {
        applyConfig();
    } catch (error) {
        warn("failed to apply configuration: " + error);
    }

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

    // A settings window may already be open and focused when the script loads,
    // in which case its Apply must not be missed.
    settingsWindowSeen = isSettingsWindow(currentActiveWindow());

    // Last statement: a re-entrant call must not register everything twice.
    initialized = true;
}

try {
    init();
} catch (error) {
    warn("failed to initialize: " + error);
}
