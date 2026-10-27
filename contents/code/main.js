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
   configuration module does not notify KWin after writing the file. The script
   therefore asks KWin to reconfigure when the settings dialog loses focus and
   defers a press that arrives before the new values are visible, because
   readConfig() cannot be refreshed synchronously. See "How configuration
   reloading works" in README.md for the whole sequence and the trade-offs.
*/

var SLOT_COUNT = 7;

// The one deadline of the configuration machinery. It encodes both guarantees
// the old pair of timers carried: every deferred press has a deadline, and a
// reload request that KWin never answers cannot latch, because callDBus() drops
// error replies and a timeout is the only way out. The request and every deferred
// press re-arm it, so it fires CONFIG_TIMEOUT_MS after the last event that needed
// it, and whichever of the two happened last is handled by the same handler.
var CONFIG_TIMEOUT_MS = 1000;

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

// Single-shot deadline shared by the reload request and the deferred presses,
// created lazily. It dies with the script: KWin owns the QJSEngine, objects
// created in JavaScript have JavaScript ownership, so destroying the engine
// destroys the timer - there is no unload hook to worry about. The handler stays
// defensive anyway (a timeout can arrive half-way through a reload, and creating
// the timer can fail), which costs a handful of lines.
var configTimer = null;

// The "no timer at all" fallback below is worth exactly one journal line: if
// QTimer cannot be created, every press would otherwise repeat it.
var noTimerFallbackLogged = false;

