#!/usr/bin/env node
// Logic tests for contents/code/main.js, run against mocked KWin globals.
//
//   node tests/main-js-test.mjs
//
// The mocks follow what KWin 6.8 actually exposes to a javascript script:
// readConfig, registerShortcut, callDBus, workspace, options and QTimer
// (QTimer maps to KWin::ScriptTimer, i.e. interval/singleShot properties,
// start()/stop() slots and the timeout signal - there is no isActive()).
// No dependencies, plain ESM.
//
// The command-line side of the same script - the real QJSEngine, the real
// QTimer metaobject and a timer that really fires - is covered by the optional
// tests/script-engine-test.cpp and its runner.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_PATH = fileURLToPath(new URL('../contents/code/main.js', import.meta.url));
const MAIN_XML_PATH = path.join(REPO_ROOT, 'contents/config/main.xml');
const CONFIG_UI_PATH = path.join(REPO_ROOT, 'contents/ui/config.ui');
const POT_PATH = path.join(REPO_ROOT, 'po/quakewindows.pot');
const METADATA_PATH = path.join(REPO_ROOT, 'metadata.json');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

let failures = 0;

function check(fn, message) {
    try {
        fn();
        console.log('ok:   ' + message);
    } catch (error) {
        failures += 1;
        console.log('FAIL: ' + message + '\n      ' + error.message);
    }
}

function signal() {
    return { fns: [], connect(fn) { this.fns.push(fn); } };
}

class MockTimer {
    constructor() {
        this.interval = 0;
        this.singleShot = false;
        this.timeout = signal();
        this.running = false;
        // How often start() was called: the tests use it to prove that a second
        // deferral re-arms the same timer object instead of creating a new one.
        this.starts = 0;
    }
    start(ms) {
        if (typeof ms === 'number') {
            this.interval = ms;
        }
        this.running = true;
        this.starts += 1;
        // Restarting a timer must not add a second entry: the tests count the
        // timer objects that were created, not the start() calls.
        if (!harness.timers.includes(this)) {
            harness.timers.push(this);
        }
    }
    stop() {
        this.running = false;
    }
    fire() {
        // A timer that is not running delivers no timeout, exactly like Qt. The
        // return value lets a test tell "nothing was armed" from "fired", so no
        // test can silently rely on firing a stopped timer.
        if (!this.running) {
            return false;
        }
        // A single-shot timer stops before its handler runs.
        this.running = false;
        for (const fn of this.timeout.fns) {
            fn();
        }
        return true;
    }
}

function makeWindow(caption, extra = {}) {
    return {
        caption,
        minimized: false,
        onAllDesktops: false,
        skipTaskbar: false,
        skipPager: false,
        skipSwitcher: false,
        resourceClass: 'app',
        ...extra,
    };
}

// ----------------------------------------------------------------- harness state
const harness = {
    timers: [],
    dbus: [],
    shortcuts: [],
    warnings: [],
    infos: [],
};

function createContext(state) {
    const config = { ...state };
    const context = {
        console: {
            warn: (...args) => harness.warnings.push(args.join(' ')),
            info: (...args) => harness.infos.push(args.join(' ')),
            log: (...args) => harness.infos.push(args.join(' ')),
        },
        readConfig(key, fallback) {
            return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback;
        },
        registerShortcut(id, name, key, callback) {
            harness.shortcuts.push({ id, name, key, callback });
        },
        callDBus(a, b, c, d) {
            // KWin drops error replies, so a failed request is simply silent.
            harness.dbus.push({ service: a, path: b, iface: c, method: d });
        },
        QTimer: MockTimer,
        options: { configChanged: signal() },
        workspace: {
            windows: state.windows || [],
            currentDesktopChanged: signal(),
            windowActivated: signal(),
            windowListCalls: 0,
            windowList() {
                this.windowListCalls += 1;
                return this.windows;
            },
            _activeWindow: state.activeWindow || null,
            get activeWindow() {
                return this._activeWindow;
            },
            // Activating a window emits windowActivated, which is what makes a
            // replayed press observable.
            set activeWindow(client) {
                this._activeWindow = client;
                for (const fn of this.windowActivated.fns) {
                    fn(client);
                }
            },
        },
    };
    return { context, config };
}

function reset() {
    harness.timers = [];
    harness.dbus = [];
    harness.shortcuts = [];
    harness.warnings = [];
    harness.infos = [];
}

function load(state) {
    reset();
    const { context, config } = createContext(state);
    vm.createContext(context);
    if (state.throwInApplyConfig) {
        // Every readConfig() access inside applyConfig() is guarded, so poisoning
        // JSON.stringify is the only remaining way to make it throw. The guard in
        // init() is what has to survive that.
        context.JSON = {
            stringify() {
                throw new Error('poisoned JSON');
            },
        };
    }
    if (state.failTimerCreation) {
        // The first N QTimer constructions throw, which is the case makeConfigTimer()
        // turns into a null timer: the script then has to work without the
        // configuration deadline at all. Infinity makes every construction fail.
        const HostTimer = context.QTimer;
        let constructions = 0;
        context.QTimer = function () {
            constructions += 1;
            if (constructions <= state.failTimerCreation) {
                throw new Error('no timer available');
            }
            return new HostTimer();
        };
    }
    vm.runInContext(SOURCE, context, { filename: 'main.js' });
    return { context, config };
}

const settingsWindow = () => makeWindow('System Settings', { resourceClass: 'systemsettings' });

function reconfigureCalls() {
    return harness.dbus.filter((call) => call.method === 'reconfigure');
}

function runningTimers() {
    return [...new Set(harness.timers.filter((timer) => timer.running))];
}

// The configuration deadline is a single lazily created timer, shared by the
// reload request and the deferred presses.
function configTimer(context) {
    assert.ok(context.configTimer instanceof MockTimer, 'the configuration timer exists');
    return context.configTimer;
}

// KWin makes the new window active before it emits windowActivated, so the mock
// does the same: the handler always observes the client it is told about through
// workspace.activeWindow. That is what exercises configMayBeStale()'s
// isSettingsWindow(currentActiveWindow()) branch.
//
// deliver: false only records the active window, for the cases where the script
// does not see the activation signal (KWin drops it for the window that was
// already active, for example).
function activate(context, client, { deliver = true } = {}) {
    context.workspace._activeWindow = client;
    if (!deliver) {
        return;
    }
    context.workspace.windowActivated.fns.forEach((fn) => fn(client));
}

function setActive(context, client) {
    activate(context, client, { deliver: false });
}

function emitConfigChanged(context) {
    context.options.configChanged.fns.forEach((fn) => fn());
}

// The parity state is an array of undefined/true entries; the tests only care
// about which slots are pending.
function pendingIndexes(context) {
    const pending = [];
    for (let index = 0; index < context.SLOT_COUNT; ++index) {
        if (context.pendingPresses[index]) {
            pending.push(index);
        }
    }
    return pending;
}

// ================================================================= 1. registration
{
    const { context } = load({ windows: [] });

    check(() => {
        assert.equal(harness.shortcuts.length, 7);
        for (let i = 0; i < 7; ++i) {
            assert.equal(harness.shortcuts[i].id, 'QuakeWindows ' + (i + 1));
            assert.equal(harness.shortcuts[i].name, 'Toggle Window ' + (i + 1));
            assert.equal(harness.shortcuts[i].key, '');
            assert.equal(typeof harness.shortcuts[i].callback, 'function');
        }
    }, 'registers QuakeWindows 1..7 with unchanged ids, names and empty default key');

    check(() => {
        assert.equal(harness.timers.length, 0, 'no timer object is created at init');
        assert.equal(runningTimers().length, 0, 'no timer is running after init');
        assert.equal(context.configTimer, null,
            'the configuration timer is created lazily');
        assert.equal(context.initialized, true, 'initialized is set last by init()');
    }, 'init creates no timer object at all and leaves the configuration timer unarmed');

    check(() => {
        assert.equal(reconfigureCalls().length, 0);
        assert.equal(harness.warnings.length, 0);
        assert.match(harness.infos.join('\n'), /active slots: none/);
    }, 'unconfigured slots are inactive and no reconfigure is requested on startup');
}

