import {
    I18nProvider,
    createTranslator,
    isRtl,
    resolveLocale,
    type Locale,
} from '@shared/i18n';
import {
    createContext,
    createElement,
    useContext,
    useMemo,
    type JSX,
    type ReactNode,
} from 'react';

/**
 * Kitchen-display vocabulary.
 *
 * `@shared/i18n` owns the *mechanism* (locale resolution, RTL, `{placeholder}` interpolation,
 * document `lang`/`dir`) and a small cross-app key set. It cannot own the KDS key set: its
 * `Dictionary` type is derived from its own `en` object, so the shared file would have to grow
 * every app's strings and every app would pay for every other app's bundle.
 *
 * So this module reuses the shared machinery verbatim — `createTranslator` for the shared keys,
 * `resolveLocale`/`isRtl` for the locale decision — and layers an app-scoped dictionary on top.
 * `t()` looks in the KDS dictionary first and falls through to the shared one, which means a
 * component can say `t('common.retry')` and `t('kds.board.empty')` with one function.
 *
 * French is the default (`SUPPORTED[0]`), per the project brief.
 */

export const SUPPORTED_LOCALES: readonly Locale[] = ['fr', 'en', 'ar'];

const en = {
    'kds.app.title': 'Kitchen display',

    'kds.pair.title': 'Pair this display',
    'kds.pair.intro': 'Enter the pairing code generated in the back office.',
    'kds.pair.code': 'Pairing code',
    'kds.pair.name': 'Display name',
    'kds.pair.submit': 'Pair display',
    'kds.pair.failed': 'Pairing failed. Check the code and try again.',
    'kds.pair.expired': 'That code is unknown or expired.',
    'kds.pair.revoked': 'This display was revoked. Pair it again to continue.',

    'kds.display.choose': 'Choose a display',
    'kds.display.intro': 'This device is paired. Pick the screen it should show.',
    'kds.display.none': 'No preparation display is configured for this register.',
    'kds.display.manual': 'Enter a display token',
    'kds.display.change': 'Change display',
    'kds.display.unpair': 'Unpair this device',
    'kds.display.unpairConfirm': 'Unpair this display? It will need a new pairing code.',

    'kds.stage.todo': 'To do',
    'kds.stage.inProgress': 'In progress',
    'kds.stage.ready': 'Ready',
    'kds.stage.done': 'Served',

    'kds.board.empty': 'Nothing to prepare',
    'kds.board.emptyStage': 'Empty',
    'kds.board.loading': 'Loading the board…',
    'kds.board.layoutColumns': 'Columns',
    'kds.board.layoutList': 'List',
    'kds.board.layoutGrid': 'Grid',
    'kds.board.rollUpTickets': 'On {count} tickets',
    'kds.board.rollUpTicketsOne': 'On 1 ticket',
    'kds.board.rollUpEmpty': 'Nothing to make',
    'kds.board.allDone': 'All done',
    'kds.board.advance': 'Advance',
    'kds.board.recall': 'Recall',
    'kds.board.recalled': 'Recalled',
    'kds.board.recallBar': 'Recently completed',
    'kds.board.recallHint': 'Hold a completed ticket to bring it back',
    'kds.board.newTicket': 'New ticket',
    'kds.board.takeaway': 'Takeaway',
    'kds.board.guests': '{count} guests',
    'kds.board.guestsOne': '1 guest',
    'kds.board.course': 'Course {index}',
    'kds.board.fired': 'Fired',
    'kds.board.cancelled': 'Cancelled',
    'kds.board.noteUpdate': 'Note changed',
    'kds.board.orderNote': 'Order note',
    'kds.board.lineDone': 'Done',
    'kds.board.tracking': 'No. {number}',

    'kds.filter.all': 'All items',
    'kds.filter.categories': 'Categories',
    'kds.filter.lateOnly': 'Late only',
    'kds.filter.clear': 'Clear filters',
    'kds.filter.course': 'Course',

    'kds.summary.open': 'Open',
    'kds.summary.oldest': 'Oldest',
    'kds.summary.average': 'Average',
    'kds.summary.late': 'Late',
    'kds.summary.mute': 'Mute alerts',
    'kds.summary.unmute': 'Unmute alerts',
    'kds.summary.queued': '{count} queued',

    'kds.net.live': 'Live',
    'kds.net.polling': 'Polling',
    'kds.net.offline': 'Offline — board frozen',
    'kds.net.queued': 'Changes will be sent when the network returns.',
    'kds.net.stale': 'Board may be out of date — reconnecting…',
    'kds.net.reconciled': 'Board refreshed from the server',
    'kds.net.actionFailed': 'The server refused that change. The board was refreshed.',
} as const;

export type KdsKey = keyof typeof en;
export type KdsDictionary = Record<KdsKey, string>;

