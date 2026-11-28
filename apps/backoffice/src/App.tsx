import { PageHeader } from '@erp/ui';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Api } from './api';
import { AccountsScreen, ExpenseCategoriesScreen, LedgerScreen } from './accounting/AccountsScreens';
import { DocumentScreen, MoneyScreen } from './accounting/MoneyScreen';
import { PeriodsScreen } from './accounting/PeriodsScreen';
import { VoucherScreen } from './accounting/VoucherScreen';
import { CategoriesScreen } from './catalog/CategoriesScreen';
import { ItemScreen } from './catalog/ItemScreen';
import { ItemsScreen } from './catalog/ItemsScreen';
import { DashboardScreen } from './dashboard/DashboardScreen';
import { LabelsScreen } from './catalog/LabelsScreen';
import { NewItemScreen } from './catalog/NewItemScreen';
import { AdjustmentScreen, AdjustmentsScreen } from './inventory/AdjustmentScreen';
import { StockCardScreen, StockSettingsScreen, TransferNeededScreen } from './inventory/StockScreens';
import { TransferScreen, TransfersScreen } from './inventory/TransferScreen';
import { ReceiptScreen, ReceiptsScreen } from './purchasing/ReceiptScreen';
import { ReturnScreen, ReturnsScreen } from './purchasing/ReturnScreen';
import { SupplierScreen, SuppliersScreen } from './purchasing/SuppliersScreen';
import { CustomerScreen, CustomersScreen } from './customers/CustomersScreen';
import { allowed, MENU, needsOf, Shell } from './layout/Shell';
import { navigate, useRoute, type Route } from './router';
import { CountersScreen } from './screens/CountersScreen';
import { ShopSettingsScreen } from './screens/ShopSettingsScreen';
import { LoginScreen } from './screens/LoginScreen';
import { PasswordScreen } from './screens/PasswordScreen';
import {
  AgeingScreen,
  ExceptionsScreen,
  OverridesScreen,
  SalesRegisterScreen,
  StockReportScreen,
  TraceScreen,
  VoidsReturnsScreen,
} from './reports/ReportViews';
import { BillScreen } from './reports/BillScreen';
import { BillsScreen, SalesReturnsScreen } from './reports/SalesDocumentScreens';
import {
  BalanceSheetScreen,
  CashBookScreen,
  DayBookScreen,
  ExpensesScreen,
  ProfitLossScreen,
  ReportsHomeScreen,
  TrialBalanceScreen,
} from './reports/FinancialScreens';
import {
  DeadStockScreen,
  InventoryAnalysisScreen,
  ReorderScreen,
  StockAtScreen,
  StockLedgerScreen,
  StockMovementScreen,
} from './reports/StockReportScreens';
import {
  PurchaseRegisterScreen,
  RatesScreen,
  SalesOverTimeScreen,
  SalesProfitScreen,
} from './reports/SalesReportScreens';
import { PrintProvider } from './reports/frame/ReportFrame';
import {
  BalanceTrendScreen,
  CashFlowScreen,
  CollectionsScreen,
  OverdueScreen,
  OverLimitScreen,
  PartnerLedgerScreen,
  StatementsScreen,
  UserActivityScreen,
} from './reports/PartnerReportScreens';
import { CashVarianceScreen, DayReconciliationScreen } from './screens/ReportsScreens';
import { PersonScreen } from './staff/PersonScreen';
import { StaffScreen } from './staff/StaffScreen';
import { applyTheme, type Theme } from './theme';
import { notify, ScreenGuard } from './ui';

// The back office: sign in, the forced password change (W1-02), then the layout with its menu and the screen named by
// the address (W1-04 plan).

export interface Me {
  tenantId: string;
  user: { id: string; username: string; fullName: string };
  permissions: string[];
  mustChangePassword: boolean;
  /** For the reports' print header (W2-01). */
  shopName?: string;
  /** The person's theme, kept on the server (W2-07, D-120). */
  theme?: Theme;
}

/** The screen to show: the one addressed if this person may open it, otherwise the first one they may. */
function screenFor(route: Route, permissions: readonly string[]): Route | null {
  const items = MENU.flatMap((g) => g.items);
  const needs = needsOf(route.screen);
  if (needs && needs.some((p) => permissions.includes(p))) return route;
  const first = items.find((i) => allowed(i, permissions));
  return first ? ({ screen: first.screens[0]! } as Route) : null;
}