// ================================= 1b. applyConfig() failing during init() (finding 1)
{
    const { context } = load({ WindowName1: '^quake$', throwInApplyConfig: true });

    check(() => {
        assert.match(harness.warnings.join('\n'), /failed to apply configuration: .*poisoned JSON/);
        assert.equal(harness.shortcuts.length, 7, 'the shortcuts are registered anyway');
        assert.equal(context.workspace.currentDesktopChanged.fns.length, 1,
            'currentDesktopChanged is connected anyway');
        assert.equal(context.workspace.windowActivated.fns.length, 1,
            'windowActivated is connected anyway');
        assert.equal(context.options.configChanged.fns.length, 1,
            'options.configChanged is connected anyway');
        assert.equal(context.initialized, true, 'init() still completes');
    }, 'a failing applyConfig() during init() is caught and does not stop the setup');

    check(() => {
        assert.doesNotThrow(() => harness.shortcuts[0].callback(),
            'a press on the unusable slot does not escape into KWin');
        assert.match(harness.infos.join('\n'), /slot 1 is disabled or has no valid expression/);
        assert.doesNotThrow(() => emitConfigChanged(context),
            'a configuration change does not escape into KWin');
        assert.match(harness.warnings.join('\n'), /failed to apply configuration/);
    }, 'after the failed init the script stays inert but guarded');
}

// ================================ 1c. a failing applyConfig() commits nothing (finding 3)
{
    const window1 = makeWindow('quake');
    const { context, config } = load({
        WindowName1: '^quake$',
        WindowName2: '^other$',
        windows: [window1],
    });

    check(() => {
        // Slot 3 is unusable, so the "logged once" memory is filled before the
        // failing generation.
        harness.shortcuts[2].callback();
        assert.match(harness.infos.join('\n'), /slot 3 is disabled or has no valid expression/);

        const signature = context.configSignature;
        const compiled = context.slotRegex;
        const active = context.activeSlots;
        const logged = context.inactiveSlotLogged;
        assert.notEqual(signature, null, 'the first generation was applied');

        // The second pattern compiles, but building its journal line explodes, so
        // applyConfig() throws in the middle of the loop.
        // The host constructor: a vm context does not expose its intrinsics as
        // properties of the sandbox object, so the spy needs one from outside.
        const HostRegExp = RegExp;
        let constructed = 0;
        context.RegExp = function (pattern) {
            constructed += 1;
            if (constructed === 2) {
                return { get source() { throw new Error('broken generation'); } };
            }
            return new HostRegExp(pattern);
        };

        config.WindowName1 = '^renamed$';
        const warningsBefore = harness.warnings.length;
        assert.doesNotThrow(() => emitConfigChanged(context));
        assert.match(harness.warnings[warningsBefore],
            /failed to apply configuration: .*broken generation/);
        assert.equal(context.configSignature, signature,
            'the broken generation is not marked as applied');
        assert.equal(context.slotRegex, compiled, 'the compiled slots are untouched');
        assert.equal(context.activeSlots, active, 'the active slots are untouched');
        assert.equal(context.inactiveSlotLogged, logged,
            'the "logged once" memory of the applied generation survives');

        // The same generation is still in force, so the unusable slot stays quiet.
        const before = harness.infos.length;
        harness.shortcuts[2].callback();
        assert.equal(harness.infos.length, before, 'the slot is not reported a second time');

        // Once applyConfig() can run again the new generation is committed as a
        // whole and the "logged once" memory starts over.
        delete context.RegExp;
        emitConfigChanged(context);
        assert.notEqual(context.configSignature, signature, 'the new generation is applied');
        assert.notEqual(context.slotRegex, compiled, 'the compiled slots were replaced');
        assert.match(harness.infos.join('\n'), /active slots: 1: \^renamed\$/);
        const after = harness.infos.length;
        harness.shortcuts[2].callback();
        assert.match(harness.infos.slice(after).join('\n'),
            /slot 3 is disabled or has no valid expression/,
            'a new generation reports the unusable slot again');
    }, 'an applyConfig() that throws mid-loop commits nothing and keeps the old generation');
}

// ===================== 1d. a configuration change must not re-register (finding 6)
//
// The original implementation called init() again from options.configChanged,
// which registered every shortcut a second time and doubled the signal handlers.
{
    const { context, config } = load({ WindowName1: '^quake$' });

    check(() => {
        assert.equal(harness.shortcuts.length, 7, 'init() registered seven shortcuts once');

        config.WindowName1 = '^other$';
        emitConfigChanged(context);
        config.WindowName2 = '^third$';
        emitConfigChanged(context);
        emitConfigChanged(context);

        assert.equal(harness.shortcuts.length, 7,
            'a configuration change registers no shortcut again (got '
            + harness.shortcuts.length + ' registerShortcut calls)');
        assert.equal(context.workspace.currentDesktopChanged.fns.length, 1,
            'currentDesktopChanged still has one listener');
        assert.equal(context.workspace.windowActivated.fns.length, 1,
            'windowActivated still has one listener');
        assert.equal(context.options.configChanged.fns.length, 1,
            'options.configChanged still has one listener');
        assert.equal(harness.warnings.length, 0, 'nothing warns');
        assert.match(harness.infos.join('\n'), /active slots: 1: \^other\$, 2: \^third\$/,
            'the new configuration was applied');
    }, 'a configChanged after init re-applies the values without re-registering anything');
}

// ====================================================== 2. matching / enabled flags
{
    const window1 = makeWindow('some window');
    const window2 = makeWindow('Rocket.Chat');
    const state = {
        WindowName1: '^some window$',
        WindowName2: '^.*Rocket\\.Chat.*$',
        WindowName3: '[invalid(',
        Enabled4: false,
        WindowName4: 'should not matter',
        WindowName5: '',
        windows: [window1, window2],
    };
    const { context } = load(state);

    check(() => {
        const active = harness.infos.join('\n');
        assert.match(active, /1: \^some window\$/);
        assert.match(active, /2: \^\.\*Rocket\\\.Chat/);
        assert.doesNotMatch(active, /4:/);
        assert.doesNotMatch(active, /5:/);
    }, 'compiles enabled slots only and reports them');

    check(() => {
        const warnings = harness.warnings.join('\n');
        assert.match(warnings, /WindowName3/);
        assert.match(warnings, /invalid regular expression/);
    }, 'an invalid expression is reported and does not abort the other slots');

    check(() => {
        // Slot 1 must still work although slot 3 is broken.
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, true);
        assert.equal(window1.onAllDesktops, true);
        assert.equal(window1.skipTaskbar, true);
        assert.equal(window1.skipPager, true);
        assert.equal(window1.skipSwitcher, true);
    }, 'a valid slot still toggles although another slot holds an invalid regex');

    check(() => {
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, false);
        assert.equal(window1.onAllDesktops, false);
        assert.equal(window1.skipTaskbar, false);
    }, 'a second press restores the previous state');

    check(() => {
        const before = harness.infos.length;
        harness.shortcuts[2].callback();  // invalid regex slot
        harness.shortcuts[3].callback();  // Enabled4=false
        harness.shortcuts[4].callback();  // empty pattern
        harness.shortcuts[6].callback();  // never configured
        assert.equal(window1.minimized, false);
        assert.equal(window2.minimized, false);

        const logged = harness.infos.slice(before).join('\n');
        assert.match(logged, /slot 3 is disabled or has no valid expression/);
        assert.match(logged, /slot 4 is disabled or has no valid expression/);
        assert.match(logged, /slot 7 is disabled or has no valid expression/);
    }, 'disabled, empty, invalid and unconfigured slots log one info line and never throw');

    check(() => {
        // Nothing toggled above, so the configuration never became stale.
        assert.equal(reconfigureCalls().length, 0);
        assert.deepEqual(pendingIndexes(context), []);
    }, 'pressing an inactive slot does not request a configuration reload');
}