const fr: KdsDictionary = {
    'kds.app.title': 'Écran cuisine',

    'kds.pair.title': 'Appairer cet écran',
    'kds.pair.intro': "Saisissez le code d'appairage généré dans le back-office.",
    'kds.pair.code': "Code d'appairage",
    'kds.pair.name': "Nom de l'écran",
    'kds.pair.submit': "Appairer l'écran",
    'kds.pair.failed': 'Échec de l’appairage. Vérifiez le code et réessayez.',
    'kds.pair.expired': 'Ce code est inconnu ou expiré.',
    'kds.pair.revoked': 'Cet écran a été révoqué. Appairez-le de nouveau pour continuer.',

    'kds.display.choose': 'Choisir un écran',
    'kds.display.intro': 'Cet appareil est appairé. Choisissez l’écran à afficher.',
    'kds.display.none': 'Aucun écran de préparation n’est configuré pour cette caisse.',
    'kds.display.manual': 'Saisir un jeton d’écran',
    'kds.display.change': 'Changer d’écran',
    'kds.display.unpair': 'Dissocier cet appareil',
    'kds.display.unpairConfirm': 'Dissocier cet écran ? Un nouveau code sera nécessaire.',

    'kds.stage.todo': 'À faire',
    'kds.stage.inProgress': 'En cours',
    'kds.stage.ready': 'Prêt',
    'kds.stage.done': 'Servi',

    'kds.board.empty': 'Rien à préparer',
    'kds.board.emptyStage': 'Vide',
    'kds.board.loading': 'Chargement du tableau…',
    'kds.board.layoutColumns': 'Colonnes',
    'kds.board.layoutList': 'Liste',
    'kds.board.layoutGrid': 'Grille',
    'kds.board.rollUpTickets': 'Sur {count} tickets',
    'kds.board.rollUpTicketsOne': 'Sur 1 ticket',
    'kds.board.rollUpEmpty': 'Rien à préparer',
    'kds.board.allDone': 'Tout est prêt',
    'kds.board.advance': 'Avancer',
    'kds.board.recall': 'Rappeler',
    'kds.board.recalled': 'Rappelée',
    'kds.board.recallBar': 'Terminées récemment',
    'kds.board.recallHint': 'Maintenez une commande terminée pour la rappeler',
    'kds.board.newTicket': 'Nouvelle commande',
    'kds.board.takeaway': 'À emporter',
    'kds.board.guests': '{count} couverts',
    'kds.board.guestsOne': '1 couvert',
    'kds.board.course': 'Service {index}',
    'kds.board.fired': 'Lancé',
    'kds.board.cancelled': 'Annulé',
    'kds.board.noteUpdate': 'Note modifiée',
    'kds.board.orderNote': 'Note de commande',
    'kds.board.lineDone': 'Fait',
    'kds.board.tracking': 'N° {number}',

    'kds.filter.all': 'Tous les articles',
    'kds.filter.categories': 'Catégories',
    'kds.filter.lateOnly': 'En retard seulement',
    'kds.filter.clear': 'Effacer les filtres',
    'kds.filter.course': 'Service',

    'kds.summary.open': 'En cours',
    'kds.summary.oldest': 'Plus ancienne',
    'kds.summary.average': 'Moyenne',
    'kds.summary.late': 'En retard',
    'kds.summary.mute': 'Couper les alertes',
    'kds.summary.unmute': 'Activer les alertes',
    'kds.summary.queued': '{count} en attente',

    'kds.net.live': 'Temps réel',
    'kds.net.polling': 'Interrogation',
    'kds.net.offline': 'Hors ligne — tableau figé',
    'kds.net.queued': 'Les changements partiront au retour du réseau.',
    'kds.net.stale': 'Le tableau peut être périmé — reconnexion…',
    'kds.net.reconciled': 'Tableau actualisé depuis le serveur',
    'kds.net.actionFailed': 'Le serveur a refusé ce changement. Le tableau a été actualisé.',
};

