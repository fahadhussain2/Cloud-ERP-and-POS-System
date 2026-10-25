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

## Keep the browser from deleting data

- Do not use *Clear browsing data*, cleaner tools (for example CCleaner) or "clear on exit" settings on a counter PC.
- In the browser settings, *Cookies and site data*: **off** for "Clear cookies and site data when you close all windows".
- For PCs we manage with policies (optional, Chrome and Edge use the same names): `ClearBrowsingDataOnExitList` empty, `CookiesAllowedForUrls` includes `https://pos.zorbixtechnologies.com`, `IncognitoModeAvailability` = 1 (InPrivate/Incognito off), `BrowserGuestModeEnabled` = false.
- Never "reset" the browser or delete its profile while the status bar shows bills waiting to sync.

## Moving or replacing a counter

Revoke the old counter in *Counters* only after its status bar shows **0 bills waiting to sync**. A revoked counter can no longer sync.