// =================================== 2b. a slot matching nothing (finding 5)
{
    const window1 = makeWindow('something else');
    load({ WindowName1: '^typo$', windows: [window1] });

    check(() => {
        const before = harness.infos.length;
        harness.shortcuts[0].callback();
        const logged = harness.infos.slice(before).join('\n');
        assert.match(logged, /no window matches slot 1/);
        assert.equal(window1.minimized, false, 'nothing was toggled');
        assert.equal(reconfigureCalls().length, 0,
            'a valid expression never requests a reload');
    }, 'a slot with a valid expression that matches nothing logs one info line');

    check(() => {
        // The same report must not be repeated on every press forever (finding 3).
        const before = harness.infos.length;
        harness.shortcuts[0].callback();
        harness.shortcuts[0].callback();
        assert.equal(harness.infos.length, before,
            'the "no window matches" line is written once per configuration');
    }, 'a slot matching nothing is reported once per configuration, not once per press');
}

// ================================ 2d. journal noise of unusable slots (finding 3)
{
    const window1 = makeWindow('quake');
    const { context, config } = load({
        Enabled1: false, WindowName1: 'quake',
        WindowName2: '[invalid(',
        WindowName3: '   ',
        // A valid slot whose expression matches no window at all.
        WindowName4: '^typo$',
        windows: [window1],
    });

    check(() => {
        const before = harness.infos.length;
        for (let round = 0; round < 3; ++round) {
            for (const slot of [0, 1, 2, 3]) {
                harness.shortcuts[slot].callback();
            }
        }
        const logged = harness.infos.slice(before).join('\n');
        for (const slot of [1, 2, 3]) {
            assert.equal(logged.match(new RegExp('slot ' + slot + ' is disabled', 'g'), []).length, 1,
                'slot ' + slot + ' is reported once');
        }
        assert.equal(logged.match(/no window matches slot 4/g, []).length, 1,
            'the unmatched slot is reported once');
        assert.equal(window1.minimized, false, 'no press toggled anything');
    }, 'each unusable slot fills the journal once per configuration generation');

    check(() => {
        // A new generation resets the memory, so a slot that is still unusable is
        // reported once again after the configuration changed.
        config.WindowName4 = '^also a typo$';
        emitConfigChanged(context);
        const before = harness.infos.length;
        harness.shortcuts[0].callback();
        harness.shortcuts[3].callback();
        const logged = harness.infos.slice(before).join('\n');
        assert.match(logged, /slot 1 is disabled or has no valid expression/);
        assert.match(logged, /no window matches slot 4/);
    }, 'a new configuration generation reports the unusable slots again');
}

// ===================================================== 2c. readBool string coercion
{
    const window1 = makeWindow('quake');
    load({
        Enabled1: 'false', WindowName1: 'quake',
        Enabled2: '0', WindowName2: 'quake',
        Enabled3: 'true', WindowName3: 'quake',
        Enabled4: '1', WindowName4: 'quake',
        windows: [window1],
    });

    check(() => {
        const active = harness.infos.join('\n');
        assert.match(active, /3: quake/);
        assert.match(active, /4: quake/);
        assert.doesNotMatch(active, /1: quake/);
        assert.doesNotMatch(active, /2: quake/);
    }, 'the strings "false" and "0" disable a slot, "true" and "1" enable it');

    check(() => {
        harness.shortcuts[0].callback();
        harness.shortcuts[1].callback();
        assert.equal(window1.minimized, false, 'the disabled slots did not toggle');
        const logged = harness.infos.join('\n');
        assert.match(logged, /slot 1 is disabled or has no valid expression/);
        assert.match(logged, /slot 2 is disabled or has no valid expression/);
        harness.shortcuts[2].callback();
        assert.equal(window1.minimized, true, 'the slot enabled by "true" toggles');
    }, 'a slot disabled by the string "false" or "0" never toggles');
}

// ============================================ 3. pattern compilation edge cases
{
    const spaced = makeWindow('Title ');
    const plain = makeWindow('Title');
    const { context } = load({
        WindowName1: '^Title $',       // deliberately ends with a space
        WindowName2: '   ',            // whitespace only: disabled
        WindowName3: '^Title$',
        windows: [spaced, plain],
    });

    check(() => {
        const active = harness.infos.join('\n');
        assert.match(active, /1: \^Title \$/);
        assert.doesNotMatch(active, /2:/);
        assert.match(active, /3: \^Title\$/);
    }, 'a pattern with a trailing space is compiled verbatim, a whitespace-only one is disabled');

    check(() => {
        harness.shortcuts[0].callback();
        assert.equal(spaced.minimized, true, 'the trailing space is significant');
        assert.equal(plain.minimized, false);
        harness.shortcuts[0].callback();
    }, 'the trailing-space pattern matches only the caption that really has the space');

    check(() => {
        harness.shortcuts[1].callback();
        assert.match(harness.infos.join('\n'),
            /slot 2 is disabled or has no valid expression/);
        assert.equal(spaced.minimized, false);
        assert.equal(plain.minimized, false);
    }, 'the whitespace-only pattern behaves like an empty slot');

    check(() => {
        // Windows whose properties are null/undefined must not throw anywhere:
        // neither during matching nor while filtering the settings windows.
        const context2 = load({
            WindowName4: 'anything',
            windows: [{ caption: undefined, resourceClass: undefined, resourceName: undefined, minimized: false }],
        }).context;
        activate(context2, context2.workspace.windows[0]);
        activate(context2, undefined);
        activate(context2, null);
        harness.shortcuts[3].callback();
        assert.equal(reconfigureCalls().length, 0, 'undefined properties are not a settings window');
    }, 'undefined caption/resourceClass/resourceName never throw and never look like a settings window');
}

// ============================================================ 4. focus-driven reload
{
    const window1 = makeWindow('first title');
    const state = { WindowName1: 'first title', windows: [window1] };
    const { context, config } = load(state);

    check(() => {
        activate(context, settingsWindow());
        assert.equal(context.settingsWindowSeen, true);
        assert.equal(reconfigureCalls().length, 0,
            'activating the dialog alone must not reconfigure');
        activate(context, makeWindow('other'));
        assert.equal(context.settingsWindowSeen, false);
        assert.equal(context.awaitingConfig, true);
        assert.equal(reconfigureCalls().length, 1, 'leaving the dialog reconfigures once');
        assert.deepEqual(reconfigureCalls()[0], {
            service: 'org.kde.KWin',
            path: '/KWin',
            iface: 'org.kde.KWin',
            method: 'reconfigure',
        });
    }, 'focus entering and leaving the settings dialog triggers exactly one reconfigure');

    check(() => {
        activate(context, makeWindow('other'));
        activate(context, makeWindow('another'));
        assert.equal(reconfigureCalls().length, 1,
            'no request is repeated while configChanged is still missing');
        const timer = configTimer(context);
        assert.equal(timer.singleShot, true, 'the deadline is single shot');
        assert.equal(timer.interval, 1000, 'the deadline is the 1 s configuration timeout');
        assert.equal(timer.running, true, 'the deadline of the unanswered request is armed');
        assert.deepEqual(runningTimers(), [timer],
            'exactly one timer object is armed for a plain focus change');
    }, 'no repeated reconfigure requests while the previous one is unanswered');

    check(() => {
        config.WindowName2 = '^second window$';
        const second = makeWindow('second window');
        context.workspace.windows = [window1, second];
        emitConfigChanged(context);
        assert.equal(context.awaitingConfig, false);
        assert.match(harness.infos.join('\n'), /2: \^second window\$/);
        harness.shortcuts[1].callback();
        assert.equal(second.minimized, true);
        harness.shortcuts[1].callback();
        assert.equal(second.minimized, false);
    }, 'options.configChanged recompiles the slots and they take effect immediately');

    check(() => {
        activate(context, settingsWindow());
        activate(context, makeWindow('third'));
        assert.equal(reconfigureCalls().length, 2,
            'a completed reload allows the next dialog visit to reload again');
        emitConfigChanged(context);
        assert.equal(context.awaitingConfig, false);
    }, 'a second dialog visit reloads again once the previous reload completed');
}

