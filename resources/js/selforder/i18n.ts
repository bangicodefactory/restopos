import { I18nProvider, createTranslator, isRtl, resolveLocale, type Locale } from '@shared/i18n';
import { createContext, createElement, useContext, useMemo, type JSX, type ReactNode } from 'react';

/**
 * Self-order vocabulary, in the three languages the venue serves.
 *
 * Same arrangement as the kitchen app: `@shared/i18n` owns the mechanism (locale resolution, RTL,
 * `document.dir`, `{placeholder}` interpolation) and the small cross-app key set; this module adds
 * the customer-facing strings. Sharing a single dictionary across apps would put the kitchen's
 * vocabulary in a customer's bundle and vice versa.
 *
 * This is the app where the translation actually matters: the reader is a stranger holding their
 * own phone, and a missing string is a lost order rather than a puzzled colleague. Hence French
 * first (the default), and Arabic with a real RTL flip rather than a mirrored afterthought.
 */

export const SUPPORTED_LOCALES: readonly Locale[] = ['fr', 'en', 'ar'];

export const LOCALE_LABELS: Record<Locale, string> = {
    fr: 'Français',
    en: 'English',
    ar: 'العربية',
};

const en = {
    'so.landing.welcome': 'Welcome',
    'so.landing.table': 'Table {name}',
    'so.landing.start': 'Start order',
    'so.landing.browse': 'View the menu',
    'so.landing.myOrders': 'My orders',
    'so.landing.closed': "We're currently closed",
    'so.landing.closedHint': 'You can still browse the menu.',
    'so.landing.consultation': 'Menu only — ordering is not available here.',
    'so.landing.language': 'Language',
    'so.landing.confirmTable': 'You are at table {name}. Is that right?',
    'so.landing.notMyTable': 'Choose another table',

    'so.mode.eatIn': 'Eat in',
    'so.mode.takeAway': 'Take away',
    'so.mode.choose': 'Where will you eat?',

    'so.menu.title': 'Menu',
    'so.menu.search': 'Search the menu',
    'so.menu.empty': 'Nothing available right now',
    'so.menu.unavailable': 'Unavailable',
    'so.menu.allergens': 'Allergens',
    'so.menu.from': 'from {price}',

    'so.product.add': 'Add to order',
    'so.product.update': 'Update',
    'so.product.quantity': 'Quantity',
    'so.product.note': 'Special request',
    'so.product.notePlaceholder': 'No onions, extra sauce…',
    'so.product.required': 'Required',
    'so.product.chooseRequired': 'Please choose {name}',
    'so.product.total': 'Total',

    'so.combo.step': 'Step {current} of {total}',
    'so.combo.choose': 'Choose {name}',
    'so.combo.chooseUpTo': 'Choose up to {count}',
    'so.combo.included': 'Included',
    'so.combo.next': 'Next',
    'so.combo.summary': 'Your menu',

    'so.cart.title': 'Your order',
    'so.cart.empty': 'Your order is empty',
    'so.cart.emptyHint': 'Add something from the menu to get started.',
    'so.cart.remove': 'Remove',
    'so.cart.subtotal': 'Subtotal',
    'so.cart.tax': 'Tax',
    'so.cart.total': 'Total',
    'so.cart.taxIncluded': 'Tax included',
    'so.cart.taxExcluded': 'Tax excluded',
    'so.cart.checkout': 'Order',
    'so.cart.addMore': 'Add more',
    'so.cart.minimum': 'Minimum order is {amount}',
    'so.cart.removedTitle': 'Some items are no longer available',
    'so.cart.removedBody': 'We removed them from your order: {names}',
    'so.cart.stand': 'Table tracker number',
    'so.cart.standHint': 'Take a table stand and enter its number.',

    'so.checkout.title': 'How would you like to pay?',
    'so.checkout.payCashier': 'Pay at the counter',
    'so.checkout.payCashierHint': 'Your order goes to the kitchen now. Pay when you are done.',
    'so.checkout.payOnline': 'Pay now',
    'so.checkout.payOnlineHint': 'Card payment on this device.',
    'so.checkout.sending': 'Sending your order…',
    'so.checkout.failed': 'We could not send your order. Please try again.',
    'so.checkout.paymentFailed': 'The payment could not be started. You can still pay at the counter.',
    'so.checkout.paymentPending': 'Waiting for the payment…',
    'so.checkout.cancel': 'Cancel order',
    'so.checkout.cancelConfirm': 'Cancel this order?',
    'so.checkout.cancelRefused': 'This order can no longer be cancelled.',

    'so.status.title': 'Order {tracking}',
    'so.status.received': 'Received',
    'so.status.preparing': 'Preparing',
    'so.status.ready': 'Ready',
    'so.status.done': 'Completed',
    'so.status.cancelled': 'Cancelled',
    'so.status.receivedHint': 'The kitchen has your order.',
    'so.status.preparingHint': 'Your food is being prepared.',
    'so.status.readyHint': 'Your order is ready.',
    'so.status.payAtCounter': 'Please pay at the counter.',
    'so.status.paid': 'Paid',
    'so.status.due': 'To pay',
    'so.status.newOrder': 'Order something else',
    'so.status.backToMenu': 'Back to the menu',

    'so.history.title': 'My orders',
    'so.history.empty': 'No orders yet',
    'so.history.reopen': 'View',

    'so.kiosk.tapToStart': 'Touch to order',
    'so.kiosk.idleTitle': 'Are you still there?',
    'so.kiosk.idleBody': 'Your order will be cleared in {seconds} s.',
    'so.kiosk.continue': "I'm still here",
    'so.kiosk.startOver': 'Start over',

    'so.pwa.install': 'Add to home screen',
    'so.pwa.dismiss': 'Not now',

    'so.error.offline': 'You are offline. The menu below may be out of date.',
    'so.error.offlineSubmit': 'You are offline — your order will send when the connection returns. Your cart is saved.',
    'so.error.load': 'We could not load the menu.',
    'so.error.invalidToken': 'This QR code is no longer valid. Please ask a member of staff.',
    'so.error.orderingDisabled': 'Ordering is not available at this venue.',
} as const;

