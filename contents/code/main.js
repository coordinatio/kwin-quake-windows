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
   therefore asks KWin to re-read the file through its scripting interface
   (org.kde.kwin.Scripting.start) when the settings dialog loses focus and defers
   a press that arrives before the new values are visible, because readConfig()
   cannot be refreshed synchronously. A plain reconfigure, which works on every
   KWin, is the fallback for a KWin that does not answer the scripting call. See
   "How configuration reloading works" in README.md for the whole sequence and
   the trade-offs.
*/

var SLOT_COUNT = 7;

// The one deadline of the configuration machinery. It carries three guarantees:
// every deferred press has a deadline, a reload request that KWin never answers
// cannot latch, because callDBus() drops error replies and a timeout is the only
// way out, and the reconfigure fallback sent by the first expiry is given a
// deadline of its own. Both the request, every deferred press and the fallback
// re-arm it, so it fires CONFIG_TIMEOUT_MS after the last event that needed it,
// and whichever of those happened last is handled by the same handler.
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

// A reload was requested and neither the reply of the scripting call nor
// options.configChanged has settled it yet.
var awaitingConfig = false;

// The deadline of the current request expired once already and its reconfigure
// fallback was sent. Makes the fallback one per request instead of one per
// expiry, and turns the next expiry into "give up and use the current values".
var configFallbackSent = false;

// Identifies the reload request in flight. The reply callback closes over the id
// of its own request, so a late reply cannot complete a newer request's wait.
var configRequestId = 0;

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
// defensive anyway: a timeout can arrive half-way through a reload, and creating
// the timer can fail.
var configTimer = null;

// The deadline above is really ticking. Set only when start() returned, cleared
// whenever it is stopped or fires, so it is the one truth about whether a wait
// has an end. awaitingConfig is never left set without it: a latch whose deadline
// could not be armed would swallow every later request.
var configTimerArmed = false;

// Toggling without waiting is worth exactly one journal line: a press that cannot
// be deferred would otherwise repeat the warning on every keypress.
var deferralFallbackLogged = false;

// Creating the timer failed once already. QTimer does not start working later in
// a session, so the attempt and its warning are not repeated.
var configTimerUnavailable = false;

// Starting the timer failed once already. For the same reason the failure is not
// retried silently and its warning is one-shot: several code paths arm the same
// deadline for one press, so an ungated warning would repeat per press.
var configTimerStartFailedLogged = false;

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

/**
 * Reads one property of a client. A Client wrapper whose window is being
 * destroyed throws on every property read, and one such window must neither
 * swallow a press nor abort a loop over workspace.windowList(), so a failed read
 * is treated as an absent value.
 */
function clientRead(client, name, fallback) {
    if (!client) {
        return fallback;
    }
    try {
        return client[name];
    } catch (error) {
        return fallback;
    }
}

/** A string property of a client: "" when it is missing or unreadable. */
function clientText(client, name) {
    return text(clientRead(client, name, ""));
}

/**
 * Writes one flag of a client. Returns false when the write throws, which is what
 * a window being destroyed does; the caller then skips that window instead of
 * letting the exception escape into the other windows of the list.
 */