// ============================================ 5. deferred hotkey press and replay
{
    const window1 = makeWindow('first title');
    const second = makeWindow('second window');
    const state = { WindowName1: 'first title', windows: [window1, second] };
    const { context, config } = load(state);

    check(() => {
        activate(context, settingsWindow());
        assert.equal(context.settingsWindowSeen, true);
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, false, 'the stale window is not toggled');
        assert.equal(second.minimized, false);
        assert.deepEqual(pendingIndexes(context), [0], 'the press is pending');
        assert.equal(reconfigureCalls().length, 1, 'the press requests a reload itself');
        const timer = configTimer(context);
        assert.equal(timer.singleShot, true);
        assert.equal(timer.interval, 1000);
        assert.equal(timer.running, true, 'the deadline is armed');
        assert.equal(harness.timers.length, 1,
            'the request and the press share one timer object');
    }, 'a hotkey pressed while the configuration is stale is deferred, not toggled');

    check(() => {
        config.WindowName1 = '^second window$';
        emitConfigChanged(context);
        assert.deepEqual(pendingIndexes(context), [], 'no press is pending any more');
        assert.equal(configTimer(context).running, false, 'the deadline is stopped');
        assert.equal(second.minimized, true, 'the replayed press used the fresh expression');
        assert.equal(window1.minimized, false, 'the old expression was not used');
    }, 'options.configChanged replays the pending press with the fresh configuration');

    check(() => {
        // The replay happened while the dialog was still focused, so the latch
        // survived the reload: it only means "the dialog is still up".
        activate(context, window1);
        assert.equal(context.settingsWindowSeen, false,
            'the focus change clears the latch');
        assert.equal(reconfigureCalls().length, 2,
            'the dialog is gone now, so its Apply is picked up by one reload');
        assert.equal(context.awaitingConfig, true);

        emitConfigChanged(context);
        assert.equal(context.awaitingConfig, false);
        assert.equal(context.settingsWindowSeen, false,
            'a reload landing with a normal window focused keeps the latch cleared');

        harness.shortcuts[0].callback();
        assert.equal(second.minimized, false, 'the press toggles back synchronously');
        assert.deepEqual(pendingIndexes(context), [], 'nothing is pending when the config is fresh');
    }, 'after the replay a press with a fresh configuration toggles synchronously');

    check(() => {
        // A press that arrives while a reload is already pending is folded into the
        // parity flag without sending a second D-Bus call.
        const before = reconfigureCalls().length;
        activate(context, settingsWindow());
        activate(context, window1);              // focus loss -> reconfigure #before+1
        assert.equal(reconfigureCalls().length, before + 1);
        assert.equal(context.awaitingConfig, true);
        harness.shortcuts[1].callback();          // press while awaitingConfig
        assert.deepEqual(pendingIndexes(context), [1], 'one press is pending for slot 2');
        harness.shortcuts[1].callback();          // and once more
        assert.equal(reconfigureCalls().length, before + 1,
            'the pending reload is reused instead of being requested again');
        assert.deepEqual(pendingIndexes(context), [], 'two presses cancel out per slot');
        const target = makeWindow('third title');
        context.workspace.windows = [window1, second, target];
        config.WindowName2 = '^third title$';
        emitConfigChanged(context);
        assert.equal(target.minimized, false, 'two presses toggle nothing');
        assert.equal(context.awaitingConfig, false);
        assert.equal(configTimer(context).running, false,
            'the reload stopped the deadline');
        assert.equal(configTimer(context).fire(), false,
            'firing a stopped timer delivers nothing');
        assert.equal(target.minimized, false, 'a stale deadline replays nothing');
    }, 'presses arriving during a pending reload are counted per slot, not queued');

    check(() => {
        // Every deferred press re-arms the same timer instead of creating a new
        // one, so the wait runs from the last press, not from the first.
        const timer = configTimer(context);
        activate(context, settingsWindow());
        for (let i = 0; i < 3; ++i) {
            const startsBefore = timer.starts;
            harness.shortcuts[0].callback();
            assert.ok(timer.starts > startsBefore,
                'press ' + (i + 1) + ' re-arms the deadline');
            assert.equal(context.configTimer, timer, 'the timer object is reused');
        }
        assert.equal(harness.timers.length, 1, 'no second timer object was created');
        assert.deepEqual(pendingIndexes(context), [0], 'three presses leave one queued');
        assert.equal(timer.running, true);
        emitConfigChanged(context);
        assert.equal(timer.running, false, 'configChanged stops the re-armed deadline');
        activate(context, window1);
        emitConfigChanged(context);
    }, 'three deferred presses re-arm one timer object and the reload stops it');
}

// ======================================= 5b. a replay must not reload again (finding 1)
{
    const window1 = makeWindow('first title');
    window1.minimized = true;     // the replayed press will restore and activate it
    const { context } = load({ WindowName1: '^first title$', windows: [window1] });

    check(() => {
        activate(context, settingsWindow());
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, true, 'the press is deferred, not toggled');
        assert.deepEqual(pendingIndexes(context), [0]);
        assert.equal(reconfigureCalls().length, 1);

        // configChanged arrives while the dialog is still focused: the replay
        // restores the window, which activates it.
        emitConfigChanged(context);
        assert.equal(window1.minimized, false, 'the pending press restored the window');
        assert.equal(reconfigureCalls().length, 1,
            'replaying a press must not request another reload');
        assert.equal(context.awaitingConfig, false);
        assert.equal(context.replaying, false, 'the replay flag is cleared by finally');
        assert.equal(context.settingsWindowSeen, true,
            'the reload keeps the latch: the dialog is still focused, another Apply may come');
    }, 'a replayed press does not request a second configuration reload');

    check(() => {
        // The dialog is focused again and the user pressed OK a second time. The
        // latch survived the first reload, so it catches this press on its own.
        activate(context, settingsWindow());
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, false, 'the press is deferred again');
        assert.deepEqual(pendingIndexes(context), [0]);
        assert.equal(reconfigureCalls().length, 2, 'and it asks for a reload');
        assert.equal(context.awaitingConfig, true);
    }, 'a second Apply is still detected while the dialog stays focused');
}