const ar: KdsDictionary = {
    'kds.app.title': 'شاشة المطبخ',

    'kds.pair.title': 'اقتران هذه الشاشة',
    'kds.pair.intro': 'أدخل رمز الاقتران الذي أُنشئ في لوحة الإدارة.',
    'kds.pair.code': 'رمز الاقتران',
    'kds.pair.name': 'اسم الشاشة',
    'kds.pair.submit': 'اقتران الشاشة',
    'kds.pair.failed': 'فشل الاقتران. تحقق من الرمز وحاول مجددًا.',
    'kds.pair.expired': 'هذا الرمز غير معروف أو منتهي الصلاحية.',
    'kds.pair.revoked': 'تم إلغاء هذه الشاشة. أعد اقترانها للمتابعة.',

    'kds.display.choose': 'اختر شاشة',
    'kds.display.intro': 'تم اقتران الجهاز. اختر الشاشة المطلوب عرضها.',
    'kds.display.none': 'لا توجد شاشة تحضير مهيأة لهذه النقطة.',
    'kds.display.manual': 'إدخال رمز الشاشة',
    'kds.display.change': 'تغيير الشاشة',
    'kds.display.unpair': 'إلغاء اقتران الجهاز',
    'kds.display.unpairConfirm': 'إلغاء اقتران الشاشة؟ ستحتاج إلى رمز جديد.',

    'kds.stage.todo': 'قيد الانتظار',
    'kds.stage.inProgress': 'قيد التحضير',
    'kds.stage.ready': 'جاهز',
    'kds.stage.done': 'تم التقديم',

    'kds.board.empty': 'لا شيء للتحضير',
    'kds.board.emptyStage': 'فارغ',
    'kds.board.loading': 'جارٍ تحميل اللوحة…',
    'kds.board.layoutColumns': 'أعمدة',
    'kds.board.layoutList': 'قائمة',
    'kds.board.layoutGrid': 'شبكة',
    'kds.board.rollUpTickets': 'على {count} طلبات',
    'kds.board.rollUpTicketsOne': 'على طلب واحد',
    'kds.board.rollUpEmpty': 'لا شيء للتحضير',
    'kds.board.allDone': 'اكتمل الكل',
    'kds.board.advance': 'تقدم',
    'kds.board.recall': 'استرجاع',
    'kds.board.recalled': 'مُسترجعة',
    'kds.board.recallBar': 'اكتملت مؤخرًا',
    'kds.board.recallHint': 'اضغط مطولًا على طلب مكتمل لاسترجاعه',
    'kds.board.newTicket': 'طلب جديد',
    'kds.board.takeaway': 'طلب خارجي',
    'kds.board.guests': '{count} ضيوف',
    'kds.board.guestsOne': 'ضيف واحد',
    'kds.board.course': 'الطبق {index}',
    'kds.board.fired': 'أُطلق',
    'kds.board.cancelled': 'ملغى',
    'kds.board.noteUpdate': 'تغيّرت الملاحظة',
    'kds.board.orderNote': 'ملاحظة الطلب',
    'kds.board.lineDone': 'تم',
    'kds.board.tracking': 'رقم {number}',

    'kds.filter.all': 'كل الأصناف',
    'kds.filter.categories': 'الفئات',
    'kds.filter.lateOnly': 'المتأخرة فقط',
    'kds.filter.clear': 'مسح عوامل التصفية',
    'kds.filter.course': 'الطبق',

    'kds.summary.open': 'مفتوحة',
    'kds.summary.oldest': 'الأقدم',
    'kds.summary.average': 'المتوسط',
    'kds.summary.late': 'متأخرة',
    'kds.summary.mute': 'كتم التنبيهات',
    'kds.summary.unmute': 'تشغيل التنبيهات',
    'kds.summary.queued': '{count} في الانتظار',

    'kds.net.live': 'مباشر',
    'kds.net.polling': 'استطلاع',
    'kds.net.offline': 'غير متصل — اللوحة متجمدة',
    'kds.net.queued': 'ستُرسل التغييرات عند عودة الشبكة.',
    'kds.net.stale': 'قد تكون اللوحة قديمة — جارٍ إعادة الاتصال…',
    'kds.net.reconciled': 'تم تحديث اللوحة من الخادم',
    'kds.net.actionFailed': 'رفض الخادم هذا التغيير. تم تحديث اللوحة.',
};

export const KDS_DICTIONARIES: Record<Locale, KdsDictionary> = { en, fr, ar };

export type KdsTranslate = (
    key: KdsKey | string,
    params?: Record<string, string | number>,
) => string;

function interpolate(template: string, params?: Record<string, string | number>): string {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
        key in params ? String(params[key]) : match,
    );
}

/** KDS keys first, shared keys second, the key itself last — a visible key beats a blank button. */
export function createKdsTranslator(locale: Locale): KdsTranslate {
    const dictionary = KDS_DICTIONARIES[locale] ?? fr;
    const shared = createTranslator(locale);
    return (key, params) => {
        const local = (dictionary as Record<string, string>)[key] ?? (fr as Record<string, string>)[key];
        if (local !== undefined) return interpolate(local, params);
        // `createTranslator` already falls back to English and then to the key.
        return shared(key as never, params);
    };
}

const KdsI18nContext = createContext<{ locale: Locale; rtl: boolean; t: KdsTranslate }>({
    locale: 'fr',
    rtl: false,
    t: createKdsTranslator('fr'),
});

export function KitchenI18nProvider({
    locale,
    children,
}: {
    locale: Locale;
    children: ReactNode;
}): JSX.Element {
    const value = useMemo(
        () => ({ locale, rtl: isRtl(locale), t: createKdsTranslator(locale) }),
        [locale],
    );
    // The shared provider owns `document.lang`/`dir` and serves the shared key set.
    return createElement(I18nProvider, {
        locale,
        children: createElement(KdsI18nContext.Provider, { value }, children),
    });
}

export function useKdsI18n(): { locale: Locale; rtl: boolean; t: KdsTranslate } {
    return useContext(KdsI18nContext);
}

export function useT(): KdsTranslate {
    return useContext(KdsI18nContext).t;
}

export { resolveLocale };
export type { Locale };