export type SelfOrderKey = keyof typeof en;
export type SelfOrderDictionary = Record<SelfOrderKey, string>;

const fr: SelfOrderDictionary = {
    'so.landing.welcome': 'Bienvenue',
    'so.landing.table': 'Table {name}',
    'so.landing.start': 'Commander',
    'so.landing.browse': 'Voir la carte',
    'so.landing.myOrders': 'Mes commandes',
    'so.landing.closed': 'Nous sommes fermés',
    'so.landing.closedHint': 'Vous pouvez tout de même consulter la carte.',
    'so.landing.consultation': 'Carte uniquement — la commande n’est pas disponible ici.',
    'so.landing.language': 'Langue',
    'so.landing.confirmTable': 'Vous êtes à la table {name}. C’est bien cela ?',
    'so.landing.notMyTable': 'Choisir une autre table',

    'so.mode.eatIn': 'Sur place',
    'so.mode.takeAway': 'À emporter',
    'so.mode.choose': 'Où allez-vous manger ?',

    'so.menu.title': 'Carte',
    'so.menu.search': 'Rechercher un plat',
    'so.menu.empty': 'Rien de disponible pour le moment',
    'so.menu.unavailable': 'Indisponible',
    'so.menu.allergens': 'Allergènes',
    'so.menu.from': 'dès {price}',

    'so.product.add': 'Ajouter',
    'so.product.update': 'Modifier',
    'so.product.quantity': 'Quantité',
    'so.product.note': 'Demande particulière',
    'so.product.notePlaceholder': 'Sans oignon, sauce à part…',
    'so.product.required': 'Obligatoire',
    'so.product.chooseRequired': 'Veuillez choisir : {name}',
    'so.product.total': 'Total',

    'so.combo.step': 'Étape {current} sur {total}',
    'so.combo.choose': 'Choisissez {name}',
    'so.combo.chooseUpTo': 'Choisissez jusqu’à {count}',
    'so.combo.included': 'Inclus',
    'so.combo.next': 'Suivant',
    'so.combo.summary': 'Votre menu',

    'so.cart.title': 'Votre commande',
    'so.cart.empty': 'Votre commande est vide',
    'so.cart.emptyHint': 'Ajoutez un article depuis la carte pour commencer.',
    'so.cart.remove': 'Retirer',
    'so.cart.subtotal': 'Sous-total',
    'so.cart.tax': 'TVA',
    'so.cart.total': 'Total',
    'so.cart.taxIncluded': 'TVA comprise',
    'so.cart.taxExcluded': 'Hors TVA',
    'so.cart.checkout': 'Commander',
    'so.cart.addMore': 'Ajouter un article',
    'so.cart.minimum': 'Commande minimum : {amount}',
    'so.cart.removedTitle': 'Certains articles ne sont plus disponibles',
    'so.cart.removedBody': 'Nous les avons retirés de votre commande : {names}',
    'so.cart.stand': 'Numéro de chevalet',
    'so.cart.standHint': 'Prenez un chevalet et saisissez son numéro.',

    'so.checkout.title': 'Comment souhaitez-vous payer ?',
    'so.checkout.payCashier': 'Payer au comptoir',
    'so.checkout.payCashierHint': 'Votre commande part en cuisine. Vous paierez ensuite.',
    'so.checkout.payOnline': 'Payer maintenant',
    'so.checkout.payOnlineHint': 'Paiement par carte sur cet appareil.',
    'so.checkout.sending': 'Envoi de votre commande…',
    'so.checkout.failed': 'Nous n’avons pas pu envoyer votre commande. Réessayez.',
    'so.checkout.paymentFailed': 'Le paiement n’a pas pu démarrer. Vous pouvez payer au comptoir.',
    'so.checkout.paymentPending': 'Paiement en attente…',
    'so.checkout.cancel': 'Annuler la commande',
    'so.checkout.cancelConfirm': 'Annuler cette commande ?',
    'so.checkout.cancelRefused': 'Cette commande ne peut plus être annulée.',

    'so.status.title': 'Commande {tracking}',
    'so.status.received': 'Reçue',
    'so.status.preparing': 'En préparation',
    'so.status.ready': 'Prête',
    'so.status.done': 'Terminée',
    'so.status.cancelled': 'Annulée',
    'so.status.receivedHint': 'La cuisine a reçu votre commande.',
    'so.status.preparingHint': 'Votre commande est en préparation.',
    'so.status.readyHint': 'Votre commande est prête.',
    'so.status.payAtCounter': 'Merci de régler au comptoir.',
    'so.status.paid': 'Payée',
    'so.status.due': 'Reste à payer',
    'so.status.newOrder': 'Commander autre chose',
    'so.status.backToMenu': 'Retour à la carte',

    'so.history.title': 'Mes commandes',
    'so.history.empty': 'Aucune commande',
    'so.history.reopen': 'Voir',

    'so.kiosk.tapToStart': 'Touchez pour commander',
    'so.kiosk.idleTitle': 'Êtes-vous toujours là ?',
    'so.kiosk.idleBody': 'Votre commande sera effacée dans {seconds} s.',
    'so.kiosk.continue': 'Je suis là',
    'so.kiosk.startOver': 'Recommencer',

    'so.pwa.install': 'Ajouter à l’écran d’accueil',
    'so.pwa.dismiss': 'Plus tard',

    'so.error.offline': 'Vous êtes hors ligne. La carte ci-dessous peut être obsolète.',
    'so.error.offlineSubmit': 'Vous êtes hors ligne — votre commande partira au retour de la connexion. Votre panier est enregistré.',
    'so.error.load': 'Impossible de charger la carte.',
    'so.error.invalidToken': 'Ce QR code n’est plus valide. Adressez-vous au personnel.',
    'so.error.orderingDisabled': 'La commande n’est pas disponible dans cet établissement.',
};

