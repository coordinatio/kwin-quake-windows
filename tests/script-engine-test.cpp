// Checks contents/code/main.js against a real Qt script engine.
//
// The JavaScript suite (tests/main-js-test.mjs) runs the script against hand-made
// mocks; this one runs it in a QJSEngine and drives the real shortcut callbacks,
// the real options.configChanged signal and a real QTimer timeout. It is the only
// suite that can prove the script only uses what KWin actually exposes:
//
//   * QTimer is registered exactly as KWin registers it in scripting.cpp - the
//     meta-object of a QTimer subclass with a Q_INVOKABLE constructor
//     (KWin::ScriptTimer). Everything the script touches (singleShot, interval,
//     start(), stop(), timeout) therefore comes from QTimer's own meta-object,
//     and a method QTimer does not expose (isActive(), say) fails here instead of
//     in a user session.
//   * readConfig, callDBus and registerShortcut are properties of one object,
//     copied onto the global object the way KWin copies the methods of the Script
//     object, so they are global functions here too.
//   * console, workspace and options are recording fakes with the same shape as
//     KWin's: options emits configChanged, workspace has an activeWindow property,
//     windowList() and the windowActivated/currentDesktopChanged signals.
//
// Build and run it through tests/run-script-engine-test.sh. By hand:
//
//   moc script-engine-test.cpp -o script-engine-test.moc
//   g++ -std=c++20 -fPIC script-engine-test.cpp -o script-engine-test -I. \
//       $(pkg-config --cflags --libs Qt6Core Qt6Qml)
//   ./script-engine-test ../../contents/code/main.js
//
// SPDX-License-Identifier: GPL-3.0-or-later

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QHash>
#include <QJSValue>
#include <QJSEngine>
#include <QList>
#include <QObject>
#include <QString>
#include <QStringList>
#include <QTextStream>
#include <QThread>
#include <QTimer>
#include <QVariant>
#include <QVariantList>

#include <functional>

static int failures = 0;

static QTextStream &stream()
{
    static QTextStream out(stdout);
    return out;
}

static void check(bool ok, const QString &message)
{
    stream() << (ok ? "ok:   " : "FAIL: ") << message << Qt::endl;
    if (!ok) {
        ++failures;
    }
}

// --------------------------------------------------------------- fakes

// QTimer exactly as KWin's scripting.cpp exposes it: the meta-object of
// KWin::ScriptTimer, which is a QTimer with nothing but a Q_INVOKABLE
// constructor (that is what makes `new QTimer()` possible from JavaScript).
class ScriptTimer : public QTimer
{
    Q_OBJECT

public:
    Q_INVOKABLE ScriptTimer(QObject *parent = nullptr)
        : QTimer(parent)
    {
    }
};

class FakeWindow : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QString caption MEMBER caption)
    Q_PROPERTY(QString resourceClass MEMBER resourceClass)
    Q_PROPERTY(QString resourceName MEMBER resourceName)
    Q_PROPERTY(bool minimized MEMBER minimized)
    Q_PROPERTY(bool onAllDesktops MEMBER onAllDesktops)
    Q_PROPERTY(bool skipTaskbar MEMBER skipTaskbar)
    Q_PROPERTY(bool skipPager MEMBER skipPager)
    Q_PROPERTY(bool skipSwitcher MEMBER skipSwitcher)

public:
    explicit FakeWindow(const QString &caption,
                        const QString &resourceClass = QStringLiteral("app"),
                        QObject *parent = nullptr)
        : QObject(parent)
        , caption(caption)
        , resourceClass(resourceClass)
        , resourceName(resourceClass)
    {
    }

    QString caption;
    QString resourceClass;
    QString resourceName;
    bool minimized = false;
    bool onAllDesktops = false;
    bool skipTaskbar = false;
    bool skipPager = false;
    bool skipSwitcher = false;
};

class FakeWorkspace : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QObject *activeWindow READ activeWindow WRITE setActiveWindow NOTIFY activeWindowChanged)

