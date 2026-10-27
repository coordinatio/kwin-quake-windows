// End-to-end check of the Quake Windows settings KCM.
//
// Reproduces what KWin's "KWin Scripts" KCM does when the user presses
// "Configure": it hands the *package* metadata to KCMultiDialog, which resolves
// the X-KDE-ConfigModule plugin and lets it load contents/config/main.xml plus
// contents/ui/config.ui.
//
// This is the only test that covers the whole wiring - KConfigXT main.xml <->
// config.ui <-> the [Script-quakewindows] group in kwinrc <-> KLocalizedTranslator
// - because no JavaScript test can instantiate a KCModule.
//
// Build and run it through tests/run-kcm-test.sh, which installs the package into
// a temporary XDG_DATA_HOME and writes the kwinrc fixture. Building it by hand:
//
//   g++ -std=c++20 -fPIC kcm-test.cpp -o kcm-test \
//       $(for d in /usr/include/KF6/*/; do echo -n "-I$d "; done) \
//       -I/usr/include/qt6 -I/usr/include/qt6/QtCore -I/usr/include/qt6/QtGui \
//       -I/usr/include/qt6/QtWidgets \
//       -lKF6KCMUtils -lKF6KCMUtilsCore -lKF6ConfigCore -lKF6ConfigGui \
//       -lKF6ConfigWidgets -lKF6CoreAddons -lKF6WidgetsAddons \
//       -lQt6Widgets -lQt6Gui -lQt6Core
//
// QUAKEWINDOWS_TEST_EXPECT_LANG selects the language the form has to show: "C"
// for English, "ru" for the Russian catalog. Without it the language assertion is
// skipped, so a manual run cannot fail for an environment reason.

#include <QApplication>
#include <QCheckBox>
#include <QFile>
#include <QLabel>
#include <QLocale>
#include <KCMultiDialog>
#include <KCModule>
#include <QLineEdit>
#include <QRegularExpression>
#include <QTextStream>
#include <KPluginMetaData>
#include <QPluginLoader>

static int failures = 0;

static void check(bool ok, const QString &message)
{
    QTextStream out(stdout);
    out << (ok ? "ok:   " : "FAIL: ") << message << Qt::endl;
    if (!ok) {
        ++failures;
    }
}

