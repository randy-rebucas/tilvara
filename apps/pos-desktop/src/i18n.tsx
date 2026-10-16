import { createContext, useContext, useState, type ReactNode } from 'react';

/** EN + FIL. Filipino is a first translation and needs native-speaker review (as in admin-web). */
const en = {
  'app.title': '1POS Counter',
  'app.browserMode': 'Browser mode · online only · no printer or drawer',
  'common.signOut': 'Sign out',
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.error': 'Something went wrong. Try again.',
  'common.network': 'No connection to the server. Nothing was recorded — try again.',
  'signin.title': 'Sign in to the counter',
  'signin.lede': 'Use your 1POS account. You stay signed in until you sign out or reload this page.',
  'signin.email': 'Email',
  'signin.password': 'Password',
  'signin.submit': 'Sign in',
  'business.title': 'Choose a business',
  'register.title': 'Choose your register',
  'register.lede': 'Open a shift with your starting cash, or continue your open shift.',
  'register.none': 'You are not allowed to run a register yet. Ask your manager for cashier access.',
  'register.continue': 'Continue shift',
  'register.busy': 'In use by another cashier',
  'register.open': 'Open shift',
  'register.float': 'Starting cash',
  'register.floatHint': 'Count the cash in the drawer before you start.',
  'register.floatInvalid': 'Enter an amount such as 1000.00.',
  'sell.scan': 'Scan a barcode or type a SKU or name',
  'sell.add': 'Add',
  'sell.emptyCart': 'Scan an item to start a sale.',
  'sell.notFound': 'No item matches “{q}”.',
  'sell.unpriced': '{name} has no price at this branch and cannot be sold.',
  'sell.results': 'Matches',
  'sell.qty': 'Quantity',
  'sell.remove': 'Remove',
  'sell.sc': 'SC/PWD',
  'sell.scTitle': 'Senior citizen / PWD discount',
  'sell.scHint': 'Record the name and ID shown. Only for items for the cardholder’s own use.',
  'sell.scheme': 'Discount',
  'sell.beneficiaryName': 'Name on ID',
  'sell.idNumber': 'ID number (OSCA / PWD)',
  'sell.apply': 'Apply',
  'sell.removeDiscount': 'Remove discount',
  'sell.pendingReview': 'SC/PWD computation awaits tax-professional sign-off; test use only.',
  'sell.newSale': 'New sale',
  'totals.title': 'Total due',
  'totals.vatable': 'VATable sales',
  'totals.vat': 'VAT',
  'totals.exempt': 'VAT-exempt sales',
  'totals.zero': 'Zero-rated sales',
  'totals.pt': 'Sales subject to percentage tax',
  'totals.statutory': 'SC/PWD discount',
  'totals.vatExemption': 'VAT exemption',
  'totals.updating': 'Updating…',
  'pay.cash': 'Cash',
  'pay.card': 'Card',
  'pay.qr': 'QR / e-wallet',
  'pay.tendered': 'Cash received',
  'pay.change': 'Change',
  'pay.short': 'Short by {amount}',
  'pay.complete': 'Complete sale',
  'pay.paidElectronic': 'Paid by {method}',
  'pay.takeCard': 'Charge {amount} by {method}',
  'pay.declined': 'Declined: {code}',
  'pay.unknown': 'No answer from the payment provider. Do not charge again — check the payment.',
  'pay.check': 'Check payment',
  'pay.cancelPayment': 'Cancel payment',
  'pay.totalChanged': 'Prices changed. New total: {amount}. Review and complete again.',
  'pay.remaining': 'Remaining',
  'receipt.title': 'Receipt',
  'receipt.print': 'Print',
  'receipt.cashier': 'Cashier',
  'receipt.signature': 'Signature',
  'nav.sell': 'Sell',
  'nav.history': 'This shift',
  'nav.close': 'Close shift',
  'history.empty': 'No sales yet in this shift.',
  'history.void': 'Void sale',
  'history.return': 'Return items',
  'history.reason': 'Reason',
  'history.returnQty': 'Return qty',
  'history.damaged': 'Damaged (do not restock)',
  'history.refund': 'Refund {amount} in cash',
  'history.managerOnly': 'Voids and returns need a manager.',
  'history.returned': 'returned {qty}',
  'close.title': 'Close shift',
  'close.expected': 'Expected in drawer',
  'close.counted': 'Counted cash',
  'close.submit': 'Close shift',
  'close.variance': 'Variance {amount} — a manager must approve it.',
  'close.balanced': 'Drawer balanced. Shift closed.',
} as const;

export type MessageKey = keyof typeof en;