public:
    explicit FakeWorkspace(QObject *parent = nullptr)
        : QObject(parent)
    {
    }

    QObject *activeWindow() const
    {
        return m_activeWindow;
    }

    void setActiveWindow(QObject *window)
    {
        m_activeWindow = window;
    }

    Q_INVOKABLE QVariantList windowList() const
    {
        ++m_windowListCalls;
        QVariantList list;
        list.reserve(m_windows.size());
        for (QObject *window : m_windows) {
            list.append(QVariant::fromValue(window));
        }
        return list;
    }

    void addWindow(QObject *window)
    {
        window->setParent(this);
        m_windows.append(window);
    }

    // KWin makes the new window active before it emits windowActivated, so the
    // handler always sees the client it is told about through activeWindow.
    void activate(QObject *window)
    {
        m_activeWindow = window;
        emit activeWindowChanged();
        emit windowActivated(window);
    }

    int windowListCalls() const
    {
        return m_windowListCalls;
    }

signals:
    void activeWindowChanged();
    void windowActivated(QObject *client);
    void currentDesktopChanged(int previousDesktop, int currentDesktop);

private:
    QList<QObject *> m_windows;
    QObject *m_activeWindow = nullptr;
    mutable int m_windowListCalls = 0;
};

class FakeOptions : public QObject
{
    Q_OBJECT

signals:
    void configChanged();
};

// The one deliberately replaced piece: KWin installs the console extension, but a
// test has to read back what the script writes to the journal.
class FakeConsole : public QObject
{
    Q_OBJECT

public:
    Q_INVOKABLE void warn(const QString &message)
    {
        warnings.append(message);
    }

    Q_INVOKABLE void info(const QString &message)
    {
        infos.append(message);
    }

    Q_INVOKABLE void log(const QString &message)
    {
        infos.append(message);
    }

    QStringList warnings;
    QStringList infos;
};

// Stands in for the Script object KWin copies readConfig/callDBus/registerShortcut
// and the seven-slot kwinrc group from.
class FakeHost : public QObject
{
    Q_OBJECT

public:
    struct Shortcut {
        QString id;
        QString name;
        QString key;
        QJSValue callback;
    };

    explicit FakeHost(QObject *parent = nullptr)
        : QObject(parent)
    {
    }

    Q_INVOKABLE QVariant readConfig(const QString &key, const QVariant &fallback)
    {
        ++m_configReads;
        return m_config.contains(key) ? m_config.value(key) : fallback;
    }

    Q_INVOKABLE void callDBus(const QString &service, const QString &path,
                              const QString &interface, const QString &method)
    {
        dbusCalls.append(service + u' ' + path + u' ' + interface + u' ' + method);
    }

    Q_INVOKABLE void registerShortcut(const QString &id, const QString &name,
                                      const QString &key, const QJSValue &callback)
    {
        shortcuts.append({id, name, key, callback});
    }

    void setConfig(const QString &key, const QVariant &value)
    {
        m_config.insert(key, value);
    }

    int configReads() const
    {
        return m_configReads;
    }

    int reconfigureCalls() const
    {
        int calls = 0;
        for (const QString &call : dbusCalls) {
            if (call.endsWith(QLatin1String(" org.kde.KWin reconfigure"))) {
                ++calls;
            }
        }
        return calls;
    }

    QList<Shortcut> shortcuts;
    QStringList dbusCalls;

private:
    QHash<QString, QVariant> m_config;
    int m_configReads = 0;
};

// ------------------------------------------------------------------- harness

// One harness per scenario: a fresh QJSEngine means a fresh copy of every global
// of the script, which is what makes the scenarios independent of each other.
class Harness
{
public:
    Harness()
    {
        const QJSValue hostObject = engine.newQObject(&host);
        QJSEngine::setObjectOwnership(&host, QJSEngine::CppOwnership);

        // KWin copies the properties of the Script object onto the global object,
        // which is what makes them global functions for a script.
        const QStringList globals{QStringLiteral("readConfig"),
                                  QStringLiteral("callDBus"),
                                  QStringLiteral("registerShortcut")};
        for (const QString &name : globals) {
            engine.globalObject().setProperty(name, hostObject.property(name));
        }

        // "Make the timer visible to QJSEngine", word for word from scripting.cpp.
        engine.globalObject().setProperty(QStringLiteral("QTimer"),
                                          engine.newQMetaObject(&ScriptTimer::staticMetaObject));

        engine.globalObject().setProperty(QStringLiteral("console"), engine.newQObject(&console));
        engine.globalObject().setProperty(QStringLiteral("workspace"), engine.newQObject(&workspace));
        engine.globalObject().setProperty(QStringLiteral("options"), engine.newQObject(&options));
        QJSEngine::setObjectOwnership(&console, QJSEngine::CppOwnership);
        QJSEngine::setObjectOwnership(&workspace, QJSEngine::CppOwnership);
        QJSEngine::setObjectOwnership(&options, QJSEngine::CppOwnership);
    }