int main(int argc, char **argv)
{
    QApplication app(argc, argv);
    QTextStream out(stdout);

    const QString dataDir = qEnvironmentVariable("XDG_DATA_HOME");
    const QString metaPath = dataDir + QStringLiteral("/kwin/scripts/quakewindows/metadata.json");
    check(QFile::exists(metaPath), QStringLiteral("installed package metadata exists at %1").arg(metaPath));

    const KPluginMetaData packageMeta = KPluginMetaData::fromJsonFile(metaPath);
    check(packageMeta.isValid(), QStringLiteral("package metadata parses"));
    check(packageMeta.pluginId() == QStringLiteral("quakewindows"),
          QStringLiteral("plugin id is 'quakewindows' (got %1)").arg(packageMeta.pluginId()));
    check(packageMeta.value(QStringLiteral("X-KDE-ConfigModule"))
              == QStringLiteral("kwin/effects/configs/kcm_kwin4_genericscripted"),
          QStringLiteral("X-KDE-ConfigModule points at the generic scripted config module"));
    check(packageMeta.value(QStringLiteral("X-KWin-Config-TranslationDomain")) == QStringLiteral("quakewindows"),
          QStringLiteral("X-KWin-Config-TranslationDomain is 'quakewindows'"));

    // KCMUtils' KPluginModel resolves X-KDE-ConfigModule the same way: the
    // package's raw metadata plus the absolute path of the plugin library.
    const QString configModuleId = packageMeta.value(QStringLiteral("X-KDE-ConfigModule"));
    const QString configModulePath = QPluginLoader(configModuleId).fileName();
    check(!configModulePath.isEmpty(),
          QStringLiteral("X-KDE-ConfigModule '%1' resolves to a plugin library (got '%2')")
              .arg(configModuleId, configModulePath));
    const KPluginMetaData meta(packageMeta.rawData(), configModulePath);

    auto openDialog = [&meta, &packageMeta]() {
        auto *dialog = new KCMultiDialog();
        dialog->addModule(meta, QVariantList{packageMeta.pluginId(), QStringLiteral("KWin/Script")});
        dialog->show();
        return dialog;
    };

    // ---------------------------------------------------------------- first run
    KCMultiDialog *dialog = openDialog();
    app.processEvents();

    const auto modules = dialog->findChildren<KCModule *>();
    check(modules.size() == 1, QStringLiteral("one KCModule was created (got %1)").arg(modules.size()));
    if (modules.isEmpty()) {
        return 1;
    }
    KCModule *module = modules.first();
    module->load();
    app.processEvents();

    QWidget *form = module->widget();
    check(form != nullptr, QStringLiteral("the module provides a widget"));
    if (!form) {
        return 1;
    }

    bool errorLabel = false;
    const auto labels = form->findChildren<QLabel *>();
    for (QLabel *label : labels) {
        if (label->text().contains(QStringLiteral("does not exist"))
            || label->text().contains(QStringLiteral("Error loading widget"))) {
            errorLabel = true;
            out << "  ERROR LABEL: " << label->text() << Qt::endl;
        }
    }
    check(!errorLabel, QStringLiteral("no 'missing file' / 'error loading widget' label is shown"));

    QWidget *configForm = form->findChild<QWidget *>(QStringLiteral("KWin::QuakeWindowsConfigForm"));
    check(configForm != nullptr, QStringLiteral("the configuration form KWin::QuakeWindowsConfigForm was loaded"));

    // ---------------------------------------------------------- translated labels
    //
    // KLocalizedTranslator translates this form from the compiled catalog named by
    // X-KWin-Config-TranslationDomain, so the intro label is the runtime proof that
    // the catalog is found. The runner starts the test once per locale and says
    // which language to expect through QUAKEWINDOWS_TEST_EXPECT_LANG; the Russian
    // assertion is skipped when Qt did not pick the Russian language up, so it can
    // never fail for an environment reason.
    auto *intro = form->findChild<QLabel *>(QStringLiteral("introLabel"));
    check(intro != nullptr, QStringLiteral("the intro label exists"));
    const QString introText = intro ? intro->text() : QString();
    const QString expectedLanguage = qEnvironmentVariable("QUAKEWINDOWS_TEST_EXPECT_LANG");
    if (expectedLanguage == QLatin1String("ru")) {
        if (QLocale::system().language() == QLocale::Russian) {
            check(introText.startsWith(QStringLiteral("Показать")),
                  QStringLiteral("the intro label is translated into Russian (got '%1')").arg(introText));
        } else {
            out << "SKIP: the Russian intro label is not checked, Qt did not pick ru_RU.UTF-8 up"
                << Qt::endl;
        }
    } else if (expectedLanguage == QLatin1String("C")) {
        check(introText.startsWith(QStringLiteral("Toggle any window")),
              QStringLiteral("the intro label stays English under LANG=C.UTF-8 (got '%1')").arg(introText));
    } else {
        out << "SKIP: no language expectation was passed, the intro label is not checked"
            << Qt::endl;
    }

    auto edit = [form](int slot) {
        return form->findChild<QLineEdit *>(QStringLiteral("kcfg_WindowName%1").arg(slot));
    };
    auto box = [form](int slot) {
        return form->findChild<QCheckBox *>(QStringLiteral("kcfg_Enabled%1").arg(slot));
    };

    check(edit(1) && edit(1)->text() == QStringLiteral("^Alacritty$"),
          QStringLiteral("WindowName1 is populated from kwinrc (got %1)").arg(edit(1) ? edit(1)->text() : QStringLiteral("<missing>")));
    check(edit(3) && edit(3)->text() == QStringLiteral("Чат и звонки"),
          QStringLiteral("WindowName3 keeps its Cyrillic value"));
    check(box(3) && !box(3)->isChecked(), QStringLiteral("Enabled3=false is read from kwinrc"));
    check(edit(3) && !edit(3)->isEnabled(),
          QStringLiteral("the disabled slot's line edit is disabled through the .ui connection"));
    check(box(1) && box(1)->isChecked(), QStringLiteral("a missing Enabled1 defaults to checked"));
    check(edit(7) && edit(7)->text().isEmpty(), QStringLiteral("unconfigured WindowName7 is empty (no implicit default)"));

    // ---------------------------------------------------------------- apply changes
    edit(7)->setText(QStringLiteral("^New Tab — Original profile$"));
    box(7)->setChecked(true);
    box(2)->setChecked(false);
    edit(5)->setText(QStringLiteral("^.+ - Mozilla Thunderbird$"));
    module->save();
    app.processEvents();

    QFile kwinrc(qEnvironmentVariable("XDG_CONFIG_HOME") + QStringLiteral("/kwinrc"));
    check(kwinrc.open(QIODevice::ReadOnly), QStringLiteral("kwinrc exists after save"));
    const QString contents = QString::fromUtf8(kwinrc.readAll());
    kwinrc.close();

    QRegularExpression groupRe(QStringLiteral("(?m)^\\[Script-quakewindows\\]$"));
    check(groupRe.match(contents).hasMatch(), QStringLiteral("save wrote the [Script-quakewindows] group"));
    check(!contents.contains(QStringLiteral("[Script-quakewindows/")),
          QStringLiteral("save did not create a nested group"));
    check(contents.contains(QStringLiteral("\nWindowName7=^New Tab — Original profile$")),
          QStringLiteral("WindowName7 was written"));
    // KConfigSkeleton only writes entries that differ from their default, so
    // EnabledN=true is intentionally absent and falls back to the default.
    check(!contents.contains(QStringLiteral("\nEnabled7=false")), QStringLiteral("Enabled7 stays at its true default"));
    check(contents.contains(QStringLiteral("\nEnabled2=false")), QStringLiteral("Enabled2 was written as false"));
    check(contents.contains(QStringLiteral("WindowName2=^.*Rocket")) && contents.contains(QStringLiteral("Chat.*$")),
          QStringLiteral("WindowName2 is preserved while its slot is disabled"));
    check(contents.contains(QStringLiteral("\nWindowName5=^.+ - Mozilla Thunderbird$")),
          QStringLiteral("WindowName5 was written"));
    check(contents.contains(QStringLiteral("WindowName3=Чат и звонки")),
          QStringLiteral("WindowName3 with Cyrillic is preserved"));

    out << "--- kwinrc [Script-quakewindows] ---" << Qt::endl;
    const int start = contents.indexOf(QStringLiteral("[Script-quakewindows]"));
    out << contents.mid(start, contents.indexOf(QStringLiteral("\n["), start + 1) - start) << Qt::endl;

    dialog->close();
    delete dialog;
    app.processEvents();

    // ---------------------------------------------------------------- reload round trip
    KCMultiDialog *second = openDialog();
    app.processEvents();
    const auto secondModules = second->findChildren<KCModule *>();
    check(!secondModules.isEmpty(), QStringLiteral("the dialog can be reopened"));
    if (!secondModules.isEmpty()) {
        secondModules.first()->load();
        app.processEvents();
        QWidget *form2 = secondModules.first()->widget();
        auto edit2 = [form2](int slot) {
            return form2->findChild<QLineEdit *>(QStringLiteral("kcfg_WindowName%1").arg(slot));
        };
        auto box2 = [form2](int slot) {
            return form2->findChild<QCheckBox *>(QStringLiteral("kcfg_Enabled%1").arg(slot));
        };
        check(edit2(7) && edit2(7)->text() == QStringLiteral("^New Tab — Original profile$"),
              QStringLiteral("reopened dialog shows the saved WindowName7"));
        check(box2(2) && !box2(2)->isChecked(), QStringLiteral("reopened dialog shows Enabled2 unchecked"));
        check(edit2(2) && !edit2(2)->isEnabled(), QStringLiteral("reopened dialog keeps the disabled field disabled"));
    }

    // ---------------------------------------------------------------- Defaults button
    check(!secondModules.isEmpty(), QStringLiteral("a module is available for the Defaults test"));
    if (!secondModules.isEmpty()) {
        KCModule *defaultsModule = secondModules.first();
        defaultsModule->load();
        app.processEvents();
        defaultsModule->defaults();
        app.processEvents();
        QWidget *form3 = defaultsModule->widget();
        bool allEmpty = true;
        bool allChecked = true;
        for (int slot = 1; slot <= 7; ++slot) {
            auto *edit = form3->findChild<QLineEdit *>(QStringLiteral("kcfg_WindowName%1").arg(slot));
            auto *box = form3->findChild<QCheckBox *>(QStringLiteral("kcfg_Enabled%1").arg(slot));
            allEmpty = allEmpty && edit && edit->text().isEmpty();
            allChecked = allChecked && box && box->isChecked();
        }
        check(allEmpty, QStringLiteral("Defaults clears every expression"));
        check(allChecked, QStringLiteral("Defaults re-enables every slot"));

        defaultsModule->save();
        app.processEvents();
        QFile afterDefaults(qEnvironmentVariable("XDG_CONFIG_HOME") + QStringLiteral("/kwinrc"));
        afterDefaults.open(QIODevice::ReadOnly);
        const QString content = QString::fromUtf8(afterDefaults.readAll());
        afterDefaults.close();
        check(!content.contains(QStringLiteral("Enabled3=false")) && !content.contains(QStringLiteral("Enabled2=false")),
              QStringLiteral("saving the defaults removes the EnabledN=false overrides"));
        check(!content.contains(QStringLiteral("WindowName7=^New Tab")),
              QStringLiteral("saving the defaults removes the stored expressions"));
    }

    out << Qt::endl << failures << " check(s) failed" << Qt::endl;
    return failures == 0 ? 0 : 1;
}