const ar: SelfOrderDictionary = {
    'so.landing.welcome': 'أهلًا بك',
    'so.landing.table': 'طاولة {name}',
    'so.landing.start': 'اطلب الآن',
    'so.landing.browse': 'تصفح القائمة',
    'so.landing.myOrders': 'طلباتي',
    'so.landing.closed': 'نحن مغلقون حاليًا',
    'so.landing.closedHint': 'يمكنك تصفح القائمة.',
    'so.landing.consultation': 'القائمة فقط — الطلب غير متاح هنا.',
    'so.landing.language': 'اللغة',
    'so.landing.confirmTable': 'أنت على الطاولة {name}. هل هذا صحيح؟',
    'so.landing.notMyTable': 'اختر طاولة أخرى',

    'so.mode.eatIn': 'تناول هنا',
    'so.mode.takeAway': 'طلب خارجي',
    'so.mode.choose': 'أين ستتناول طعامك؟',

    'so.menu.title': 'القائمة',
    'so.menu.search': 'ابحث في القائمة',
    'so.menu.empty': 'لا يوجد شيء متاح حاليًا',
    'so.menu.unavailable': 'غير متاح',
    'so.menu.allergens': 'مسببات الحساسية',
    'so.menu.from': 'ابتداءً من {price}',

    'so.product.add': 'أضف إلى الطلب',
    'so.product.update': 'تحديث',
    'so.product.quantity': 'الكمية',
    'so.product.note': 'طلب خاص',
    'so.product.notePlaceholder': 'بدون بصل، صلصة إضافية…',
    'so.product.required': 'مطلوب',
    'so.product.chooseRequired': 'يرجى اختيار {name}',
    'so.product.total': 'الإجمالي',

    'so.combo.step': 'الخطوة {current} من {total}',
    'so.combo.choose': 'اختر {name}',
    'so.combo.chooseUpTo': 'اختر حتى {count}',
    'so.combo.included': 'مشمول',
    'so.combo.next': 'التالي',
    'so.combo.summary': 'وجبتك',

    'so.cart.title': 'طلبك',
    'so.cart.empty': 'طلبك فارغ',
    'so.cart.emptyHint': 'أضف صنفًا من القائمة للبدء.',
    'so.cart.remove': 'إزالة',
    'so.cart.subtotal': 'المجموع الفرعي',
    'so.cart.tax': 'الضريبة',
    'so.cart.total': 'الإجمالي',
    'so.cart.taxIncluded': 'شامل الضريبة',
    'so.cart.taxExcluded': 'غير شامل الضريبة',
    'so.cart.checkout': 'إرسال الطلب',
    'so.cart.addMore': 'أضف المزيد',
    'so.cart.minimum': 'الحد الأدنى للطلب {amount}',
    'so.cart.removedTitle': 'بعض الأصناف لم تعد متاحة',
    'so.cart.removedBody': 'أزلناها من طلبك: {names}',
    'so.cart.stand': 'رقم حامل الطاولة',
    'so.cart.standHint': 'خذ حاملًا وأدخل رقمه.',

    'so.checkout.title': 'كيف تود الدفع؟',
    'so.checkout.payCashier': 'الدفع عند الكاشير',
    'so.checkout.payCashierHint': 'سيصل طلبك إلى المطبخ الآن. ادفع لاحقًا.',
    'so.checkout.payOnline': 'ادفع الآن',
    'so.checkout.payOnlineHint': 'دفع بالبطاقة من هذا الجهاز.',
    'so.checkout.sending': 'جارٍ إرسال طلبك…',
    'so.checkout.failed': 'تعذر إرسال طلبك. حاول مرة أخرى.',
    'so.checkout.paymentFailed': 'تعذر بدء الدفع. يمكنك الدفع عند الكاشير.',
    'so.checkout.paymentPending': 'في انتظار الدفع…',
    'so.checkout.cancel': 'إلغاء الطلب',
    'so.checkout.cancelConfirm': 'إلغاء هذا الطلب؟',
    'so.checkout.cancelRefused': 'لم يعد بالإمكان إلغاء هذا الطلب.',

    'so.status.title': 'الطلب {tracking}',
    'so.status.received': 'تم الاستلام',
    'so.status.preparing': 'قيد التحضير',
    'so.status.ready': 'جاهز',
    'so.status.done': 'مكتمل',
    'so.status.cancelled': 'ملغى',
    'so.status.receivedHint': 'وصل طلبك إلى المطبخ.',
    'so.status.preparingHint': 'يجري تحضير طلبك.',
    'so.status.readyHint': 'طلبك جاهز.',
    'so.status.payAtCounter': 'يرجى الدفع عند الكاشير.',
    'so.status.paid': 'مدفوع',
    'so.status.due': 'المتبقي',
    'so.status.newOrder': 'اطلب شيئًا آخر',
    'so.status.backToMenu': 'العودة إلى القائمة',

    'so.history.title': 'طلباتي',
    'so.history.empty': 'لا توجد طلبات بعد',
    'so.history.reopen': 'عرض',

    'so.kiosk.tapToStart': 'المس للطلب',
    'so.kiosk.idleTitle': 'هل ما زلت هنا؟',
    'so.kiosk.idleBody': 'سيُمسح طلبك خلال {seconds} ثانية.',
    'so.kiosk.continue': 'ما زلت هنا',
    'so.kiosk.startOver': 'ابدأ من جديد',

    'so.pwa.install': 'أضف إلى الشاشة الرئيسية',
    'so.pwa.dismiss': 'ليس الآن',

    'so.error.offline': 'أنت غير متصل. قد تكون القائمة قديمة.',
    'so.error.offlineSubmit': 'أنت غير متصل — سيُرسَل طلبك عند عودة الاتصال. سلتك محفوظة.',
    'so.error.load': 'تعذر تحميل القائمة.',
    'so.error.invalidToken': 'رمز QR لم يعد صالحًا. يرجى سؤال أحد الموظفين.',
    'so.error.orderingDisabled': 'الطلب غير متاح في هذا المكان.',
};

