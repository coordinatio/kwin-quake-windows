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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = fileURLToPath(new URL('../contents/code/main.js', import.meta.url));
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
    }
    start(ms) {
        if (typeof ms === 'number') {
            this.interval = ms;
        }
        this.running = true;
        harness.timers.push(this);
    }
    stop() {
        this.running = false;
    }
    fire() {
        // A single-shot timer stops before its handler runs.
        this.running = false;
        for (const fn of this.timeout.fns) {
            fn();
        }
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
    context.workspace.__config = config;
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
    vm.runInContext(SOURCE, context, { filename: 'main.js' });
    harness.context = context;
    return { context, config };
}

const settingsWindow = () => makeWindow('System Settings', { resourceClass: 'systemsettings' });

function reconfigureCalls() {
    return harness.dbus.filter((call) => call.method === 'reconfigure');
}

function runningTimers() {
    return [...new Set(harness.timers.filter((timer) => timer.running))];
}

// The safety net is created lazily, on the first deferred press.
function safetyTimer(context) {
    assert.ok(context.pendingToggleTimer instanceof MockTimer, 'the safety timer exists');
    return context.pendingToggleTimer;
}

// The reload watchdog is created lazily, on the first reload request.
function watchdogTimer(context) {
    assert.ok(context.configWatchdogTimer instanceof MockTimer, 'the watchdog exists');
    return context.configWatchdogTimer;
}

function activate(context, client) {
    context.workspace.windowActivated.fns.forEach((fn) => fn(client));
}

function emitConfigChanged(context) {
    context.options.configChanged.fns.forEach((fn) => fn());
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
        assert.equal(context.pendingToggleTimer, null, 'the safety timer is created lazily');
        assert.equal(context.configWatchdogTimer, null, 'the watchdog is created lazily');
        assert.equal(context.initialized, true, 'initialized is set last by init()');
    }, 'init creates no timer object at all and leaves both timers unarmed');

    check(() => {
        assert.equal(reconfigureCalls().length, 0);
        assert.equal(harness.warnings.length, 0);
        assert.match(harness.infos.join('\n'), /active slots: none/);
    }, 'unconfigured slots are inactive and no reconfigure is requested on startup');
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
        assert.equal(context.pendingToggles.length, 0);
    }, 'pressing an inactive slot does not request a configuration reload');
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
        assert.equal(context.pendingToggleTimer, null,
            'no safety timer is armed for a plain focus change');
        assert.deepEqual(runningTimers(), [watchdogTimer(context)],
            'only the reload watchdog is armed');
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
        assert.deepEqual([...context.pendingToggles], [0], 'the press was queued');
        assert.equal(reconfigureCalls().length, 1, 'the press requests a reload itself');
        const timer = safetyTimer(context);
        assert.equal(timer.singleShot, true);
        assert.equal(timer.interval, 1000);
        assert.equal(timer.running, true, 'the safety net is armed');
    }, 'a hotkey pressed while the configuration is stale is deferred, not toggled');

    check(() => {
        config.WindowName1 = '^second window$';
        emitConfigChanged(context);
        assert.equal(context.pendingToggles.length, 0, 'the queue is drained');
        assert.equal(safetyTimer(context).running, false, 'the safety net is stopped');
        assert.equal(second.minimized, true, 'the replayed press used the fresh expression');
        assert.equal(window1.minimized, false, 'the old expression was not used');
    }, 'options.configChanged replays the queued press with the fresh configuration');

    check(() => {
        // Focus left the dialog (as it does in real use) and the reload completed.
        activate(context, window1);
        assert.equal(context.settingsWindowSeen, false);
        assert.equal(reconfigureCalls().length, 2, 'focus loss asks for another reload');
        emitConfigChanged(context);
        assert.equal(context.awaitingConfig, false);

        harness.shortcuts[0].callback();
        assert.equal(second.minimized, false, 'the press toggles back synchronously');
        assert.equal(context.pendingToggles.length, 0, 'nothing is queued when the config is fresh');
    }, 'after the replay a press with a fresh configuration toggles synchronously');

    check(() => {
        // A press that arrives while a reload is already pending joins the queue
        // without sending a second D-Bus call.
        const before = reconfigureCalls().length;
        activate(context, settingsWindow());
        activate(context, window1);              // focus loss -> reconfigure #before+1
        assert.equal(reconfigureCalls().length, before + 1);
        assert.equal(context.awaitingConfig, true);
        harness.shortcuts[1].callback();          // press while awaitingConfig
        harness.shortcuts[1].callback();          // and once more
        assert.equal(reconfigureCalls().length, before + 1,
            'the pending reload is reused instead of being requested again');
        assert.deepEqual([...context.pendingToggles], [1, 1], 'both presses are queued in order');
        const target = makeWindow('third title');
        context.workspace.windows = [window1, second, target];
        config.WindowName2 = '^third title$';
        emitConfigChanged(context);
        assert.equal(context.pendingToggles.length, 0);
        assert.equal(target.minimized, false, 'two presses cancel out per slot');
        assert.equal(context.awaitingConfig, false);
    }, 'presses arriving during a pending reload are queued and replayed in order');

    check(() => {
        // Queue cap: never grow beyond 8 entries.
        activate(context, settingsWindow());
        for (let i = 0; i < 12; ++i) {
            harness.shortcuts[2].callback();
        }
        assert.equal(context.pendingToggles.length, 8, 'the queue is capped at 8 entries');
        emitConfigChanged(context);
        assert.equal(context.pendingToggles.length, 0);
    }, 'the queue of pending presses is capped at 8 entries');
}