// ============== 5f. a focused settings window defers a press on its own (finding 1)
{
    const window1 = makeWindow('first title');
    const other = makeWindow('other');
    const { context } = load({ WindowName1: '^first title$', windows: [window1] });

    check(() => {
        // A reload lands with a normal window focused, so the latch is cleared.
        activate(context, settingsWindow());
        activate(context, other);
        emitConfigChanged(context);
        assert.equal(context.settingsWindowSeen, false, 'the latch is cleared');
        assert.equal(context.awaitingConfig, false);

        // Now a settings window is the active one again without an activation
        // event reaching the script, so the latch stays false and only
        // isSettingsWindow(currentActiveWindow()) can see the dialog.
        setActive(context, settingsWindow());
        assert.equal(context.settingsWindowSeen, false, 'no signal, so no latch');

        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, false, 'the press is deferred nonetheless');
        assert.deepEqual(pendingIndexes(context), [0], 'and it is remembered');
        assert.equal(reconfigureCalls().length, 2, 'the press asks for a reload itself');
    }, 'a press while a settings window is focused is deferred even when the latch is cleared');
}

// ============================ 5c. the settings latch heals itself (finding 2)
{
    const window1 = makeWindow('first title');
    const { context } = load({ WindowName1: '^first title$', windows: [window1] });

    check(() => {
        // The dialog was activated and then closed without any other window
        // becoming active, so nothing cleared the latch before this press.
        activate(context, settingsWindow());
        assert.equal(context.settingsWindowSeen, true);
        assert.equal(reconfigureCalls().length, 0);

        harness.shortcuts[0].callback();
        assert.deepEqual(pendingIndexes(context), [0], 'the press is deferred');
        assert.equal(reconfigureCalls().length, 1, 'and it pays exactly one reconfigure');

        emitConfigChanged(context);
        assert.equal(window1.minimized, true, 'the deferred press is replayed');
        assert.equal(context.settingsWindowSeen, true,
            'the reload keeps the latch: the dialog is still the active window');
    }, 'a latched settings flag costs one reconfigure and is not cleared behind the dialog');

    check(() => {
        // Focus finally leaves the dialog and the reload it triggers lands with a
        // normal window focused, which is what clears the latch.
        activate(context, window1);
        assert.equal(context.settingsWindowSeen, false, 'the focus change clears the latch');
        assert.equal(reconfigureCalls().length, 2);
        emitConfigChanged(context);
        assert.equal(context.settingsWindowSeen, false,
            'a reload with a normal window focused keeps the latch cleared');

        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, false, 'the press toggles immediately');
        assert.equal(reconfigureCalls().length, 2, 'no reload is requested any more');
        assert.deepEqual(pendingIndexes(context), [], 'nothing is pending');
    }, 'after the healing reload a press is not deferred again');
}

// ===================== 5d. a press is dropped when its slot is gone (finding 6)
{
    const window1 = makeWindow('quake');
    const { context, config } = load({ WindowName1: '^quake$', windows: [window1] });

    check(() => {
        activate(context, settingsWindow());
        harness.shortcuts[0].callback();
        assert.deepEqual(pendingIndexes(context), [0], 'the press is deferred');

        // The slot was disabled while the press was waiting.
        config.Enabled1 = false;
        emitConfigChanged(context);

        assert.equal(window1.minimized, false, 'the dropped press toggled nothing');
        assert.deepEqual(pendingIndexes(context), [], 'nothing stays pending');
        const infos = harness.infos.join('\n');
        assert.match(infos,
            /the press on slot 1 was dropped because the slot is now disabled/);
        assert.doesNotMatch(infos,
            /slot 1 is disabled or has no valid expression, nothing to toggle/,
            'the replay reports its own reason, not the live-press message');
    }, 'a press whose slot was disabled meanwhile is dropped with its own message');
}

// ===== 5d2. a dropped replay does not silence the next live press (finding C3)
{
    const window1 = makeWindow('quake');
    const other = makeWindow('other');
    const { context, config } = load({ WindowName1: '^quake$', windows: [window1] });

    check(() => {
        activate(context, settingsWindow());
        harness.shortcuts[0].callback();
        assert.deepEqual(pendingIndexes(context), [0], 'the press is deferred');

        // The slot is disabled while the press waits, and focus moves on without
        // an activation event, so the latch is cleared by the reload itself.
        setActive(context, other);
        config.Enabled1 = false;
        emitConfigChanged(context);
        assert.match(harness.infos.join('\n'),
            /the press on slot 1 was dropped because the slot is now disabled/);

        // The dropped replay must not consume the once-per-generation message:
        // a live press on the very same slot still reports its own reason.
        const before = harness.infos.length;
        harness.shortcuts[0].callback();
        assert.match(harness.infos.slice(before).join('\n'),
            /slot 1 is disabled or has no valid expression, nothing to toggle/);
        assert.equal(window1.minimized, false, 'nothing was toggled');
    }, 'a dropped replay does not consume the once-per-generation message of a live press');
}

// =========== 5e. a windowActivated delivered after the replay (finding 7)
{
    const window1 = makeWindow('first title');
    window1.minimized = true;      // replaying the press restores and activates it
    const { context } = load({ WindowName1: '^first title$', windows: [window1] });

    check(() => {
        activate(context, settingsWindow());
        harness.shortcuts[0].callback();
        assert.deepEqual(pendingIndexes(context), [0], 'the press is deferred');
        assert.equal(reconfigureCalls().length, 1);

        // The Wayland restore path may deliver windowActivated only after the
        // replay returned, i.e. with `replaying` already false. The flag only
        // suppresses the synchronous variant; an asynchronous one can cost one
        // extra reconfigure, which is harmless and pinned here.
        configTimer(context).fire();
        assert.deepEqual(pendingIndexes(context), [], 'no press is lost');
        assert.equal(window1.minimized, false, 'the press toggled the window exactly once');
        assert.equal(reconfigureCalls().length, 1,
            'the synchronous activation caused by the replay is suppressed');

        activate(context, window1);   // the same activation, delivered late
        assert.deepEqual(pendingIndexes(context), [], 'still no press is lost');
        assert.equal(window1.minimized, false, 'and nothing is toggled twice');
        assert.equal(reconfigureCalls().length, 2,
            'the asynchronous activation costs at most one extra reconfigure');
        activate(context, window1);   // the latch is cleared now
        assert.equal(reconfigureCalls().length, 2, 'the extra reconfigure happens once');
    }, 'a windowActivated delivered after the replay loses no press and costs at most one reload');
}

// ======================= 5g. a replay that focuses a settings window re-arms the latch
{
    const dialog = makeWindow('System Settings', { resourceClass: 'systemsettings' });
    dialog.minimized = true;      // replaying the press restores and activates it
    const normal = makeWindow('terminal');
    const { context } = load({ WindowName1: '^System Settings$', windows: [dialog] });

    check(() => {
        activate(context, dialog);                 // the dialog is up
        assert.equal(context.settingsWindowSeen, true);
        activate(context, normal);                 // focus loss -> reload, latch cleared
        assert.equal(context.settingsWindowSeen, false);
        assert.equal(reconfigureCalls().length, 1);

        harness.shortcuts[0].callback();            // deferred while awaitingConfig
        assert.deepEqual(pendingIndexes(context), [0], 'the press is deferred');

        // The reload lands with the normal window focused, so the reload itself
        // clears the latch; the replay then restores the dialog, which activates
        // it. That activation has to re-arm the latch even though the replay is
        // still running.
        emitConfigChanged(context);
        assert.equal(dialog.minimized, false, 'the replayed press restored the dialog');
        assert.equal(context.replaying, false, 'the replay flag is cleared by finally');
        assert.equal(reconfigureCalls().length, 1, 'the replay requested no reload');
        assert.equal(context.settingsWindowSeen, true,
            'a settings window activated by the replay re-arms the latch');

        activate(context, normal);                 // leaving it is noticed again
        assert.equal(context.awaitingConfig, true);
        assert.equal(context.settingsWindowSeen, false, 'the focus loss clears the latch');
        assert.equal(reconfigureCalls().length, 2,
            'the re-armed latch picks up the next focus loss');
    }, 'a settings window activated during a replay re-arms the latch without a reload');
}

