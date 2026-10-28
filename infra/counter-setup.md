# Setting up a counter PC

A counter keeps unsynced bills in the browser's storage on that PC (D-010, D-089). These steps make sure the browser never deletes them. One-time per PC, about 10 minutes.

## What the PC needs

- Windows with **current Chrome or Edge**, signed in to a normal Windows account (not a guest account).
- The internet for the setup itself; after that the counter works offline.

## Steps

1. **In the back office** (`app.zorbixtechnologies.com`), as a manager: *Counters* → choose the branch and kind → **Create a one-time code**. The code is valid for an hour and works once.
2. **On the counter PC**, open `https://pos.zorbixtechnologies.com` in a normal window (never InPrivate or Incognito).
3. **Install the POS:** the install icon at the end of the address bar → *Install*. Always open the POS from its own icon afterwards. Chrome gives permanent storage to an installed app; without it the counter shows *This counter cannot sell yet* and stays stopped (POS spec §3).
4. In the POS, enter the shop code and the one-time code → **Set up counter**. The counter gets its code (C01, C02…), shown in the status bar.
5. **Staff PINs:** in the back office, give each person a temporary PIN and tell them in person. At their first unlock the counter makes them choose their own (this needs the internet).

## Printing bills (POS spec §13)

Bills print with no dialog to the PC's **default Windows printer** (Delux: the shared printer at the cash counter).

1. Install the bill printer in Windows (*Settings → Bluetooth & devices → Printers & scanners*) and **set it as the default**. Turn off *Let Windows manage my default printer*.
2. **A5 landscape** (Delux): in the printer's *Printing preferences*, choose paper size **A5** and orientation **Landscape**. If the driver has no A5, add a custom form of 210 × 148 mm (*Print server properties → Forms*). An A4 profile needs no change.
3. **Silent printing:** right-click the POS icon (on the desktop or the taskbar) → *Properties* → in *Target*, add ` --kiosk-printing` after the existing text, then *OK*. Always start the POS from this icon.
4. Check: unlock, sell one item for cash, and the bill should come out of the printer without a dialog. If a print is lost or jammed, **Alt+P** reprints any bill of the last 30 days, marked REPRINT.

## Keep the browser from deleting data

- Do not use *Clear browsing data*, cleaner tools (for example CCleaner) or "clear on exit" settings on a counter PC.
- In the browser settings, *Cookies and site data*: **off** for "Clear cookies and site data when you close all windows".
- For PCs we manage with policies (optional, Chrome and Edge use the same names): `ClearBrowsingDataOnExitList` empty, `CookiesAllowedForUrls` includes `https://pos.zorbixtechnologies.com`, `IncognitoModeAvailability` = 1 (InPrivate/Incognito off), `BrowserGuestModeEnabled` = false.
- Never "reset" the browser or delete its profile while the status bar shows bills waiting to sync.

## Moving or replacing a counter

Revoke the old counter in *Counters* only after its status bar shows **0 bills waiting to sync**. A revoked counter can no longer sync.