function clientWrite(client, name, value) {
    if (!client) {
        return false;
    }
    try {
        client[name] = value;
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Sets every toggle flag of one window. Returns false as soon as a write throws:
 * the window is going away, so the remaining flags and the activation are
 * pointless, but the press itself must not fail because of it.
 */
function setToggleFlags(client, hidden) {
    var names = ["onAllDesktops", "minimized", "skipTaskbar", "skipPager", "skipSwitcher"];
    for (var index = 0; index < names.length; ++index) {
        if (!clientWrite(client, names[index], hidden)) {
            return false;
        }
    }
    return true;
}

/**
 * Asks KWin to focus a client. Returns true when the request did not throw, which
 * is all it can mean: the assignment goes through KWin's activation policy, and
 * the policy can refuse it (for a hidden window, for example) without raising an
 * error. A wrapper whose window is being destroyed does throw, so the assignment
 * is guarded like a property write: the applied flags of that window stay.
 */
function clientActivate(client) {
    if (!client) {
        return false;
    }
    try {
        workspace.activeWindow = client;
        return true;
    } catch (error) {
        return false;
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
        var lower = String(value).toLowerCase();
        if (lower === "true" || lower === "on" || lower === "yes" || lower === "1") {
            return true;
        }
        if (lower === "false" || lower === "off" || lower === "no" || lower === "0") {
            return false;
        }
        // Not a spelling this script knows: a hand-edited kwinrc then means the
        // default, not "true".
        return fallback;
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
 * A compact signature of the stored slots: the enable flag and the pattern of
 * every slot, joined with NUL bytes, which neither of them can contain. Built by
 * hand, without JSON or any other helper the engine provides: the comparison has
 * to stay cheap (it runs on every reload), its result has to be deterministic,
 * and it must not change if this file - or a future engine release - gives one of
 * those helpers a different meaning.
 */
function slotSignature(raw) {
    var parts = [];
    for (var index = 0; index < SLOT_COUNT; ++index) {
        parts.push(raw[index].enabled ? "1" : "0", raw[index].pattern);
    }
    return parts.join("\u0000");
}

/**
 * Re-reads the seven slots and recompiles them when the stored values changed.
 */
function applyConfig() {
    var raw = readRawSlots();
    var signature = slotSignature(raw);
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

function endsWith(value, suffix) {
    return value.length >= suffix.length &&
        value.lastIndexOf(suffix) === value.length - suffix.length;
}

/**
 * Turns one window name into the bare module name: lower case, without the
 * ".desktop" suffix of a desktop file name and without the directory part of an
 * absolute path (desktopFileName may hold one when the file is not in a standard
 * location). An empty name stays empty.
 */
function normalizeWindowName(value) {
    var name = value.toLowerCase();
    var slash = name.lastIndexOf("/");
    if (slash !== -1) {
        name = name.slice(slash + 1);
    }
    if (endsWith(name, ".desktop")) {
        name = name.slice(0, name.length - ".desktop".length);
    }
    return name;
}

// The client properties that can name the settings host, in the order they are
// read. All of them are considered instead of the first non-empty one, because
// the sources disagree: a KCM inside System Settings can carry a generic resource
// class while its desktop file name still names the settings host.
var settingsNameProperties = ["resourceClass", "resourceName", "desktopFileName"];

/**
 * Matches one module name against the settings hosts: systemsettings,
 * plasma-systemsettings, plasma-settings, kdesystemsettings and reverse-DNS ids
 * like org.kde.systemsettings, plus every kcmshell module. The name ends with the
 * module name, so the suffix decides: a look-alike such as "not-settings-really"
 * or "plasma-settings-helper" is not a settings window, while
 * "org.kde.systemsettings" is.
 *
 * A trailing version number is not part of the name, so "systemsettings6" is
 * recognised exactly like the unversioned form. kcmshell is matched as a
 * contained segment rather than as a prefix, because the portal and standalone
 * forms are reverse-DNS ids such as org.kde.kcmshell6.
 */
function isSettingsName(name) {
    name = name.replace(/[0-9]+$/, "");
    if (!name) {
        return false;
    }
    if (name.indexOf("kcmshell") !== -1) {
        return true;
    }
    return endsWith(name, "settings");
}

/**
 * True when one of the window's names identifies it as a host of the settings
 * dialog. The scan stops at the first property that does, so the common case
 * reads one property instead of three.
 *
 * Known trade-off, kept on purpose: a third-party window whose name merely ends
 * with "settings" also counts as a settings window. Missing the real dialog costs
 * a stale toggle, while a false positive only costs one deferred press and one
 * reconfigure.
 */
function isSettingsWindow(client) {
    for (var index = 0; index < settingsNameProperties.length; ++index) {
        var name = normalizeWindowName(clientText(client, settingsNameProperties[index]));
        if (isSettingsName(name)) {
            return true;
        }
    }
    return false;
}

/**
 * The active window, or null when reading it throws. Only the property access on
 * the workspace object is guarded here; reads on the client itself go through
 * clientRead().
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
 * dialog was used, so a press has to wait for the reload to be confirmed instead
 * of toggling a window from a stale configuration. Two reasons are tracked
 * explicitly: a reload was requested and not confirmed yet, and the dialog was
 * activated since the last reload (completeConfigReload() rebuilds that latch
 * from the active window, so a second Apply while the dialog stays focused is
 * already covered by it). The third check - is a settings window focused right
 * now - is a cheap safety net for an activation that never reached the script; it
 * is not what catches the second Apply.
 */
function configMayBeStale() {
    if (awaitingConfig || settingsWindowSeen) {
        return true;
    }
    return isSettingsWindow(currentActiveWindow());
}

/**
 * Asks KWin to re-read kwinrc through its scripting interface, and falls back to
 * a plain reconfigure when that is not answered (see onConfigTimeout()).
 *
 * The primary call is Scripting::start(): in KWin 6.8 it reparses kwinrc
 * synchronously inside the call (Scripting::queryScriptsToLoad()), so its reply is
 * a deterministic "the configuration is fresh now" moment instead of a guess. It
 * does not re-evaluate the window rules of every window the way
 * Workspace::slotReconfigure() does, and it does not restart this script either:
 * Script::run() returns immediately for an already running script.
 *
 * Returns true when a deferred press may wait: a reload is pending and the shared
 * deadline is really ticking, so something will end the wait even if the answer
 * never arrives. Returns false when waiting would strand the press - the deadline
 * could not be armed (no QTimer here, or start() threw) or the call itself threw
 * - so the caller has to toggle synchronously instead. Everything is decided by
 * configTimerArmed, never by "is there a timer object?": a created but unarmed
 * timer ends nothing.
 */
function requestConfigReload() {
    if (awaitingConfig) {
        if (configTimerArmed) {
            // A request is already in flight: the press waits for the same answer
            // and shares the same deadline.
            return true;
        }
        // The latch has no deadline left to end it, so it would swallow every
        // later request. Drop it and send a fresh one below instead. While the
        // invariants above hold this branch is unreachable - awaitingConfig is
        // only ever set together with an armed deadline - so it is a backstop
        // that keeps a future change from leaving a latch that eats requests.
        awaitingConfig = false;
        configFallbackSent = false;
    }
    awaitingConfig = true;
    configFallbackSent = false;
    configRequestId += 1;
    var requestId = configRequestId;
    armConfigTimer();
    if (!configTimerArmed) {
        // The request is still worth sending - the reply or
        // options.configChanged may arrive - but nothing here can end the wait,
        // so no latch is kept.
        awaitingConfig = false;
    }
    // Script::callDBus() takes the last callable argument as the reply callback
    // and drops it for an error reply: it logs "Received D-Bus message is error"
    // to kwin_scripting and never calls the function. On a KWin without this
    // method the callback is therefore never reached, and the deadline armed
    // above is what unsticks it by falling back to reconfigure.
    try {
        callDBus("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "start",
                 function () {
                     onConfigReply(requestId);
                 });
    } catch (error) {
        awaitingConfig = false;
        configFallbackSent = false;
        stopConfigTimer();
        warn("could not ask KWin to reload its configuration: " + error);
        // No reload is pending any more, so a deferred press has nothing left to
        // wait for.
        return false;
    }
    // The request survived, but waiting still needs a deadline: without one only
    // the reply or options.configChanged could end the wait, and neither may
    // ever come.
    return configTimerArmed;
}

/**
 * Sends the reconfigure call that works on every KWin, the fallback of
 * onConfigTimeout() when the scripting interface did not answer. Its answer is
 * options.configChanged, like any other reconfigure, so nothing here waits for
 * the call itself.
 *
 * Returns false when the call threw, which only a JavaScript-level failure does:
 * Script::callDBus() never throws for a D-Bus error.
 */
function requestReconfigureFallback() {
    try {
        callDBus("org.kde.KWin", "/KWin", "org.kde.KWin", "reconfigure");
        return true;
    } catch (error) {
        warn("could not ask KWin to reload its configuration: " + error);
        return false;
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
        // Only a start() that returned makes the deadline real. A throwing one
        // leaves the timer in an unknown state, which is treated as not armed.
        configTimerArmed = true;
    } catch (error) {
        configTimerArmed = false;
        if (!configTimerStartFailedLogged) {
            configTimerStartFailedLogged = true;
            warn("could not start the configuration timer: " + error);
        }
    }
}

function stopConfigTimer() {
    configTimerArmed = false;
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

/**
 * Undoes notePendingPress() when the press is not deferred after all, so the
 * parity bit does not stay queued for a replay that should not happen.
 */
function clearPendingPress(index) {
    pendingPresses[index] = !pendingPresses[index];
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
 * The configuration is fresh now - the scripting call replied, or
 * options.configChanged arrived - so this is the moment to recompile the slots,
 * to stop the deadline and to replay whatever was queued for the new values.
 *
 * Both events mean the same thing and both run this, which is what keeps them
 * idempotent when the same reload is announced twice: applyConfig() is a no-op
 * for an unchanged signature, the second call finds no armed deadline left, and
 * replayPendingPresses() clears the queue before touching it, so the presses are
 * replayed once. "The dialog was used since the last reload" is rebuilt rather
 * than cleared, so a second arrival cannot lose a latch the first one set.
 */
function completeConfigReload() {
    try {
        applyConfig();
    } catch (error) {
        warn("failed to apply configuration: " + error);
    }
    awaitingConfig = false;
    configFallbackSent = false;
    // With a settings window still focused the flag only means "the dialog is
    // still up, so another Apply may still come". With a normal window focused it
    // becomes false, which keeps the flag self-healing when the dialog was closed
    // without any window becoming active afterwards.
    settingsWindowSeen = isSettingsWindow(currentActiveWindow());
    stopConfigTimer();
    replayPendingPresses();
}

/**
 * The scripting interface replied. KWin reparsed kwinrc inside that call, so
 * readConfig() is already fresh here; nothing is inferred. The request id keeps a
 * late reply of an older request from completing the wait of a newer one, which
 * would replay the queued presses against a configuration that may still be the
 * old one.
 */
function onConfigReply(requestId) {
    if (requestId !== configRequestId) {
        return;
    }
    completeConfigReload();
}

/**
 * options.configChanged arrived, so readConfig() now returns the new values.
 *
 * Any such signal counts as confirmation, whichever reconfigure triggered it: the
 * KWin config cache is reparsed before the signal is emitted, so readConfig() is
 * already fresh here and no "is this our reload?" bookkeeping is needed.
 */
function onConfigChanged() {
    completeConfigReload();
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
 * The deadline expired without an answer. It has two stages, one warning each and
 * the fallback exactly once per request:
 *
 * The first expiry means the scripting call was not answered - an older KWin
 * without that method drops the error reply, so the callback never comes. The
 * reconfigure call, which works everywhere, is sent once and the deadline is
 * re-armed to give its options.configChanged a chance to arrive; KWin coalesces
 * reconfigure requests with its own 200 ms timer, so the request itself is not
 * debounced here.
 *
 * The second expiry means the fallback did not answer either. The current values
 * are then the best ones available: the latch is cleared (otherwise one
 * unanswered request would ignore every later one), one line is written, and the
 * configuration is re-read and the queued presses replayed once more. A press is
 * therefore never lost because KWin stayed silent.
 */
function onConfigTimeout() {
    // The single-shot timer stopped itself before this handler ran.
    configTimerArmed = false;
    if (awaitingConfig && !configFallbackSent) {
        configFallbackSent = true;
        // One line per request, not one per expired deadline: a press re-arms the
        // same deadline without asking for a new fallback.
        warn("KWin did not answer the script reload request, falling back to reconfigure");
        if (requestReconfigureFallback()) {
            armConfigTimer();
            if (configTimerArmed) {
                // The fallback answers through options.configChanged, so waiting is
                // safe; the next expiry is what ends it if that never arrives.
                return;
            }
        }
        // The fallback could not be sent or has no deadline to be waited for, so
        // finish with the values that are available instead of waiting forever.
        awaitingConfig = false;
        configFallbackSent = false;
    } else if (awaitingConfig) {
        awaitingConfig = false;
        configFallbackSent = false;
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
        // trigger: focus demonstrably left the dialog and the configuration was
        // reloaded a moment ago, so the latch can be cleared. Only the reload
        // request of this focus loss is suppressed: one was just answered.
        settingsWindowSeen = false;
        return;
    }
    if (settingsWindowSeen) {
        settingsWindowSeen = false;
        requestConfigReload();
    }
}

/**
 * True when the caption matches the expression of one slot. An empty caption
 * never matches, so a catch-all expression does not touch caption-less windows.
 * Taking the caption as an argument lets a caller that reads it once - the
 * desktop-change fixup - test every active slot against the same string.
 */
function captionMatches(caption, index) {
    var regex = slotRegex[index];
    if (!regex || !caption) {
        return false;
    }
    return regex.test(caption);
}

/** True when the caption of a client matches the expression of one slot. */
function isRelevant(client, index) {
    if (!client) {
        return false;
    }
    return captionMatches(clientText(client, "caption"), index);
}

/**
 * configIsFresh is true when readConfig() is known to return the current values,
 * i.e. for a press that is replayed after the configuration was reloaded.
 */
function toggleWindow(index, configIsFresh) {
    if (!configIsFresh && configMayBeStale()) {
        // readConfig() still holds the old values, so the press is queued instead
        // of toggling a stale window.
        notePendingPress(index);
        if (requestConfigReload()) {
            return;
        }
        // The request could not be given a deadline (it threw, or no timer could
        // be created or started), so waiting would mean waiting forever. A toggle
        // with a possibly stale configuration beats a press that never happens:
        // undo the parity flip just made, say so once and fall through to the
        // synchronous path.
        clearPendingPress(index);
        if (!deferralFallbackLogged) {
            deferralFallbackLogged = true;
            warn("could not defer the press until the configuration is reloaded, " +
                 "toggling with the configuration as it is");
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
        var client = allClients[i];
        if (!isRelevant(client, index)) {
            continue;
        }
        matched = true;
        var prevMini = clientRead(client, "minimized", false);
        if (!setToggleFlags(client, !prevMini)) {
            // A window that throws on a flag write is going away; the press must
            // not turn into an error because of it. Another window may match the
            // same slot and still be alive, so the scan goes on instead of
            // giving up on the press.
            warn("could not set the toggle flags of a window matching slot " + (index + 1));
            continue;
        }
        if (prevMini && !clientActivate(client)) {
            // The window is going away: it has been toggled, it just could not be
            // asked to take focus. The press itself is done.
            warn("could not activate a window matching slot " + (index + 1));
        }
        break; // at most one window per slot is toggled
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
        var client = allClients[i];
        // The caption is read once per window and then tested against every
        // active slot: this loop walks the whole window list on every desktop
        // switch, so a property read per slot is wasted work.
        var caption = clientText(client, "caption");
        if (!caption) {
            continue;
        }
        for (var j = 0; j < activeSlots.length; ++j) {
            if (captionMatches(caption, activeSlots[j])) {
                // Assigning the same value twice is pointless, so the first
                // matching slot decides for this window. A window that is going
                // away is skipped here and the rest of the list is still fixed up.
                var minimized = clientRead(client, "minimized", null);
                if (minimized === null) {
                    // The read failed, so the flag this window should get is
                    // unknown. Writing the false fallback would clear
                    // skipTaskbar of a window the fixup could not read; another
                    // matching slot reads the same property and gives up the
                    // same way, so the window stays untouched.
                    continue;
                }
                clientWrite(client, "skipTaskbar", minimized);
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