// ======================================= 5b. a replay must not reload again (finding 1)
{
    const window1 = makeWindow('first title');
    window1.minimized = true;     // the replayed press will restore and activate it
    const { context } = load({ WindowName1: '^first title$', windows: [window1] });

    check(() => {
        activate(context, settingsWindow());
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, true, 'the press is queued, not toggled');
        assert.deepEqual([...context.pendingToggles], [0]);
        assert.equal(reconfigureCalls().length, 1);

        // configChanged arrives while the dialog is still focused: the replay
        // restores the window, which activates it.
        emitConfigChanged(context);
        assert.equal(window1.minimized, false, 'the queued press restored the window');
        assert.equal(reconfigureCalls().length, 1,
            'replaying a press must not request another reload');
        assert.equal(context.awaitingConfig, false);
        assert.equal(context.replaying, false, 'the replay flag is cleared by finally');
        assert.equal(context.settingsWindowSeen, true,
            'the settings window stays recorded');
    }, 'a replayed press does not request a second configuration reload');

    check(() => {
        // settingsWindowSeen is sticky, so a second Apply in the still focused
        // dialog is noticed on the next press.
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, false, 'the press is deferred again');
        assert.deepEqual([...context.pendingToggles], [0]);
        assert.equal(reconfigureCalls().length, 2, 'and it asks for a reload');
        assert.equal(context.awaitingConfig, true);
    }, 'a second Apply is still detected while the dialog stays focused');
}

// ============================================ 6. reload watchdog (finding 4)
{
    const window1 = makeWindow('first title');
    const { context } = load({ WindowName1: '^first title$', windows: [window1] });

    check(() => {
        activate(context, settingsWindow());
        activate(context, makeWindow('other'));   // focus loss -> reconfigure
        assert.equal(context.awaitingConfig, true);
        const timer = watchdogTimer(context);
        assert.equal(timer.singleShot, true, 'the watchdog is single shot');
        assert.equal(timer.interval, 2000, 'the watchdog fires after 2000 ms');
        assert.equal(timer.running, true, 'the watchdog is armed');
        assert.equal(context.pendingToggleTimer, null, 'the safety timer is not involved');
    }, 'requesting a reload arms one single-shot watchdog');

    check(() => {
        const warningsBefore = harness.warnings.length;
        watchdogTimer(context).fire();            // KWin never answered the request
        assert.equal(context.awaitingConfig, false, 'a stuck reload request is cleared');
        assert.equal(harness.warnings.length, warningsBefore + 1, 'exactly one warning is logged');
        assert.match(harness.warnings[harness.warnings.length - 1],
            /did not confirm the configuration reload/);
        watchdogTimer(context).fire();            // a later timeout must stay silent
        assert.equal(harness.warnings.length, warningsBefore + 1, 'the warning is logged once');
    }, 'the watchdog unsticks an unconfirmed reload and warns once');

    check(() => {
        // A later press must not wait for the 1 s safety timeout any more.
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, true, 'the press toggles immediately');
        assert.equal(context.pendingToggles.length, 0, 'nothing is queued');
        assert.equal(context.pendingToggleTimer, null, 'no safety timer was armed');
        assert.equal(reconfigureCalls().length, 1, 'no extra reload request');
    }, 'after the watchdog a press is not delayed by the safety timeout');

    check(() => {
        activate(context, settingsWindow());
        activate(context, makeWindow('other'));   // reconfigure #2, watchdog re-armed
        assert.equal(reconfigureCalls().length, 2);
        assert.equal(watchdogTimer(context).running, true, 'the watchdog is armed again');
        emitConfigChanged(context);
        assert.equal(watchdogTimer(context).running, false, 'configChanged stops the watchdog');
        assert.equal(context.awaitingConfig, false);
    }, 'options.configChanged stops the armed watchdog');
}