// Creating the timer failed once already. QTimer does not start working later in
// a session, so the attempt and its warning are not repeated.
var configTimerUnavailable = false;

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
        if (lower === "true" || lower === "on" || lower === "yes" || lower === "1") {
            return true;
        }
        if (lower === "false" || lower === "off" || lower === "no" || lower === "0") {
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
 * like org.kde.systemsettings, plus every kcmshell module. The class and the
 * resource name end with the module name, so the suffix decides: a look-alike
 * such as "not-settings-really" or "plasma-settings-helper" is not a settings
 * window, while "org.kde.systemsettings" is.
 *
 * A trailing version number is not part of the name, so "systemsettings6" is
 * recognised exactly like the unversioned form. kcmshell is matched as a
 * contained segment rather than as a prefix, because the portal and standalone
 * forms are reverse-DNS ids such as org.kde.kcmshell6.
 *
 * Known trade-off, kept on purpose: a third-party window class that merely ends
 * with "settings" also counts as a settings window. Missing the real dialog costs
 * a stale toggle, while a false positive only costs one deferred press and one
 * reconfigure.
 */
function isSettingsWindow(client) {
    var name = windowClass(client).replace(/[0-9]+$/, "");
    if (!name) {
        return false;
    }
    if (name.indexOf("kcmshell") !== -1) {
        return true;
    }
    return endsWith(name, "settings");
}

/**
 * workspace.activeWindow itself does not throw; what throws is a property read on
 * the wrapper of a window that is being destroyed (see windowClass()). The value
 * is fetched here and every read of it stays guarded, because no press handling
 * may break on a dying window; the try/catch is the last line of defence only.
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
 * 200 ms timer, so there is no point in debouncing here; the shared deadline is
 * only about the answer, not about the request.
 */
function requestConfigReload() {
    if (awaitingConfig) {
        return;
    }
    awaitingConfig = true;
    armConfigTimer();
    // The try/catch only guards the JS call itself: Script::callDBus() never
    // throws and silently drops error replies, so a failed reconfigure is
    // invisible here. The deadline armed above is what unsticks it.
    try {
        callDBus("org.kde.KWin", "/KWin", "org.kde.KWin", "reconfigure");
    } catch (error) {
        awaitingConfig = false;
        stopConfigTimer();
        warn("could not ask KWin to reload its configuration: " + error);
    }
}

/**
 * Creates the single-shot deadline timer lazily. Returns null when KWin cannot
 * create one; both callers survive that (the timeout path is then simply gone,
 * and toggleWindow() falls back to a synchronous toggle).
 */
function makeConfigTimer() {
    try {
        var timer = new QTimer();
        timer.singleShot = true;
        timer.interval = CONFIG_TIMEOUT_MS;
        timer.timeout.connect(onConfigTimeout);
        return timer;
    } catch (error) {
        warn("could not create the configuration timer: " + error);
        return null;
    }
}

function configDeadline() {
    if (configTimer) {
        return configTimer;
    }
    if (configTimerUnavailable) {
        return null;
    }
    configTimer = makeConfigTimer();
    if (!configTimer) {
        configTimerUnavailable = true;
    }
    return configTimer;
}

/**
 * (Re)arms the single deadline. Both the reload request and every deferred press
 * push it back, so it fires CONFIG_TIMEOUT_MS after the last of them - which is
 * what makes a queued press wait for the last press instead of the first.
 */
function armConfigTimer() {
    var timer = configDeadline();
    if (!timer) {
        return;
    }
    try {
        timer.start(CONFIG_TIMEOUT_MS);
    } catch (error) {
        warn("could not start the configuration timer: " + error);
    }
}

function stopConfigTimer() {
    if (!configTimer) {
        return;
    }
    try {
        configTimer.stop();
    } catch (error) {
        warn("could not stop the configuration timer: " + error);
    }
}

function notePendingPress(index) {
    // Toggling is parity-sensitive, so remember only whether the number of
    // presses for this slot is odd. Dropping presses of a bounded queue could
    // leave the window in the opposite state.
    pendingPresses[index] = !pendingPresses[index];
    armConfigTimer();
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
                // This does not consume the "logged once" memory: a replay
                // happens at most once per generation per slot anyway, and a
                // later live press on the same slot must still report its own
                // message.
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
 *
 * Any such signal counts as confirmation of our own request, whichever
 * reconfigure triggered it: the KWin config cache is reparsed before the signal
 * is emitted, so readConfig() is already fresh here and no "is this our reload?"
 * bookkeeping is needed.
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
    stopConfigTimer();
    replayPendingPresses();
}

/**
 * The configuration reload will not be confirmed any more, so the current values
 * are the best ones available: re-read them once more and replay whatever is
 * queued. Both halves are guarded, and applyConfig() is a no-op when the stored
 * values did not change.
 */
function rereadConfigAndReplay() {
    // Best effort: if KWin reparsed kwinrc but the configChanged signal was lost,
    // this picks the fresh values up. When nothing changed, the signature check
    // keeps applyConfig() a no-op.
    try {
        applyConfig();
    } catch (error) {
        warn("failed to apply configuration: " + error);
    }
    replayPendingPresses();
}

/**
 * The deadline expired without options.configChanged. Clearing awaitingConfig
 * keeps the reload request path alive instead of ignoring every later request,
 * and the queued presses are replayed so that no keypress is lost. The single
 * warning is the one report of the stuck reload; nothing else logs about it.
 */
function onConfigTimeout() {
    if (awaitingConfig) {
        awaitingConfig = false;
        warn("KWin did not confirm the configuration reload, using the current values");
    }
    if (!hasPendingPresses()) {
        return;
    }
    rereadConfigAndReplay();
}

/**
 * Watches the active window to find out when the settings dialog was used. KWin
 * does not tell scripts about a script-configuration change, so this is the only
 * way to know when to ask KWin to re-read kwinrc.
 */
function onWindowActivated(client) {
    if (isSettingsWindow(client)) {
        // Values are written when the dialog is applied or closed, so the reload
        // has to wait until focus leaves it. The latch is updated even while a
        // press is replayed: replaying can focus a settings window, and that one
        // is still up, so its Apply must not be missed.
        settingsWindowSeen = true;
        return;
    }
    if (replaying) {
        // Caused by replaying a press after a reload, which the user did not
        // trigger: the configuration was reloaded a moment ago, so only the
        // reload request of this focus loss is suppressed.
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
        if (configTimer) {
            return;
        }
        // Neither the press nor the reload request got a deadline, so waiting
        // would mean waiting forever. A toggle with a possibly stale
        // configuration beats a press that never happens: undo the parity flip
        // just made, say so once and fall through to the synchronous path.
        pendingPresses[index] = !pendingPresses[index];
        if (!noTimerFallbackLogged) {
            noTimerFallbackLogged = true;
            warn("no configuration timer is available, toggling with the configuration as it is");
        }
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