    bool load(const QString &source)
    {
        const QJSValue result = engine.evaluate(source, QStringLiteral("main.js"));
        if (result.isError()) {
            stream() << "FAIL: evaluating main.js failed: "
                     << result.property(QStringLiteral("message")).toString() << Qt::endl;
            ++failures;
            return false;
        }
        return true;
    }

    QString warnings() const
    {
        return console.warnings.join(u'\n');
    }

    int reconfigureCalls() const
    {
        return host.reconfigureCalls();
    }

    FakeHost host;
    FakeConsole console;
    FakeWorkspace workspace;
    FakeOptions options;
    // Declared last, so it is destroyed first: the JavaScript wrappers of the
    // fakes must not outlive the engine.
    QJSEngine engine;
};

// Presses a hotkey. The script wraps every handler, so an exception escaping here
// would mean a guard is missing.
static void press(Harness &harness, int slot)
{
    if (slot < 0 || slot >= harness.host.shortcuts.size()) {
        stream() << "FAIL: no shortcut is registered for slot " << slot + 1 << Qt::endl;
        ++failures;
        return;
    }
    const QJSValue result = harness.host.shortcuts.at(slot).callback.call();
    if (result.isError()) {
        stream() << "FAIL: the handler of slot " << slot + 1
                 << " threw: " << result.toString() << Qt::endl;
        ++failures;
    }
}

// A bounded event loop, so the real timer can fire without a QtTest dependency.
static bool waitFor(const std::function<bool()> &done, int timeoutMs)
{
    QElapsedTimer elapsed;
    elapsed.start();
    while (elapsed.elapsed() < timeoutMs) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 10);
        if (done()) {
            return true;
        }
        QThread::msleep(2);
    }
    QCoreApplication::processEvents(QEventLoop::AllEvents, 10);
    return done();
}