const fil: Record<MessageKey, string> = {
  'app.title': '1POS Counter',
  'app.browserMode': 'Browser mode · online lang · walang printer o drawer',
  'common.signOut': 'Mag-sign out',
  'common.cancel': 'Kanselahin',
  'common.back': 'Bumalik',
  'common.error': 'May nagkamali. Subukan ulit.',
  'common.network': 'Walang koneksyon sa server. Walang naitala — subukan ulit.',
  'signin.title': 'Mag-sign in sa counter',
  'signin.lede': 'Gamitin ang iyong 1POS account. Naka-sign in ka hanggang mag-sign out o i-reload ang pahina.',
  'signin.email': 'Email',
  'signin.password': 'Password',
  'signin.submit': 'Mag-sign in',
  'business.title': 'Pumili ng negosyo',
  'register.title': 'Piliin ang iyong register',
  'register.lede': 'Magbukas ng shift gamit ang panimulang pera, o ituloy ang bukas mong shift.',
  'register.none': 'Wala ka pang pahintulot sa register. Humingi ng cashier access sa manager.',
  'register.continue': 'Ituloy ang shift',
  'register.busy': 'Ginagamit ng ibang cashier',
  'register.open': 'Buksan ang shift',
  'register.float': 'Panimulang pera',
  'register.floatHint': 'Bilangin ang pera sa drawer bago magsimula.',
  'register.floatInvalid': 'Maglagay ng halaga gaya ng 1000.00.',
  'sell.scan': 'I-scan ang barcode o i-type ang SKU o pangalan',
  'sell.add': 'Idagdag',
  'sell.emptyCart': 'Mag-scan ng item para magsimula.',
  'sell.notFound': 'Walang item na tugma sa “{q}”.',
  'sell.unpriced': 'Walang presyo ang {name} sa branch na ito at hindi maibebenta.',
  'sell.results': 'Mga tugma',
  'sell.qty': 'Dami',
  'sell.remove': 'Alisin',
  'sell.sc': 'SC/PWD',
  'sell.scTitle': 'Diskwento ng senior citizen / PWD',
  'sell.scHint': 'Itala ang pangalan at ID. Para lang sa sariling gamit ng may-ari ng ID.',
  'sell.scheme': 'Diskwento',
  'sell.beneficiaryName': 'Pangalan sa ID',
  'sell.idNumber': 'Numero ng ID (OSCA / PWD)',
  'sell.apply': 'Ilapat',
  'sell.removeDiscount': 'Alisin ang diskwento',
  'sell.pendingReview': 'Hinihintay pa ang pagsusuri ng tax professional sa SC/PWD; pang-test lang.',
  'sell.newSale': 'Bagong benta',
  'totals.title': 'Kabuuang babayaran',
  'totals.vatable': 'VATable na benta',
  'totals.vat': 'VAT',
  'totals.exempt': 'VAT-exempt na benta',
  'totals.zero': 'Zero-rated na benta',
  'totals.pt': 'Bentang may percentage tax',
  'totals.statutory': 'Diskwento ng SC/PWD',
  'totals.vatExemption': 'VAT exemption',
  'totals.updating': 'Ina-update…',
  'pay.cash': 'Cash',
  'pay.card': 'Card',
  'pay.qr': 'QR / e-wallet',
  'pay.tendered': 'Natanggap na cash',
  'pay.change': 'Sukli',
  'pay.short': 'Kulang ng {amount}',
  'pay.complete': 'Tapusin ang benta',
  'pay.paidElectronic': 'Bayad sa {method}',
  'pay.takeCard': 'Singilin ang {amount} sa {method}',
  'pay.declined': 'Tinanggihan: {code}',
  'pay.unknown': 'Walang sagot mula sa payment provider. Huwag singilin ulit — suriin ang bayad.',
  'pay.check': 'Suriin ang bayad',
  'pay.cancelPayment': 'Kanselahin ang bayad',
  'pay.totalChanged': 'Nagbago ang presyo. Bagong kabuuan: {amount}. Suriin at tapusin ulit.',
  'pay.remaining': 'Natitira',
  'receipt.title': 'Resibo',
  'receipt.print': 'I-print',
  'receipt.cashier': 'Cashier',
  'receipt.signature': 'Lagda',
  'nav.sell': 'Magbenta',
  'nav.history': 'Ngayong shift',
  'nav.close': 'Isara ang shift',
  'history.empty': 'Wala pang benta sa shift na ito.',
  'history.void': 'I-void ang benta',
  'history.return': 'Ibalik ang mga item',
  'history.reason': 'Dahilan',
  'history.returnQty': 'Dami ng ibabalik',
  'history.damaged': 'Sira (huwag ibalik sa stock)',
  'history.refund': 'Ibalik ang {amount} na cash',
  'history.managerOnly': 'Kailangan ng manager para sa void at return.',
  'history.returned': 'naibalik {qty}',
  'close.title': 'Isara ang shift',
  'close.expected': 'Inaasahang laman ng drawer',
  'close.counted': 'Nabilang na cash',
  'close.submit': 'Isara ang shift',
  'close.variance': 'Diperensya {amount} — kailangang aprubahan ng manager.',
  'close.balanced': 'Tugma ang drawer. Sarado na ang shift.',
};

export type Lang = 'en' | 'fil';
const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, fil };

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => undefined });

function initialLang(): Lang {
  try {
    return localStorage.getItem('1pos.lang') === 'fil' ? 'fil' : 'en';
  } catch {
    return 'en';
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    document.documentElement.lang = l;
    try {
      localStorage.setItem('1pos.lang', l);
    } catch {
      // Language preference is a convenience only.
    }
  };
  return <Ctx.Provider value={{ lang, setLang }}>{children}</Ctx.Provider>;
}

export function useT() {
  const { lang, setLang } = useContext(Ctx);
  const t = (key: MessageKey, vars?: Record<string, string>) => {
    let s = dictionaries[lang][key] ?? en[key];
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  };
  return { t, lang, setLang };
}