// ===================================== 7. an already active settings window (finding 5)
{
    const { context } = load({ windows: [], activeWindow: settingsWindow() });

    check(() => {
        assert.equal(context.settingsWindowSeen, true,
            'a settings window that is active at load time is imported');
        assert.equal(reconfigureCalls().length, 0, 'loading the script does not reconfigure');
        assert.equal(context.pendingToggleTimer, null);
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

// ======================================================== 9. safety-timeout replay
{
    const window1 = makeWindow('first title');
    const { context, config } = load({ WindowName1: 'first title', windows: [window1] });

    check(() => {
        config.WindowName1 = '^renamed$';
        activate(context, settingsWindow());
        harness.shortcuts[0].callback();
        assert.equal(window1.minimized, false);

        const warningsBefore = harness.warnings.length;
        safetyTimer(context).fire();  // KWin never sends configChanged
        assert.equal(harness.warnings.length, warningsBefore + 1, 'one warning is logged');
        assert.match(harness.warnings[harness.warnings.length - 1], /did not confirm the configuration reload/);
        assert.equal(context.pendingToggles.length, 0, 'the queue is drained');
        assert.equal(context.awaitingConfig, false, 'the state machine is unstuck');
        assert.equal(window1.minimized, true, 'the press is not lost and toggles the window');
    }, 'the safety timeout replays a queued press when configChanged never arrives');

    check(() => {
        // A late configChanged must not toggle the same press twice.
        emitConfigChanged(context);
        assert.equal(window1.minimized, true, 'no double toggle after the timeout');
        assert.equal(context.pendingToggles.length, 0);
        assert.match(harness.infos.join('\n'), /active slots: none|1:/);
    }, 'a late configChanged after the timeout does not toggle twice');

    check(() => {
        // An empty queue on timeout is a no-op and must not warn.
        const warningsBefore = harness.warnings.length;
        safetyTimer(context).fire();
        assert.equal(harness.warnings.length, warningsBefore);
    }, 'an empty queue on the safety timeout does nothing');
}

// ========================================================= 10. dropped queued press
{
    const { context } = load({ WindowName1: 'anything', windows: [] });

    check(() => {
        activate(context, settingsWindow());
        const before = harness.warnings.length;
        for (let i = 0; i < 9; ++i) {
            harness.shortcuts[0].callback();
        }
        assert.equal(context.pendingToggles.length, 8, 'the cap stays at 8');
        const logged = harness.warnings.slice(before);
        assert.equal(logged.length, 1, 'dropping the oldest press warns exactly once');
        assert.match(logged[0], /queue of pending toggles is full/);
        assert.match(logged[0], /dropping the oldest/);
    }, 'a queued press dropped by the cap is reported with a warning');
}

// ============================================== 11. which windows are settings windows
{
    check(() => {
        const classes = ['systemsettings', 'plasma-systemsettings', 'plasma-settings',
            'kcmshell', 'kcmshell5', 'kcmshell6'];
        for (const className of classes) {
            const { context } = load({ windows: [] });
            activate(context, makeWindow('Settings', { resourceClass: className }));
            assert.equal(context.settingsWindowSeen, true, className + ' is a settings window');
        }

        const { context } = load({ windows: [] });
        activate(context, makeWindow('Settings', { resourceClass: 'plasma-settings-helper' }));
        assert.equal(context.settingsWindowSeen, false, 'a look-alike class name is not one');
    }, 'plasma-settings and the whole kcmshell family are recognised, look-alikes are not');
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
}

console.log('');
if (failures) {
    console.log(failures + ' check(s) failed');
    process.exit(1);
}
console.log('All main.js checks passed.');