static bool containsInfo(const Harness &harness, const QString &text)
{
    for (const QString &info : harness.console.infos) {
        if (info.contains(text)) {
            return true;
        }
    }
    return false;
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);

    const QString scriptPath = argc > 1 ? QString::fromLocal8Bit(argv[1])
                                        : QStringLiteral("contents/code/main.js");
    QFile scriptFile(scriptPath);
    if (!scriptFile.open(QIODevice::ReadOnly)) {
        stream() << "FAIL: cannot read " << scriptPath << Qt::endl;
        return 1;
    }
    const QString source = QString::fromUtf8(scriptFile.readAll());

    // ----------------------------------------------- 1. the exposed meta-object
    {
        Harness harness;
        check(harness.engine.globalObject().property(QStringLiteral("QTimer")).isObject(),
              QStringLiteral("QTimer is a global, as scripting.cpp registers ScriptTimer"));

        const QJSValue probe = harness.engine.evaluate(QStringLiteral(
            "var probeHits = 0;"
            "var probeTimer = new QTimer();"
            "probeTimer.singleShot = true;"
            "probeTimer.interval = 10;"
            "probeTimer.timeout.connect(function () { probeHits += 1; });"
            "probeTimer.start(10);"
            "'armed'"));
        check(!probe.isError() && probe.toString() == QLatin1String("armed"),
              QStringLiteral("new QTimer() with singleShot/interval/timeout.connect/start works: ")
                  + (probe.isError() ? probe.toString() : probe.toString()));
        check(waitFor([&harness] {
                  return harness.engine.evaluate(QStringLiteral("probeHits")).toInt() >= 1;
              }, 2000),
              QStringLiteral("the real QTimer fires its timeout signal inside the harness event loop"));

        const QJSValue stopProbe = harness.engine.evaluate(QStringLiteral(
            "(function () { var timer = new QTimer(); timer.start(500); timer.stop(); return 'stopped'; })()"));
        check(!stopProbe.isError() && stopProbe.toString() == QLatin1String("stopped"),
              QStringLiteral("start() and stop() are both exposed"));

        // This is what makes the harness fail loudly: a script that calls a QTimer
        // method KWin does not expose throws, and its own try/catch turns that into
        // a warning the checks below would report.
        const QJSValue missing = harness.engine.evaluate(QStringLiteral(
            "(function () {"
            "  try { new QTimer().isActive(); return 'callable'; }"
            "  catch (error) { return 'absent'; }"
            "})()"));
        check(missing.toString() == QLatin1String("absent"),
              QStringLiteral("QTimer.isActive() is absent, as in KWin, so using it cannot go unnoticed"));
    }

    // ------------------------------------ 2. registration and a synchronous press
    {
        Harness harness;
        auto *terminal = new FakeWindow(QStringLiteral("alacritty"));
        auto *chat = new FakeWindow(QStringLiteral("chat"));
        harness.workspace.addWindow(terminal);
        harness.workspace.addWindow(chat);
        harness.host.setConfig(QStringLiteral("WindowName1"), QStringLiteral("^alacritty$"));
        harness.host.setConfig(QStringLiteral("WindowName2"), QStringLiteral("^chat$"));
        harness.load(source);

        check(harness.host.shortcuts.size() == 7,
              QStringLiteral("seven shortcuts are registered (got %1)")
                  .arg(harness.host.shortcuts.size()));

        bool idsOk = harness.host.shortcuts.size() == 7;
        for (int index = 0; index < harness.host.shortcuts.size(); ++index) {
            const FakeHost::Shortcut &shortcut = harness.host.shortcuts.at(index);
            idsOk = idsOk
                && shortcut.id == QStringLiteral("QuakeWindows %1").arg(index + 1)
                && shortcut.name == QStringLiteral("Toggle Window %1").arg(index + 1)
                && shortcut.key.isEmpty()
                && shortcut.callback.isCallable();
        }
        check(idsOk,
              QStringLiteral("the ids, names and empty default keys are unchanged (QuakeWindows 1..7, Toggle Window 1..7)"));

        check(harness.console.warnings.isEmpty(),
              QStringLiteral("a valid configuration loads without a warning: ") + harness.warnings());
        check(containsInfo(harness, QStringLiteral("active slots: 1: ^alacritty$, 2: ^chat$")),
              QStringLiteral("the active slots are reported"));

        press(harness, 0);
        check(terminal->minimized && terminal->skipTaskbar && terminal->skipPager
                  && terminal->skipSwitcher && terminal->onAllDesktops,
              QStringLiteral("a fresh press toggles the matching window and all four flags"));
        check(!chat->minimized, QStringLiteral("a window that matches another slot is untouched"));

        press(harness, 0);
        check(!terminal->minimized && !terminal->skipTaskbar,
              QStringLiteral("a second press restores the window"));
        check(harness.reconfigureCalls() == 0,
              QStringLiteral("a fresh press never asks KWin to reconfigure (got %1)")
                  .arg(harness.reconfigureCalls()));
    }

    // ------------- 3. deferral behind a settings window, replay and press parity
    {
        Harness harness;
        auto *settings = new FakeWindow(QStringLiteral("System Settings"),
                                        QStringLiteral("systemsettings"));
        auto *terminal = new FakeWindow(QStringLiteral("alacritty"));
        auto *renamed = new FakeWindow(QStringLiteral("renamed"));
        harness.workspace.addWindow(settings);
        harness.workspace.addWindow(terminal);
        harness.workspace.addWindow(renamed);
        harness.host.setConfig(QStringLiteral("WindowName1"), QStringLiteral("^alacritty$"));
        harness.load(source);

        harness.workspace.activate(settings);
        press(harness, 0);
        check(!terminal->minimized,
              QStringLiteral("a press while a settings window is active is deferred, not toggled"));
        check(harness.reconfigureCalls() == 1,
              QStringLiteral("the deferred press asks KWin to reconfigure exactly once (got %1)")
                  .arg(harness.reconfigureCalls()));

        // Apply: the fake kwinrc changes and KWin emits options.configChanged.
        harness.host.setConfig(QStringLiteral("WindowName1"), QStringLiteral("^renamed$"));
        emit harness.options.configChanged();

        check(renamed->minimized,
              QStringLiteral("options.configChanged replays the press with the new expression"));
        check(!terminal->minimized, QStringLiteral("the stale expression was not used"));
        check(harness.console.warnings.isEmpty(),
              QStringLiteral("the deferral and the replay do not warn: ") + harness.warnings());

        // The parity rule: the dialog is still focused (the latch survives the
        // reload), so two presses cancel out instead of toggling twice.
        const bool minimizedBefore = renamed->minimized;
        const int callsBefore = harness.reconfigureCalls();
        press(harness, 0);
        press(harness, 0);
        check(harness.reconfigureCalls() == callsBefore + 1,
              QStringLiteral("two deferred presses reuse the one pending reload request"));
        emit harness.options.configChanged();
        check(renamed->minimized == minimizedBefore,
              QStringLiteral("two deferred presses cancel out and toggle nothing"));
        check(harness.console.warnings.isEmpty(),
              QStringLiteral("a replay of nothing warns about nothing: ") + harness.warnings());
    }

    // ------------------------------- 4. the real timer deadline and its replay
    {
        Harness harness;
        auto *settings = new FakeWindow(QStringLiteral("System Settings"),
                                        QStringLiteral("systemsettings"));
        auto *terminal = new FakeWindow(QStringLiteral("alacritty"));
        auto *late = new FakeWindow(QStringLiteral("late"));
        harness.workspace.addWindow(settings);
        harness.workspace.addWindow(terminal);
        harness.workspace.addWindow(late);
        harness.host.setConfig(QStringLiteral("WindowName1"), QStringLiteral("^alacritty$"));
        harness.load(source);

        harness.workspace.activate(settings);
        QElapsedTimer deadline;
        deadline.start();
        press(harness, 0);
        check(!terminal->minimized, QStringLiteral("the press waits for the deadline"));

        // KWin reparsed kwinrc, but options.configChanged never arrives, so only
        // the timeout can pick the new value up.
        harness.host.setConfig(QStringLiteral("WindowName1"), QStringLiteral("^late$"));

        check(waitFor([late] {
                  return late->minimized;
              }, 4000),
              QStringLiteral("the real 1 s timer fires and replays the pending press"));

        // The bound is what makes a deadline regression visible: changing
        // CONFIG_TIMEOUT_MS to 2000 ms would still replay the press, just too
        // late, so the wait itself is measured. The lower bound catches a
        // deadline that fires far too early.
        const qint64 replayMs = deadline.elapsed();
        check(replayMs < 1500,
              QStringLiteral("the replay happens within 1.5 s of the deferral (took %1 ms)")
                  .arg(replayMs));
        check(replayMs >= 500,
              QStringLiteral("the replay waits for a deadline of about 1 s (took %1 ms)")
                  .arg(replayMs));
        check(!terminal->minimized,
              QStringLiteral("the re-read expression decided the replay, not the stale one"));
        check(harness.warnings().contains(QStringLiteral("did not confirm the configuration reload")),
              QStringLiteral("the missed confirmation is reported once: ") + harness.warnings());

        const int warningsBefore = harness.console.warnings.size();
        emit harness.options.configChanged();
        check(late->minimized,
              QStringLiteral("a late options.configChanged does not toggle the window twice"));
        check(harness.console.warnings.size() == warningsBefore,
              QStringLiteral("nothing warns after the deadline was handled"));

        // The replay restored nothing (the window was not minimized before), so a
        // press afterwards must work synchronously again.
        check(harness.reconfigureCalls() == 1,
              QStringLiteral("the whole deadline path costs exactly one reconfigure (got %1)")
                  .arg(harness.reconfigureCalls()));
    }

    stream() << Qt::endl;
    if (failures) {
        stream() << failures << " check(s) failed" << Qt::endl;
        return 1;
    }
    stream() << "All script engine checks passed." << Qt::endl;
    return 0;
}

#include "script-engine-test.moc"