// ===================================== 6. the configuration deadline (finding 4)
//
// One timer now answers both questions the old pair answered: a deferred press
// always has a deadline, and an unanswered reload request cannot latch. Both
// paths are driven through this single timer.
{
    const window1 = makeWindow('first title');
    const { context } = load({ WindowName1: '^first title$', windows: [window1] });

    check(() => {
        activate(context, settingsWindow());
        activate(context, makeWindow('other'));   // focus loss -> reconfigure
        assert.equal(context.awaitingConfig, true);
        const timer = configTimer(context);
        assert.equal(timer.singleShot, true, 'the deadline is single shot');
        assert.equal(timer.interval, 1000, 'the deadline fires after 1000 ms');
        assert.equal(timer.running, true, 'the deadline of the reload request is armed');
        assert.equal(harness.timers.length, 1, 'one timer object serves the whole path');
    }, 'requesting a reload arms the single configuration deadline');

    check(() => {
        const warningsBefore = harness.warnings.length;
        assert.equal(configTimer(context).fire(), true, 'the armed deadline fires');
        assert.equal(context.awaitingConfig, false, 'a stuck reload request is cleared');
        assert.equal(harness.warnings.length, warningsBefore + 1, 'exactly one warning is logged');
        assert.match(harness.warnings[harness.warnings.length - 1],
            /did not confirm the configuration reload/);
        assert.equal(configTimer(context).fire(), false,
            'the stopped deadline delivers nothing');
        assert.equal(harness.warnings.length, warningsBefore + 1, 'the warning is logged once');
    }, 'the deadline unsticks an unconfirmed reload and warns exactly once');

    check(() => {
        // A later press must not wait for a deadline any more.
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, true, 'the press toggles immediately');
        assert.deepEqual(pendingIndexes(context), [], 'nothing is pending');
        assert.equal(configTimer(context).running, false, 'the deadline is not armed again');
        assert.equal(reconfigureCalls().length, 1, 'no extra reload request');
        assert.equal(harness.timers.length, 1, 'no second timer object was created');
    }, 'after the deadline a press is not delayed any more');

    check(() => {
        activate(context, settingsWindow());
        activate(context, makeWindow('other'));   // reconfigure #2, deadline re-armed
        assert.equal(reconfigureCalls().length, 2);
        assert.equal(configTimer(context).running, true, 'the deadline is armed again');
        emitConfigChanged(context);
        assert.equal(configTimer(context).running, false, 'configChanged stops the deadline');
        assert.equal(context.awaitingConfig, false);
        assert.equal(harness.timers.length, 1, 'still the same single timer object');
    }, 'options.configChanged stops the armed deadline and no second timer appears');
}

// ======== 6b. without a timer a stale press toggles synchronously instead (finding C1)
{
    const window1 = makeWindow('first title');
    const { context } = load({
        WindowName1: '^first title$',
        windows: [window1],
        // QTimer cannot be created at all, so neither the reload request nor a
        // deferred press has a deadline. Waiting would mean waiting forever.
        failTimerCreation: Infinity,
    });

    check(() => {
        activate(context, settingsWindow());
        harness.shortcuts[0].callback();
        const warnings = harness.warnings.join('\n');
        assert.match(warnings, /could not create the configuration timer/);
        assert.match(warnings,
            /no configuration timer is available, toggling with the configuration as it is/);
        assert.equal(window1.minimized, true,
            'the press toggles synchronously instead of being lost');
        assert.deepEqual(pendingIndexes(context), [],
            'the parity flip is undone, nothing stays queued');
        assert.equal(context.configTimer, null, 'there is no timer to fire');
        assert.equal(harness.timers.length, 0, 'no timer object exists at all');
        assert.equal(reconfigureCalls().length, 1,
            'the reload request was still made, so the new values may still arrive');
    }, 'a press with no timer falls back to a synchronous toggle and warns once');

    check(() => {
        // A second press must neither warn again nor try to create the timer
        // again, and it must not queue anything either.
        const warningsBefore = harness.warnings.length;
        const callsBefore = reconfigureCalls().length;
        harness.shortcuts[0].callback();
        assert.equal(harness.warnings.length, warningsBefore,
            'the missing timer is reported once, not on every press');
        assert.equal(window1.minimized, false, 'the second press toggles back');
        assert.deepEqual(pendingIndexes(context), [], 'again nothing is queued');
        assert.equal(reconfigureCalls().length, callsBefore,
            'the already pending request is reused');
        assert.equal(context.awaitingConfig, true,
            'awaitingConfig stays set because nothing can time it out');
        assert.equal(context.configTimerUnavailable, true,
            'the failed creation is remembered');
    }, 'the no-timer fallback is logged once and keeps toggling');

    check(() => {
        // The latch that no timer can clear is still cleared by a real reload.
        emitConfigChanged(context);
        assert.equal(context.awaitingConfig, false);
        assert.equal(harness.timers.length, 0, 'no timer appears out of nowhere');
    }, 'a latched reload request without a timer is cleared by configChanged');
}

// ===================================== 7. an already active settings window (finding 5)
{
    const { context } = load({ windows: [], activeWindow: settingsWindow() });

    check(() => {
        assert.equal(context.settingsWindowSeen, true,
            'a settings window that is active at load time is imported');
        assert.equal(reconfigureCalls().length, 0, 'loading the script does not reconfigure');
        assert.equal(context.configTimer, null);
        assert.equal(harness.timers.length, 0);
    }, 'init() notices a settings window that is already active');

    check(() => {
        activate(context, makeWindow('other'));
        assert.equal(context.settingsWindowSeen, false);
        assert.equal(reconfigureCalls().length, 1, 'its Apply is not missed');
    }, 'leaving the already-active settings window requests one reload');
}

// ================================================ 8. handler guards (finding 5)
{
    const explodes = () => {
        throw new Error('dead window');
    };
    const dying = { minimized: false };
    Object.defineProperty(dying, 'resourceClass', { get: explodes });
    Object.defineProperty(dying, 'resourceName', { get: explodes });
    dying.caption = 'dying';

    const { context } = load({ WindowName1: 'dying', windows: [dying] });

    check(() => {
        assert.doesNotThrow(() => activate(context, dying),
            'a throwing property access does not escape into KWin');
        assert.match(harness.warnings.join('\n'), /failed to handle a window activation/);
        assert.equal(context.settingsWindowSeen, false);
    }, 'the windowActivated wrapper catches a failing property access and warns');

    check(() => {
        const explodingCaption = makeWindow('x');
        Object.defineProperty(explodingCaption, 'caption', { get: explodes });
        context.workspace.windows = [explodingCaption];
        assert.doesNotThrow(() => {
            context.workspace.currentDesktopChanged.fns.forEach((fn) => fn(null, null));
        }, 'a throwing property access does not escape into KWin');
        assert.match(harness.warnings.join('\n'), /failed to handle a desktop change/);
    }, 'the currentDesktopChanged wrapper catches a failing property access and warns');
}