export const SELF_ORDER_DICTIONARIES: Record<Locale, SelfOrderDictionary> = { en, fr, ar };

export type SelfOrderTranslate = (
    key: SelfOrderKey | string,
    params?: Record<string, string | number>,
) => string;

function interpolate(template: string, params?: Record<string, string | number>): string {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in params ? String(params[key]) : match,
    );
}

export function createSelfOrderTranslator(locale: Locale): SelfOrderTranslate {
    const dictionary = SELF_ORDER_DICTIONARIES[locale] ?? fr;
    const shared = createTranslator(locale);
    return (key, params) => {
        const local =
            (dictionary as Record<string, string>)[key] ?? (fr as Record<string, string>)[key];
        if (local !== undefined) return interpolate(local, params);
        return shared(key as never, params);
    };
}

type SelfOrderI18n = { locale: Locale; rtl: boolean; t: SelfOrderTranslate };

const Context = createContext<SelfOrderI18n>({
    locale: 'fr',
    rtl: false,
    t: createSelfOrderTranslator('fr'),
});

export function SelfOrderI18nProvider({
    locale,
    children,
}: {
    locale: Locale;
    children: ReactNode;
}): JSX.Element {
    const value = useMemo<SelfOrderI18n>(
        () => ({ locale, rtl: isRtl(locale), t: createSelfOrderTranslator(locale) }),
        [locale],
    );
    return createElement(I18nProvider, {
        locale,
        children: createElement(Context.Provider, { value }, children),
    });
}

export function useSelfOrderI18n(): SelfOrderI18n {
    return useContext(Context);
}

export function useT(): SelfOrderTranslate {
    return useContext(Context).t;
}

export { resolveLocale };
export type { Locale };
