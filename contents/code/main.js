/*
   SPDX-FileCopyrightText: 2023 Ivan Volkov <angrycore@gmail.com>
   SPDX-License-Identifier: GPL-3.0-or-later
*/

var windowName = [null, null, null, null, null, null, null];

function isRelevant(client, index) {
   if (windowName[index] === null)
      return false
   if ('caption' in client)
      return windowName[index].test(client.caption)
   return false;
}

function toggleWindow(index) {
   assertTrue(windowName[index] != null, `QuakeWindows failed to load WindowName${index+1} from config!`);
   var allClients = workspace.windowList();
   for (var i = 0; i < allClients.length; ++i) {
      if (isRelevant(allClients[i], index)) {
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
}

function init() {
   for (let i = 0; i < windowName.length; ++i) {
      // kwriteconfig6 --file ~/.config/kwinrc --group Script-quakewindows --key WindowName1 <window title regex>
      windowName[i] = new RegExp(readConfig(`WindowName${i+1}`, "Alacritty").toString());
      registerShortcut(`QuakeWindows ${i+1}`, `Toggle Window ${i+1}`, "", function () {toggleWindow(i)});
   }
   options.configChanged.connect(init);
}

init();