// ================================================== 9. the deadline replays a press
{
    const window1 = makeWindow('first title');
    const { context, config } = load({ WindowName1: '^first title$', windows: [window1] });

    check(() => {
        activate(context, settingsWindow());
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, false, 'the press is deferred');
        assert.deepEqual(pendingIndexes(context), [0]);

        // KWin reparsed kwinrc but the configChanged signal was lost: only now,
        // after the deadline is armed, does readConfig() start returning new values.
        const renamed = makeWindow('renamed');
        context.workspace.windows = [window1, renamed];
        config.WindowName1 = '^renamed$';

        const warningsBefore = harness.warnings.length;
        configTimer(context).fire();  // KWin never sends configChanged
        assert.equal(harness.warnings.length, warningsBefore + 1, 'one warning is logged');
        assert.match(harness.warnings[harness.warnings.length - 1], /did not confirm the configuration reload/);
        assert.deepEqual(pendingIndexes(context), [], 'no press is pending any more');
        assert.equal(context.awaitingConfig, false, 'the state machine is unstuck');
        assert.equal(renamed.minimized, true, 'the replayed press used the re-read expression');
        assert.equal(window1.minimized, false, 'the old expression was not used');
    }, 'the configuration deadline re-reads the configuration and replays the pending press');

    check(() => {
        // A late configChanged must not toggle the same press twice.
        emitConfigChanged(context);
        assert.equal(context.workspace.windows[1].minimized, true, 'no double toggle after the timeout');
        assert.deepEqual(pendingIndexes(context), []);
        assert.match(harness.infos.join('\n'), /active slots: 1: \^renamed\$/);
    }, 'a late configChanged after the timeout does not toggle twice');

    check(() => {
        // Nothing pending on the deadline is a no-op: no warning, no re-read. The
        // timer has to be running for the timeout to be delivered at all.
        configTimer(context).start(1000);
        const warningsBefore = harness.warnings.length;
        const infosBefore = harness.infos.length;
        assert.equal(configTimer(context).fire(), true, 'the armed deadline fires');
        assert.equal(harness.warnings.length, warningsBefore,
            'nothing is left to warn about once awaitingConfig is clear');
        assert.equal(harness.infos.length, infosBefore, 'the configuration is not re-read');
    }, 'an empty pending set on the configuration deadline does nothing');
}

// =============================================== 10. per-slot press parity (finding 4)
{
    // Toggling is parity-sensitive, so the deferred presses are counted per slot
    // instead of being queued: dropping any of them would invert the result.
    const single = makeWindow('quake');
    const odd = load({ WindowName1: '^quake$', windows: [single] });
    check(() => {
        activate(odd.context, settingsWindow());
        harness.shortcuts[0].callback();
        assert.deepEqual(pendingIndexes(odd.context), [0], 'one press is pending');
        emitConfigChanged(odd.context);
        assert.deepEqual(pendingIndexes(odd.context), [], 'the pending press was replayed');
        assert.equal(single.minimized, true, 'one press toggles the window exactly once');
    }, 'a single pending press toggles the window once');

    const pairWindow = makeWindow('quake');
    const even = load({ WindowName1: '^quake$', windows: [pairWindow] });
    check(() => {
        activate(even.context, settingsWindow());
        harness.shortcuts[0].callback();
        harness.shortcuts[0].callback();
        assert.deepEqual(pendingIndexes(even.context), [], 'two presses cancel out');
        emitConfigChanged(even.context);
        assert.equal(pairWindow.minimized, false, 'two presses leave the window untouched');
        assert.equal(even.context.configTimer.running, false, 'the deadline is stopped');
    }, 'two pending presses cancel out and toggle nothing');

    const tripleWindow = makeWindow('quake');
    const triple = load({ WindowName1: '^quake$', windows: [tripleWindow] });
    check(() => {
        activate(triple.context, settingsWindow());
        for (let i = 0; i < 3; ++i) {
            harness.shortcuts[0].callback();
        }
        assert.deepEqual(pendingIndexes(triple.context), [0], 'three presses leave one');
        emitConfigChanged(triple.context);
        assert.equal(tripleWindow.minimized, true, 'three presses toggle the window once');
        assert.equal(harness.warnings.length, 0, 'nothing warns about a full queue any more');
    }, 'three pending presses toggle the window exactly once');

    // Presses on different slots are independent, so their order does not matter.
    const first = makeWindow('quake');
    const chat = makeWindow('chat');
    const mixed = load({ WindowName1: '^quake$', WindowName2: '^chat$', windows: [first, chat] });
    check(() => {
        activate(mixed.context, settingsWindow());
        for (const slot of [0, 1, 0, 1, 0]) {
            harness.shortcuts[slot].callback();
        }
        assert.deepEqual(pendingIndexes(mixed.context), [0], 'only slot 1 has an odd count');
        emitConfigChanged(mixed.context);
        assert.equal(first.minimized, true, 'slot 1 toggled once');
        assert.equal(chat.minimized, false, 'slot 2 toggled twice, i.e. never');
    }, 'presses on different slots are independent of their order');
}

// ===================================== 11. which windows are settings windows
// The window classes the stale-configuration feature depends on, one test row
// each: a rename upstream (or a regression in the suffix heuristic) has to show
// up here instead of in the field. The trailing-version rows are the reason the
// heuristic strips a version suffix before the suffix test, and the reverse-DNS
// kcmshell row is the reason kcmshell is matched as a contained segment rather
// than as a prefix.
const SETTINGS_CLASSES = [
    'systemsettings',
    'systemsettings6',
    'kdesystemsettings',
    'org.kde.systemsettings',
    'plasma-settings',
    'plasma-systemsettings',
    'kcmshell',
    'kcmshell5',
    'kcmshell6',
    'org.kde.kcmshell6',
    'org.kde.kcmshell',
];

// Look-alikes that must stay unrecognised: "settings" as a substring is not
// enough, and a trailing version does not turn a helper into a host.
const LOOK_ALIKE_CLASSES = [
    'plasma-settings-helper',
    'not-settings-really',
    'systemsettings-helper',
    'myapp',
];

{
    for (const className of SETTINGS_CLASSES) {
        check(() => {
            const { context } = load({ windows: [] });
            activate(context, makeWindow('Settings', { resourceClass: className }));
            assert.equal(context.settingsWindowSeen, true, className + ' is a settings window');
        }, 'the settings window class ' + className + ' is recognised');
    }

    for (const className of LOOK_ALIKE_CLASSES) {
        check(() => {
            const { context } = load({ windows: [] });
            activate(context, makeWindow('Settings', { resourceClass: className }));
            assert.equal(context.settingsWindowSeen, false, className + ' is not one');
        }, 'the look-alike class ' + className + ' is not a settings window');
    }

    check(() => {
        const { context } = load({ windows: [] });
        activate(context, makeWindow('Settings', { resourceClass: '', resourceName: 'systemsettings' }));
        assert.equal(context.settingsWindowSeen, true,
            'an empty resourceClass falls back to resourceName');
    }, 'resourceName is used when resourceClass is empty');
}