export function App({ api }: { api: Api }) {
  const { t } = useTranslation();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const route = useRoute();

  const fetchMe = useCallback(async () => {
    const r = await api('GET', '/api/auth/me');
    return r.status === 200 ? (r.body as Me) : null;
  }, [api]);
  const loadMe = async () => setMe(await fetchMe());

  useEffect(() => {
    let live = true;
    void fetchMe().then((m) => live && setMe(m));
    return () => {
      live = false;
    };
  }, [fetchMe]);

  // The open high-severity exceptions of the last week, beside Exceptions in the menu (owner answer 5 to W1-20).
  const [openHigh, setOpenHigh] = useState(0);
  const seesReports = me?.permissions.includes('reports.view') ?? false;
  useEffect(() => {
    if (!seesReports) return;
    let live = true;
    void api('GET', '/api/reports/exceptions/open-count').then((r) => {
      if (live && r.status === 200) setOpenHigh((r.body as { high: number }).high);
    });
    return () => {
      live = false;
    };
  }, [api, seesReports, route]);

  // The person's theme wins over this browser's copy once they are known (W2-07); signed out, the copy stays.
  const theme = me?.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
  const [themeNotSaved, setThemeNotSaved] = useState(false);

  if (me === undefined) return <p className="p-6 text-muted-foreground">{t('app.loading')}</p>;
  // A sign-in opens the person's first screen (the owner's Dashboard, D-118), not the screen the address still names
  // from before signing out; a reload while signed in keeps its place.
  const signedIn = (m: Me) => {
    navigate('');
    setMe(m);
  };
  if (me === null) return <LoginScreen api={api} onSignedIn={signedIn} />;
  if (me.mustChangePassword) return <PasswordScreen api={api} onChanged={() => void loadMe()} />;

  const signOut = async () => {
    await api('POST', '/api/auth/logout');
    notify.clear();
    setMe(null);
  };
  // A choice shows at once and is then saved for the person's other computers; a failed save keeps it here (W2-07).
  const chooseTheme = async (next: Theme) => {
    applyTheme(next);
    setMe({ ...me, theme: next });
    const r = await api('PUT', '/api/users/me/settings', { theme: next });
    setThemeNotSaved(r.status !== 204);
  };
  const shown = screenFor(route, me.permissions);
  const badges = { reports: seesReports ? openHigh : 0 };

  return (
    <PrintProvider value={{ shopName: me.shopName ?? '', userName: me.user.fullName }}>
      <Shell
        fullName={me.user.fullName}
        username={me.user.username}
        permissions={me.permissions}
        route={shown ?? route}
        onSignOut={() => void signOut()}
        badges={badges}
        theme={me.theme ?? 'system'}
        onTheme={(next) => void chooseTheme(next)}
        themeNotSaved={themeNotSaved}
      >
        {/* A screen that fails shows the error screen in its place, not a blank page; the menu stays (W2-17). */}
        <ScreenGuard at={JSON.stringify(route)}>
          {shown === null ? (
            <PageHeader title={t('app.title')} help={t('home.nothing')} />
          ) : shown.screen === 'dashboard' ? (
            <DashboardScreen api={api} />
          ) : shown.screen === 'reportsHome' ? (
            <ReportsHomeScreen permissions={me.permissions} badges={badges} />
          ) : shown.screen === 'trialBalance' ? (
            <TrialBalanceScreen api={api} />
          ) : shown.screen === 'profitLoss' ? (
            <ProfitLossScreen api={api} />
          ) : shown.screen === 'balanceSheet' ? (
            <BalanceSheetScreen api={api} />
          ) : shown.screen === 'cashBook' ? (
            <CashBookScreen api={api} />
          ) : shown.screen === 'dayBook' ? (
            <DayBookScreen api={api} />
          ) : shown.screen === 'expensesReport' ? (
            <ExpensesScreen api={api} />
          ) : shown.screen === 'person' ? (
            <PersonScreen key={shown.id} api={api} id={shown.id} permissions={me.permissions} />
          ) : shown.screen === 'counters' ? (
            <CountersScreen api={api} />
          ) : shown.screen === 'shopSettings' ? (
            <ShopSettingsScreen api={api} />
          ) : shown.screen === 'dayReconciliation' ? (
            <DayReconciliationScreen api={api} permissions={me.permissions} />
          ) : shown.screen === 'cashVariance' ? (
            <CashVarianceScreen api={api} />
          ) : shown.screen === 'salesRegister' ? (
            <SalesRegisterScreen api={api} permissions={me.permissions} />
          ) : shown.screen === 'overridesReport' ? (
            <OverridesScreen api={api} permissions={me.permissions} />
          ) : shown.screen === 'voidsReturns' ? (
            <VoidsReturnsScreen api={api} permissions={me.permissions} />
          ) : shown.screen === 'stockReport' ? (
            <StockReportScreen api={api} />
          ) : shown.screen === 'stockAt' ? (
            <StockAtScreen api={api} />
          ) : shown.screen === 'stockMovement' ? (
            <StockMovementScreen api={api} />
          ) : shown.screen === 'stockLedger' ? (
            <StockLedgerScreen api={api} />
          ) : shown.screen === 'reorder' ? (
            <ReorderScreen api={api} />
          ) : shown.screen === 'deadStock' ? (
            <DeadStockScreen api={api} />
          ) : shown.screen === 'inventoryAnalysis' ? (
            <InventoryAnalysisScreen api={api} />
          ) : shown.screen === 'salesProfit' ? (
            <SalesProfitScreen api={api} />
          ) : shown.screen === 'purchaseRegister' ? (
            <PurchaseRegisterScreen api={api} />
          ) : shown.screen === 'rates' ? (
            <RatesScreen api={api} />
          ) : shown.screen === 'salesOverTime' ? (
            <SalesOverTimeScreen api={api} />
          ) : shown.screen === 'partnerLedger' ? (
            <PartnerLedgerScreen api={api} />
          ) : shown.screen === 'statements' ? (
            <StatementsScreen api={api} />
          ) : shown.screen === 'balanceTrend' ? (
            <BalanceTrendScreen api={api} />
          ) : shown.screen === 'overdue' ? (
            <OverdueScreen api={api} />
          ) : shown.screen === 'overLimit' ? (
            <OverLimitScreen api={api} />
          ) : shown.screen === 'collections' ? (
            <CollectionsScreen api={api} />
          ) : shown.screen === 'userActivity' ? (
            <UserActivityScreen api={api} />
          ) : shown.screen === 'cashFlow' ? (
            <CashFlowScreen api={api} />
          ) : shown.screen === 'ageing' ? (
            <AgeingScreen api={api} />
          ) : shown.screen === 'exceptions' ? (
            <ExceptionsScreen api={api} permissions={me.permissions} />
          ) : shown.screen === 'trace' ? (
            <TraceScreen key={shown.number ?? ''} api={api} number={shown.number} />
          ) : shown.screen === 'items' ? (
            <ItemsScreen api={api} />
          ) : shown.screen === 'item' ? (
            <ItemScreen key={shown.id} api={api} id={shown.id} />
          ) : shown.screen === 'newItem' ? (
            <NewItemScreen api={api} />
          ) : shown.screen === 'categories' ? (
            <CategoriesScreen api={api} />
          ) : shown.screen === 'labels' ? (
            <LabelsScreen
              key={JSON.stringify(shown.source)}
              api={api}
              source={shown.source}
              permissions={me.permissions}
            />
          ) : shown.screen === 'bills' ? (
            <BillsScreen api={api} />
          ) : shown.screen === 'returns' ? (
            <SalesReturnsScreen api={api} />
          ) : shown.screen === 'bill' ? (
            <BillScreen key={shown.number} api={api} number={shown.number} />
          ) : shown.screen === 'customers' ? (
            <CustomersScreen api={api} />
          ) : shown.screen === 'customer' ? (
            <CustomerScreen
              key={shown.id}
              api={api}
              id={shown.id}
              reports={me.permissions.includes('reports.view')}
            />
          ) : shown.screen === 'suppliers' ? (
            <SuppliersScreen api={api} />
          ) : shown.screen === 'supplier' ? (
            <SupplierScreen
              key={shown.id}
              api={api}
              id={shown.id}
              reports={me.permissions.includes('reports.view') && me.permissions.includes('cost.view')}
            />
          ) : shown.screen === 'receipts' ? (
            <ReceiptsScreen api={api} />
          ) : shown.screen === 'receipt' ? (
            <ReceiptScreen key={shown.id} api={api} id={shown.id} />
          ) : shown.screen === 'purchaseReturns' ? (
            <ReturnsScreen api={api} />
          ) : shown.screen === 'purchaseReturn' ? (
            <ReturnScreen key={shown.id} api={api} id={shown.id} />
          ) : shown.screen === 'transfers' ? (
            <TransfersScreen api={api} />
          ) : shown.screen === 'transfer' ? (
            <TransferScreen key={shown.id} api={api} id={shown.id} />
          ) : shown.screen === 'adjustments' ? (
            <AdjustmentsScreen api={api} />
          ) : shown.screen === 'adjustment' ? (
            <AdjustmentScreen key={shown.id} api={api} id={shown.id} />
          ) : shown.screen === 'stockCard' ? (
            <StockCardScreen key={shown.itemId ?? ''} api={api} itemId={shown.itemId ?? null} />
          ) : shown.screen === 'transferNeeded' ? (
            <TransferNeededScreen api={api} />
          ) : shown.screen === 'stockSettings' ? (
            <StockSettingsScreen api={api} />
          ) : shown.screen === 'money' ? (
            <MoneyScreen api={api} />
          ) : shown.screen === 'accountingDocument' ? (
            <DocumentScreen key={`${shown.type}/${shown.id}`} api={api} type={shown.type} id={shown.id} />
          ) : shown.screen === 'voucher' ? (
            <VoucherScreen key={shown.id} api={api} id={shown.id} />
          ) : shown.screen === 'periods' ? (
            <PeriodsScreen api={api} />
          ) : shown.screen === 'accounts' ? (
            <AccountsScreen api={api} />
          ) : shown.screen === 'ledger' ? (
            <LedgerScreen key={shown.id} api={api} id={shown.id} />
          ) : shown.screen === 'expenseCategories' ? (
            <ExpenseCategoriesScreen api={api} />
          ) : (
            <StaffScreen api={api} permissions={me.permissions} />
          )}
        </ScreenGuard>
      </Shell>
    </PrintProvider>
  );
}