// ========================================================= 12. desktop switch fixup
{
    const window1 = makeWindow('quake');
    window1.minimized = true;
    const other = makeWindow('other');
    const { context } = load({ WindowName1: 'quake', windows: [window1, other] });

    check(() => {
        const listeners = context.workspace.currentDesktopChanged.fns;
        assert.equal(listeners.length, 1, 'exactly one currentDesktopChanged listener');
        window1.skipTaskbar = false;
        other.skipTaskbar = true;
        const calls = context.workspace.windowListCalls;
        listeners[0](null, null);
        assert.ok(context.workspace.windowListCalls > calls, 'the window list is scanned');
        assert.equal(window1.skipTaskbar, true, 'matching hidden window is put back out of the taskbar');
        assert.equal(other.skipTaskbar, true, 'non-matching window is untouched');
    }, 'the desktop-change workaround is connected once and still restores skipTaskbar');

    check(() => {
        assert.equal(context.workspace.windowActivated.fns.length, 1);
        assert.equal(context.options.configChanged.fns.length, 1);
    }, 'signal handlers are connected exactly once');

    check(() => {
        const context2 = load({ windows: [makeWindow('quake')] }).context;
        const listener = context2.workspace.currentDesktopChanged.fns[0];
        const calls = context2.workspace.windowListCalls;
        listener(null, null);
        assert.equal(context2.workspace.windowListCalls, calls,
            'no window scan when no slot is active');
        assert.equal(harness.warnings.length, 0);
    }, 'without an active slot the desktop-change handler returns before scanning the windows');

    check(() => {
        // One window matching two slots: the fixup is idempotent, so skipTaskbar
        // must be written once per window, not once per matching slot.
        let writes = 0;
        const both = makeWindow('quake');
        both.minimized = true;
        Object.defineProperty(both, 'skipTaskbar', {
            get() {
                return both._skipTaskbar;
            },
            set(value) {
                writes += 1;
                both._skipTaskbar = value;
            },
        });
        both._skipTaskbar = false;
        const ctx = load({ WindowName1: 'quake', WindowName2: '^quake$', windows: [both] }).context;
        ctx.workspace.currentDesktopChanged.fns[0](null, null);
        assert.equal(writes, 1, 'skipTaskbar is assigned exactly once');
        assert.equal(both.skipTaskbar, true, 'the hidden window leaves the taskbar');
    }, 'the desktop-change fixup writes skipTaskbar once for a window matching two slots');
}

// ============================================ 13. package structure cross-check
{
    const mainXml = fs.readFileSync(MAIN_XML_PATH, 'utf8');
    const configUi = fs.readFileSync(CONFIG_UI_PATH, 'utf8');
    const entryNames = [...mainXml.matchAll(/<entry\s+name="([^"]+)"/g)].map((match) => match[1]);
    const widgetNames = [...configUi.matchAll(/<widget[^>]*\bname="kcfg_([^"]+)"/g)]
        .map((match) => match[1]);
    const declaredSlots = Number(/var SLOT_COUNT = (\d+);/.exec(SOURCE)[1]);

    check(() => {
        assert.equal(declaredSlots, 7, 'main.js still declares seven slots');
        const expected = [];
        for (let slot = 1; slot <= declaredSlots; ++slot) {
            expected.push('Enabled' + slot, 'WindowName' + slot);
        }
        assert.equal(entryNames.length, 14, 'main.xml declares 14 entries');
        assert.deepEqual([...entryNames].sort(), [...expected].sort(),
            'main.xml declares EnabledN and WindowNameN only');
    }, 'contents/config/main.xml declares exactly 14 entries for seven slots');

    check(() => {
        assert.equal(widgetNames.length, 14, 'config.ui has 14 kcfg_* widgets');
        assert.deepEqual([...widgetNames].sort(), [...entryNames].sort(),
            'every entry has a kcfg_ widget and vice versa');
        for (let slot = 1; slot <= declaredSlots; ++slot) {
            assert.ok(widgetNames.includes('Enabled' + slot), 'kcfg_Enabled' + slot + ' exists');
            assert.ok(widgetNames.includes('WindowName' + slot), 'kcfg_WindowName' + slot + ' exists');
        }
    }, 'contents/ui/config.ui mirrors main.xml and SLOT_COUNT one to one');
}

// ============================== 14. translation coverage of the settings form
//
// The compiled catalog is the only thing that translates contents/ui/config.ui,
// so a string that lupdate did not extract silently stays English. The .pot is
// therefore compared with the form itself, which catches a string that was added
// without re-running tools/update-po.sh.
const PO_ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };

function poUnquote(quoted) {
    assert.ok(quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"'),
        'a PO string is double quoted: ' + quoted);
    return quoted.slice(1, -1).replace(/\\(.)/g, (all, char) =>
        (Object.prototype.hasOwnProperty.call(PO_ESCAPES, char) ? PO_ESCAPES[char] : char));
}

// Minimal .pot reader: multi-line entries are concatenated as gettext does, PO
// escapes are decoded, and obsolete "#~" entries are counted separately.
function parsePot(source) {
    const msgids = [];
    let obsolete = 0;
    let current = null;

    const flush = () => {
        // The empty msgid is the catalog header, not a translatable string.
        if (current !== null && current !== '') {
            msgids.push(current);
        }
        current = null;
    };

    for (const rawLine of source.split('\n')) {
        const line = rawLine.trim();
        if (line.startsWith('#~')) {
            obsolete += 1;
            continue;
        }
        if (line === '') {
            flush();
            continue;
        }
        if (line.startsWith('#')) {
            continue;
        }
        if (line.startsWith('msgid ')) {
            flush();
            current = poUnquote(line.slice('msgid '.length));
            continue;
        }
        if (line.startsWith('msgstr') || line.startsWith('msgctxt ')) {
            // Continuation lines of a msgstr arrive with current === null and are
            // ignored, so only msgids are collected.
            flush();
            continue;
        }
        if (line.startsWith('"')) {
            if (current !== null) {
                current += poUnquote(line);
            }
            continue;
        }
        assert.fail('unexpected line in po/quakewindows.pot: ' + line);
    }
    flush();

    return { msgids, obsolete };
}

function xmlUnescape(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function normaliseWhitespace(value) {
    return value.replace(/\s+/g, ' ').trim();
}

{
    const pot = parsePot(fs.readFileSync(POT_PATH, 'utf8'));
    const msgids = new Set(pot.msgids);
    const normalised = new Set(pot.msgids.map(normaliseWhitespace));

    check(() => {
        assert.ok(pot.msgids.length > 0, 'the template carries msgids');
        assert.equal(pot.obsolete, 0,
            'po/quakewindows.pot carries ' + pot.obsolete + ' obsolete #~ line(s)');
    }, 'po/quakewindows.pot parses and holds no obsolete entries');

    check(() => {
        const uiSource = fs.readFileSync(CONFIG_UI_PATH, 'utf8');
        const translatable = [];
        for (const match of uiSource.matchAll(/<string([^>]*)>([\s\S]*?)<\/string>/g)) {
            if (/notr\s*=\s*"true"/.test(match[1])) {
                continue;
            }
            translatable.push(xmlUnescape(match[2]));
        }
        assert.ok(translatable.length > 0, 'the form has translatable strings');
        const missing = translatable.filter((value) =>
            !msgids.has(value) && !normalised.has(normaliseWhitespace(value)));
        assert.deepEqual(missing, [],
            'translatable strings missing from po/quakewindows.pot: ' + JSON.stringify(missing));
    }, 'every <string> of contents/ui/config.ui without notr="true" is in the .pot');

    // The plugin metadata is not part of the catalog: lupdate reads the .ui file
    // only, and KPluginMetaData picks the localized variant up from its own
    // "Key[lang]" pairs. Both variants therefore have to be complete.
    check(() => {
        const plugin = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8')).KPlugin || {};
        for (const key of ['Name', 'Description']) {
            assert.equal(typeof plugin[key], 'string', key + ' is declared');
            assert.ok(plugin[key].trim().length > 0, key + ' is not empty');
            const localized = plugin[key + '[ru]'];
            assert.equal(typeof localized, 'string', key + '[ru] is declared');
            assert.ok(localized.trim().length > 0, key + '[ru] is not empty');
            assert.notEqual(localized, plugin[key], key + '[ru] differs from ' + key);
        }
        for (const key of Object.keys(plugin)) {
            const base = /^(.*)\[[^\]]+\]$/.exec(key);
            if (base) {
                assert.ok(Object.prototype.hasOwnProperty.call(plugin, base[1]),
                    'localized key ' + key + ' has the base key ' + base[1]);
            }
        }
    }, 'metadata.json carries Name and Description with non-empty [ru] variants');
}

console.log('');
if (failures) {
    console.log(failures + ' check(s) failed');
    process.exit(1);
}
console.log('All main.js checks passed.');
